import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { WebSocket, type WebSocketServer } from 'ws'
import type { WorkerId } from '@wemux/domain'
import { FS_WRITE_ADMISSION_V1, type FileWriteResultPayload, type ServerToWorkerFrame, type WorkerHelloFrame } from '@wemux/wire-protocol'
import { computeFileWriteResultDigest } from '@wemux/wire-protocol/file-admission-node'
import { AuthenticationService, hashSecret } from '../application/auth.ts'
import { AdministratorDirectory } from '../application/administrator-directory.ts'
import { Notifications } from '../application/notifications.ts'
import { ServerService, now } from '../application/server-service.ts'
import { WorkerService } from '../application/worker-service.ts'
import { TaskService } from '../application/task-service.ts'
import { SessionAccessService } from '../application/session-access-service.ts'
import { ProjectAccessService } from '../application/project-access-service.ts'
import type { FileWriteAdmission } from '../application/ports/file-write-admission.ts'
import { SqliteServerStore } from '../storage/sqlite/store.ts'
import { WorkerGateway } from '../worker-ws/gateway.ts'
import { ServerTransportStore } from '../worker-ws/transport-store.ts'
import type { ServerFileResultIngress } from '../worker-ws/file-result-ingress.ts'

const worker = 'worker' as WorkerId
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
const hello = (id = worker, features: string[] = [FS_WRITE_ADMISSION_V1]): WorkerHelloFrame => ({
  frameType: 'transport.hello', side: 'worker', workerId: id, name: 'Fixture', workerVersion: 'test', platform: 'linux', architecture: 'x64',
  transport: { supportedMajors: [2], preferredMinorByMajor: { '2': 0 } }, adkProfiles: ['wemux.adk.v1'], features,
  resume: { logicalConnectionId: null, workerToServer: { deliveryEpoch: 'worker-epoch', ackThrough: 0 }, serverToWorker: null },
})
const result = (a: FileWriteAdmission, outcome: 'succeeded' | 'unknown' = 'succeeded'): FileWriteResultPayload => {
  const value = { type: 'fs.write.result' as const, requestId: a.admissionId, sessionId: a.sessionId, workerId: a.workerId, operation: a.operation,
    fingerprintVersion: a.fingerprintVersion, fingerprint: a.fingerprint, resultVersion: 1 as const, outcome,
    resultJson: JSON.stringify(outcome === 'succeeded' ? { ok: true, operation: 'write', subpath: a.subpath, size: 1 } : { ok: false, operation: 'write', effect: 'uncertain', error: 'uncertain' }) }
  return { ...value, resultDigest: computeFileWriteResultDigest(value) }
}
const envelope = (payload: FileWriteResultPayload, seq = 1, messageId = randomUUID()) => ({ frameType: 'data' as const, durability: 'durable' as const, deliveryEpoch: 'worker-epoch', directionSeq: seq,
  messageId: messageId as never, lane: 'control' as const, payloadVersion: 'wemux.worker.payload.v1', expiresAt: null, payload })
const isAck = (f: ServerToWorkerFrame) => f.frameType === 'data' && f.payload.type === 'fs.write.result.ack'
function assertTemporary(frame: ServerToWorkerFrame) {
  assert.equal(frame.frameType, 'transport.error')
  if (frame.frameType !== 'transport.error') throw new Error('expected error')
  assert.equal(frame.retryable, true)
  assert.equal(frame.code, 'temporary-unavailable')
  assert.equal(frame.message, 'File result storage temporarily unavailable')
}
function assertPermanent(frame: ServerToWorkerFrame) {
  assert.equal(frame.frameType, 'transport.error')
  if (frame.frameType !== 'transport.error') throw new Error('expected error')
  assert.equal(frame.retryable, false)
  assert.notEqual(frame.code, 'temporary-unavailable')
}
class Peer {
  readonly frames: ServerToWorkerFrame[] = []
  private readonly waiters = new Set<() => void>()
  constructor(readonly ws: WebSocket) { ws.on('message', data => { this.frames.push(JSON.parse(data.toString())); for (const notify of this.waiters) notify() }) }
  raw(frame: unknown) { this.ws.send(JSON.stringify(frame)) }
  wait(predicate: (f: ServerToWorkerFrame) => boolean, start = 0): Promise<ServerToWorkerFrame> {
    const found = this.frames.slice(start).find(predicate)
    if (found) return Promise.resolve(found)
    return new Promise(resolve => { const notify = () => { const frame = this.frames.slice(start).find(predicate); if (frame) { this.waiters.delete(notify); resolve(frame) } }; this.waiters.add(notify) })
  }
  async checkpoint() { const nonce = randomUUID(); this.raw({ frameType: 'transport.ping', nonce, sentAt: now() }); await this.wait(f => f.frameType === 'transport.pong' && f.nonce === nonce) }
  async close() { if (this.ws.readyState === WebSocket.CLOSED) return; const done = once(this.ws, 'close'); this.ws.close(); await done }
}
async function fixture(optIn = true) {
  const directory = mkdtempSync(join(tmpdir(), 'server-result-ingress-')), appPath = join(directory, 'app.sqlite'), transportPath = join(directory, 'transport.sqlite')
  let store = new SqliteServerStore(appPath), transport = new ServerTransportStore(transportPath)
  const observer = new DatabaseSync(appPath), transportObserver = new DatabaseSync(transportPath), notifications = new Notifications()
  const owner = 'owner' as never, teamId = 'team' as never, projectId = 'project' as never, sessionId = 'session' as never
  await store.transaction(async tx => {
    await tx.identity.saveTeam({ id: teamId, name: 'Fixture', createdAt: now() })
    await tx.identity.saveUser({ id: owner, username: 'owner', email: null, createdAt: now() })
    await tx.identity.saveMembership({ teamId, userId: owner, role: 'owner', joinedAt: now() })
    await tx.resources.saveProject({ id: projectId, teamId, ownerId: owner, name: 'Fixture', shareScope: 'team', deletedAt: null })
    for (const id of [worker, 'other' as WorkerId]) {
      await tx.resources.saveWorker({ id, teamId, ownerId: owner, name: 'Fixture', shareScope: 'owner-only', connectionState: 'offline', version: null, platform: null, capabilities: [], lastSeenAt: null })
      await tx.identity.saveWorkerCredential({ id: `credential-${id}` as never, workerId: id, credentialHash: hashSecret(`synthetic-${id}`), createdAt: now(), revokedAt: null })
    }
  })
  const task = await new TaskService(store).create(projectId, { title: 'Fixture' }, { actor: owner, requestId: 'task' })
  await store.transaction(tx => tx.resources.saveSession({ id: sessionId, projectId, taskId: task.id, runId: null, ownerId: owner, workspaceId: 'workspace' as never, title: 'Fixture', shareScope: 'project', runtimeState: 'idle', deletedAt: null,
    binding: { workspaceId: 'workspace' as never, agent: { workerId: worker, agentKey: 'agent' as never }, modelId: null } }))
  const service = () => new ServerService(store, notifications, undefined, undefined, undefined, new SessionAccessService(store, new ProjectAccessService(store)))
  const a = await service().admitFileWrite(sessionId, owner, { requestId: 'client', subpath: 'folder/file.txt', base64Content: 'YQ==' })
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  let calls = 0
  const ingress: ServerFileResultIngress = { admissions: { get: id => store.fileWrites.get(id) }, receiveFileWriteResult: async (id, input) => { calls++; return service().receiveFileWriteResult(id, input) } }
  const makeGateway = () => new WorkerGateway(server, new AuthenticationService(store, new AdministratorDirectory(store.identity)), new WorkerService(store, notifications), notifications, transport, optIn ? ingress : undefined)
  let gateway = makeGateway()
  const peers: Peer[] = []
  const connect = async (features = [FS_WRITE_ADMISSION_V1] as string[], id = worker, handshake = true) => {
    const p = new Peer(new WebSocket(`ws://127.0.0.1:${port}/worker/ws`, { headers: { authorization: `Bearer synthetic-${id}` } })); peers.push(p)
    await once(p.ws, 'open')
    if (handshake) { p.raw(hello(id, features)); await p.wait(f => f.frameType === 'transport.hello' || f.frameType === 'transport.error') }
    return p
  }
  return { a, ingress, observer, transportObserver, get calls() { return calls }, get store() { return store }, get transport() { return transport }, get gateway() { return gateway }, connect,
    socket() { return [...(gateway as unknown as { wss: WebSocketServer }).wss.clients].find(ws => ws.readyState === WebSocket.OPEN)! },
    async reopen() { await gateway.close(); store.close(); store = new SqliteServerStore(appPath); transport = new ServerTransportStore(transportPath); gateway = makeGateway() },
    async close() { for (const p of peers) await p.close(); await gateway.close(); await new Promise<void>(resolve => server.close(() => resolve())); observer.close(); transportObserver.close(); store.close(); rmSync(directory, { recursive: true, force: true }) } }
}
const retained = (f: Awaited<ReturnType<typeof fixture>>) => f.observer.prepare("SELECT data FROM records WHERE kind='file-write-result'").all()
const inbox = (f: Awaited<ReturnType<typeof fixture>>) => f.transportObserver.prepare('SELECT * FROM transport_inbox').all()

test('real authenticated ingress commits before durable ACK, no waiter; exact duplicates dedup outstanding ACK and ACK bursts do not re-enqueue', { timeout: 10000 }, async t => {
  const f = await fixture(); t.after(() => f.close()); const p = await f.connect(), value = result(f.a)
  const original = f.transport.enqueueFileResultAck.bind(f.transport); let enqueues = 0
  f.transport.enqueueFileResultAck = (id, ack, r) => { assert.deepEqual(JSON.parse(String(retained(f)[0]!.data)), value); enqueues++; original(id, ack, r) }
  p.raw(envelope(value)); const first = await p.wait(isAck); assert.equal(first.frameType, 'data'); await p.checkpoint()
  assert.equal(f.calls, 1); assert.equal(retained(f).length, 1)
  p.raw(envelope(value, 2)); await p.checkpoint(); assert.equal(f.calls, 2); assert.equal(f.transport.pending(worker, 100).length, 1)
  assert.deepEqual(await f.store.fileWrites.getIntent(f.a.admissionId), { admissionId: f.a.admissionId, state: 'held' })
  assert.deepEqual(await f.store.commands.listDeliverable(worker, 100), [])
  if (first.frameType !== 'data' || first.durability !== 'durable') throw new Error('expected durable ACK')
  for (let i = 0; i < 100; i++) p.raw({ frameType: 'transport.ack', deliveryEpoch: first.deliveryEpoch, ackThrough: first.directionSeq })
  await p.checkpoint(); assert.equal(enqueues, 2); assert.deepEqual(f.transport.pending(worker, 100), [])
  p.raw(envelope(value, 3)); await p.checkpoint(); const next = f.transport.pending(worker, 100)[0]!
  assert.equal(next.directionSeq, first.directionSeq + 1); assert.deepEqual(next.payload, first.payload)
})

for (const [name, optIn, features] of [['default off', false, [FS_WRITE_ADMISSION_V1]], ['one-sided local', true, []], ['legacy default', false, []]] as const) {
  test(`${name}: legacy hello preserved, file ingress denied`, { timeout: 10000 }, async t => {
    const f = await fixture(optIn); t.after(() => f.close()); const p = await f.connect([...features])
    assert.deepEqual(p.frames[0]!.frameType === 'transport.hello' && p.frames[0].enabledFeatures, ['durable-ack', 'bounded-replay'])
    await p.checkpoint(); p.raw(envelope(result(f.a))); await p.wait(x => x.frameType === 'transport.error')
    assert.equal(f.calls, 0); assert.deepEqual(retained(f), []); assert.deepEqual(inbox(f), [])
    await assert.rejects(f.gateway.send(worker, { ...result(f.a), type: 'fs.write.result.ack' } as never), /internal result ingress/)
    assert.throws(() => f.transport.enqueue(worker, { ...result(f.a), type: 'fs.write.result.ack' } as never), /internal result ingress/)
  })
}

for (const name of ['digest', 'malformed', 'direction', 'volatile', 'other-worker', 'prehello', 'identity', 'binary'] as const) {
  test(`rejects ${name} without retention/application ACK`, { timeout: 10000 }, async t => {
    const f = await fixture(); t.after(() => f.close())
    const p = await f.connect(undefined, name === 'other-worker' ? 'other' as WorkerId : worker, name !== 'prehello')
    const frame = envelope(result(f.a))
    let input: unknown = frame
    if (name === 'digest') input = { ...frame, payload: { ...frame.payload, resultDigest: '0'.repeat(64) } }
    if (name === 'malformed') input = { ...frame, payload: { ...frame.payload, extra: true } }
    if (name === 'direction') input = { ...frame, payload: { ...frame.payload, type: 'fs.write.result.ack' } }
    if (name === 'volatile') input = { frameType: 'data', durability: 'volatile', lane: 'realtime', payloadVersion: frame.payloadVersion, payload: frame.payload }
    if (name === 'identity') { const value = { ...frame.payload, sessionId: 'other-session' as never }; input = { ...frame, payload: { ...value, resultDigest: computeFileWriteResultDigest(value) } } }
    if (name === 'binary') p.ws.send(Buffer.from(JSON.stringify(input))); else p.raw(input)
    assertPermanent(await p.wait(x => x.frameType === 'transport.error')); assert.equal(f.calls, 0); assert.deepEqual(retained(f), []); assert.deepEqual(inbox(f), []); assert.equal(p.frames.some(isAck), false)
  })
}

test('changed valid result is rejected on new and original accepted sequences, never overwrites unknown', { timeout: 10000 }, async t => {
  const f = await fixture(); t.after(() => f.close()); const p = await f.connect(), original = envelope(result(f.a, 'unknown'))
  p.raw(original); await p.wait(isAck); const before = retained(f)
  p.raw({ ...original, payload: result(f.a) }); assertPermanent(await p.wait(x => x.frameType === 'transport.error')); assert.deepEqual(retained(f), before)
  await p.close(); const q = await f.connect(); q.raw(envelope(result(f.a), 2)); assertPermanent(await q.wait(x => x.frameType === 'transport.error')); assert.deepEqual(retained(f), before)
})

for (const changed of [false, true]) test(`transport-only gap replays original identity across reopen; first application commit authority (changed=${changed})`, { timeout: 10000 }, async t => {
  const f = await fixture(); t.after(() => f.close()); const p = await f.connect(), frame = envelope(result(f.a))
  const receive = f.ingress.receiveFileWriteResult
  f.ingress.receiveFileWriteResult = async () => { throw new Error('injected pre-retention failure') }
  p.raw(frame); await p.wait(x => x.frameType === 'transport.error'); assert.equal(inbox(f).length, 1); assert.deepEqual(retained(f), []); assert.equal(p.frames.some(isAck), false)
  f.ingress.receiveFileWriteResult = receive; await f.reopen(); const q = await f.connect()
  const replay = changed ? { ...frame, payload: result(f.a, 'unknown') } : frame
  q.raw(replay); await q.wait(isAck); assert.deepEqual(await f.store.fileWrites.getResult(f.a.admissionId), replay.payload)
  // There is deliberately no transport payload ledger: same messageId does not prove pre-gap byte equality.
  assert.equal(inbox(f).length, 1)
})

for (const mismatch of ['messageId', 'missing-row', 'epoch', 'worker'] as const) test(`old-sequence replay requires exact inbox ${mismatch}`, { timeout: 10000 }, async t => {
  const f = await fixture(); t.after(() => f.close()); const p = await f.connect(), frame = envelope(result(f.a))
  f.ingress.receiveFileWriteResult = async () => { throw new Error('gap') }
  p.raw(frame); await p.wait(x => x.frameType === 'transport.error'); await p.close()
  if (mismatch === 'missing-row') f.transportObserver.exec('DELETE FROM transport_inbox')
  const q = await f.connect(undefined, mismatch === 'worker' ? 'other' as WorkerId : worker)
  q.raw({ ...frame, ...(mismatch === 'messageId' ? { messageId: randomUUID() } : {}), ...(mismatch === 'epoch' ? { deliveryEpoch: 'wrong-epoch' } : {}) })
  const error = await q.wait(x => x.frameType === 'transport.error'); assertPermanent(error)
  assert.match(error.frameType === 'transport.error' ? error.message : '', mismatch === 'worker' ? /Worker mismatch/ : mismatch === 'epoch' ? /epoch/ : /integrity mismatch/)
  assert.deepEqual(retained(f), []); assert.equal(q.frames.some(isAck), false)
})

for (const receiptFirst of ['transport', 'application'] as const) test(`${receiptFirst} receipt first: disconnect/reopen exact ACK replay and bounded result retry`, { timeout: 10000 }, async t => {
  const f = await fixture(); t.after(() => f.close()); const p = await f.connect(), frame = envelope(result(f.a))
  p.raw(frame); const ack = await p.wait(isAck); await p.checkpoint()
  const outstanding = f.transport.pending(worker, 100)[0]!
  if (receiptFirst === 'transport') { p.raw({ frameType: 'transport.ack', deliveryEpoch: outstanding.deliveryEpoch, ackThrough: outstanding.directionSeq }); await p.checkpoint() }
  await f.reopen(); const q = await f.connect(); await q.checkpoint()
  if (receiptFirst === 'application') { assert.deepEqual(await q.wait(isAck), ack); assert.deepEqual(f.transport.pending(worker, 100)[0], outstanding) }
  else { assert.equal(q.frames.some(isAck), false); q.raw(frame); await q.wait(isAck); assert.equal(f.transport.pending(worker, 100)[0]!.directionSeq, outstanding.directionSeq + 1) }
  assert.deepEqual(await f.store.fileWrites.getResult(f.a.admissionId), frame.payload)
})

test('downgrade refuses hello without leaking/discarding/skipping retained ACK rows', { timeout: 10000 }, async t => {
  const f = await fixture(); t.after(() => f.close()); const p = await f.connect(); p.raw(envelope(result(f.a))); await p.wait(isAck)
  const before = f.transport.pending(worker, 100); await f.reopen(); const q = await f.connect([])
  const error = await q.wait(x => x.frameType === 'transport.error')
  assert.match(error.frameType === 'transport.error' ? error.message : '', /needs attention/)
  await once(q.ws, 'close'); assert.equal(q.frames.some(x => x.frameType === 'data' || x.frameType === 'transport.hello'), false); assert.deepEqual(f.transport.pending(worker, 100), before)
})

test('receiver Buffer snapshot precedes queue, and stale generation cannot enqueue/disclose completed ACK', { timeout: 10000 }, async t => {
  const f = await fixture(); t.after(() => f.close()); const p = await f.connect(), entered = deferred(), release = deferred()
  t.after(() => release.resolve())
  const receive = f.ingress.receiveFileWriteResult
  f.ingress.receiveFileWriteResult = async (id, input) => { entered.resolve(); await release.promise; return receive(id, input) }
  const first = envelope(result(f.a)), second = envelope(result(f.a), 2)
  p.raw(first); await entered.promise
  // Directly exercise the actual connected Server socket listener, not sender serialization.
  const buffer = Buffer.from(JSON.stringify(second)); f.socket().emit('message', buffer, false); buffer.fill(0x20)
  release.resolve(); await p.checkpoint(); assert.equal(f.calls, 2)
  const paused = deferred(), done = deferred(); t.after(() => done.resolve())
  f.ingress.receiveFileWriteResult = async (id, input) => { const ack = await receive(id, input); paused.resolve(); await done.promise; return ack }
  let staleEnqueues = 0
  const enqueue = f.transport.enqueueFileResultAck.bind(f.transport)
  f.transport.enqueueFileResultAck = (...args) => { staleEnqueues++; enqueue(...args) }
  const oldRows = f.transport.pending(worker, 100); p.raw(envelope(result(f.a), 3)); await paused.promise
  const q = await f.connect(); await q.checkpoint(); const before = q.frames.filter(isAck).length
  done.resolve(); await once(p.ws, 'close'); await q.checkpoint()
  assert.deepEqual(f.transport.pending(worker, 100), oldRows); assert.equal(q.frames.filter(isAck).length, before); assert.equal(staleEnqueues, 0)
})

for (const failure of ['enqueue', 'send'] as const) test(`${failure} failure leaves committed result retryable via original frame/outbox`, { timeout: 10000 }, async t => {
  const f = await fixture(); t.after(() => f.close()); const p = await f.connect(), frame = envelope(result(f.a))
  if (failure === 'enqueue') {
    f.transportObserver.exec("CREATE TRIGGER fail_ack BEFORE INSERT ON transport_outbox BEGIN SELECT RAISE(ABORT,'private enqueue failure'); END")
    p.raw(frame); assertTemporary(await p.wait(x => x.frameType === 'transport.error')); assert.equal(retained(f).length, 1); assert.deepEqual(f.transport.pending(worker, 100), [])
    f.transportObserver.exec('DROP TRIGGER fail_ack')
  } else {
    const socket = f.socket(), send = socket.send.bind(socket)
    socket.send = ((data: string, callback?: (error?: Error) => void) => {
      if (isAck(JSON.parse(String(data)))) { callback?.(new Error('injected socket send callback failure')); return }
      send(data, callback)
    }) as typeof socket.send
    p.raw(frame); await once(p.ws, 'close'); assert.equal(retained(f).length, 1); assert.equal(f.transport.pending(worker, 100).length, 1)
  }
  await f.reopen(); const q = await f.connect(); q.raw(frame); await q.wait(isAck); assert.deepEqual(await f.store.fileWrites.getResult(f.a.admissionId), frame.payload); assert.equal(f.transport.pending(worker, 100).length, 1)
})

test('gateway shutdown awaits active receiver commit without publishing stale ACK', { timeout: 10000 }, async t => {
  const f = await fixture(); t.after(() => f.close()); const p = await f.connect(), entered = deferred(), release = deferred(); t.after(() => release.resolve())
  const receive = f.ingress.receiveFileWriteResult
  f.ingress.receiveFileWriteResult = async (id, input) => { entered.resolve(); await release.promise; return receive(id, input) }
  p.raw(envelope(result(f.a))); await entered.promise
  let closed = false; const closing = f.gateway.close().then(() => { closed = true })
  await once(p.ws, 'close'); assert.equal(closed, false); release.resolve(); await closing
  assert.equal(retained(f).length, 1); assert.equal(p.frames.some(isAck), false)
  // reopen also reconstructs the closed transport; avoid a second close of the old gateway.
  f.gateway.close = async () => {}
  await f.reopen(); const q = await f.connect(); q.raw(envelope(result(f.a), 2)); await q.wait(isAck)
})

test('default legacy pre-hello negotiation rejection retains original error code', { timeout: 10000 }, async t => {
  const f = await fixture(false); t.after(() => f.close()); const p = await f.connect([], worker, false)
  p.raw({ ...hello(worker, []), transport: { supportedMajors: [99], preferredMinorByMajor: { '99': 0 } } })
  const error = await p.wait(x => x.frameType === 'transport.error'); assert.equal(error.frameType === 'transport.error' && error.code, 'unsupported-transport-major'); assert.equal(p.frames.some(x => x.frameType === 'transport.hello'), false)
})

for (const failure of ['rollback', 'commit'] as const) test(`real application ${failure} after transport acceptance is retryable without ACK and exact replay converges`, { timeout: 10000 }, async t => {
  const f = await fixture(); t.after(() => f.close()); const p = await f.connect(), frame = envelope(result(f.a))
  if (failure === 'rollback') f.observer.exec("CREATE TRIGGER fail_result BEFORE INSERT ON records WHEN NEW.kind='file-write-result' BEGIN SELECT RAISE(ABORT,'private result failure'); END")
  else {
    f.observer.exec('CREATE TABLE result_commit_probe (parent INTEGER REFERENCES result_commit_probe(id) DEFERRABLE INITIALLY DEFERRED, id INTEGER PRIMARY KEY)')
    f.observer.exec("CREATE TRIGGER fail_result AFTER INSERT ON records WHEN NEW.kind='file-write-result' BEGIN INSERT INTO result_commit_probe(parent) VALUES(999); END")
  }
  p.raw(frame); assertTemporary(await p.wait(x => x.frameType === 'transport.error'))
  assert.equal(inbox(f).length, 1); assert.deepEqual(retained(f), []); assert.equal(p.frames.some(isAck), false); assert.deepEqual(f.transport.pending(worker, 100), [])
  f.observer.exec('DROP TRIGGER fail_result')
  await f.reopen(); const q = await f.connect(); q.raw(frame); await q.wait(isAck)
  assert.deepEqual(await f.store.fileWrites.getResult(f.a.admissionId), frame.payload)
})

test('legacy durable heartbeat and transport duplicate semantics are unchanged with feature off', { timeout: 10000 }, async t => {
  const f = await fixture(false); t.after(() => f.close()); const p = await f.connect([])
  const frame = { ...envelope(result(f.a)), payload: { type: 'heartbeat', nonce: randomUUID(), sentAt: now() } }
  p.raw(frame); await p.wait(x => x.frameType === 'transport.ack'); await p.checkpoint()
  p.raw({ ...frame, messageId: randomUUID() }); await p.checkpoint()
  assert.equal(inbox(f).length, 1); assert.equal(f.calls, 0); assert.equal(p.frames.some(x => x.frameType === 'transport.error'), false)
})

test('HTTP upgrade uses real stored credential and rejects an unknown synthetic credential', { timeout: 10000 }, async t => {
  const f = await fixture(); t.after(() => f.close())
  // Existing authenticated connection supplies only the dynamically allocated URL.
  const p = await f.connect(), ws = new WebSocket(p.ws.url, { headers: { authorization: 'Bearer wrong-synthetic' } })
  const response = new Promise<number>(resolve => ws.once('unexpected-response', (_request, response) => { resolve(response.statusCode!); response.resume(); ws.terminate() }))
  ws.on('error', () => {})
  assert.equal(await response, 401); assert.equal(f.calls, 0); assert.deepEqual(retained(f), [])
})


for (const invalid of ['digest', 'worker'] as const) test(`ACK ${invalid} validation remains permanent before outbox persistence`, { timeout: 10000 }, async t => {
  const f = await fixture(); t.after(() => f.close()); const p = await f.connect(), receive = f.ingress.receiveFileWriteResult
  f.ingress.receiveFileWriteResult = async (id, input) => {
    const ack = await receive(id, input)
    return invalid === 'digest' ? { ...ack, resultDigest: '0'.repeat(64) } : { ...ack, workerId: 'other' as WorkerId }
  }
  // If persistence were reached it would be operational; validation must win.
  f.transportObserver.exec("CREATE TRIGGER fail_ack BEFORE INSERT ON transport_outbox BEGIN SELECT RAISE(ABORT,'must not reach persistence'); END")
  p.raw(envelope(result(f.a))); assertPermanent(await p.wait(x => x.frameType === 'transport.error'))
  assert.equal(retained(f).length, 1); assert.equal(p.frames.some(isAck), false); assert.deepEqual(f.transport.pending(worker, 100), [])
})

test('ACK authenticated target mismatch remains permanent even with internally matching result/ACK', { timeout: 10000 }, async t => {
  const f = await fixture(); t.after(() => f.close()); const p = await f.connect(), enqueue = f.transport.enqueueFileResultAck.bind(f.transport)
  f.transport.enqueueFileResultAck = (_id, ack, value) => enqueue('other' as WorkerId, ack, value)
  p.raw(envelope(result(f.a))); const error = await p.wait(x => x.frameType === 'transport.error'); assertPermanent(error)
  assert.match(error.frameType === 'transport.error' ? error.message : '', /Worker mismatch/)
  assert.equal(retained(f).length, 1); assert.equal(p.frames.some(isAck), false); assert.deepEqual(f.transport.pending(worker, 100), [])
})

test('unclassified internal port errors are not made retryable by message text', { timeout: 10000 }, async t => {
  const f = await fixture(); t.after(() => f.close()); const p = await f.connect()
  f.ingress.receiveFileWriteResult = async () => { throw new Error('File result storage temporarily unavailable') }
  p.raw(envelope(result(f.a))); assertPermanent(await p.wait(x => x.frameType === 'transport.error'))
  assert.deepEqual(retained(f), []); assert.equal(p.frames.some(isAck), false)
})
