#!/usr/bin/env node
/** Real enrolled Worker coordination conversation, non-paid Test Agent only.
 * Run: node --import tsx apps/e2e/team-coordination-transport.mjs
 * This is a positive functional test, not an expected-failure gate test. The 996c617
 * baseline must fail at first-send (403 coordination_gate_closed), not report PASS.
 * Scope: owned clean instance, same-home restart and one unauthorized outsider. This
 * does not cover concurrent first-sends, revocation during a queued Turn, unknown
 * Agent, cross-Project placement, model switching, real Pi, or backup migration.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { connect, createServer } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import { createWemuxServer } from '../server/src/server.ts'
import { login } from './session.ts'
import { seedLocalAccount } from '../server/src/test/fixtures/administrator.ts'
import { ownedWorkerLaunch, removeOwnedServerDatabases } from './owned-worker-fixture.mjs'

// Source: coordination-write-channel-probes.mjs. Proxy observes the real Upgrade/hello and
// forwards every byte unchanged; only the negative cases inject RFC 6455 server-role frames.
function transportProxy(port) {
  const links = [], seen = [], receipts = [], cursor = { epoch: null, next: 1 }
  const parse = buffer => {
    if (buffer.length < 2) return null
    const masked = Boolean(buffer[1] & 128)
    let length = buffer[1] & 127, offset = 2
    if (length === 126) { if (buffer.length < 4) return null; length = buffer.readUInt16BE(2); offset = 4 }
    else if (length === 127) { if (buffer.length < 10) return null; length = Number(buffer.readBigUInt64BE(2)); offset = 10 }
    const start = offset + (masked ? 4 : 0)
    return buffer.length < start + length ? null : { total: start + length, start, length, masked, opcode: buffer[0] & 15 }
  }
  const decode = (bytes, frame) => {
    if (frame.opcode !== 1) return null
    const body = Buffer.from(bytes.subarray(frame.start, frame.total))
    if (frame.masked) { const key = bytes.subarray(frame.start - 4, frame.start); for (let i = 0; i < body.length; i++) body[i] ^= key[i % 4] }
    try { return JSON.parse(body.toString('utf8')) } catch { return null }
  }
  const server = createServer(client => {
    const upstream = connect(port, '127.0.0.1')
    const link = { client, upstream, mode: 'head', head: Buffer.alloc(0), incoming: Buffer.alloc(0), outgoing: Buffer.alloc(0), upgraded: false }
    links.push(link)
    client.on('error', () => {}); upstream.on('error', () => {})
    client.on('close', () => upstream.destroy()); upstream.on('close', () => client.destroy())
    client.on('data', chunk => {
      if (link.mode === 'raw') return upstream.write(chunk)
      if (link.mode === 'head') {
        link.head = Buffer.concat([link.head, chunk]); const end = link.head.indexOf('\r\n\r\n')
        if (end < 0) return
        const head = link.head.subarray(0, end + 4), rest = link.head.subarray(end + 4)
        link.mode = /upgrade:\s*websocket/i.test(head.toString('latin1')) ? 'ws' : 'raw'
        upstream.write(head); if (rest.length) upstream.write(rest)
        return
      }
      upstream.write(chunk)
      link.incoming = Buffer.concat([link.incoming, chunk])
      for (;;) {
        const frame = parse(link.incoming); if (!frame) break
        const value = decode(link.incoming.subarray(0, frame.total), frame)
        link.incoming = link.incoming.subarray(frame.total)
        if (value?.frameType === 'data' && value.payload?.type === 'ack') receipts.push(value.payload.receipt)
      }
    })
    upstream.on('data', chunk => {
      client.write(chunk)
      if (link.mode !== 'ws') return
      link.outgoing = Buffer.concat([link.outgoing, chunk])
      if (!link.upgraded) {
        const end = link.outgoing.indexOf('\r\n\r\n')
        if (end < 0) return
        link.outgoing = link.outgoing.subarray(end + 4); link.upgraded = true
      }
      for (;;) {
        const frame = parse(link.outgoing); if (!frame) break
        const value = decode(link.outgoing.subarray(0, frame.total), frame)
        link.outgoing = link.outgoing.subarray(frame.total)
        if (value?.frameType === 'transport.hello' && value.authoritativeCursors?.serverToWorker?.deliveryEpoch) {
          cursor.epoch = value.authoritativeCursors.serverToWorker.deliveryEpoch
          cursor.next = (value.authoritativeCursors.serverToWorker.ackThrough ?? 0) + 1
        }
        if (value?.frameType === 'data' && value.durability === 'durable' && value.deliveryEpoch === cursor.epoch) cursor.next = Math.max(cursor.next, value.directionSeq + 1)
        // Never persist full frames: capability grants and transport credentials can be inside them.
        if (value?.frameType === 'data' && value.payload?.type === 'command') seen.push({ direction: 'toWorker', commandId: value.payload.commandId, kind: value.payload.command?.kind, signed: Boolean(value.payload.authorization?.signature) })
      }
    })
  })
  return { server, seen, receipts, close: async () => { for (const link of links) { link.client.destroy(); link.upstream.destroy() } await new Promise(resolve => server.close(resolve)) } }
}
const eventually = async (read, accept, label, timeout = 30000) => {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    const value = await read()
    if (accept(value)) return value
    await delay(50)
  }
  throw Error(`Timed out: ${label}`)
}

const data = await mkdtemp(join(tmpdir(), 'wemux-team-coordination-'))
const home = join(data, 'worker'), database = join(data, 'server.sqlite')
const email = 'coordination-transport-owner@example.test', password = 'coordination-transport-password'
const app = createWemuxServer({ databasePath: database, administratorEmails: [email], mail: {}, google: {} })
let proxy, worker, step = 'setup'
const checks = []
function launch(args, origin) {
  const isolated = ownedWorkerLaunch(args, origin)
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/worker/src/cli.ts', ...isolated.args], {
    cwd: process.cwd(), env: isolated.env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr })) })
  void done.catch(() => {})
  return { child, done, logs: () => ({ stdout, stderr }) }
}
async function stop() {
  if (!worker) return
  const current = worker; worker = null
  if (current.child.exitCode === null && current.child.signalCode === null) current.child.kill('SIGTERM')
  const timer = setTimeout(() => current.child.kill('SIGKILL'), 10000)
  try { assert.equal((await current.done).code, 0, 'Worker graceful stop') } finally { clearTimeout(timer) }
}
function workerDocument(bucket, id) {
  const db = new DatabaseSync(join(home, 'worker.sqlite'), { readOnly: true })
  try { return db.prepare('SELECT body FROM documents WHERE bucket=? AND id=?').get(bucket, id)?.body ?? null } finally { db.close() }
}
async function raw(origin, session, path, method = 'GET', body) {
  const response = await fetch(`${origin}/api${path}`, {
    method, headers: { cookie: session.cookie, 'content-type': 'application/json', ...(method === 'GET' ? {} : { 'x-csrf-token': session.csrfToken }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, body: await response.json() }
}
try {
  const origin = await app.listen(0)
  proxy = transportProxy(Number(new URL(origin).port))
  await new Promise(resolve => proxy.server.listen(0, '127.0.0.1', resolve))
  const via = `http://127.0.0.1:${proxy.server.address().port}`
  const owner = await seedLocalAccount(app.store, { username: email, email, password, administrator: true })
  const outsiderEmail = 'coordination-transport-outsider@example.test'
  await seedLocalAccount(app.store, { username: outsiderEmail, email: outsiderEmail, password, administrator: false })
  const admin = await login(origin, email, password), outsider = await login(origin, outsiderEmail, password), api = admin.api
  await api('/bootstrap', 'POST', {})
  // Bootstrap owns default-team; enrolled Worker belongs there, so use that Team
  // rather than creating a separate Team that cannot authorize its Worker.
  const team = { id: 'default-team' }
  const token = await api('/enrollment-tokens', 'POST', {})
  const registration = await launch(['register', '--home', home, `--token=${token.token}`, '--name', 'Coordination E2E Worker'], via).done
  assert.equal(registration.code, 0, `register Worker: ${registration.stderr}`)
  const workerId = JSON.parse(registration.stdout).workerId
  const start = () => { worker = launch(['start', '--home', home, '--name', 'Coordination E2E Worker'], via) }
  start()
  await eventually(() => api(`/workers/${workerId}/capabilities`), v => v.capabilities.some(c => c.agentKey === 'test' && c.availability.status === 'available'), 'real Test Agent capability')
  const project = await api('/projects', 'POST', { name: 'Coordination placement project', teamId: team.id, requestId: 'coordination-project' })
  const provision = await api('/workspaces', 'POST', { projectId: project.id, workerId, name: 'Coordination empty workspace', source: 'empty', requestId: 'coordination-workspace' })
  const workspaceId = provision.workspace.id
  await eventually(() => api(`/workspaces/${workspaceId}`), v => v.placements.some(p => p.workerId === workerId && p.status === 'ready'), 'real WS workspace placement')

  step = 'outsider denied before first-send'
  const endpoint = `/teams/${team.id}/coordination/sessions`
  const firstInput = { workerId, workspaceId, agentKey: 'test', modelId: 'test', content: 'coordination-first-echo', requestId: 'coordination-first', commandId: 'coordination-first-command' }
  const denied = await raw(origin, outsider, endpoint, 'POST', firstInput)
  assert.equal(denied.status, 403, 'outsider must not create a coordination conversation')
  assert.equal(denied.body.error?.code, 'team_membership_required')
  assert.equal(JSON.stringify(denied.body).includes(team.id), false)
  assert.equal((await app.store.resources.listSessions()).filter(s => s.projectId === `team:${team.id}`).length, 0, 'outsider request cannot create Team Session')
  checks.push('outsider denied without Team identity disclosure or side effects')

  step = 'Team first-send through real Server API'
  const first = await api(endpoint, 'POST', firstInput)
  assert.ok(first.session?.id && first.messageCommandId && first.messageId, 'first-send must return Session, messageCommandId and messageId')
  const sessionId = first.session.id, taskId = first.session.taskId
  assert.ok(taskId?.startsWith('coordination:'), 'Team Task ID is required')
  const task = await app.store.tasks.get(taskId)
  assert.equal(task?.projectId, `team:${team.id}`, 'Task must be anchored to Team, not Workspace Project')
  assert.deepEqual(task.teamCoordination, { teamId: team.id, ownerId: owner.id, workerId, agentKey: 'test' })
  assert.equal(first.session.projectId, project.id, 'Session executes in the authorized Project Workspace; only Task is Team-anchored')
  assert.equal(first.session.workspaceId, workspaceId)
  assert.equal(first.session.binding.agent.workerId, workerId)
  assert.equal(first.session.binding.agent.agentKey, 'test')
  assert.equal(first.session.binding.modelId, 'test')
  const journal = () => api(`/sessions/${sessionId}/events?fromSeq=1&limit=1000`)
  const completed = (events, messageId, text) => {
    const started = events.find(e => e.payload.kind === 'turn.started' && e.payload.messageId === messageId)
    return Boolean(started && events.some(e => e.payload.kind === 'turn.finished' && e.payload.turnId === started.payload.turnId && e.payload.outcome === 'completed')) && events.filter(e => e.payload.kind === 'assistant.text.delta').map(e => e.payload.text).join('').includes(text)
  }
  await eventually(() => api(`/commands/${first.messageCommandId}`), c => c.status === 'accepted', 'first signed enqueue receipt')
  await eventually(journal, j => completed(j.events, first.messageId, firstInput.content), 'actual Test Agent first echo + completed Turn')
  assert.ok(workerDocument('sessions', sessionId), 'Worker must have persisted real Session')
  await eventually(() => Promise.resolve(proxy.seen.some(f => f.commandId === first.messageCommandId && f.kind === 'session.enqueue' && f.signed)), Boolean, 'first enqueue signed WS observation')
  checks.push('Team Task anchoring, Project Workspace placement, signed WS first-send, real Test Agent echo and turn.finished')

  step = 'idempotent replay and continuation'
  const replay = await api(endpoint, 'POST', firstInput)
  assert.equal(replay.session?.id, sessionId)
  assert.equal(replay.messageId, first.messageId)
  assert.equal(replay.messageCommandId, first.messageCommandId)
  await delay(400)
  const eventsAfterReplay = (await journal()).events
  assert.equal(eventsAfterReplay.filter(e => e.payload.kind === 'message.queued' && e.payload.messageId === first.messageId).length, 1, 'replay must not queue twice')
  const firstTurnIds = eventsAfterReplay.filter(e => e.payload.kind === 'turn.started' && e.payload.messageId === first.messageId).map(e => e.payload.turnId)
  assert.equal(firstTurnIds.length, 1, 'replay must not start twice')
  assert.equal(eventsAfterReplay.filter(e => e.payload.kind === 'turn.finished' && e.payload.turnId === firstTurnIds[0]).length, 1, 'replay must not finish twice')
  const second = await api(`/sessions/${sessionId}/messages`, 'POST', { content: 'coordination-second-echo', commandId: 'coordination-second-command' })
  await eventually(() => api(`/commands/${second.commandId}`), c => c.status === 'accepted', 'second signed enqueue receipt')
  await eventually(journal, j => completed(j.events, second.messageId, 'coordination-second-echo'), 'second Test Agent echo + completed Turn')
  await eventually(() => Promise.resolve(proxy.seen.some(f => f.commandId === second.commandId && f.kind === 'session.enqueue' && f.signed)), Boolean, 'continuation signed WS observation')
  checks.push('first-send replay idempotent; second send completed')

  step = 'same-home Worker restart and restore'
  await stop()
  start()
  await eventually(() => api('/workers'), v => v.items.some(w => w.id === workerId && w.connectionState === 'online'), 'same-home Worker reconnect')
  await eventually(() => api(`/workers/${workerId}/capabilities`), v => v.capabilities.some(c => c.agentKey === 'test' && c.availability.status === 'available'), 'Test Agent available after restart')
  // GET is the Team-scoped list/restore contract; ordinary /sessions listing is
  // Project-filtered and must not silently substitute for Team history.
  const history = await api(`${endpoint}?workerId=${encodeURIComponent(workerId)}&agentKey=test`)
  assert.ok(history.items?.some(item => (item.session?.id ?? item.id) === sessionId), 'Team coordination list must restore original Session')
  const restored = await api(`/sessions/${sessionId}`)
  assert.equal(restored.session?.taskId ?? restored.taskId, taskId)
  assert.ok(completed((await journal()).events, second.messageId, 'coordination-second-echo'), 'journal must survive Worker restart')
  const outsiderList = await raw(origin, outsider, endpoint)
  assert.equal(outsiderList.status, 403, 'outsider cannot list coordination history')
  const outsiderSession = await raw(origin, outsider, `/sessions/${sessionId}`)
  assert.ok([403, 404].includes(outsiderSession.status), 'outsider cannot restore owner Session')
  checks.push('same-home Worker restart; authorized list/restore and journal retained; outsider excluded')
  console.log(JSON.stringify({ status: 'pass', checks }))
} catch (error) {
  // No tokens or unredacted Worker stdout: diagnostics contain only the failed assertion / API response.
  console.error(`Team coordination transport ${step}: ${error.stack ?? error}; completed=${JSON.stringify(checks)}`)
  process.exitCode = 1
} finally {
  try { await stop() } catch (error) { console.error(`Worker shutdown: ${error}`); process.exitCode = 1 }
  try { await proxy?.close() } catch (error) { console.error(`Proxy shutdown: ${error}`); process.exitCode = 1 }
  try { await app.close() } catch (error) { console.error(`Server shutdown: ${error}`); process.exitCode = 1 }
  try { await removeOwnedServerDatabases(database); await rm(data, { recursive: true, force: true }) }
  catch (error) { console.error(`Owned fixture cleanup: ${error}`); process.exitCode = 1 }
}
