import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Serialize transactions; only expose the new state after an atomic replacement. */
export class JsonStore<T> {
  private value: T
  private ready: Promise<void>
  private queue: Promise<unknown> = Promise.resolve()
  private file: string
  constructor(file: string, initial: T, validate: (value: unknown) => T) {
    this.file = file
    this.value = initial
    this.ready = readFile(file, 'utf8').then(text => { this.value = validate(JSON.parse(text)) }).catch(error => {
      if (error.code !== 'ENOENT') throw new Error(`无法读取 ${file}；原文件已保留：${error.message}`)
    })
    // A caller may initialize stores before opening the first HTTP request.
    void this.ready.catch(() => {})
  }
  async read(): Promise<T> { await this.ready; await this.queue; return structuredClone(this.value) }
  update<R>(change: (draft: T) => R | Promise<R>): Promise<R> {
    const work = this.queue.then(async () => {
      await this.ready
      const draft = structuredClone(this.value)
      const result = await change(draft)
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
      const temp = `${this.file}.${randomUUID()}.tmp`
      try {
        await writeFile(temp, JSON.stringify(draft, null, 2) + '\n', { mode: 0o600 })
        await rename(temp, this.file)
      } finally { await rm(temp, { force: true }) }
      this.value = draft
      return result
    })
    this.queue = work.catch(() => {})
    return work
  }
}
