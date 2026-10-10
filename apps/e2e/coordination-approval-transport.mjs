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
  const links = [], seen = [], receipts = [], transportAcks = [], cursor = { epoch: null, next: 1 }
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
        if (value?.frameType === 'transport.ack') transportAcks.push({ epoch: value.deliveryEpoch, through: value.ackThrough })
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
        if (value?.frameType === 'data' && value.payload?.type === 'command') seen.push({ direction: 'toWorker', commandId: value.payload.commandId, kind: value.payload.command?.kind, signed: Boolean(value.payload.authorization?.signature), epoch: value.deliveryEpoch, seq: value.directionSeq })
      }
    })
  })
  const inject = (commandId, command, authorization) => {
    const live = links.filter(l => l.mode === 'ws' && l.upgraded && !l.client.destroyed)
    assert.equal(live.length, 1, 'exactly one authenticated Worker WebSocket required for injection')
    assert.ok(cursor.epoch, 'real transport.hello must precede durable injection')
    const frame = { frameType: 'data', durability: 'durable', deliveryEpoch: cursor.epoch, directionSeq: cursor.next++, messageId: randomUUID(), lane: 'command', payloadVersion: '1', expiresAt: null, payload: { type: 'command', commandId, command, ...(authorization ? { authorization } : {}) } }
    const bytes = Buffer.from(JSON.stringify(frame))
    assert.ok(bytes.length < 65536, 'injected frame exceeds two-byte WS length')
    const header = bytes.length < 126 ? Buffer.from([129, bytes.length]) : Buffer.from([129, 126, bytes.length >> 8, bytes.length & 255])
    live[0].client.write(Buffer.concat([header, bytes]))
    return { epoch: frame.deliveryEpoch, seq: frame.directionSeq }
  }
  return { server, inject, seen, receipts, transportAcks, connectionCount: () => links.filter(l => l.mode === 'ws').length, close: async () => { for (const link of links) { link.client.destroy(); link.upstream.destroy() } await new Promise(resolve => server.close(resolve)) } }
}
const eventually = async (read, accept, label, timeout = 30000) => {
  const until = Date.now() + timeout
  while (Date.now() < until) { const value = await read(); if (accept(value)) return value; await delay(50) }
  throw Error(`Timed out: ${label}`)
}
const data = await mkdtemp(join(tmpdir(), 'wemux-ticket02-'))
const home = join(data, 'worker'), database = join(data, 'server.sqlite')
const email = 'ticket02-owner@example.test', password = 'ticket02-owned-password'
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
  step = 'native approval requested by healthy Test Agent Turn'
  const invocation = await send('[test-agent:approval] ticket02-native', 'ticket02-native-turn')
  await eventually(() => api(`/commands/${invocation.commandId}`), v => v.status === 'accepted', 'signed enqueue delivery')
  assert.ok(proxy.seen.some(f => f.commandId === invocation.commandId && f.signed), 'signed enqueue traversed real WS')
  await eventually(journal, v => v.events.some(e => e.payload.kind === 'approval.requested' && e.payload.turnId), 'native approval request')
  const requested = (await journal()).events.find(e => e.payload.kind === 'approval.requested')
  const { approvalId, turnId } = requested.payload
  assert.ok(approvalId && turnId)
  step = 'revoked actor denied before approval admission'
  const memberEmail = 'ticket02-revoked-approver@example.test'
  const member = await seedLocalAccount(app.store, { username: memberEmail, email: memberEmail, password, administrator: false })
  const memberSession = await login(origin, memberEmail, password)
  const invitation = await api('/teams/default-team/invitations', 'POST', { email: memberEmail })
  await memberSession.api(`/team-invitations/${invitation.token}/accept`, 'POST', {})
  await api(`/projects/${project.id}/grants`, 'POST', { userId: member.id, role: 'contributor' })
  await api(`/auth/account/users/${member.id}/disable`, 'POST', {})
  const revokedId = `ticket02-revoked-approval-${randomUUID()}`
  await assert.rejects(memberSession.api(`/sessions/${id}/runtime/approvals/${encodeURIComponent(approvalId)}`, 'POST', { commandId: revokedId, turnId, decision: 'approve' }), /401|403/)
  assert.equal(await app.store.commands.getPendingCommand(revokedId), null, 'revoked actor created no approval command')
  results.push('revoked actor denied at admission without persisted approval')
  step = 'transient Worker authorization failure on a healthy WS'
  const decisionId = 'ticket02-native-approval'
  const realAuthorize = app.service.authorizeEnqueueLaunch.bind(app.service)
  const signer = app.service.commandSigning
  assert.ok(signer, 'Server signing identity required')
  const realSign = signer.sign.bind(signer)
  let denied = 0, recovered = false
  app.service.authorizeEnqueueLaunch = async (target, commandId) => {
    if (commandId === decisionId && !recovered && proxy.seen.some(f => f.commandId === decisionId)) { denied++; return { allowed: false } }
    return realAuthorize(target, commandId)
  }
  signer.sign = claims => realSign(claims.commandId === decisionId ? { ...claims, expiresAt: new Date(Date.now() + 1_000).toISOString() } : claims)
  try {
    await api(`/sessions/${id}/runtime/approvals/${encodeURIComponent(approvalId)}`, 'POST', { commandId: decisionId, turnId, decision: 'approve' })
    signer.sign = realSign
    const first = await eventually(() => Promise.resolve(proxy.seen.find(f => f.commandId === decisionId && f.signed)), Boolean, 'signed approval traversed real WS')
    await eventually(() => Promise.resolve(proxy.transportAcks.some(a => a.epoch === first.epoch && a.through >= first.seq) && denied > 0), Boolean, 'transport ACK despite denied application authorization')
    assert.equal(proxy.receipts.some(r => r?.commandId === decisionId), false, 'temporary denial cannot issue terminal application receipt')
    assert.equal(workerDocument('commands', decisionId), null, 'temporary denial cannot persist or invoke approval')
    assert.equal((await api(`/commands/${decisionId}`)).status, 'pending')
    // Initial serialized assertion expires after the transport ACK. The retry must
    // mint a fresh envelope, not replay its expired assertion or skip the sequence.
    await delay(1_200)
    assert.ok(Date.parse((await app.store.commands.getPendingCommand(decisionId)).authorization.claims.expiresAt) <= Date.now())
    recovered = true
    const connectionCount = proxy.connectionCount()
    await eventually(() => api(`/commands/${decisionId}`), v => v.status === 'accepted', 'same-connection terminal approval receipt', 15000)
    assert.equal(proxy.connectionCount(), connectionCount, 'same healthy WebSocket throughout retry')
    const attempts = proxy.seen.filter(f => f.commandId === decisionId && f.signed)
    assert.ok(attempts.length >= 2 && attempts.some(f => f.seq > first.seq && f.epoch === first.epoch), 'fresh signed envelope after transport ACK with increasing directionSeq')
    assert.ok(Date.parse((await app.store.commands.getPendingCommand(decisionId)).authorization.claims.expiresAt) > Date.now(), 'persisted authorization was refreshed after serialized expiry')
    assert.ok(denied >= 1, 'transient denied launch occurred before recovery')
  } finally { signer.sign = realSign; app.service.authorizeEnqueueLaunch = realAuthorize }
  step = 'authorized native approval after recovery'
  assert.equal((await app.store.commands.getPendingCommand(decisionId))?.authorization?.claims.kind, 'runtime.approval.resolve')
  await eventually(journal, v => v.events.some(e => e.payload.kind === 'turn.finished' && e.payload.turnId === turnId && e.payload.outcome === 'completed') && v.events.filter(e => e.payload.kind === 'assistant.text.delta').map(e => e.payload.text).join('').includes('Native approval: approve'), 'native adapter approval effect and finished Turn')
  assert.equal((await journal()).events.filter(e => e.payload.kind === 'approval.resolved' && e.payload.approvalId === approvalId).length, 1, 'native decision recorded exactly once')
  // Exact commandId receipt replay must not invoke the native adapter again.
  await api(`/sessions/${id}/runtime/approvals/${encodeURIComponent(approvalId)}`, 'POST', { commandId: decisionId, turnId, decision: 'approve' })
  assert.equal((await journal()).events.filter(e => e.payload.kind === 'approval.resolved' && e.payload.approvalId === approvalId).length, 1)
  assert.equal((await journal()).events.filter(e => e.payload.kind === 'turn.finished' && e.payload.turnId === turnId).length, 1)
  results.push('healthy WS transient denial → transport ACK → serialized expiry → fresh signed replay → one native approval and terminal application receipt')
  step = 'unsigned approval replay'
  const forged = `ticket02-unsigned-approval-${randomUUID()}`
  proxy.inject(forged, { kind: 'runtime.approval.resolve', sessionId: id, turnId, approvalId, decision: 'approve', decidedByAccountId: owner.id })
  assert.equal((await eventually(() => Promise.resolve(proxy.receipts.find(r => r?.commandId === forged)), Boolean, 'unsigned approval ACK')).status, 'rejected')
  assert.equal(workerDocument('commands', forged), null)
  results.push('unsigned durable approval rejected without command record')
  step = 'expired and tampered assertions rejected before native invocation'
  const original = (await app.store.commands.getPendingCommand(decisionId)).authorization
  const signing = app.service.commandSigning
  assert.ok(original && signing, 'real persisted signing assertion and signer required')
  for (const variant of ['expired', 'tampered']) {
    const forgedId = `ticket02-${variant}-${randomUUID()}`
    const forgedCommand = { kind: 'runtime.approval.resolve', sessionId: id, turnId, approvalId, decision: 'approve', decidedByAccountId: owner.id }
    const { createHash } = await import('node:crypto')
    const claims = { ...original.claims, commandId: forgedId, commandDigest: createHash('sha256').update(JSON.stringify(forgedCommand)).digest('hex'), issuedAt: new Date(Date.now() - 120_000).toISOString(), expiresAt: new Date(Date.now() - 60_000).toISOString() }
    const expired = signing.sign(claims)
    const assertion = variant === 'tampered' ? { ...expired, claims: { ...expired.claims, expiresAt: new Date(Date.now() + 60_000).toISOString() } } : expired
    const injected = proxy.inject(forgedId, forgedCommand, assertion)
    await eventually(() => Promise.resolve(proxy.transportAcks.some(a => a.epoch === injected.epoch && a.through >= injected.seq)), Boolean, `${variant} transport ACK`)
    await delay(150)
    assert.equal(workerDocument('commands', forgedId), null, `${variant} approval never persisted`)
  }
  assert.equal((await journal()).events.filter(e => e.payload.kind === 'approval.resolved' && e.payload.approvalId === approvalId).length, 1)
  results.push('expired and tampered assertions rejected without native replay')
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
