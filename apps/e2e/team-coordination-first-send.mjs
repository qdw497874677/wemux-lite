#!/usr/bin/env node
/** Owned Server + Worker Test Agent end-to-end first-send. No paid runtime. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createWemuxServer } from '../server/src/server.ts'
import { login } from './session.ts'
import { seedLocalAccount } from '../server/src/test/fixtures/administrator.ts'
import { ownedWorkerLaunch, removeOwnedServerDatabases } from './owned-worker-fixture.mjs'

const directory = await mkdtemp(join(tmpdir(), 'wemux-coordination-first-send-'))
const database = join(directory, 'server.sqlite'), home = join(directory, 'worker')
const email = 'coordination-first-send@example.test', password = 'coordination-test-only-password'
const app = createWemuxServer({ databasePath: database, administratorEmails: [email], mail: {}, google: {} })
let worker, step = 'setup'
function launch(args, origin) {
  const isolated = ownedWorkerLaunch(args, origin)
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/worker/src/cli.ts', ...isolated.args], { cwd: process.cwd(), env: isolated.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', value => { stdout += value })
  child.stderr.on('data', value => { stderr += value })
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr })) })
  void done.catch(() => {})
  return { child, done, logs: () => ({ stdout, stderr }) }
}
async function eventually(read, accept, label, timeout = 30000) {
  const limit = Date.now() + timeout
  while (Date.now() < limit) {
    const value = await read()
    if (accept(value)) return value
    await delay(100)
  }
  throw Error(`Timed out: ${label}`)
}
try {
  const origin = await app.listen(0)
  await seedLocalAccount(app.store, { username: email, email, password, administrator: true })
  const { api } = await login(origin, email, password)
  await api('/bootstrap', 'POST', {})
  step = 'enroll Worker'
  const enrollment = await api('/enrollment-tokens', 'POST', {})
  const registered = await launch(['register', '--home', home, `--token=${enrollment.token}`, '--name', 'Owned Coordination Worker'], origin).done
  assert.equal(registered.code, 0, `Worker registration: ${registered.stderr}`)
  const workerId = JSON.parse(registered.stdout).workerId
  worker = launch(['start', '--home', home, '--name', 'Owned Coordination Worker'], origin)
  await eventually(() => api(`/workers/${workerId}/capabilities`), capabilities => capabilities.capabilities.some(agent => agent.agentKey === 'test' && agent.availability.status === 'available'), 'Test Agent online')
  step = 'prepare authorized Workspace'
  const project = await api('/projects', 'POST', { name: 'Coordination Test Project', teamId: 'default-team', requestId: randomUUID() })
  const provision = await api('/workspaces', 'POST', { projectId: project.id, workerId, name: 'Owned Workspace', source: 'empty', requestId: randomUUID() })
  const workspaceId = provision.workspace.id
  await eventually(() => api(`/workspaces/${workspaceId}`), space => space.placements.some(placement => placement.workerId === workerId && placement.status === 'ready'), 'ready Workspace placement')
  step = 'first-send and real Test Agent echo'
  const body = { requestId: randomUUID(), commandId: randomUUID(), workspaceId, workerId, agentKey: 'test', modelId: 'test', content: 'coordination-e2e-echo' }
  const created = await api('/teams/default-team/coordination/sessions', 'POST', body)
  assert.equal(created.session.projectId, project.id)
  assert.ok(created.session.taskId.startsWith('coordination:'))
  assert.equal(created.messageCommandId, body.commandId)
  await eventually(() => api(`/commands/${body.commandId}`), receipt => receipt.status === 'accepted', 'first enqueue accepted')
  const journal = () => api(`/sessions/${created.session.id}/events?fromSeq=1&limit=1000`)
  await eventually(journal, value => value.events.some(event => event.payload.kind === 'turn.finished' && event.payload.outcome === 'completed') && value.events.filter(event => event.payload.kind === 'assistant.text.delta').map(event => event.payload.text).join('').includes(body.content), 'Test Agent completed echo')
  const retried = await api('/teams/default-team/coordination/sessions', 'POST', body)
  assert.equal(retried.session.id, created.session.id)
  assert.equal(retried.created, false)
  assert.equal((await api('/teams/default-team/coordination/sessions')).items.length, 1)
  const subsequent = await api(`/sessions/${created.session.id}/messages`, 'POST', { commandId: randomUUID(), content: 'coordination-follow-up' })
  await eventually(journal, value => value.events.some(event => event.payload.kind === 'turn.finished' && event.payload.outcome === 'completed') && value.events.filter(event => event.payload.kind === 'assistant.text.delta').map(event => event.payload.text).join('').includes('coordination-follow-up'), 'follow-up echo')
  assert.ok(subsequent.commandId)
  console.log(JSON.stringify({ status: 'pass', checks: ['owned Worker Test Agent available', 'Project Workspace placement ready', 'Task-bound coordination first-send echo', 'same-identity replay', 'follow-up echo'] }))
} catch (error) {
  console.error(`Team coordination ${step}: ${error.stack ?? error}; Worker: ${JSON.stringify(worker?.logs())}`)
  process.exitCode = 1
} finally {
  if (worker) {
    if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill('SIGTERM')
    const timer = setTimeout(() => worker.child.kill('SIGKILL'), 10000)
    try { const stopped = await worker.done; assert.equal(stopped.code, 0, 'Worker graceful stop') }
    catch (error) { console.error(`Worker shutdown: ${error}`); process.exitCode = 1 }
    finally { clearTimeout(timer) }
  }
  await app.close()
  await removeOwnedServerDatabases(database)
  await rm(directory, { recursive: true, force: true })
}
