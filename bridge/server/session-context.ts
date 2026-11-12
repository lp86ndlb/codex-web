import { createHash } from 'node:crypto'
import { JsonStore } from './storage.ts'

interface SavedContexts { version: 1; threads: Record<string, string> }

function validate(value: unknown): SavedContexts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid context cache')
  const data = value as Record<string, unknown>
  if (data.version !== 1 || !data.threads || typeof data.threads !== 'object' || Array.isArray(data.threads)) throw new Error('Invalid context cache')
  const entries = Object.entries(data.threads)
  if (entries.some(([id, hash]) => !id || id.length > 160 || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))) throw new Error('Invalid context fingerprint')
  return { version: 1, threads: Object.fromEntries(entries) as Record<string, string> }
}

/** Remember only successful cweb context injections, never instruction text.
 * Native history remains authoritative; compaction/revert invalidates the
 * fingerprint instead of assuming that the injected message survived. */
export class SessionContextStore {
  private store: JsonStore<SavedContexts>
  private hashes = new Map<string, string>()
  private generations = new Map<string, number>()
  private queues = new Map<string, Promise<void>>()
  private ready: Promise<void>
  private readable = true

  constructor(path: string) {
    this.store = new JsonStore(path, { version: 1, threads: {} }, validate)
    this.ready = this.store.read().then(data => {
      for (const [id, hash] of Object.entries(data.threads)) {
        // An invalidation can arrive before the first disk read finishes.
        if (!this.generations.has(id)) this.hashes.set(id, hash)
      }
    }).catch(() => {
      // This cache is an optimization. Corrupt/unreadable originals stay on
      // disk; start with no trusted fingerprints and continue sending messages.
      this.readable = false
    })
  }

  private serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const operation = (this.queues.get(id) || Promise.resolve()).then(work)
    const tail = operation.then(() => {}, () => {})
    this.queues.set(id, tail)
    void tail.then(() => { if (this.queues.get(id) === tail) this.queues.delete(id) })
    return operation
  }

  private async persist() {
    if (!this.readable) return
    try {
      // Capture current memory inside JsonStore's transaction queue, so writes
      // from independent threads cannot replace each other's fingerprints.
      await this.store.update(data => { data.threads = Object.fromEntries(this.hashes) })
    } catch {
      // A successful RPC must not become a failed user send because this small
      // local cache couldn't be saved. Memory still deduplicates this process;
      // a later mutation retries persistence, or restart conservatively injects.
    }
  }

  async ensure(id: string, context: string, inject: () => Promise<unknown>): Promise<boolean> {
    const hash = createHash('sha256').update(context).digest('hex')
    const generation = this.generations.get(id) || 0
    return this.serial(id, async () => {
      await this.ready
      if (generation === (this.generations.get(id) || 0) && this.hashes.get(id) === hash) return false
      await inject()
      if (generation === (this.generations.get(id) || 0)) {
        this.hashes.set(id, hash)
        await this.persist()
      }
      return true
    })
  }

  async invalidate(id: string): Promise<void> {
    // Invalidate immediately, including a queued/running ensure. The serialized
    // delete also fences any in-flight disk write before this promise resolves.
    this.generations.set(id, (this.generations.get(id) || 0) + 1)
    this.hashes.delete(id)
    return this.serial(id, async () => {
      await this.ready
      this.hashes.delete(id)
      await this.persist()
    })
  }

  /** Drain fire-and-forget invalidations before their data directory is removed.
   * Call after stopping the native transport, which can emit one last reset. */
  async flush(): Promise<void> {
    await this.ready
    for (;;) {
      await Promise.all([...this.queues.values()])
      // JsonStore.read also waits for its atomic transaction/temporary-file
      // cleanup queue. Cache corruption or IO failures remain non-fatal here.
      try { await this.store.read() } catch { /* Sending/closing must not depend on this cache. */ }
      if (!this.queues.size) return
    }
  }
}
