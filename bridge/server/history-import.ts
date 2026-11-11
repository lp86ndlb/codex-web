import { copyFile, mkdir, readdir, rename, rm, readFile, writeFile, link } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, resolve, relative } from 'node:path'
import { randomUUID } from 'node:crypto'
import { sessionOwners } from './session-access.ts'

const idOf = (name: string) => /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.jsonl$/.exec(name)?.[1]
async function rollouts(home: string) {
  const result: { path: string; id: string }[] = []
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error })) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) { const id = idOf(entry.name); if (id) result.push({ path, id }) }
    }
  }
  await walk(resolve(home, 'sessions')); await walk(resolve(home, 'archived_sessions'))
  return result
}
/** One-time, append-only migration. Keep the original home intact; never copy a database,
 * overwrite a native rollout or re-import an archived/deleted session after migration. */
export async function importLegacyHistory(from: string, to: string, marker: string) {
  if (resolve(from) === resolve(to)) return 0
  const source = await rollouts(from)
  if (!source.length) return 0
  const imported: string[] = await readFile(marker, 'utf8').then(JSON.parse).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error })
  const existing = new Set((await rollouts(to)).map(row => row.id))
  const owners = await sessionOwners(from)
  let count = 0
  for (const row of source) {
    if (imported.includes(row.id) || owners.has(row.id)) continue
    if (!existing.has(row.id)) {
      const target = resolve(to, relative(from, row.path)); const temp = `${target}.${randomUUID()}.tmp`
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      try {
        await copyFile(row.path, temp, constants.COPYFILE_EXCL)
        await link(temp, target).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error })
        count++
      } finally { await rm(temp, { force: true }) }
    }
    imported.push(row.id)
  }
  const temp = `${marker}.${randomUUID()}.tmp`
  await writeFile(temp, JSON.stringify(imported), { mode: 0o600 }); await rename(temp, marker)
  return count
}
