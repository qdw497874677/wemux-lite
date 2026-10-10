#!/usr/bin/env node
/** Ticket 02: real authenticated Server + enrolled Worker transport; deterministic Test Agent only. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
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
  const inject = (commandId, command) => {
    const live = links.filter(l => l.mode === 'ws' && l.upgraded && !l.client.destroyed)
    assert.equal(live.length, 1, 'exactly one authenticated Worker WebSocket required for injection')
    assert.ok(cursor.epoch, 'real transport.hello must precede durable injection')
    const frame = { frameType: 'data', durability: 'durable', deliveryEpoch: cursor.epoch, directionSeq: cursor.next++, messageId: randomUUID(), lane: 'command', payloadVersion: '1', expiresAt: null, payload: { type: 'command', commandId, command } }
    const bytes = Buffer.from(JSON.stringify(frame))
    assert.ok(bytes.length < 65536, 'injected frame exceeds two-byte WS length')
    const header = bytes.length < 126 ? Buffer.from([129, bytes.length]) : Buffer.from([129, 126, bytes.length >> 8, bytes.length & 255])
    live[0].client.write(Buffer.concat([header, bytes]))
    return { epoch: frame.deliveryEpoch, seq: frame.directionSeq }
  }
  return { server, inject, seen, receipts, close: async () => { for (const link of links) { link.client.destroy(); link.upstream.destroy() } await new Promise(resolve => server.close(resolve)) } }
}
const eventually = async (read, accept, label, timeout = 30000) => {
  const until = Date.now() + timeout
  while (Date.now() < until) { const value = await read(); if (accept(value)) return value; await delay(50) }
  throw Error(`Timed out: ${label}`)
}
const data = await mkdtemp(join(tmpdir(), 'wemux-ticket02-'))
const home = join(data, 'worker'), database = join(data, 'server.sqlite')
const email = 'ticket02-owner@example.test', password = 'ticket02-owned-password'
const mode = process.env.WEMUX_TICKET02_CASE ?? 'all'
assert.ok(['all', 'positive', 'unsigned', 'revoke'].includes(mode), 'WEMUX_TICKET02_CASE must be all|positive|unsigned|revoke')
const app = createWemuxServer({ databasePath: database, administratorEmails: [email], mail: {}, google: {} })
let proxy, worker, step = 'setup'
const results = []
function launch(args, origin) {
  const isolated = ownedWorkerLaunch(args, origin)
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/worker/src/cli.ts', ...isolated.args], { cwd: process.cwd(), env: isolated.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
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
try {
  const origin = await app.listen(0)
  proxy = transportProxy(Number(new URL(origin).port))
  await new Promise(resolve => proxy.server.listen(0, '127.0.0.1', resolve))
  const via = `http://127.0.0.1:${proxy.server.address().port}`
  const owner = await seedLocalAccount(app.store, { username: email, email, password, administrator: true })
  const admin = await login(origin, email, password), api = admin.api
  await api('/bootstrap', 'POST', {})
  const token = await api('/enrollment-tokens', 'POST', {})
  const registration = await launch(['register', '--home', home, `--token=${token.token}`, '--name', 'Ticket02 Owned Worker'], via).done
  assert.equal(registration.code, 0, `register Worker: ${registration.stderr}`)
  const workerId = JSON.parse(registration.stdout).workerId
  const start = () => { worker = launch(['start', '--home', home, '--name', 'Ticket02 Owned Worker'], via) }
  start()
  await eventually(() => api(`/workers/${workerId}/capabilities`), v => v.capabilities.some(c => c.agentKey === 'test' && c.availability.status === 'available'), 'real Worker Test Agent capability')
  const project = await api('/projects', 'POST', { name: 'Ticket02 实际命令', teamId: 'default-team', requestId: 'ticket02-project' })
  const task = await api(`/projects/${project.id}/tasks`, 'POST', { title: 'Ticket02 会话', requestId: 'ticket02-task' })
  const provision = await api('/workspaces', 'POST', { projectId: project.id, workerId, name: 'Ticket02 空目录', source: 'empty', requestId: 'ticket02-workspace' })
  const workspaceId = provision.workspace.id
  await eventually(() => api(`/workspaces/${workspaceId}`), v => v.placements.some(p => p.workerId === workerId && p.status === 'ready'), 'real provision through WS')
  const created = await api(`/projects/${project.id}/tasks/${task.id}/sessions`, 'POST', { workerId, agentKey: 'test', modelId: 'test', workspaceId, title: 'Ticket02 Task Session', requestId: 'ticket02-session' })
  await eventually(() => api(`/commands/${created.commandId}`), v => v.status === 'accepted', 'real session.create receipt')
  await eventually(() => Promise.resolve(workerDocument('sessions', created.session.id)), Boolean, 'real Worker Session row')
  const id = created.session.id
  const journal = () => api(`/sessions/${id}/events?fromSeq=1&limit=1000`)
  const send = (content, commandId) => api(`/sessions/${id}/messages`, 'POST', { content, commandId })
  const echo = await send('ticket02-positive-echo', 'ticket02-positive')
  await eventually(() => api(`/commands/${echo.commandId}`), v => v.status === 'accepted', 'real enqueue receipt')
  await eventually(journal, v => v.events.some(e => e.payload.kind === 'turn.finished' && e.payload.outcome === 'completed') && v.events.filter(e => e.payload.kind === 'assistant.text.delta').map(e => e.payload.text).join('').includes('ticket02-positive-echo'), 'actual Test Agent echo, not only command ACK')
  for (const commandId of [provision.commandId, created.commandId, echo.commandId]) {
    assert.ok(proxy.seen.some(f => f.commandId === commandId), `missing real WebSocket delivery ${commandId}`)
    const pending = await app.store.commands.getPendingCommand(commandId)
    assert.ok(pending?.command, `missing persisted Server command ${commandId}`)
    // Ticket02 signs actor-bearing session.enqueue, not provisioning or session creation.
    if ((mode === 'all' || mode === 'positive') && commandId === echo.commandId) assert.equal(proxy.seen.find(f => f.commandId === commandId)?.signed, true, `Ticket02 signature missing on delivered Server command ${commandId}`)
  }
  results.push('legitimate Task-bound create/enqueue delivered + completed Test Agent echo' + (mode === 'all' || mode === 'positive' ? ' + signed transport' : ' (signature not asserted in isolated negative mode)'))
  if (mode !== 'revoke') {
  step = 'unsigned durable command rejection'
  // The Ticket02 contract signs actor-bearing enqueue only; provisioning and creation are not signed.
  const commandId = `ticket02-unsigned-enqueue-${randomUUID()}`
  const messageId = `ticket02-forged-message-${randomUUID()}`
  const command = { kind: 'session.enqueue', sessionId: id, message: { messageId, content: 'ticket02-forged-echo', sentByAccountId: owner.id } }
  proxy.inject(commandId, command)
  // The authenticated WS ACK is mandatory even when a rejected command is deliberately
  // not recorded, to avoid poisoning a commandId that the Server may retry signed.
  const receipt = await eventually(() => Promise.resolve(proxy.receipts.find(r => r?.commandId === commandId)), Boolean, 'Worker ACK for unsigned enqueue')
  assert.equal((await journal()).events.some(e => e.payload.kind === 'message.queued' && e.payload.messageId === messageId), false, 'unsigned enqueue produced a queued Worker side effect')
  assert.equal(receipt.status, 'rejected', 'unsigned enqueue must receive a rejected ACK')
  assert.equal(workerDocument('commands', commandId), null, 'rejected unsigned enqueue must not poison Worker command store')
  results.push('unsigned enqueue delivered, rejected by Worker ACK, and not queued')
  }

  if (mode !== 'unsigned') {
  step = 'revoke while queued then same-home restart'
  const memberEmail = 'ticket02-member@example.test'
  const member = await seedLocalAccount(app.store, { username: memberEmail, email: memberEmail, password, administrator: false })
  const memberSession = await login(origin, memberEmail, password)
  const invitation = await api('/teams/default-team/invitations', 'POST', { email: memberEmail })
  await memberSession.api(`/team-invitations/${invitation.token}/accept`, 'POST', {})
  await api(`/projects/${project.id}/grants`, 'POST', { userId: member.id, role: 'contributor' })
  const slow = await send('[test-agent:pause-ms=120000] ticket02-prior', 'ticket02-slow')
  await eventually(journal, v => v.events.some(e => e.payload.kind === 'turn.started' && e.payload.messageId === slow.messageId), 'prior Turn started')
  const priorStart = (await journal()).events.find(e => e.payload.kind === 'turn.started' && e.payload.messageId === slow.messageId)
  assert.ok(priorStart, 'prior Turn was running before revoke')
  const queued = await memberSession.api(`/sessions/${id}/messages`, 'POST', { content: 'ticket02-revoked-marker', commandId: 'ticket02-revoked' })
  await eventually(() => api(`/commands/${queued.commandId}`), v => v.status === 'accepted', 'queued command delivered to Worker')
  assert.ok(proxy.seen.some(f => f.commandId === queued.commandId), 'revoked-actor enqueue must traverse actual WS')
  await eventually(journal, v => v.events.some(e => e.payload.kind === 'message.queued' && e.payload.messageId === queued.messageId), 'queued message reached Worker journal')
  // Stop while the prior Test Agent is still paused; this simulates a same-home
  // crash/recovery without waiting 120s or allowing the queued item to launch.
  assert.equal((await journal()).events.some(e => e.payload.kind === 'turn.finished' && e.payload.turnId === priorStart.payload.turnId), false, 'prior Turn must still be active before restart')
  await stop()
  await api(`/auth/account/users/${member.id}/disable`, 'POST', {})
  start()
  await eventually(() => api('/workers'), v => v.items.some(w => w.id === workerId && w.connectionState === 'online'), 'same-home Worker reconnect')
  // Wait for interrupted prior Turn to settle and for scheduler to advance. Test Agent has no paid calls.
  await eventually(journal, v => v.events.some(e => e.payload.kind === 'turn.finished' && e.payload.turnId === priorStart.payload.turnId), 'interrupted prior Turn settled')
  await delay(1500)
  const events = (await journal()).events
  assert.equal(events.filter(e => e.payload.kind === 'message.queued' && e.payload.messageId === queued.messageId).length, 1, 'queued item really persisted')
  assert.equal(events.filter(e => e.payload.kind === 'turn.started' && e.payload.messageId === queued.messageId).length, 0, 'revoked actor must not launch a second Turn after restart')
  assert.equal(events.filter(e => e.payload.kind === 'assistant.text.delta').map(e => e.payload.text).join('').includes('ticket02-revoked-marker'), false, 'revoked Agent must not echo')
  results.push('revoked queued actor not launched on same-home recovery')
  }
  console.log(JSON.stringify({ status: 'pass', checks: results }))
} catch (error) {
  console.error(`Ticket02 ${step}: ${error.stack ?? error}; completed=${JSON.stringify(results)}; worker=${JSON.stringify(worker?.logs())}`)
  process.exitCode = 1
} finally {
  try { await stop() } catch (error) { console.error(`Worker shutdown: ${error}`); process.exitCode = 1 }
  try { await proxy?.close() } catch (error) { console.error(`Proxy shutdown: ${error}`); process.exitCode = 1 }
  await app.close()
  await removeOwnedServerDatabases(database)
  await rm(data, { recursive: true, force: true })
}
