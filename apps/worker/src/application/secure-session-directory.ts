import { lstat, mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/** Create/check each descendant without following pre-existing symlinks out of a verified placement. */
export async function secureSessionDirectory(placement: string, target: string): Promise<void> {
  const root = resolve(placement)
  const path = resolve(target)
  const suffix = relative(root, path)
  if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix) || await realpath(root).catch(() => null) !== root) throw new Error('agent_launch_home_mismatch')
  let current = root
  for (const segment of suffix.split(sep)) {
    current = resolve(current, segment)
    try { await mkdir(current, { mode: 0o700 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    const stat = await lstat(current)
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(current) !== current) throw new Error('agent_launch_home_mismatch')
  }
}
