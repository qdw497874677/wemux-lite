import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { WebSocket } from 'ws'
import type { WorkerId } from '@wemux/domain'
import { FS_WRITE_ADMISSION_V1, type ServerToWorkerFrame, type WorkerToServerFrame } from '@wemux/wire-protocol'
import { parseFileWriteResultAck } from '@wemux/wire-protocol/file-admission-node'
import { AuthenticationService, hashSecret } from '../../server/src/application/auth.ts'
import { AdministratorDirectory } from '../../server/src/application/administrator-directory.ts'
import { Notifications } from '../../server/src/application/notifications.ts'
import { ServerService, now } from '../../server/src/application/server-service.ts'
import { WorkerService } from '../../server/src/application/worker-service.ts'
import { TaskService } from '../../server/src/application/task-service.ts'
import { SessionAccessService } from '../../server/src/application/session-access-service.ts'
import { ProjectAccessService } from '../../server/src/application/project-access-service.ts'
import { fileWriteWireAdmission } from '../../server/src/application/file-write-results.ts'
import { SqliteServerStore } from '../../server/src/storage/sqlite/store.ts'
import { WorkerGateway } from '../../server/src/worker-ws/gateway.ts'
import { ServerTransportStore } from '../../server/src/worker-ws/transport-store.ts'
import { WorkerRuntime } from '../src/application/runtime.ts'
import { SqliteWorkerStore } from '../src/storage/sqlite-store.ts'
import { WorkerTransportStore } from '../src/transport/transport-store.ts'
import { WebSocketTransport } from '../src/transport/websocket.ts'
import { writeWorkspaceFile } from '../src/files/workspace-files.ts'

const workerId = 'integration-worker' as WorkerId
const support = { localFeatures: [FS_WRITE_ADMISSION_V1], peerFeatures: [FS_WRITE_ADMISSION_V1] }
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
class Signals<T> {
  readonly values: T[] = []
  private waiters: Array<{ predicate: (value: T) => boolean; resolve: (value: T) => void }> = []
  push(value: T) { this.values.push(value); for (const waiter of [...this.waiters]) if (waiter.predicate(value)) { this.waiters.splice(this.waiters.indexOf(waiter), 1); waiter.resolve(value) } }
  wait(predicate: (value: T) => boolean): Promise<T> {
    const found = this.values.find(predicate)
    return found === undefined ? new Promise(resolve => this.waiters.push({ predicate, resolve })) : Promise.resolve(found)
  }
}
async function deadline<T>(promise: Promise<T>): Promise<T> {
  let timer!: NodeJS.Timeout
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Integration event deadline exceeded')), 8000) })]) }
  finally { clearTimeout(timer) }
}
type Fault = 'insert' | 'commit' | 'ack-outbox'
type Order = 'application-first' | 'transport-first'

// All resource ownership is local to this callback, including failed fixture setup.
async function withFixture(run: (f: Awaited<ReturnType<typeof compose>>) => Promise<void>, options: { fault?: Fault; order?: Order } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'file-result-integration-'))
  const cleanup: Array<() => void | Promise<void>> = []
  try { await deadline(run(await compose(directory, cleanup, options))) }
  finally {
    try {
      const failures: unknown[] = []
      for (const close of cleanup.reverse()) { try { await close() } catch (error) { failures.push(error) } }
      if (failures.length) throw new AggregateError(failures, 'Fixture cleanup failed')
    }
    finally { await rm(directory, { recursive: true, force: true }) }
  }
}
async function compose(directory: string, cleanup: Array<() => void | Promise<void>>, options: { fault?: Fault; order?: Order }) {
  const root = join(directory, 'workspace'); await mkdir(root)
  const app = new SqliteServerStore(join(directory, 'server.sqlite')); cleanup.push(() => app.close())
  const serverTransport = new ServerTransportStore(join(directory, 'server-transport.sqlite'))
  let gatewayOwnsTransport = false
  cleanup.push(() => { if (!gatewayOwnsTransport) serverTransport.close() })
  const workerStore = new SqliteWorkerStore(join(directory, 'worker.sqlite')); cleanup.push(() => workerStore.close())
  const workerTransport = new WorkerTransportStore(join(directory, 'worker-transport.sqlite')); cleanup.push(() => workerTransport.close())
  const databases = ['server.sqlite', 'server-transport.sqlite', 'worker.sqlite', 'worker-transport.sqlite'].map(name => {
    const db = new DatabaseSync(join(directory, name)); cleanup.push(() => db.close()); return db
  })
  const [serverDb, serverTransportDb, workerDb, workerTransportDb] = databases as [DatabaseSync, DatabaseSync, DatabaseSync, DatabaseSync]
  const owner = 'integration-owner' as never, teamId = 'integration-team' as never, projectId = 'integration-project' as never, sessionId = 'integration-session' as never
  await app.transaction(async tx => {
    await tx.identity.saveTeam({ id: teamId, name: 'Test', createdAt: now() })
    await tx.identity.saveUser({ id: owner, username: 'test-owner', email: null, createdAt: now() })
    await tx.identity.saveMembership({ teamId, userId: owner, role: 'owner', joinedAt: now() })
    await tx.resources.saveProject({ id: projectId, teamId, ownerId: owner, name: 'Test', shareScope: 'team', deletedAt: null })
    await tx.resources.saveWorker({ id: workerId, teamId, ownerId: owner, name: 'Test', shareScope: 'owner-only', connectionState: 'offline', version: null, platform: null, capabilities: [], lastSeenAt: null })
    await tx.identity.saveWorkerCredential({ id: 'test-credential' as never, workerId, credentialHash: hashSecret('synthetic-integration-only'), createdAt: now(), revokedAt: null })
  })
  const task = await new TaskService(app).create(projectId, { title: 'Integration' }, { actor: owner, requestId: 'test-task' })
  const binding = { workspaceId: 'integration-workspace' as never, agent: { workerId, agentKey: 'test-agent' as never }, modelId: null }
  await app.transaction(tx => tx.resources.saveSession({ id: sessionId, projectId, taskId: task.id, runId: null, ownerId: owner, workspaceId: binding.workspaceId, title: 'Test', shareScope: 'project', runtimeState: 'idle', deletedAt: null, binding }))
  const notifications = new Notifications()
  const service = new ServerService(app, notifications, undefined, undefined, undefined, new SessionAccessService(app, new ProjectAccessService(app)))
  const admission = await service.admitFileWrite(sessionId, owner, { requestId: 'test-client', subpath: 'notes/file.txt', base64Content: 'aGVsbG8=' })
  const wireAdmission = fileWriteWireAdmission(admission)
  const held = () => serverDb.prepare("SELECT kind,id,data FROM records WHERE kind IN ('file-write-admission','file-write-intent') ORDER BY kind,id").all()
  const originalHeld = held()
  workerStore.saveIdentity({ workerId, serverUrl: 'http://127.0.0.1', credentialRef: 'synthetic', enrolledAt: now() })
  workerStore.saveLocalInstallation({ installationId: 'test-installation', name: 'Test', createdAt: now() })
  const http = createServer(); cleanup.push(() => new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve())))
  let upgrades = 0
  http.on('upgrade', () => { upgrades++ })
  const connectedSockets = new Set<WebSocket>()
  http.listen(0, '127.0.0.1'); await once(http, 'listening')
  const address = http.address(); assert.ok(address && typeof address !== 'string'); assert.notEqual(address.port, 8004)
  let receiverCalls = 0, ackEnqueues = 0, resultEnqueues = 0, writes = 0, connections = 0
  const serverResults = () => serverDb.prepare("SELECT data FROM records WHERE kind='file-write-result'").all()
  const resultBytes = () => String(workerDb.prepare('SELECT result_json FROM worker_file_results WHERE request_id=?').get(admission.admissionId)!.result_json)
  const marker = () => workerDb.prepare('SELECT acknowledged FROM worker_file_result_delivery WHERE request_id=?').get(admission.admissionId)!.acknowledged
  const workerOutbox = () => workerTransportDb.prepare('SELECT * FROM transport_outbox ORDER BY seq').all()
  const serverOutbox = () => serverTransportDb.prepare('SELECT * FROM transport_outbox ORDER BY seq').all()
  const enqueueAck = serverTransport.enqueueFileResultAck.bind(serverTransport)
  serverTransport.enqueueFileResultAck = (id, ack, result) => {
    assert.equal(serverResults().length, 1, 'independent connection sees application COMMIT before ACK enqueue')
    assert.deepEqual(JSON.parse(String(serverResults()[0]!.data)), result)
    ackEnqueues++; enqueueAck(id, ack, result)
  }
  const enqueueResult = workerTransport.enqueueFileResult.bind(workerTransport)
  workerTransport.enqueueFileResult = async result => {
    assert.deepEqual(JSON.parse(resultBytes()), result, 'Worker result committed before projection')
    resultEnqueues++; return enqueueResult(result)
  }
  const gateway = new WorkerGateway(http, new AuthenticationService(app, new AdministratorDirectory(app.identity)), new WorkerService(app, notifications), notifications, serverTransport, {
    admissions: { get: id => app.fileWrites.get(id) },
    receiveFileWriteResult: (id, input) => { receiverCalls++; return service.receiveFileWriteResult(id, input) },
  })
  // Transfer sole transport ownership after successful gateway construction.
  gatewayOwnsTransport = true
  cleanup.push(() => gateway.close())
  let transport!: WebSocketTransport
  const runtime = new WorkerRuntime(workerStore, { provision: async () => { throw Error('No provision in this slice') } }, [], { send: payload => { void transport.send(payload) } }, workerId, 'Test', undefined, undefined, undefined, null, undefined, undefined,
    { write: async (...args) => { writes++; return writeWorkspaceFile(...args) } })
  cleanup.push(() => runtime.shutdown())
  const states = new Signals<string>(), outbound = new Signals<ServerToWorkerFrame>(), inbound = new Signals<WorkerToServerFrame>()
  const retryGate = deferred(), receiptGate = deferred()
  cleanup.push(() => { retryGate.resolve(); receiptGate.resolve() })
  let serverSocket!: WebSocket
  let releaseReceipt: (() => void) | undefined
  transport = new WebSocketTransport({ url: `ws://127.0.0.1:${address.port}/worker/ws`, authToken: 'synthetic-integration-only', workerId, workerVersion: 'test', name: 'Test', platform: 'linux', architecture: 'x64', store: workerTransport,
    fileWriteIngress: runtime.fileWriteIngress, onMessage: payload => runtime.receive(payload), onStateChange: change => states.push(change.current),
    retry: { baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
    onConnected: async () => {
      connections++
      // Test-local socket inspection only, no added product API or generic-send bypass.
      serverSocket = (gateway as unknown as { connections: Map<WorkerId, { socket: WebSocket }> }).connections.get(workerId)!.socket
      connectedSockets.add(serverSocket)
      serverSocket.on('message', raw => inbound.push(JSON.parse(raw.toString()) as WorkerToServerFrame))
      const send = serverSocket.send.bind(serverSocket)
      serverSocket.send = ((data: string, callback?: (error?: Error) => void) => {
        let frame = JSON.parse(String(data)) as ServerToWorkerFrame
        // Optional negative sensitivity: mimic the old permanent wire signal only.
        // This is NOT a source revert of the original error-classification defect.
        if (process.env.WEMUX_TEST_PERMANENT_RESULT_SIGNAL === '1' && frame.frameType === 'transport.error') {
          frame = { ...frame, retryable: false, code: 'invalid-frame' }; data = JSON.stringify(frame)
        }
        outbound.push(frame)
        const hold = options.order === 'application-first' ? frame.frameType === 'transport.ack'
          : options.order === 'transport-first' && frame.frameType === 'data' && frame.payload.type === 'fs.write.result.ack'
        if (hold && !releaseReceipt) { releaseReceipt = () => send(data, callback); receiptGate.resolve(); return }
        send(data, callback)
      }) as typeof serverSocket.send
      if (connections > 1) await retryGate.promise
    },
  })
  cleanup.push(async () => {
    retryGate.resolve(); receiptGate.resolve()
    const internals = transport as unknown as { socket?: WebSocket; processingMessages: Promise<void> }
    const socket = internals.socket
    const closed = socket && socket.readyState !== 3 ? once(socket, 'close') : Promise.resolve()
    transport.stop(); await closed; await internals.processingMessages
  })
  // Compose before initialize; seed the test Session afterwards, as a newly created
  // Session rather than boot-time history that would schedule unrelated journal sync.
  await runtime.initialize()
  await workerStore.transaction(async tx => {
    await tx.workspaces.save({ id: binding.workspaceId, workerId, projectId, rootPath: root, spec: { kind: 'composite', memberWorkspaceIds: [] }, status: 'ready', failureReason: null, updatedAt: now() })
    await tx.sessions.createSession(sessionId, binding)
  })
  // No Server admission dispatcher exists. Execute the AUTHORIZED admission through
  // the existing trusted internal Runtime seam, NOT gateway.send or transport injection.
  // This synthetic envelope is never sent or committed to either transport inbox.
  await runtime.fileWriteIngress!.receive({ frameType: 'data', durability: 'durable', deliveryEpoch: 'test-internal-seed', directionSeq: 1, messageId: randomUUID(), lane: 'command', payloadVersion: 'wemux.server.payload.v1', expiresAt: null, payload: wireAdmission }, support, async () => {})
  const retainedBytes = resultBytes()
  assert.equal(marker(), 0); assert.equal(writes, 1); assert.equal(await readFile(join(root, admission.subpath), 'utf8'), 'hello')
  assert.equal(workerOutbox().length, 0); assert.equal(serverResults().length, 0)
  async function checkpoint() {
    const nonce = randomUUID()
    const done = inbound.wait(frame => frame.frameType === 'transport.pong' && frame.nonce === nonce)
    serverSocket.send(JSON.stringify({ frameType: 'transport.ping', nonce, sentAt: now() })); await done
  }
  async function serverCheckpoint() {
    const socket = (transport as unknown as { socket: WebSocket }).socket
    const nonce = randomUUID()
    const done = outbound.wait(frame => frame.frameType === 'transport.pong' && frame.nonce === nonce)
    socket.send(JSON.stringify({ frameType: 'transport.ping', nonce, sentAt: now() })); await done
  }
  function installFault() {
    if (options.fault === 'insert') serverDb.exec("CREATE TRIGGER fail_result BEFORE INSERT ON records WHEN NEW.kind='file-write-result' BEGIN SELECT RAISE(ABORT,'test result insert failure'); END")
    if (options.fault === 'commit') serverDb.exec("CREATE TABLE result_commit_probe (parent INTEGER REFERENCES result_commit_probe(id) DEFERRABLE INITIALLY DEFERRED, id INTEGER PRIMARY KEY); CREATE TRIGGER fail_result AFTER INSERT ON records WHEN NEW.kind='file-write-result' BEGIN INSERT INTO result_commit_probe(parent) VALUES(999); END")
    if (options.fault === 'ack-outbox') serverTransportDb.exec("CREATE TRIGGER fail_ack BEFORE INSERT ON transport_outbox BEGIN SELECT RAISE(ABORT,'test ack insert failure'); END")
  }
  function removeFault() {
    if (options.fault === 'ack-outbox') serverTransportDb.exec('DROP TRIGGER fail_ack')
    else serverDb.exec('DROP TRIGGER fail_result')
    retryGate.resolve()
  }
  async function settled() {
    const ack = await outbound.wait(frame => frame.frameType === 'data' && frame.payload.type === 'fs.write.result.ack')
    assert.ok(ack.frameType === 'data')
    parseFileWriteResultAck(ack.payload, JSON.parse(retainedBytes))
    await checkpoint(); await serverCheckpoint()
    assert.equal(marker(), 1, 'real Runtime application ACK persisted, independent SQLite observer')
    assert.equal(workerOutbox().length, 0); assert.equal(serverOutbox().length, 0)
    assert.equal(resultBytes(), retainedBytes); assert.deepEqual(JSON.parse(String(serverResults()[0]!.data)), JSON.parse(retainedBytes))
    assert.deepEqual((await workerStore.fileWrites.get(admission.admissionId))?.admission, wireAdmission)
    assert.equal((await workerStore.fileWrites.listPendingResults(10)).length, 0)
    assert.equal(writes, 1); assert.equal(await readFile(join(root, admission.subpath), 'utf8'), 'hello')
    assert.deepEqual(held(), originalHeld); assert.deepEqual(await app.fileWrites.getIntent(admission.admissionId), { admissionId: admission.admissionId, state: 'held' })
    assert.deepEqual(await app.commands.listDeliverable(workerId, 100), [])
    assert.equal(states.values.includes('needs-attention'), false)
    assert.equal(upgrades, connections); assert.equal(connectedSockets.size, connections)
  }
  return { transport, runtime, workerStore, admission, support, wireAdmission, states, outbound, inbound, receiptGate, checkpoint, serverCheckpoint, installFault, removeFault, settled, marker, workerOutbox, serverOutbox, serverResults, resultBytes, retainedBytes,
    get connections() { return connections }, get writes() { return writes }, get receiverCalls() { return receiverCalls }, get ackEnqueues() { return ackEnqueues }, get resultEnqueues() { return resultEnqueues },
    releaseReceipt() { assert.ok(releaseReceipt); releaseReceipt() },
    inbox() { return serverTransportDb.prepare('SELECT * FROM transport_inbox').all() },
    commitProbe() { return serverDb.prepare('SELECT * FROM result_commit_probe').all() },
    async ackBurst() {
      const ack = outbound.values.find(frame => frame.frameType === 'transport.ack')!
      const application = outbound.values.find(frame => frame.frameType === 'data' && frame.durability === 'durable' && frame.payload.type === 'fs.write.result.ack')!
      assert.ok(application.frameType === 'data' && application.durability === 'durable')
      const socket = (transport as unknown as { socket: WebSocket }).socket
      for (let i = 0; i < 100; i++) {
        serverSocket.send(JSON.stringify(ack))
        socket.send(JSON.stringify({ frameType: 'transport.ack', deliveryEpoch: application.deliveryEpoch, ackThrough: application.directionSeq }))
      }
      await checkpoint(); await serverCheckpoint()
    },
  }
}

for (const order of ['transport-first', 'application-first'] as const) test(`real Runtime and gateway: ${order} receipts commit independently, held intent unchanged`, { timeout: 10000 }, async () => {
  await withFixture(async f => {
    f.transport.start()
    await f.receiptGate.promise
    await f.checkpoint(); await f.serverCheckpoint()
    assert.equal(f.serverResults().length, 1)
    assert.equal(f.marker(), order === 'application-first' ? 1 : 0)
    assert.equal(f.workerOutbox().length, order === 'application-first' ? 1 : 0)
    assert.equal(f.serverOutbox().length, order === 'application-first' ? 0 : 1)
    assert.equal((await f.workerStore.fileWrites.listPendingResults(10)).length, order === 'application-first' ? 0 : 1)
    f.releaseReceipt(); await f.settled()
    const counts = [f.receiverCalls, f.ackEnqueues, f.resultEnqueues]
    await f.ackBurst(); await f.settled()
    assert.deepEqual([f.receiverCalls, f.ackEnqueues, f.resultEnqueues], counts, '100 receipts each direction never enqueue another result/ACK')
    assert.deepEqual(counts, [1, 1, 1]); assert.equal(f.connections, 1)
  }, { order })
})

for (const fault of ['insert', 'commit', 'ack-outbox'] as const) test(`real ${fault} failure: automatic Worker backoff/reconnect converges without manual retry`, { timeout: 10000 }, async () => {
  await withFixture(async f => {
    f.installFault(); f.transport.start()
    const state = await f.states.wait(value => value === 'backoff' || value === 'needs-attention')
    assert.equal(state, 'backoff', 'operational failure must not permanently stop the actual Worker')
    const error = f.outbound.values.find(frame => frame.frameType === 'transport.error')!
    assert.ok(error.frameType === 'transport.error'); assert.equal(error.retryable, true)
    assert.equal(error.code, 'temporary-unavailable'); assert.equal(error.message, 'File result storage temporarily unavailable')
    assert.equal(f.marker(), 0); assert.equal(f.resultBytes(), f.retainedBytes)
    assert.equal(f.workerOutbox().length, 1); assert.equal(f.serverOutbox().length, 0); assert.equal(f.inbox().length, 1)
    assert.equal(f.serverResults().length, fault === 'ack-outbox' ? 1 : 0)
    if (fault === 'commit') assert.deepEqual(f.commitProbe(), [], 'failed COMMIT rolled back the actual deferred-FK insertion')
    const committedBeforeRetry = f.serverResults()
    assert.equal(f.outbound.values.some(frame => frame.frameType === 'data' && frame.payload.type === 'fs.write.result.ack'), false)
    assert.equal((await f.workerStore.fileWrites.listPendingResults(10)).length, 1)
    // State barrier observed after the failure; the next onConnected callback is gated.
    // Only remove the SQLite fault/release the barrier, never start/connect/retry again.
    f.removeFault(); await f.settled()
    assert.equal(f.connections, 2); assert.equal(f.receiverCalls, 2); assert.equal(f.resultEnqueues, 2)
    const results = f.inbound.values.filter(frame => frame.frameType === 'data' && frame.payload.type === 'fs.write.result')
    assert.equal(results.length, 2)
    const [first, replay] = results
    assert.ok(first?.frameType === 'data' && first.durability === 'durable' && replay?.frameType === 'data' && replay.durability === 'durable')
    assert.equal(replay.directionSeq, first.directionSeq + 1, 'accepted hello cleans transport-only receipt; application obligation reprojects')
    assert.notEqual(replay.messageId, first.messageId)
    for (const frame of results) { assert.ok(frame.frameType === 'data'); assert.deepEqual(frame.payload, JSON.parse(f.retainedBytes)) }
    if (fault === 'ack-outbox') assert.deepEqual(f.serverResults(), committedBeforeRetry, 'ACK persistence failure never rewrites committed Server result bytes')
    const counts = [f.receiverCalls, f.ackEnqueues, f.resultEnqueues]
    await f.ackBurst(); await f.settled(); assert.equal(f.connections, 2)
    assert.deepEqual([f.receiverCalls, f.ackEnqueues, f.resultEnqueues], counts)
  }, { fault })
})
