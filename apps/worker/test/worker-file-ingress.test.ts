import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { WebSocketServer, WebSocket } from 'ws'
import type { FileWriteAdmitPayload, FileWriteResultPayload } from '@wemux/wire-protocol'
import { computeFileWriteFingerprint } from '@wemux/wire-protocol/file-admission-node'
import { WorkerFileWriteExecutor } from '../src/application/file-write-executor.js'
import { WorkerRuntime } from '../src/application/runtime.js'
import { SqliteWorkerStore } from '../src/storage/sqlite-store.js'
import { WorkerTransportStore } from '../src/transport/transport-store.js'
import { WebSocketTransport } from '../src/transport/websocket.js'
import { writeWorkspaceFile } from '../src/files/workspace-files.js'

const feature = 'fs-write-admission-v1'
function admission(requestId = 'admission-1'): FileWriteAdmitPayload {
  const value = { type: 'fs.write.admit', requestId, actorId: 'actor-1', sessionId: 'session-1', clientRequestId: 'client-1',
    operation: 'fs.write', workerId: 'worker-1', binding: { workspaceId: 'workspace-1', agent: { workerId: 'worker-1', agentKey: 'pi' }, modelId: null },
    subpath: 'notes/file.txt', base64Content: 'aGVsbG8=', fingerprintVersion: 1 } as Omit<FileWriteAdmitPayload, 'fingerprint'>
  return { ...value, fingerprint: computeFileWriteFingerprint(value) }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
class Signals<T> {
  readonly values: T[] = []
  private waiters: Array<{ predicate: (value: T) => boolean; resolve: (value: T) => void }> = []
  push(value: T) { this.values.push(value); for (const waiter of [...this.waiters]) if (waiter.predicate(value)) { this.waiters.splice(this.waiters.indexOf(waiter), 1); waiter.resolve(value) } }
  next(predicate: (value: T) => boolean = () => true): Promise<T> { return new Promise(resolve => this.waiters.push({ predicate, resolve })) }
}
type Frame = { frameType: string; payload?: FileWriteResultPayload; directionSeq?: number; deliveryEpoch?: string; nonce?: string; [key: string]: unknown }
async function fixture(t: TestContext, options: { enabled?: boolean; peer?: boolean; write?: typeof writeWorkspaceFile; onMessage?: () => Promise<void>; beforeHello?: unknown; helloError?: unknown } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'worker-file-ingress-'))
  const root = join(dir, 'workspace'); await mkdir(root)
  let store = new SqliteWorkerStore(join(dir, 'application.sqlite'))
  let transportStore = new WorkerTransportStore(join(dir, 'transport.sqlite'))
  const observer = new DatabaseSync(join(dir, 'transport.sqlite'))
  const appObserver = new DatabaseSync(join(dir, 'application.sqlite'))
  const a = admission()
  store.saveIdentity({ workerId: a.workerId, serverUrl: 'http://127.0.0.1', credentialRef: 'synthetic', enrolledAt: '2026-01-01T00:00:00Z' as never })
  store.saveLocalInstallation({ installationId: 'install-1', name: 'local', createdAt: '2026-01-01T00:00:00Z' as never })
  const workspace = { id: a.binding.workspaceId, workerId: a.workerId, projectId: 'project-1' as never, rootPath: root, spec: { kind: 'composite' as const, memberWorkspaceIds: [] }, status: 'ready' as const, failureReason: null, updatedAt: '2026-01-01T00:00:00Z' as never }
  await store.transaction(async tx => { await tx.workspaces.save(workspace); await tx.sessions.createSession(a.sessionId, a.binding) })
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const stateReasons: string[] = []
  const messages = new Signals<Frame>(), notices = new Signals<string>(), states = new Signals<string>(), connections = new Signals<WebSocket>(), hellos = new Signals<{ features: string[] }>()
  let socket: WebSocket, peer = options.peer ?? true, writes = 0, seq = 0, ackThrough = 0, outboundEpoch = ''
  const inboundEpoch = randomUUID()
  let runtime: WorkerRuntime, transport: WebSocketTransport
  server.on('connection', (ws, request) => {
    assert.equal(request.headers.authorization, 'Bearer synthetic-loopback-only')
    socket = ws; connections.push(ws)
    if (options.beforeHello) ws.send(JSON.stringify(options.beforeHello))
    ws.on('error', () => {})
    ws.on('message', raw => {
      const frame = JSON.parse(raw.toString())
      if (frame.frameType === 'transport.hello') {
        hellos.push(frame); outboundEpoch = frame.resume.workerToServer.deliveryEpoch
        if (options.helloError) {
          ws.send(JSON.stringify(options.helloError))
          messages.push(frame)
          return
        }
        ws.send(JSON.stringify({ frameType: 'transport.hello', side: 'server', selectedTransport: { major: 2, minor: 0 }, selectedAdkProfile: 'wemux.adk.v1', enabledFeatures: peer ? [feature] : [], logicalConnectionId: 'connection-1', connectionEpoch: randomUUID(), resumeAccepted: true,
          authoritativeCursors: { workerToServer: { deliveryEpoch: outboundEpoch, ackThrough }, serverToWorker: { deliveryEpoch: inboundEpoch, ackThrough: 0 } }, acceptedAt: '2026-01-01T00:00:00Z' }))
      }
      if (frame.payload?.type === 'fs.write.result') {
        const row = appObserver.prepare('SELECT result_json FROM worker_file_results WHERE request_id=?').get(frame.payload.requestId)
        assert.ok(row, 'result is committed in real application database before socket send')
        assert.deepEqual(JSON.parse(String(row.result_json)), frame.payload)
      }
      messages.push(frame)
    })
  })
  function compose() {
    runtime = new WorkerRuntime(store, { provision: async () => { throw Error('unused') } }, [], { send: payload => { void transport.send(payload) } }, a.workerId, 'test', undefined, undefined, undefined, null, undefined, undefined,
      options.enabled === false ? undefined : { write: async (...args) => { writes++; return (options.write ?? writeWorkspaceFile)(...args) } })
    transport = new WebSocketTransport({ url: `ws://127.0.0.1:${address.port}`, authToken: 'synthetic-loopback-only', workerId: a.workerId, workerVersion: 'test', name: 'test', platform: 'linux', architecture: 'x64', store: transportStore,
      fileWriteIngress: runtime.fileWriteIngress, onMessage: options.onMessage ?? (payload => runtime.receive(payload)), onConnected: () => {}, onNotice: notice => notices.push(notice), onStateChange: state => { stateReasons.push(state.reason); states.push(state.current) }, retry: { baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } })
  }
  compose()
  t.after(async () => { transport.stop(); await runtime.shutdown(); for (const client of server.clients) client.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); observer.close(); appObserver.close(); transportStore.close(); store.close(); await rm(dir, { recursive: true, force: true }) })
  async function start() { const open = states.next(v => v === 'open'); transport.start(); await open; await checkpoint() }
  function frame(payload: unknown, directionSeq = ++seq) { return { frameType: 'data', durability: 'durable', deliveryEpoch: inboundEpoch, directionSeq, messageId: randomUUID(), lane: 'command', payloadVersion: 'wemux.server.payload.v1', expiresAt: null, payload } }
  function send(value: unknown) { socket.send(JSON.stringify(value)) }
  async function checkpoint() { const nonce = randomUUID(); const done = messages.next(v => v.frameType === 'transport.pong' && v.nonce === nonce); send({ frameType: 'transport.ping', nonce, sentAt: '2026-01-01T00:00:00Z' }); await done }
  function result() { return messages.next(v => v.payload?.type === 'fs.write.result') }
  async function write(value = a) { const done = result(); send(frame(value)); return done }
  function applicationAck(result: FileWriteResultPayload) { const { outcome: _outcome, resultJson: _json, ...identity } = result; return { ...identity, type: 'fs.write.result.ack' } }
  async function transportAck(value: Frame, burst = 1) { ackThrough = value.directionSeq!; for (let i = 0; i < burst; i++) send({ frameType: 'transport.ack', deliveryEpoch: outboundEpoch, ackThrough }); await checkpoint() }
  async function reconnect(nextPeer = peer, reopen = false) {
    transport.stop(); const closed = new Promise<void>(resolve => socket.once('close', () => resolve())); socket.close(); await closed
    peer = nextPeer
    if (reopen) { await runtime.shutdown(); store.close(); transportStore.close(); store = new SqliteWorkerStore(join(dir, 'application.sqlite')); transportStore = new WorkerTransportStore(join(dir, 'transport.sqlite')); compose() }
    const ready = states.next(v => v === 'open' || v === 'needs-attention'); transport.start(); return ready
  }
  return { a, root, workspace, start, frame, send, checkpoint, write, result, applicationAck, transportAck, reconnect, messages, notices, states, stateReasons, hellos, connections,
    get runtime() { return runtime }, get transport() { return transport }, get store() { return store }, get transportStore() { return transportStore }, get writes() { return writes },
    transportInternals() { return transport as unknown as { socket: WebSocket; reconnectTimer: NodeJS.Timeout | undefined; stopped: boolean; processingMessages: Promise<void> } },
    setServerReceipt(value: number) { ackThrough = value },
    outbox() { return observer.prepare('SELECT seq,payload_json FROM transport_outbox ORDER BY seq').all() },
  }
}

test('negotiated real write; exact retained replay; duplicate deliveries/conflict; bounded burst transport ACKs', { timeout: 10000 }, async t => {
  const f = await fixture(t); await f.start()
  assert.ok(f.hellos.values[0].features.includes(feature))
  const result = await f.write(); assert.equal(f.writes, 1)
  assert.equal(await readFile(join(f.root, f.a.subpath), 'utf8'), 'hello')
  f.send(f.frame(f.a, 1)); f.send(f.frame(f.a)); await f.checkpoint()
  assert.equal(f.writes, 1); assert.equal(f.outbox().length, 1)
  await f.transportAck(result, 100); assert.equal(f.outbox().length, 0)
  f.send(f.frame(f.a)); await f.checkpoint()
  assert.equal(f.messages.values.filter(v => v.payload?.type === 'fs.write.result').length, 1, 'transport ACK or duplicate admit cannot cause fresh result loop')
  assert.equal((await f.store.fileWrites.listPendingResults(10)).length, 1)
  const replay = f.result(); await f.reconnect(); const resent = await replay
  assert.deepEqual(resent.payload, result.payload); assert.notEqual(resent.directionSeq, result.directionSeq); assert.equal(f.writes, 1)
  const conflict = { ...f.a, base64Content: 'Ynll' }; conflict.fingerprint = computeFileWriteFingerprint(conflict)
  const denied = f.notices.next(v => v.includes('identity conflict')); f.send(f.frame(conflict)); await denied
  assert.equal(f.writes, 1); assert.deepEqual((await f.store.fileWrites.get(f.a.requestId))?.admission, f.a)
})

test('wrong ACK retains obligation; transport ACK then matching/duplicate application ACK clears only delivery and prevents reopen replay', { timeout: 10000 }, async t => {
  const f = await fixture(t); await f.start(); const result = await f.write(); await f.transportAck(result)
  const denied = f.notices.next(v => v.includes('ACK mismatch'))
  f.send(f.frame({ ...f.applicationAck(result.payload!), resultDigest: '0'.repeat(64) })); await denied
  assert.equal((await f.store.fileWrites.listPendingResults(10)).length, 1)
  // Invalid frames did not advance the inbox. Resume with the correct same sequence.
  const next = f.result(); await f.reconnect(); const replay = await next; await f.transportAck(replay)
  f.send(f.frame(f.applicationAck(result.payload!), 2)); await f.checkpoint()
  f.send(f.frame(f.applicationAck(result.payload!))); await f.checkpoint()
  assert.equal((await f.store.fileWrites.listPendingResults(10)).length, 0)
  assert.deepEqual((await f.store.fileWrites.get(f.a.requestId))?.result, result.payload)
  const count = f.messages.values.length; await f.reconnect(true, true); await f.checkpoint()
  assert.equal(f.messages.values.slice(count).filter(v => v.payload?.type === 'fs.write.result').length, 0)
  assert.equal(f.outbox().length, 0); assert.equal(f.writes, 1)
})

test('application ACK before transport ACK preserves original envelope across reopen; no fresh projection and legacy order survives', { timeout: 10000 }, async t => {
  const f = await fixture(t); await f.start(); const result = await f.write()
  f.send(f.frame(f.applicationAck(result.payload!))); await f.checkpoint()
  assert.equal((await f.store.fileWrites.listPendingResults(10)).length, 0)
  assert.equal(f.outbox().length, 1, 'application receipt must not remove an unacknowledged transport sequence')
  const next = f.result(); await f.reconnect(true, true); const replay = await next
  assert.deepEqual(replay, result, 'stale envelope after committed application ACK replays only its original transport identity')
  await f.transportAck(replay)
  const legacy = f.messages.next(v => v.payload?.type as string === 'heartbeat')
  await f.transport.send({ type: 'heartbeat', sentAt: 'legacy' }); const heartbeat = await legacy
  assert.equal(heartbeat.directionSeq, result.directionSeq! + 1); await f.transportAck(heartbeat)
  await f.reconnect(); await f.checkpoint(); assert.equal(f.outbox().length, 0)
})

test('reconnect of unacknowledged result deduplicates projection; downgrade fails closed without unsupported replay', { timeout: 10000 }, async t => {
  const f = await fixture(t); await f.start(); const first = await f.write()
  const next = f.result(); await f.reconnect(); assert.deepEqual(await next, first); assert.equal(f.outbox().length, 1)
  const before = f.messages.values.filter(v => v.payload?.type === 'fs.write.result').length
  assert.equal(await f.reconnect(false, true), 'needs-attention')
  assert.equal(f.messages.values.filter(v => v.payload?.type === 'fs.write.result').length, before)
  assert.equal(f.outbox().length, 1); assert.ok(f.notices.values.some(v => v.includes('connection stopped')))
})

test('default off, one-sided support, malformed/volatile/wrong-direction/tampered input deny before effect', { timeout: 15000 }, async t => {
  for (const scenario of ['default', 'old-peer', 'volatile', 'direction', 'fingerprint', 'malformed'] as const) {
    const f = await fixture(t, { enabled: scenario !== 'default', peer: scenario !== 'old-peer' }); await f.start()
    if (scenario === 'default') assert.ok(!f.hellos.values[0].features.includes(feature))
    let value: unknown = f.frame(f.a)
    if (scenario === 'volatile') value = { frameType: 'data', durability: 'volatile', lane: 'command', payloadVersion: 'wemux.server.payload.v1', payload: f.a }
    if (scenario === 'direction') value = f.frame({ ...f.a, type: 'fs.write.result' })
    if (scenario === 'fingerprint') value = f.frame({ ...f.a, fingerprint: '0'.repeat(64) }, 1)
    if (scenario === 'malformed') value = f.frame({ ...f.a, extra: true }, 1)
    const closed = f.states.next(v => v === 'backoff'); f.send(value); await closed; f.transport.stop()
    assert.equal(f.writes, 0); assert.equal(await f.store.fileWrites.get(f.a.requestId), null)
    assert.equal(f.messages.values.filter(v => v.payload?.type === 'fs.write.result').length, 0)
    assert.deepEqual(await readdir(f.root), [])
  }
})

test('current binding/local Workspace denied before reservation; raw Runtime receive cannot bypass transport', { timeout: 10000 }, async t => {
  for (const local of [false, true]) {
    const f = await fixture(t); await f.start()
    await f.runtime.receive(f.a); assert.equal(f.writes, 0)
    if (local) await f.store.transaction(tx => tx.workspaces.save({ ...f.workspace, projectId: 'local' as never }))
    else await f.store.transaction(tx => tx.sessions.setModel(f.a.sessionId, 'changed' as never))
    const denied = f.notices.next(v => v.includes(local ? 'Workspace is not eligible' : 'binding mismatch')); f.send(f.frame(f.a)); await denied; f.transport.stop()
    assert.equal(f.writes, 0); assert.equal(await f.store.fileWrites.get(f.a.requestId), null)
  }
})

test('immutable Runtime queue snapshot; common command ordering and shutdown drains admitted work', { timeout: 10000 }, async t => {
  const entered = deferred(), release = deferred()
  const f = await fixture(t, { write: async (...args) => { entered.resolve(); await release.promise; return writeWorkspaceFile(...args) } }); await f.start()
  const result = f.result(); f.send(f.frame(f.a)); await entered.promise
  const second = admission('second'), before = structuredClone(second)
  const queued = f.runtime.fileWriteIngress!.receive(f.frame(second), { localFeatures: [feature], peerFeatures: [feature] }, async () => {})
  Object.assign(second, { subpath: '../escape', base64Content: '' }); Object.assign(second.binding.agent, { workerId: 'mutated' })
  const shutdown = f.runtime.shutdown(); let finished = false; void shutdown.then(() => { finished = true })
  assert.equal(finished, false)
  await assert.rejects(f.runtime.fileWriteIngress!.receive(f.frame(admission('third')), { localFeatures: [feature], peerFeatures: [feature] }, async () => {}), /shutting down/)
  release.resolve(); await result; await queued; await shutdown
  assert.equal(f.writes, 2); assert.deepEqual((await f.store.fileWrites.get('second'))?.admission, before)
})

test('abort stops queued work but does not cancel active I/O', { timeout: 10000 }, async t => {
  const entered = deferred(), release = deferred()
  const f = await fixture(t, { write: async (...args) => { entered.resolve(); await release.promise; return writeWorkspaceFile(...args) } }); await f.start()
  const first = f.result(); f.send(f.frame(f.a)); await entered.promise
  const pending = f.runtime.fileWriteIngress!.receive(f.frame(admission('aborted')), { localFeatures: [feature], peerFeatures: [feature] }, async () => {})
  const rejected = assert.rejects(pending, /aborted/)
  f.runtime.abort(); release.resolve(); await first; await rejected; await f.runtime.shutdown()
  assert.equal(f.writes, 1); assert.equal(await f.store.fileWrites.get('aborted'), null)
  assert.equal(await readFile(join(f.root, f.a.subpath), 'utf8'), 'hello')
})

test('enqueue failure surfaces diagnostics and reconnect republishes retained result without another effect', { timeout: 10000 }, async t => {
  const f = await fixture(t); await f.start()
  const enqueue = f.transportStore.enqueueFileResult.bind(f.transportStore)
  f.transportStore.enqueueFileResult = async () => { throw Error('injected projection failure') }
  const denied = f.notices.next(v => v.includes('injected projection failure')); f.send(f.frame(f.a)); await denied; f.transport.stop()
  assert.equal(f.writes, 1); assert.equal((await f.store.fileWrites.listPendingResults(10)).length, 1)
  f.transportStore.enqueueFileResult = enqueue
  const next = f.result(); await f.reconnect(); await next; assert.equal(f.writes, 1)
})

test('asynchronous legacy handler rejection is awaited and reported, not an unhandled promise', { timeout: 10000 }, async t => {
  const entered = deferred(), release = deferred()
  const f = await fixture(t, { onMessage: async () => { entered.resolve(); await release.promise; throw Error('injected async handler failure') } }); await f.start()
  const denied = f.notices.next(v => v.includes('injected async handler failure'))
  f.send(f.frame({ type: 'fs.request', requestId: 'legacy', sessionId: f.a.sessionId, operation: 'read', subpath: 'file' }))
  await entered.promise; release.resolve(); await denied; f.transport.stop(); assert.equal(f.writes, 0)
})

test('accepted reconnect cursor cleans obsolete projection before application-pending reprojection', { timeout: 10000 }, async t => {
  const f = await fixture(t); await f.start(); const first = await f.write()
  // Server committed transport receipt but its ACK was lost before disconnect.
  f.setServerReceipt(first.directionSeq!)
  const next = f.result(); await f.reconnect(true, true); const replay = await next
  assert.deepEqual(replay.payload, first.payload); assert.equal(replay.directionSeq, first.directionSeq! + 1)
  assert.equal(f.outbox().length, 1); assert.equal(f.writes, 1)
})

test('actual socket send callback failure keeps application obligation and envelope for reconnect', { timeout: 10000 }, async t => {
  const f = await fixture(t); await f.start()
  const send = WebSocket.prototype.send
  let injected = false
  WebSocket.prototype.send = function (...args: Parameters<WebSocket['send']>) {
    const value = JSON.parse(String(args[0]))
    if (!injected && value.payload?.type === 'fs.write.result') {
      injected = true
      const callback = args.at(-1) as (error: Error) => void
      callback(new Error('injected socket send failure'))
      return
    }
    return Reflect.apply(send, this, args)
  } as WebSocket['send']
  try {
    const failed = f.notices.next(v => v.includes('injected socket send failure'))
    f.send(f.frame(f.a)); await failed; f.transport.stop()
    assert.equal(f.writes, 1); assert.equal(f.outbox().length, 1)
    assert.equal((await f.store.fileWrites.listPendingResults(10)).length, 1)
  } finally { WebSocket.prototype.send = send }
  const next = f.result(); await f.reconnect(); const result = await next
  assert.equal(result.directionSeq, 1); assert.equal(f.writes, 1)
})

test('Runtime command deletion waits for active file write then denies queued admission before reservation', { timeout: 10000 }, async t => {
  const entered = deferred(), release = deferred()
  const f = await fixture(t, { write: async (...args) => { entered.resolve(); await release.promise; return writeWorkspaceFile(...args) } }); await f.start()
  const first = f.result(); f.send(f.frame(f.a)); await entered.promise
  const deletion = f.runtime.receive({ type: 'command', commandId: 'delete-command' as never, command: { kind: 'session.delete', sessionId: f.a.sessionId } })
  const nextAdmission = f.runtime.fileWriteIngress!.receive(f.frame(admission('after-delete')), { localFeatures: [feature], peerFeatures: [feature] }, async () => assert.fail('unexpected publication'))
  const denied = assert.rejects(nextAdmission, /binding mismatch/)
  assert.ok(await f.store.sessions.get(f.a.sessionId), 'delete must wait behind the common commands queue')
  release.resolve(); await first; await deletion; await denied
  assert.equal(await f.store.sessions.get(f.a.sessionId), null); assert.equal(await f.store.fileWrites.get('after-delete'), null); assert.equal(f.writes, 1)
})

test('unresolved reservations stay await-existing across real reconnect and reopen', { timeout: 10000 }, async t => {
  const f = await fixture(t); await f.store.transaction(tx => tx.fileWrites.reserve(f.a)); await f.start()
  f.send(f.frame(f.a)); await f.checkpoint()
  await f.reconnect(true, true); f.send(f.frame(f.a)); await f.checkpoint()
  assert.equal(f.writes, 0); assert.equal((await f.store.fileWrites.get(f.a.requestId))?.result, null)
  assert.equal(f.outbox().length, 0); assert.deepEqual(await readdir(f.root), [])
})

test('sender-object mutation after serialization cannot change delivered admission', { timeout: 10000 }, async t => {
  const entered = deferred(), release = deferred()
  const f = await fixture(t, { onMessage: async () => { entered.resolve(); await release.promise } }); await f.start()
  f.send(f.frame({ type: 'fs.request', requestId: 'block', sessionId: f.a.sessionId, operation: 'read', subpath: 'file' })); await entered.promise
  const queued = admission('queued-raw'), original = structuredClone(queued)
  f.send(f.frame(queued)); Object.assign(queued.binding.agent, { agentKey: 'mutated' }); Object.assign(queued, { base64Content: '' })
  const next = f.result(); release.resolve(); await next
  assert.deepEqual((await f.store.fileWrites.get(original.requestId))?.admission, original)
  assert.equal(f.writes, 1)
})

test('pre-handshake admission is rejected without reservation or result', { timeout: 10000 }, async t => {
  const a = admission()
  const f = await fixture(t, { beforeHello: { frameType: 'data', durability: 'durable', deliveryEpoch: 'prehello', directionSeq: 1, messageId: randomUUID(), lane: 'command', payloadVersion: 'wemux.server.payload.v1', expiresAt: null, payload: a } })
  const failed = f.notices.next(v => v.includes('hello not accepted')); f.transport.start(); await failed; f.transport.stop()
  assert.equal(f.writes, 0); assert.equal(await f.store.fileWrites.get(a.requestId), null); assert.equal(f.outbox().length, 0)
})

test('committed application ACK serialized before replay prevents pending-snapshot resurrection', { timeout: 10000 }, async t => {
  const f = await fixture(t); await f.start(); const result = await f.write(); await f.transportAck(result)
  const ack = f.runtime.fileWriteIngress!.receive(f.frame(f.applicationAck(result.payload!)), { localFeatures: [feature], peerFeatures: [feature] }, async () => assert.fail('ACK cannot publish'))
  const replay = f.runtime.fileWriteIngress!.replay(async () => assert.fail('acknowledged result cannot be projected'))
  await ack; await replay
  assert.equal((await f.store.fileWrites.get(f.a.requestId))?.acknowledged, true); assert.equal(f.outbox().length, 0)
})

test('socket generation change discards old raw frames waiting behind an asynchronous handler', { timeout: 10000 }, async t => {
  const entered = deferred(), release = deferred()
  const f = await fixture(t, { onMessage: async () => { entered.resolve(); await release.promise } }); await f.start()
  f.send(f.frame({ type: 'fs.request', requestId: 'block', sessionId: f.a.sessionId, operation: 'read', subpath: 'file' })); await entered.promise
  f.send(f.frame(f.a))
  const connected = f.connections.next(); const reconnect = f.reconnect(); await connected
  release.resolve(); await reconnect; await f.checkpoint()
  assert.equal(f.writes, 0); assert.equal(await f.store.fileWrites.get(f.a.requestId), null)
})

test('permanent transport rejection does not manufacture receipt or discard a file-result sequence', { timeout: 10000 }, async t => {
  const f = await fixture(t); await f.start(); const first = await f.write()
  const stopped = f.states.next(v => v === 'needs-attention')
  f.send({ frameType: 'transport.error', code: 'invalid-frame', retryable: false, message: 'synthetic permanent rejection' }); await stopped
  assert.equal(f.outbox().length, 1); assert.equal(f.outbox()[0].seq, first.directionSeq)
  assert.equal((await f.store.fileWrites.listPendingResults(10)).length, 1)
})

for (const enabled of [false, true]) for (const pending of ['empty', 'legacy', 'file'] as const) {
  test(`permanent pre-hello rejection preserves ${pending} outbox and stops without retry (opt-in=${enabled})`, { timeout: 10000 }, async t => {
    const reason = 'Unsupported ADK profile'
    const f = await fixture(t, { enabled, helloError: { frameType: 'transport.error', code: 'unsupported-adk-profile', retryable: false, message: reason } })
    if (pending === 'legacy') await f.transportStore.enqueue({ type: 'heartbeat', sentAt: 'retained' })
    if (pending === 'file') {
      const outcome = await new WorkerFileWriteExecutor(f.store, f.a.workerId).execute(f.a)
      assert.equal(outcome.status, 'result')
      if (outcome.status !== 'result') throw Error('fixture')
      await f.transportStore.enqueueFileResult(outcome.result)
    }
    const outbox = f.outbox(), application = await f.store.fileWrites.get(f.a.requestId)
    let drops = 0
    const drop = f.transportStore.dropOldestUnacked.bind(f.transportStore)
    f.transportStore.dropOldestUnacked = async () => { drops++; return drop() }
    const connected = f.connections.next()
    f.transport.start()
    await connected
    await new Promise<void>(resolve => f.transportInternals().socket.once('close', () => resolve()))
    await f.transportInternals().processingMessages
    assert.ok(f.states.values.includes('needs-attention'), JSON.stringify(f.states.values))
    assert.equal(f.states.values.includes('backoff'), false)
    assert.equal(f.transportInternals().reconnectTimer, undefined)
    assert.equal(f.transportInternals().stopped, true)
    assert.ok(f.notices.values.some(value => value.includes('unsupported-adk-profile') && value.includes(reason)), JSON.stringify(f.notices.values))
    assert.ok(f.stateReasons.includes(reason), JSON.stringify(f.stateReasons))
    assert.equal(drops, 0); assert.deepEqual(f.outbox(), outbox)
    assert.deepEqual(await f.store.fileWrites.get(f.a.requestId), application)
    assert.equal(f.writes, 0); assert.equal(f.messages.values.some(value => value.frameType === 'data'), false)
  })
}

test('receiver message listener snapshots mutable Buffer before delayed processing', { timeout: 10000 }, async t => {
  const entered = deferred(), release = deferred()
  const f = await fixture(t, { onMessage: async () => { entered.resolve(); await release.promise } }); await f.start()
  f.send(f.frame({ type: 'fs.request', requestId: 'block', sessionId: f.a.sessionId, operation: 'read', subpath: 'file' })); await entered.promise
  const raw = Buffer.from(JSON.stringify(f.frame(f.a)))
  // Invoke the real listener installed on the actual connected Worker socket.
  // No public test hook; only test-local inspection of TypeScript-private state.
  const receiver = f.transportInternals().socket
  assert.ok(receiver.listenerCount('message') > 0)
  receiver.emit('message', raw, false)
  raw.fill(0x78) // Invalid JSON if toString() is deferred until queue execution.
  release.resolve()
  await f.transportInternals().processingMessages
  assert.equal(f.writes, 1)
  assert.deepEqual((await f.store.fileWrites.get(f.a.requestId))?.admission, f.a)
  assert.equal(await readFile(join(f.root, f.a.subpath), 'utf8'), 'hello')
})

test('retryable pre-hello rejection retains reason and schedules ordinary backoff without deleting data', { timeout: 10000 }, async t => {
  const reason = 'Temporarily unavailable'
  const f = await fixture(t, { helloError: { frameType: 'transport.error', code: 'temporary-unavailable', retryable: true, message: reason } })
  await f.transportStore.enqueue({ type: 'heartbeat', sentAt: 'retained' })
  const before = f.outbox(), connected = f.connections.next()
  f.transport.start(); await connected
  await new Promise<void>(resolve => f.transportInternals().socket.once('close', () => resolve()))
  assert.ok(f.states.values.includes('backoff'))
  assert.equal(f.states.values.includes('needs-attention'), false)
  assert.ok(f.transportInternals().reconnectTimer)
  assert.equal(f.transportInternals().stopped, false)
  assert.ok(f.notices.values.some(value => value.includes(reason)))
  assert.deepEqual(f.outbox(), before)
  f.transport.stop()
})

for (const invalid of [
  { frameType: 'transport.error', code: 'unsupported-adk-profile', retryable: 'false', message: 'malformed retryable' },
  { frameType: 'transport.error', code: 'invented-code', retryable: false, message: 'malformed code' },
  { frameType: 'transport.error', code: 'unsupported-adk-profile', retryable: false, message: 'extra field', extra: true },
  { frameType: 'transport.ack', deliveryEpoch: 'unaccepted-epoch', ackThrough: 999 },
]) {
  test(`pre-hello ${invalid.frameType} rejects invalid shape or unnegotiated receipt: ${invalid.message ?? 'ack'}`, { timeout: 10000 }, async t => {
    const f = await fixture(t, { helloError: invalid })
    await f.transportStore.enqueue({ type: 'heartbeat', sentAt: 'retained' })
    const before = f.outbox(), connected = f.connections.next()
    let receipts = 0
    f.transportStore.acknowledgeOutbound = async () => { receipts++; assert.fail('receipt before hello') }
    f.transport.start(); await connected
    await new Promise<void>(resolve => f.transportInternals().socket.once('close', () => resolve()))
    assert.equal(f.states.values.includes('needs-attention'), false)
    assert.equal(f.notices.values.some(value => value.includes('Transport handshake rejected')), false)
    assert.equal(receipts, 0); assert.deepEqual(f.outbox(), before); assert.equal(f.writes, 0)
    f.transport.stop()
  })
}
