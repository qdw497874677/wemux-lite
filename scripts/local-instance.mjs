#!/usr/bin/env node
// One explicit deployment configuration; no implicit database creation or registration.
import { readFile, writeFile, mkdir, open } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
const action = process.argv[2] ?? 'status'
const root = resolve(process.env.WEMUX_INSTANCE_HOME ?? '/opt/data/wemux-lite')
const config = JSON.parse(await readFile(join(root, 'instance.json'), 'utf8'))
const services = {
  server: { entry: join(config.release, 'apps/server/dist/main.js'), args: [], env: config.serverEnvironment },
  worker: { entry: join(config.release, 'apps/worker/dist/cli.js'), args: ['start', '--home', config.workerHome], env: {} },
}
const pause = ms => new Promise(r => setTimeout(r, ms))
async function running(name) {
  try {
    const saved = JSON.parse(await readFile(join(root, `${name}.pid.json`), 'utf8'))
    const cmd = (await readFile(`/proc/${saved.pid}/cmdline`, 'utf8')).split('\0')
    const stat = await readFile(`/proc/${saved.pid}/stat`, 'utf8')
    return cmd.includes(services[name].entry) && stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] === saved.startTime ? saved.pid : null
  } catch { return null }
}
async function start(name) {
  if (await running(name)) return
  await mkdir(join(root, 'logs'), { recursive: true, mode: 0o700 })
  const log = await open(join(root, 'logs', `${name}.log`), 'a', 0o600)
  const service = services[name]
  const child = spawn(config.node, [service.entry, ...service.args], { cwd: config.release, env: { ...process.env, ...service.env }, detached: true, stdio: ['ignore', log.fd, log.fd] })
  await new Promise((ok, fail) => { child.once('spawn', ok); child.once('error', fail) })
  const stat = await readFile(`/proc/${child.pid}/stat`, 'utf8')
  await writeFile(join(root, `${name}.pid.json`), JSON.stringify({ pid: child.pid, startTime: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] }), { mode: 0o600 })
  child.unref(); await log.close()
  await pause(500)
  if (!await running(name)) throw new Error(`${name} exited; inspect ${root}/logs/${name}.log`)
}
async function stop(name) {
  const pid = await running(name)
  if (!pid) return
  process.kill(pid, 'SIGTERM')
  for (let n = 0; n < 100; n++) { if (!await running(name)) return; await pause(100) }
  throw new Error(`${name} did not stop gracefully; refusing forced termination`)
}
if (!['start', 'stop', 'restart', 'status'].includes(action)) throw new Error('Usage: local-instance.mjs start|stop|restart|status')
if (action === 'stop' || action === 'restart') { await stop('worker'); await stop('server') }
if (action === 'start' || action === 'restart') {
  await start('server')
  let healthy = false
  for (let n = 0; n < 40; n++) {
    try { const r = await fetch(`${config.url}/api/auth/me`, { signal: AbortSignal.timeout(500) }); if (r.status === 401 || r.ok) { healthy = true; break } } catch {}
    await pause(250)
  }
  if (!healthy) throw new Error('Server API not healthy; Worker not started')
  await start('worker')
  // Process liveness is not cluster readiness. Read-only access must not reset presence.
  const local = new DatabaseSync(join(config.workerHome, 'worker.sqlite'), { readOnly: true })
  const identity = JSON.parse(local.prepare("SELECT body FROM documents WHERE bucket='identity' AND id='worker'").get().body)
  local.close()
  let online = false
  for (let n = 0; n < 80; n++) {
    const db = new DatabaseSync(config.serverEnvironment.WEMUX_DATABASE_PATH, { readOnly: true })
    try {
      online = db.prepare("SELECT data FROM records WHERE kind='worker'").all().some(row => {
        const worker = JSON.parse(row.data)
        return worker.id === identity.workerId && worker.connectionState === 'online'
      })
    } finally { db.close() }
    if (online) break
    await pause(250)
  }
  if (!online) throw new Error('Worker process started but cluster has not confirmed online; inspect worker.log')
  console.log('Worker: original identity confirmed online by Server')
}
for (const name of Object.keys(services)) console.log(`${name}: ${await running(name) ? 'running' : 'stopped'}`)
console.log(`URL: ${config.url}\nRelease: ${config.release}\nWorker home: ${config.workerHome}`)
