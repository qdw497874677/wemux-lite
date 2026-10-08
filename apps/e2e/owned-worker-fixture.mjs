import { lstat, rm } from 'node:fs/promises'

/** Keep executable discovery, but never inherit Worker routing or proxy overrides. */
export function ownedWorkerLaunch(args, origin, ambient = process.env) {
  const url = new URL(origin)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.origin !== origin) throw Error('Owned Worker requires a loopback HTTP origin')
  const env = Object.fromEntries(Object.entries(ambient).filter(([key]) => !/^WEMUX_/i.test(key) && !/^(?:https?|all|no)_proxy$/i.test(key)))
  return { args: [...args, '--server', origin, '--servers', origin, '--transport', 'direct', '--prefer', 'direct', '--host', '127.0.0.1', '--port', '0'], env }
}

/** Call only after closing the owned Server; never remove adjacent evidence. */
export async function removeOwnedServerDatabases(databasePath) {
  const paths = ['', '-wal', '-shm', '.transport', '.transport-wal', '.transport-shm'].map(suffix => `${databasePath}${suffix}`)
  for (const path of paths) await rm(path, { force: true })
  for (const path of paths) {
    try { await lstat(path) }
    catch (error) { if (error.code === 'ENOENT') continue; throw error }
    throw Error('Owned Server database cleanup incomplete')
  }
}
