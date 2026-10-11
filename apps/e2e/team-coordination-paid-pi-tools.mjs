#!/usr/bin/env node
/** Explicit opt-in: at most TWO paid Pi Turns (create+read a harmless file) in one owned Team Session.
 * WEMUX_REAL_PAID_PI_E2E=1 WEMUX_REAL_PI_MODEL=provider::model TMPDIR=<disk directory>
 * node --import tsx apps/e2e/team-coordination-paid-pi-tools.mjs
 * Existing Pi authentication only; no retries after uncertain send. Never writes outside the owned Workspace.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
const directory = await mkdtemp(join(tmpdir(), 'wemux-team-paid-pi-tools-'))
const home = join(directory, 'worker'), database = join(directory, 'server.sqlite')
const email = 'paid-pi-test-owner@example.test', password = 'paid-pi-test-only-password'
const app = createWemuxServer({ databasePath: database, administratorEmails: [email], mail: {}, google: {} })
let worker, step = 'setup', paidTurnsSubmitted = 0, followupDiagnostic
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
  const ready = await eventually(() => api(`/workspaces/${placed.workspace.id}`), value => value.placements.some(item => item.workerId === workerId && item.status === 'ready' && item.location?.rootPath), 'ready Workspace')
  const rootPath = ready.placements.find(item => item.workerId === workerId).location.rootPath
  const filename = `coordination-tool-${randomUUID()}.txt`, marker = `WEMUX_TOOL_${randomUUID().replaceAll('-', '')}`
  step = 'first-send file creation'; paidTurnsSubmitted++
  const response = await api('/teams/default-team/coordination/sessions', 'POST', {
    workspaceId: placed.workspace.id, workerId, agentKey: 'pi', modelId, requestId: randomUUID(), commandId: randomUUID(),
    content: `Use your local file tool to create the file ${filename} in the current workspace with exactly this single line: ${marker}. Do not write outside the current workspace, do not use network tools, and do not include secrets. Then reply briefly that it is done.`,
  })
  assert.ok(response.session?.id?.length && response.session?.taskId?.startsWith('coordination:'))
  const history = () => api(`/sessions/${response.session.id}/events?fromSeq=1&limit=1000`)
  const first = await eventually(history, page => page.events.some(item => item.payload.kind === 'turn.finished'), 'first Pi Turn terminal event', 120000)
  const firstOutcome = first.events.find(item => item.payload.kind === 'turn.finished')?.payload.outcome
  const firstTools = first.events.filter(item => item.payload.kind === 'tool.started').map(item => item.payload.toolName)
  if (firstOutcome !== 'completed' || firstTools.length === 0) console.error(JSON.stringify({ diagnostic: 'first-turn', outcome: firstOutcome, toolNames: firstTools }))
  assert.equal(firstOutcome, 'completed', 'create-file Turn completed')
  step = 'verify real file and tool Journal'
  assert.equal((await readFile(join(rootPath, filename), 'utf8')).trim(), marker, 'Pi actually wrote the owned Workspace file')
  assert.ok(first.events.some(item => item.payload.kind === 'tool.started') && first.events.some(item => item.payload.kind === 'tool.finished'), 'native tool events reached Server Journal')
  checks.push('paid Pi created a file in owned Workspace; native tool events reached Task-bound Journal')
  step = 'follow-up file reading'; paidTurnsSubmitted++
  const firstTerminal = first.events.find(item => item.payload.kind === 'turn.finished')
  assert.ok(Number.isSafeInteger(firstTerminal?.seq), 'first Turn Journal boundary')
  await api(`/sessions/${response.session.id}/messages`, 'POST', { commandId: randomUUID(), content: `Read the file ${filename} in the current workspace using your local file tool. Reply with the exact file contents and nothing else. Do not access network or any other files.` })
  const second = await eventually(history, page => page.events.some(item => item.seq > firstTerminal.seq && item.payload.kind === 'turn.finished'), 'second Pi Turn terminal event', 120000)
  const followup = second.events.filter(item => item.seq > firstTerminal.seq)
  const text = followup.filter(item => item.payload.kind === 'assistant.text.delta').map(item => item.payload.text ?? '').join('')
  followupDiagnostic = {
    outcome: followup.find(item => item.payload.kind === 'turn.finished')?.payload.outcome ?? 'missing',
    failureCode: followup.find(item => item.payload.kind === 'turn.finished')?.payload.failure?.code ?? null,
    abortReason: followup.find(item => item.payload.kind === 'turn.finished')?.payload.failure?.abortReason ?? null,
    toolNames: followup.filter(item => item.payload.kind === 'tool.started').map(item => item.payload.toolName),
    toolExitCodes: followup.filter(item => item.payload.kind === 'tool.finished').map(item => item.payload.exitCode),
    toolStarted: followup.filter(item => item.payload.kind === 'tool.started').length,
    toolFinished: followup.filter(item => item.payload.kind === 'tool.finished').length,
    markerInAnswer: text.includes(marker),
  }
  assert.equal(followupDiagnostic.outcome, 'completed', 'read-file Turn completed')
  assert.ok(followupDiagnostic.toolStarted > 0 && followupDiagnostic.toolFinished > 0, 'second Pi Turn used and finished a native tool')
  assert.equal(followupDiagnostic.markerInAnswer, true, 'second Pi Turn returned the Workspace file marker')
  checks.push('follow-up in same Team Session read the file with a native tool and returned its contents')
  console.log(JSON.stringify({ status: 'pass', modelId, paidTurns: paidTurnsSubmitted, checks }))
} catch (error) {
  // Print only stage and error type. Never print model output, credentials or Worker logs.
  console.error(JSON.stringify({ status: 'fail', step, paidTurnsSubmitted, errorName: error?.name ?? 'Error', ...(followupDiagnostic ? { followupDiagnostic } : {}), checks }))
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
