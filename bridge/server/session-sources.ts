import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

/** Only the current user's default home and homes of their live Codex processes.
 * Do not scan other users, workspaces, or arbitrary directories for credentials. */
export async function discoverCodexHomes(primary: string, options: { proc?: string; defaultHome?: string } = {}): Promise<string[]> {
  const candidates = new Set([options.defaultHome || resolve(homedir(), '.codex')])
  if (process.platform === 'linux') {
    const proc = options.proc || '/proc'
    const entries = await readdir(proc).catch(() => [])
    await Promise.all(entries.filter(name => /^\d+$/.test(name)).map(async pid => {
      try {
        const directory = resolve(proc, pid)
        if ((await stat(directory)).uid !== process.getuid?.() || (await readFile(resolve(directory, 'comm'), 'utf8')).trim() !== 'codex') return
        const values = (await readFile(resolve(directory, 'environ'), 'utf8')).split('\0')
        const home = values.find(value => value.startsWith('CODEX_HOME='))?.slice(11)
        if (home?.startsWith('/')) candidates.add(home)
      } catch { /* Process exited or environment is unavailable. */ }
    }))
  }
  const current = await realpath(primary).catch(() => resolve(primary)), homes = new Set<string>()
  for (const candidate of candidates) {
    try {
      const home = await realpath(candidate)
      if (home === current || (await stat(home)).uid !== process.getuid?.()) continue
      if (!(await stat(resolve(home, 'state_5.sqlite')).catch(() => null))?.isFile()
        && !(await stat(resolve(home, 'app-server-control/app-server-control.sock')).catch(() => null))?.isSocket()) continue
      homes.add(home)
    } catch { /* Not a usable native home. */ }
  }
  return [...homes].slice(0, 8)
}
