import { readdir, readFile, readlink } from 'node:fs/promises'
import { basename, resolve, sep } from 'node:path'

/** Linux Codex keeps an open rollout descriptor while a session is loaded. Read only;
 * never signal other clients. This detects existing owners, not an OS-wide mutex. */
export async function sessionOwners(home: string, ownPid?: number): Promise<Map<string, number>> {
  const owners = new Map<string, number>()
  if (process.platform !== 'linux') return owners
  const prefixes = ['sessions', 'archived_sessions'].map(name => resolve(home, name) + sep)
  const processes = await readdir('/proc').catch(() => [])
  await Promise.all(processes.filter(name => /^\d+$/.test(name) && Number(name) !== ownPid).map(async pid => {
    try {
      if ((await readFile(`/proc/${pid}/comm`, 'utf8')).trim() !== 'codex') return
      const descriptors = await readdir(`/proc/${pid}/fd`)
      await Promise.all(descriptors.map(async fd => {
        try {
          const target = await readlink(`/proc/${pid}/fd/${fd}`)
          if (!prefixes.some(prefix => target.startsWith(prefix))) return
          const id = /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.jsonl$/.exec(basename(target))?.[1]
          if (id) owners.set(id, Number(pid))
        } catch { /* Descriptor closed during inspection. */ }
      }))
    } catch { /* Process ended or belongs to another user. */ }
  }))
  return owners
}
