#!/usr/bin/env node
/** Explicit opt-in: TWO paid Pi Turns through an owned Server, enrolled Worker and Team coordination Session.
 * WEMUX_REAL_PAID_PI_E2E=1 WEMUX_REAL_PI_MODEL=provider::model WEMUX_REAL_PI_NEXT_MODEL=provider::model TMPDIR=<disk directory>
 * node --import tsx apps/e2e/team-coordination-model-switch-paid-pi.mjs
 * Uses existing operator Pi authentication without reading/printing credentials. No retry after uncertain send. Never run without operator authorization for TWO paid Turns.
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
const nextModelId = process.env.WEMUX_REAL_PI_NEXT_MODEL
assert.match(nextModelId ?? '', /^[\w.-]+::[\w.-]+$/, 'choose an explicit second Pi provider::model')
assert.notEqual(nextModelId, modelId, 'models must differ')
for (const candidate of [modelId, nextModelId]) {
  const [provider, model] = candidate.split('::')
  const ready = await new Promise(resolve => {
    const child = spawn(executable, ['auth', 'check', '--provider', provider, '--model', model, '--no-refresh'], { stdio: 'ignore' })
    child.once('error', () => resolve(false)); child.once('close', code => resolve(code === 0))
  })
  assert.equal(ready, true, 'Pi model authentication not ready; no paid Turn attempted')
}
const directory = await mkdtemp(join(tmpdir(), 'wemux-team-paid-pi-'))
const home = join(directory, 'worker'), database = join(directory, 'server.sqlite')
const email = 'paid-pi-test-owner@example.test', password = 'paid-pi-test-only-password'
const app = createWemuxServer({ databasePath: database, administratorEmails: [email], mail: {}, google: {} })
let worker, step = 'setup', submitted = 0
let diagnosedSessionId = null
let diagnosedCommandId = null
let diagnosedWorkerId = null
let api = null
let keepDirectory = false
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
  const owner = await login(origin, email, password); api = owner.api
  await api('/bootstrap', 'POST', {})
  const token = await api('/enrollment-tokens', 'POST', {})
  const enrollment = await launch(['register', '--home', home, `--token=${token.token}`, '--name', 'Paid Pi Test Worker'], origin).done
  assert.equal(enrollment.code, 0, 'owned Worker enrollment')
  const workerId = JSON.parse(enrollment.stdout).workerId
  diagnosedWorkerId = workerId
  worker = launch(['start', '--home', home, '--name', 'Paid Pi Test Worker'], origin)
  await eventually(() => api(`/workers/${workerId}/capabilities`), value => value.capabilities.some(item => item.agentKey === 'pi' && item.availability.status === 'available' && item.modelSwap && [modelId, nextModelId].every(candidate => item.models.some(entry => entry.modelId === candidate))), 'authenticated Pi capability and selected model', 60000)
  checks.push('enrolled Worker reports authenticated Pi and selected model')
  const project = await api('/projects', 'POST', { name: 'Paid Pi Team test', teamId: 'default-team', requestId: randomUUID() })
  const placed = await api('/workspaces', 'POST', { projectId: project.id, workerId, name: 'Paid Pi empty Workspace', source: 'empty', requestId: randomUUID() })
  await eventually(() => api(`/workspaces/${placed.workspace.id}`), value => value.placements.some(item => item.workerId === workerId && item.status === 'ready'), 'ready Workspace')
  step = 'first-send'; submitted++
  const response = await api('/teams/default-team/coordination/sessions', 'POST', {
    workspaceId: placed.workspace.id, workerId, agentKey: 'pi', modelId, requestId: randomUUID(), commandId: randomUUID(),
    content: 'Reply with exactly WEMUX_COORD_MODEL_BEFORE. Do not use tools or send external messages.',
  })
  assert.ok(response.session?.id?.length && response.session?.taskId?.startsWith('coordination:'))
  diagnosedSessionId = response.session.id
  const journal = () => api(`/sessions/${response.session.id}/events?fromSeq=1&limit=1000`)
  const events = await eventually(() => api(`/sessions/${response.session.id}/events?fromSeq=1&limit=1000`), page => page.events.some(item => item.payload.kind === 'turn.finished'), 'Pi Turn terminal event', 120000)
  const outcome = events.events.find(item => item.payload.kind === 'turn.finished')?.payload.outcome
  assert.equal(outcome, 'completed', `Pi Turn outcome: ${outcome ?? 'missing'}`)
  const answer = events.events.filter(item => item.payload.kind === 'assistant.text.delta').map(item => item.payload.text ?? '').join('')
  assert.match(answer, /WEMUX_COORD_MODEL_BEFORE/)
  const firstStart = events.events.filter(item => item.payload.kind === 'turn.started')
  assert.equal(firstStart.length, 1)
  assert.equal(firstStart[0].payload.modelId, modelId)
  checks.push('first Team Task-bound Pi Turn completed under initial model')

  step = 'switch confirmed by Worker Journal'
  const selection = await api(`/sessions/${response.session.id}/runtime/commands`, 'POST', {
    commandId: randomUUID(), name: 'set_model', arguments: { modelId: nextModelId },
  })
  await eventually(() => api(`/commands/${selection.commandId}`), command => command.status === 'accepted', 'model command receipt')
  await eventually(journal, page => page.events.some(item => item.payload.kind === 'model.changed' && item.payload.modelId === nextModelId), 'model.changed from Worker')
  assert.equal((await api(`/sessions/${response.session.id}`)).binding.modelId, nextModelId)
  step = 'second send'; submitted++
  const second = await api(`/sessions/${response.session.id}/messages`, 'POST', {
    commandId: randomUUID(), content: 'Reply with exactly WEMUX_COORD_MODEL_AFTER. Do not use tools or send external messages.',
  })
  diagnosedCommandId = second.commandId
  await eventually(() => api(`/commands/${second.commandId}`), command => command.status === 'accepted', 'second Turn enqueue receipt')
  const timeline = await eventually(journal, page => page.events.filter(item => item.payload.kind === 'turn.finished').length === 2, 'second Pi Turn terminal event', 120000)
  assert.deepEqual(timeline.events.filter(item => item.payload.kind === 'turn.finished').map(item => item.payload.outcome), ['completed', 'completed'])
  assert.deepEqual(timeline.events.filter(item => item.payload.kind === 'turn.started').map(item => item.payload.modelId), [modelId, nextModelId], 'first Turn snapshot remains unchanged; next Turn uses new model')
  assert.equal(timeline.events.filter(item => item.payload.kind === 'model.changed' && item.payload.modelId === nextModelId).length, 1)
  const afterText = timeline.events.filter(item => item.payload.kind === 'assistant.text.delta' && item.seq > firstStart[0].seq).map(item => item.payload.text ?? '').join('')
  assert.match(afterText, /WEMUX_COORD_MODEL_AFTER/)
  checks.push('Worker-confirmed model.changed, two distinct Turn model snapshots, second response and final binding')
  console.log(JSON.stringify({ status: 'pass', models: [modelId, nextModelId], paidTurns: submitted, checks }))
} catch (error) {
  // Print stage, assertion label, error type and Turn failure codes. Never print model output, credentials or Worker logs.
  let turnDiagnostics = null
  if (diagnosedSessionId) {
    try {
      const page = await api(`/sessions/${diagnosedSessionId}/events?fromSeq=1&limit=1000`).catch(() => null)
      turnDiagnostics = page?.events?.filter(item => item.payload.kind === 'turn.finished').map(item => ({
        outcome: item.payload.outcome,
        failureCode: item.payload.failure?.code ?? null,
        abortReason: item.payload.failure?.abortReason ?? null,
        failureMessage: item.payload.failure?.message?.slice(0, 160) ?? null,
      })) ?? null
    } catch { /* diagnostics are best-effort */ }
  }
  let workerState = null
  if (diagnosedWorkerId) {
    try {
      const listed = await api('/workers').catch(() => null)
      workerState = listed?.items?.find(item => item.id === diagnosedWorkerId)?.connectionState ?? null
    } catch { /* diagnostics are best-effort */ }
  }
  let commandProjection = null
  if (diagnosedCommandId) {
    try { commandProjection = (({ status, failure }) => ({ status, failure: failure ? { code: failure.code, abortReason: failure.abortReason ?? null } : null }))(await api(`/commands/${diagnosedCommandId}`).catch(() => null)) } catch { /* diagnostics are best-effort */ }
  }
  keepDirectory = process.env.WEMUX_E2E_KEEP_DIR === '1'
  console.error(JSON.stringify({ status: 'fail', step, paidTurnsSubmitted: submitted, errorName: error?.name ?? 'Error', ...(error instanceof Error && error.message ? { errorDetail: error.message.slice(0, 300) } : {}), ...(turnDiagnostics ? { turnDiagnostics } : {}), ...(workerState ? { workerConnectionState: workerState } : {}), ...(commandProjection ? { lastCommand: commandProjection } : {}), ...(keepDirectory ? { keptDirectory: directory } : {}), checks }))
  process.exitCode = 1
} finally {
  let workerExit = null
  if (worker) {
    if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill('SIGTERM')
    const timer = setTimeout(() => worker.child.kill('SIGKILL'), 10000)
    try { workerExit = (await worker.done).code; assert.equal(workerExit, 0, 'owned Worker graceful stop') }
    catch { process.exitCode = 1 }
    finally { clearTimeout(timer) }
  }
  await app.close().catch(() => { process.exitCode = 1 })
  if (keepDirectory) console.error(JSON.stringify({ status: 'epilogue', workerExit, keptDirectory: directory }))
  else {
    await removeOwnedServerDatabases(database).catch(() => { process.exitCode = 1 })
    await rm(directory, { recursive: true, force: true }).catch(() => { process.exitCode = 1 })
  }
}
