#!/usr/bin/env node
/** Explicit opt-in: ONE paid Pi Turn through an owned Server, enrolled Worker and Team coordination Session.
 * WEMUX_REAL_PAID_PI_E2E=1 WEMUX_REAL_PI_MODEL=provider::model TMPDIR=<disk directory>
 * node --import tsx apps/e2e/team-coordination-paid-pi.mjs
 * Uses existing operator Pi authentication without reading/printing credentials. No retry after uncertain send.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createWemuxServer } from '../server/src/server.ts'
import { seedLocalAccount } from '../server/src/test/fixtures/administrator.ts'
import { login } from './session.ts'
import { ownedWorkerLaunch, removeOwnedServerDatabases } from './owned-worker-fixture.mjs'

assert.equal(process.env.WEMUX_REAL_PAID_PI_E2E, '1', 'paid model test requires explicit opt-in')
const modelId = process.env.WEMUX_REAL_PI_MODEL
assert.match(modelId ?? '', /^[\w.-]+::[\w.-]+$/, 'choose an explicit Pi provider::model')
const executable = process.env.WEMUX_REAL_PI_EXECUTABLE
assert.ok(executable?.startsWith('/'), 'provide absolute Pi executable; do not download/install an Agent')
const [provider, model] = modelId.split('::')
const preflight = await new Promise(resolve => {
  const child = spawn(executable, ['auth', 'check', '--provider', provider, '--model', model, '--no-refresh'], { stdio: 'ignore' })
  child.once('error', () => resolve(false)); child.once('close', code => resolve(code === 0))
})
assert.equal(preflight, true, 'Pi model authentication not ready; no paid Turn attempted')
const directory = await mkdtemp(join(tmpdir(), 'wemux-team-paid-pi-'))
const home = join(directory, 'worker'), database = join(directory, 'server.sqlite')
const email = 'paid-pi-test-owner@example.test', password = 'paid-pi-test-only-password'
const app = createWemuxServer({ databasePath: database, administratorEmails: [email], mail: {}, google: {} })
let worker, step = 'setup', sent = false
const checks = []
const eventually = async (read, predicate, label, timeout = 30000) => {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    const value = await read()
    if (predicate(value)) return value
    await delay(100)
  }
  throw Error(`Timed out waiting for ${label}`)
}
function launch(args, origin) {
  const isolated = ownedWorkerLaunch(args, origin)
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/worker/src/cli.ts', ...isolated.args], {
    cwd: process.cwd(), env: { ...isolated.env, WEMUX_PI_COMMAND: executable }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  // Do not retain/print Worker stderr: it may contain sensitive diagnostics.
  child.stderr.on('data', () => {})
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve({ code, stdout })) })
  void done.catch(() => {})
  return { child, done }
}
try {
  const origin = await app.listen(0)
  await seedLocalAccount(app.store, { username: email, email, password, administrator: true })
  const owner = await login(origin, email, password), api = owner.api
  await api('/bootstrap', 'POST', {})
  const token = await api('/enrollment-tokens', 'POST', {})
  const enrollment = await launch(['register', '--home', home, `--token=${token.token}`, '--name', 'Paid Pi Test Worker'], origin).done
  assert.equal(enrollment.code, 0, 'owned Worker enrollment')
  const workerId = JSON.parse(enrollment.stdout).workerId
  worker = launch(['start', '--home', home, '--name', 'Paid Pi Test Worker'], origin)
  await eventually(() => api(`/workers/${workerId}/capabilities`), value => value.capabilities.some(item => item.agentKey === 'pi' && item.availability.status === 'available' && item.models.some(entry => entry.modelId === modelId)), 'authenticated Pi capability and selected model', 60000)
  checks.push('enrolled Worker reports authenticated Pi and selected model')
  const project = await api('/projects', 'POST', { name: 'Paid Pi Team test', teamId: 'default-team', requestId: randomUUID() })
  const placed = await api('/workspaces', 'POST', { projectId: project.id, workerId, name: 'Paid Pi empty Workspace', source: 'empty', requestId: randomUUID() })
  await eventually(() => api(`/workspaces/${placed.workspace.id}`), value => value.placements.some(item => item.workerId === workerId && item.status === 'ready'), 'ready Workspace')
  step = 'one first-send'; sent = true
  const response = await api('/teams/default-team/coordination/sessions', 'POST', {
    workspaceId: placed.workspace.id, workerId, agentKey: 'pi', modelId, requestId: randomUUID(), commandId: randomUUID(),
    content: 'This is a single paid end-to-end smoke test. Reply with exactly WEMUX_COORD_PAID_OK. Do not use tools or send external messages.',
  })
  assert.ok(response.session?.id?.length && response.session?.taskId?.startsWith('coordination:'))
  const events = await eventually(() => api(`/sessions/${response.session.id}/events?fromSeq=1&limit=1000`), page => page.events.some(item => item.payload.kind === 'turn.finished'), 'Pi Turn terminal event', 120000)
  const outcome = events.events.find(item => item.payload.kind === 'turn.finished')?.payload.outcome
  assert.equal(outcome, 'completed', `Pi Turn outcome: ${outcome ?? 'missing'}`)
  const answer = events.events.filter(item => item.payload.kind === 'assistant.text.delta').map(item => item.payload.text ?? '').join('')
  assert.match(answer, /WEMUX_COORD_PAID_OK/)
  checks.push('one Team Task-bound Pi Turn completed with expected marker and Journal result')
  console.log(JSON.stringify({ status: 'pass', modelId, paidTurns: 1, checks }))
} catch (error) {
  // Print only stage and error type. Never print model output, credentials or Worker logs.
  console.error(JSON.stringify({ status: 'fail', step, paidTurnSubmitted: sent, errorName: error?.name ?? 'Error', checks }))
  process.exitCode = 1
} finally {
  if (worker) {
    if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill('SIGTERM')
    const timer = setTimeout(() => worker.child.kill('SIGKILL'), 10000)
    try { assert.equal((await worker.done).code, 0, 'owned Worker graceful stop') }
    catch { process.exitCode = 1 }
    finally { clearTimeout(timer) }
  }
  await app.close().catch(() => { process.exitCode = 1 })
  await removeOwnedServerDatabases(database).catch(() => { process.exitCode = 1 })
  await rm(directory, { recursive: true, force: true }).catch(() => { process.exitCode = 1 })
}
