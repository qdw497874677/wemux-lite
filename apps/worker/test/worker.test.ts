import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { createServer } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import type { CommandId, EventSeq, SessionId, Timestamp, WorkerId, WorkspaceProvisionSpec } from '@wemux/domain'
import { WEMUX_ADK_PROFILE_V1, parseWorkerTransportFrame, type ServerToWorkerFrame, type WorkerCommand, type WorkerPayload, type WorkerTransportHello } from '@wemux/wire-protocol'
import { randomUUID } from 'node:crypto'
import { SqliteWorkerStore } from '../src/storage/sqlite-store.js'
import { WorkerRuntime } from '../src/application/runtime.js'
import { TestAgent } from '../src/agents/test-agent.js'
import type { AgentAdapter } from '../src/application/ports/agent-adapter.js'
import type { RuntimeSessionAdapter } from '../src/application/ports/runtime-session.js'
import { LocalProvisioner } from '../src/workspaces/local-provisioner.js'
import { WebSocketTransport } from '../src/transport/websocket.js'
import { WorkerTransportStore } from '../src/transport/transport-store.js'
import { parseServerMessage } from '../src/transport/validation.js'
import { enroll } from '../src/transport/enrollment.js'
import { config, serverUrl } from '../src/config.js'

const workerId = 'worker' as WorkerId
const sessionId = 'session' as SessionId
const workspace = JSON.parse(JSON.stringify({ workspace: { id: '../workspace', workerId, projectId: 'project', name: 'empty', spec: { kind: 'composite', memberWorkspaceIds: [] }, status: 'pending', failureReason: null }, repositories: [] })) as WorkspaceProvisionSpec
const create = JSON.parse(JSON.stringify({ kind: 'session.create', session: { sessionId, binding: { workspaceId: workspace.workspace.id, agent: { workerId, agentKey: 'test' }, modelId: 'test' } } })) as WorkerCommand
const enqueue = (id: string): WorkerCommand => JSON.parse(JSON.stringify({ kind: 'session.enqueue', sessionId, message: { messageId: id, content: id } })) as WorkerCommand

test('Session cleanup protects queued work, deletes Journal and survives restart without resurrection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-cleanup-'))
  const path = join(dir, 'worker.db')
  let store = new SqliteWorkerStore(path)
  try {
    assert.equal(create.kind, 'session.create')
    if (create.kind !== 'session.create') throw Error('fixture')
    await store.transaction(tx => tx.sessions.createSession(sessionId, create.session.binding))
    await store.transaction(tx => tx.sessions.enqueue({ sessionId, submissionCommandId: 'enqueue-cleanup' as CommandId, message: { messageId: 'cleanup-message' as import('@wemux/domain').MessageId, content: 'retain until cancelled' }, queuedAt: new Date().toISOString() as Timestamp }))
    await assert.rejects(store.transaction(tx => tx.sessions.deleteSession(sessionId)), /active/)
    await store.transaction(tx => tx.sessions.cancelQueued(sessionId, 'enqueue-cleanup' as CommandId))
    await store.transaction(tx => tx.sessions.deleteSession(sessionId))
    assert.equal(await store.sessions.get(sessionId), null)
    assert.deepEqual(await store.journal.listHeads(), [])
    assert.equal((await store.journal.read({ sessionId, fromSeq: 1 as EventSeq, limit: 100 })).events.length, 0)
    store.close(); store = new SqliteWorkerStore(path)
    await store.transaction(tx => tx.sessions.deleteSession(sessionId))
    await assert.rejects(store.transaction(tx => tx.sessions.createSession(sessionId, create.session.binding)), /deleted/)
    assert.deepEqual(await store.journal.listHeads(), [])
  } finally { store.close(); await rm(dir, { recursive: true, force: true }) }
})

test('Worker records a rejected receipt without creating a Session for unsupported storageMode', async () => {
  const f = await fixture()
  try {
    const unsupported = { ...create, session: { ...create.session, storageMode: 'replicated' as const, sessionId: 'unsupported' as SessionId } }
    await f.send('unsupported-storage', unsupported)
    assert.equal(await f.store.sessions.get('unsupported' as SessionId), null)
    const ack = f.events.filter(event => event.type === 'ack').at(-1)
    assert.equal(ack?.type, 'ack')
    if (ack?.type === 'ack') assert.equal(ack.receipt.status, 'rejected')
    assert.equal((await f.store.commands.get('unsupported-storage' as CommandId))?.state, 'rejected')
  } finally { await f.cleanup() }
})

test('accepts plain HTTP and WS Server URLs on trusted LANs', () => {
  assert.equal(config(['register', '--token=-leading-dash'], {}).token, '-leading-dash')
  assert.equal(config(['register'], { WEMUX_ENROLLMENT_TOKEN: '-leading-dash' }).token, '-leading-dash')
  assert.equal(serverUrl('http://192.168.3.22:8004').href, 'http://192.168.3.22:8004/')
  assert.equal(serverUrl('ws://10.0.0.5:3001/worker/ws').href, 'ws://10.0.0.5:3001/worker/ws')
  assert.throws(() => serverUrl('ftp://192.168.3.22/'), /Invalid Server URL/)
  assert.throws(() => serverUrl('http://user:password@192.168.3.22/'), /Invalid Server URL/)
})

async function until(predicate: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 500; i++) { if (await predicate()) return; await delay(10) }
  assert.fail('Timed out waiting for condition')
}
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'wemux-lite-worker-'))
  const store = new SqliteWorkerStore(join(home, 'worker.sqlite'))
  const events: WorkerToServer[] = []
  const runtime = new WorkerRuntime(store, new LocalProvisioner(join(home, 'workspaces')), [new TestAgent(15)], { send: message => events.push(message) }, workerId, 'test')
  await runtime.initialize()
  const send = (id: string, command: WorkerCommand) => runtime.receive({ type: 'command', commandId: id as CommandId, command })
  await send('provision', { kind: 'workspace.provision', workspace })
  await until(async () => (await store.workspaces.get(workspace.workspace.id))?.status === 'ready')
  await send('create', create)
  return { home, store, runtime, events, send, cleanup: async () => { await runtime.shutdown(); store.close(); await rm(home, { recursive: true, force: true }) } }
}

test('FIFO, durable ACK, idempotency conflict, cancellation, stop and stream/tool events', async () => {
  const f = await fixture()
  try {
    await f.send('first', enqueue('first'))
    await until(async () => Boolean((await f.store.sessions.get(sessionId))?.activeTurnId))
    await f.send('second', enqueue('second'))
    await f.send('third', enqueue('third'))
    await f.send('second', enqueue('second'))
    await f.send('second', enqueue('conflict'))
    const ack = f.events.filter(e => e.type === 'ack').at(-1)!
    assert.equal(ack.receipt.status, 'rejected')
    await f.send('cancel', { kind: 'session.cancel-queued', sessionId, submissionCommandId: 'second' as CommandId })
    const turnId = (await f.store.sessions.get(sessionId))!.activeTurnId!
    await f.send('stop', { kind: 'turn.stop', sessionId, turnId })
    await until(async () => (await f.store.sessions.get(sessionId))?.runtimeState === 'idle')
    const journal = await f.store.journal.read({ sessionId, fromSeq: 1 as EventSeq, limit: 1000 })
    assert.deepEqual(journal.events.map(e => e.seq), journal.events.map((_,i) => i + 1))
    assert.deepEqual(journal.events.flatMap(e => e.payload.kind === 'turn.started' ? [e.payload.messageId] : []), ['first', 'third'])
    assert.equal(journal.events.filter(e => e.payload.kind === 'message.queued').length, 3)
    assert.ok(journal.events.some(e => e.payload.kind === 'turn.finished' && e.payload.outcome === 'cancelled'))
    for (const kind of ['tool.started', 'tool.output.delta', 'tool.finished', 'assistant.text.delta']) assert.ok(journal.events.some(e => e.payload.kind === kind))
    const path = (await f.store.workspaces.get(workspace.workspace.id))!.rootPath
    assert.ok(path.startsWith(join(f.home, 'workspaces')))
    for (const event of f.events) if (event.type === 'event' && event.scope === 'session') assert.deepEqual(await f.store.journal.getEvent(sessionId, event.event.seq), event.event)
    await f.runtime.receive({ type: 'sync', kind: 'request', sessionId, fromSeq: 1 as EventSeq, limit: 2 })
    const batch = f.events.at(-1)!
    assert.ok(batch.type === 'sync' && batch.kind === 'batch' && batch.hasMore && batch.throughSeq === 2)
  } finally { await f.cleanup() }
})

test('cancel versus claim ordering, duplicate commands and late stop keep the next Turn single-execution', async () => {
  const f = await fixture()
  try {
    // Hold execution of the first Turn so the two orderings are observable.
    await f.send('hold', { kind: 'session.enqueue', sessionId, message: { messageId: 'hold' as never, content: '[test-agent:pause-ms=60000] hold' } })
    await until(async () => Boolean((await f.store.sessions.get(sessionId))?.activeTurnId))
    const holdId = (await f.store.sessions.get(sessionId))!.activeTurnId!
    await f.send('before', enqueue('before'))
    await f.send('after', enqueue('after'))
    // Cancel wins the claim: the cancelled message never starts. Replaying the
    // same command cannot append a second cancellation or alter the queue.
    const cancelBefore = { kind: 'session.cancel-queued', sessionId, submissionCommandId: 'before' as CommandId } as const
    await f.send('cancel-before', cancelBefore)
    await f.send('cancel-before', cancelBefore)
    await f.send('stop-hold', { kind: 'turn.stop', sessionId, turnId: holdId })
    await until(async () => (await f.store.journal.read({ sessionId, fromSeq: 1 as EventSeq, limit: 100 })).events.some(e => e.payload.kind === 'turn.started' && e.payload.messageId === 'after'))
    const afterTurn = (await f.store.journal.read({ sessionId, fromSeq: 1 as EventSeq, limit: 100 })).events.find(e => e.payload.kind === 'turn.started' && e.payload.messageId === 'after')!
    // Claim wins the cancel: the target has already started and cannot be
    // retroactively removed. A late stop for the old Turn must not stop it.
    await f.send('cancel-after', { kind: 'session.cancel-queued', sessionId, submissionCommandId: 'after' as CommandId })
    await f.send('cancel-after', { kind: 'session.cancel-queued', sessionId, submissionCommandId: 'after' as CommandId })
    await f.send('stop-hold', { kind: 'turn.stop', sessionId, turnId: holdId })
    await f.send('late-stop-hold', { kind: 'turn.stop', sessionId, turnId: holdId })
    await until(async () => (await f.store.journal.read({ sessionId, fromSeq: 1 as EventSeq, limit: 100 })).events.some(e => e.payload.kind === 'turn.finished' && e.payload.turnId === afterTurn.payload.turnId))
    const page = await f.store.journal.read({ sessionId, fromSeq: 1 as EventSeq, limit: 100 })
    assert.deepEqual(page.events.filter(e => e.payload.kind === 'turn.started').map(e => e.payload.messageId), ['hold', 'after'])
    assert.equal(page.events.filter(e => e.payload.kind === 'message.cancelled' && e.payload.messageId === 'before').length, 1)
    assert.equal(page.events.filter(e => e.payload.kind === 'message.cancelled' && e.payload.messageId === 'after').length, 0)
    assert.equal(page.events.filter(e => e.payload.kind === 'turn.finished' && e.payload.turnId === afterTurn.payload.turnId && e.payload.outcome === 'completed').length, 1)
    assert.equal((await f.store.sessions.get(sessionId))?.activeTurnId, null)
  } finally { await f.cleanup() }
})

test('a silent agent turn fails durably instead of leaving the session running forever', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wemux-silent-agent-'))
  const store = new SqliteWorkerStore(join(home, 'worker.sqlite'))
  const silentAgent: AgentAdapter = {
    agentKey: 'test' as any,
    mode: 'execution',
    async detect() { return { agentKey: 'test' as any, displayName: 'Silent', version: '1', mode: 'execution', executablePath: null, diagnostics: [], availability: { status: 'available' }, models: [{ modelId: 'test' as any, displayName: 'test', source: 'configured' }] } },
    async startTurn() {
      let stopped = false
      return {
        signals: { async *[Symbol.asyncIterator]() { while (!stopped) await delay(100) } },
        async stop() { stopped = true },
      }
    },
  }
  const runtime = new WorkerRuntime(store, new LocalProvisioner(join(home, 'workspaces')), [silentAgent], { send() {} }, workerId, 'silent', undefined, { idleMs: 30, maxMs: 100 })
  const send = (id: string, command: WorkerCommand) => runtime.receive({ type: 'command', commandId: id as CommandId, command })
  try {
    await runtime.initialize()
    await send('provision', { kind: 'workspace.provision', workspace })
    await until(async () => (await store.workspaces.get(workspace.workspace.id))?.status === 'ready')
    await send('create', create)
    await send('silent', enqueue('silent'))
    await until(async () => (await store.sessions.get(sessionId))?.runtimeState === 'failed')
    const journal = await store.journal.read({ sessionId, fromSeq: 1 as EventSeq, limit: 100 })
    const finished = journal.events.find(event => event.payload.kind === 'turn.finished')
    assert.ok(finished?.payload.kind === 'turn.finished')
    assert.equal(finished.payload.failure?.code, 'agent-error')
    assert.match(finished.payload.failure?.message ?? '', /长时间没有产生任何事件|执行时间超过上限/)
  } finally { await runtime.shutdown(); store.close(); await rm(home, { recursive: true, force: true }) }
})

test('max runtime deadline after a published event does not request a second iterator result', async t => {
  const home = await mkdtemp(join(tmpdir(), 'wemux-max-deadline-'))
  const store = new SqliteWorkerStore(join(home, 'worker.sqlite'))
  let sawFirst = false, secondNext = 0
  const agent: AgentAdapter = {
    agentKey: 'test' as any, mode: 'execution',
    async detect() { return { agentKey: 'test' as any, displayName: 'Deadline probe', version: '1', mode: 'execution', executablePath: null, diagnostics: [], availability: { status: 'available' }, models: [{ modelId: 'test' as any, displayName: 'test', source: 'configured' }] } },
  }
  const adapter: RuntimeSessionAdapter = { async openSession() { return {
    async execute() { return { signals: { async *[Symbol.asyncIterator]() {
      sawFirst = true
      yield { kind: 'event' as const, event: { kind: 'assistant.text.delta' as const, text: 'first', streamKind: 'assistant_text' as const } }
      secondNext++
      throw new Error('second iterator read must not occur after max deadline')
    } }, async stop() {} } }, async command() {}, async resolveApproval() {}, async close() {},
  } } }
  const transaction = store.transaction.bind(store)
  t.mock.method(store, 'transaction', async (...args: Parameters<typeof store.transaction>) => {
    if (sawFirst) await delay(80)
    return transaction(...args)
  })
  const runtime = new WorkerRuntime(store, new LocalProvisioner(join(home, 'workspaces')), [agent], { send() {} }, workerId, 'deadline', undefined, { idleMs: 1000, maxMs: 40 }, new Map([[agent.agentKey, adapter]]))
  const send = (id: string, command: WorkerCommand) => runtime.receive({ type: 'command', commandId: id as CommandId, command })
  try {
    await runtime.initialize()
    await send('provision', { kind: 'workspace.provision', workspace })
    await until(async () => (await store.workspaces.get(workspace.workspace.id))?.status === 'ready')
    await send('create', create)
    await send('deadline', enqueue('deadline'))
    await until(async () => (await store.sessions.get(sessionId))?.runtimeState === 'failed')
    const page = await store.journal.read({ sessionId, fromSeq: 1 as EventSeq, limit: 100 })
    assert.equal(sawFirst, true, 'fixture must deliver the first signal')
    const firstDelta = page.events.find(event => event.payload.kind === 'assistant.text.delta' && event.payload.text === 'first')
    assert.ok(firstDelta, 'first assistant event must persist before the maximum-deadline failure')
    const terminal = page.events.find(event => event.payload.kind === 'turn.finished')
    assert.ok(terminal && firstDelta.seq < terminal.seq, 'maximum deadline is reached after the first event is published')
    assert.equal(terminal?.payload.kind, 'turn.finished')
    if (terminal?.payload.kind === 'turn.finished') {
      assert.equal(terminal.payload.failure?.abortReason, 'timeout')
      assert.match(terminal.payload.failure?.message ?? '', /执行时间超过上限/)
    }
    assert.equal(secondNext, 0)
  } finally { await runtime.shutdown(); store.close(); await rm(home, { recursive: true, force: true }) }
})

test('explicit stop does not convert a non-Pi adapter abort into cancelled', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wemux-abort-stop-'))
  const store = new SqliteWorkerStore(join(home, 'worker.sqlite'))
  let fail!: (error: Error) => void
  let started!: () => void
  const executing = new Promise<void>(resolve => { started = resolve })
  const gate = new Promise<never>((_resolve, reject) => { fail = reject })
  const agent: AgentAdapter = {
    agentKey: 'test' as any,
    mode: 'execution',
    async detect() { return { agentKey: 'test' as any, displayName: 'Native abort probe', version: '1', mode: 'execution', executablePath: null, diagnostics: [], availability: { status: 'available' }, models: [{ modelId: 'test' as any, displayName: 'test', source: 'configured' }] } },
  }
  const adapter: RuntimeSessionAdapter = { async openSession() { return {
    async execute() { return { signals: { async *[Symbol.asyncIterator]() { started(); await gate } }, async stop() { fail(new Error('This operation was aborted')) } } },
    async command() {}, async resolveApproval() {}, async close() {},
  } } }
  const runtime = new WorkerRuntime(store, new LocalProvisioner(join(home, 'workspaces')), [agent], { send() {} }, workerId, 'abort-stop', undefined, undefined, new Map([[agent.agentKey, adapter]]))
  const send = (id: string, command: WorkerCommand) => runtime.receive({ type: 'command', commandId: id as CommandId, command })
  try {
    await runtime.initialize()
    await send('provision', { kind: 'workspace.provision', workspace })
    await until(async () => (await store.workspaces.get(workspace.workspace.id))?.status === 'ready')
    await send('create', create)
    await send('abort-me', enqueue('abort-me'))
    await executing
    const turnId = (await store.sessions.get(sessionId))!.activeTurnId!
    await send('stop', { kind: 'turn.stop', sessionId, turnId })
    await until(async () => Boolean((await store.journal.read({ sessionId, fromSeq: 1 as EventSeq, limit: 100 })).events.find(event => event.payload.kind === 'turn.finished')))
    const page = await store.journal.read({ sessionId, fromSeq: 1 as EventSeq, limit: 100 })
    assert.equal(page.events.find(event => event.payload.kind === 'turn.finished')?.payload.outcome, 'failed')
    assert.equal(page.events.some(event => event.payload.kind === 'turn.finished' && event.payload.failure?.abortReason === 'provider_error'), true)
  } finally { await runtime.shutdown(); store.close(); await rm(home, { recursive: true, force: true }) }
})

test('slow workspace provisioning does not block unrelated command handling', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wemux-provision-concurrency-'))
  const store = new SqliteWorkerStore(join(home, 'worker.sqlite'))
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const runtime = new WorkerRuntime(store, { async provision() { await gate; return { rootPath: home, checkouts: [] } } }, [new TestAgent(1)], { send() {} }, workerId, 'test')
  try {
    await runtime.initialize()
    const provision = runtime.receive({ type: 'command', commandId: 'slow-provision' as CommandId, command: { kind: 'workspace.provision', workspace } })
    await provision
    const startedAt = Date.now()
    await runtime.receive({ type: 'sync', kind: 'request', sessionId, fromSeq: 1 as EventSeq, limit: 1 })
    assert.ok(Date.now() - startedAt < 100, 'sync should not wait for the provisioner')
  } finally { release(); await runtime.shutdown(); store.close(); await rm(home, { recursive: true, force: true }) }
})

test('SQLite rollback, restart interruption, queued recovery and persistent identity/capabilities', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wemux-recovery-'))
  const path = join(home, 'db')
  let store = new SqliteWorkerStore(path)
  try {
    store.saveIdentity({ workerId, serverUrl: 'ws://localhost', credentialRef: 'credential', enrolledAt: new Date().toISOString() as Timestamp })
    await assert.rejects(store.transaction(async tx => { await tx.sessions.createSession(sessionId, (create as Extract<WorkerCommand,{kind:'session.create'}>).session.binding); throw new Error('rollback') }))
    assert.equal(await store.sessions.get(sessionId), null)
    await store.transaction(async tx => {
      await tx.workspaces.save({ ...workspace.workspace, rootPath: home, updatedAt: new Date().toISOString() as Timestamp, status: 'ready' })
      await tx.sessions.createSession(sessionId, (create as Extract<WorkerCommand,{kind:'session.create'}>).session.binding)
      for (const id of ['one', 'two']) await tx.sessions.enqueue({ sessionId, submissionCommandId: id as CommandId, message: (enqueue(id) as Extract<WorkerCommand,{kind:'session.enqueue'}>).message, queuedAt: new Date().toISOString() as Timestamp })
      await tx.sessions.claimNext(sessionId)
    })
    store.close(); store = new SqliteWorkerStore(path)
    assert.equal(store.identity()?.workerId, workerId)
    const runtime = new WorkerRuntime(store, new LocalProvisioner(home), [new TestAgent(1)], { send() {} }, workerId, 'recovery')
    await runtime.initialize()
    await until(async () => (await store.sessions.get(sessionId))?.runtimeState === 'idle')
    const page = await store.journal.read({ sessionId, fromSeq: 1 as EventSeq, limit: 1000 })
    assert.ok(page.events.some(e => e.payload.kind === 'turn.finished' && e.payload.failure?.code === 'interrupted'))
    assert.equal(page.events.filter(e => e.payload.kind === 'turn.started').length, 2)
    await runtime.shutdown()
    store.close(); store = new SqliteWorkerStore(path)
    assert.equal(store.capabilities()[0].agentKey, 'test')
    assert.equal((await store.sessions.listQueued(sessionId)).length, 0)
  } finally { store.close(); await rm(home, { recursive: true, force: true }) }
})

test('real transport-v2 ws connection authenticates, handshakes, delivers commands and replays after reconnect', async () => {
  const f = await fixture()
  const server = new WebSocketServer({ port: 0 })
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address()
  assert.ok(typeof address === 'object' && address)
  const messages: WorkerPayload[] = []
  let peer: WebSocket | undefined
  let connections = 0
  let serverSeq = 0
  let resolveTransportEvent!: () => void
  let transportEvent = new Promise<void>(resolve => { resolveTransportEvent = resolve })
  const serverEpoch = randomUUID()
  server.on('connection', (socket, request) => {
    assert.equal(request.headers.authorization, 'Bearer secret')
    peer = socket; connections++
    socket.on('message', raw => {
      const frame = parseWorkerTransportFrame(JSON.parse(raw.toString()))
      if (frame.frameType === 'transport.hello') {
        const hello = frame as WorkerTransportHello
        socket.send(JSON.stringify({
          frameType: 'transport.hello', side: 'server', selectedTransport: { major: 2, minor: 0 }, selectedAdkProfile: WEMUX_ADK_PROFILE_V1,
          enabledFeatures: [], logicalConnectionId: randomUUID(), connectionEpoch: randomUUID(), resumeAccepted: true,
          authoritativeCursors: { workerToServer: hello.resume.workerToServer!, serverToWorker: { deliveryEpoch: serverEpoch, ackThrough: serverSeq } },
          acceptedAt: new Date().toISOString(),
        } satisfies ServerToWorkerFrame))
      } else if (frame.frameType === 'data') {
        messages.push(frame.payload)
        if (frame.durability === 'durable') socket.send(JSON.stringify({ frameType: 'transport.ack', deliveryEpoch: frame.deliveryEpoch, ackThrough: frame.directionSeq } satisfies ServerToWorkerFrame))
        resolveTransportEvent()
      }
    })
  })
  const runtime = new WorkerRuntime(f.store, new LocalProvisioner(join(f.home, 'workspaces')), [new TestAgent(1)], { send: message => transport.send(message) }, workerId, 'network')
  const transport = new WebSocketTransport({
    url: `ws://127.0.0.1:${address.port}`, authToken: 'secret', workerId, workerVersion: 'test', name: 'network', platform: 'linux', architecture: 'x64',
    store: new WorkerTransportStore(join(f.home, 'transport.sqlite')), onMessage: message => { void runtime.receive(message) }, onConnected: () => { void runtime.connected() }, random: () => 0,
    retry: { baseDelayMs: 10, maxDelayMs: 10, jitterRatio: 0, stableConnectionMs: 100 },
  })
  const send = async (payload: import('@wemux/wire-protocol').ServerPayload) => {
    serverSeq++
    transportEvent = new Promise<void>(resolve => { resolveTransportEvent = resolve })
    peer!.send(JSON.stringify({ frameType: 'data', durability: 'durable', deliveryEpoch: serverEpoch, directionSeq: serverSeq, messageId: randomUUID(), lane: 'command', payloadVersion: 'wemux.server.payload.v1', expiresAt: null, payload } satisfies ServerToWorkerFrame))
    await transportEvent
  }
  try {
    await runtime.initialize(); transport.start()
    await until(() => messages.some(m => m.type === 'capability'))
    await send({ type: 'command', commandId: 'network' as CommandId, command: enqueue('network') })
    await until(() => messages.some(m => m.type === 'event' && m.scope === 'session' && m.event.payload.kind === 'turn.finished'))
    peer!.terminate()
    await until(() => connections === 2 && messages.filter(m => m.type === 'sync' && m.kind === 'heads').length === 2)
    await send({ type: 'sync', kind: 'request', sessionId, fromSeq: 1 as EventSeq, limit: 1000 })
    await until(() => messages.some(m => m.type === 'sync' && m.kind === 'batch'))
    const batch = messages.find(m => m.type === 'sync' && m.kind === 'batch')!
    assert.ok(batch.type === 'sync' && batch.kind === 'batch' && batch.events.length > 5 && !batch.hasMore)
  } finally {
    transport.stop(); await runtime.shutdown()
    for (const client of server.clients) client.terminate()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await f.cleanup()
  }
})

test('empty workspace provisions an isolated empty directory without a repository', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wemux-empty-'))
  try {
    const provisioner = new LocalProvisioner(root)
    const result = await provisioner.provision(workspace)
    assert.equal(result.checkouts.length, 0)
    assert.equal((await readdir(result.rootPath)).length, 0)
    assert.deepEqual(await provisioner.provision(workspace), result)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('git clone uses allocated paths, is idempotent, rejects mismatched sources', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wemux-git-'))
  try {
    const source = join(home, 'source')
    execFileSync('git', ['init', source], { stdio: 'ignore' })
    execFileSync('git', ['-C', source, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--allow-empty', '-m', 'init'], { stdio: 'ignore' })
    const input = JSON.parse(JSON.stringify({ workspace: { ...workspace.workspace, spec: { kind: 'repository', repositoryId: 'repo', ownership: { kind: 'standalone' } } }, repositories: [{ repositoryId: 'repo', gitUrl: source, revision: 'HEAD' }] })) as WorkspaceProvisionSpec
    const provisioner = new LocalProvisioner(join(home, 'managed'))
    const first = await provisioner.provision(input)
    assert.equal((await provisioner.provision(input)).rootPath, first.rootPath)
    assert.ok(await readFile(join(first.rootPath, '.git', 'HEAD'), 'utf8'))
    assert.equal(execFileSync('git', ['-C', first.rootPath, 'status', '--porcelain'], { encoding: 'utf8' }), '')
    await assert.rejects(provisioner.provision({ ...input, repositories: [] }))
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('boundary requires a strict transport-v2 data frame', () => {
  assert.throws(() => parseServerMessage(JSON.stringify({ type: 'command', commandId: 'a', command: enqueue('x') })))
  assert.throws(() => parseServerMessage(JSON.stringify({ frameType: 'data', durability: 'durable', deliveryEpoch: 'server', directionSeq: 0, messageId: randomUUID(), lane: 'command', payloadVersion: 'wemux.server.payload.v1', expiresAt: null, payload: { type: 'command', commandId: 'a', command: enqueue('x') } })))
  const payload = parseServerMessage(JSON.stringify({ frameType: 'data', durability: 'durable', deliveryEpoch: 'server', directionSeq: 1, messageId: randomUUID(), lane: 'command', payloadVersion: 'wemux.server.payload.v1', expiresAt: null, payload: { type: 'command', commandId: 'a', command: enqueue('x') } }))
  assert.equal(payload.type, 'command')
})

test('enrollment exchanges token without persisting or reusing it as credential', async () => {
  const server = createServer((request, response) => {
    assert.equal(request.url, '/api/worker-enrollments')
    assert.equal(request.headers.authorization, 'Bearer once')
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ workerId, credential: 'long-lived' }))
  })
  server.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address()!
  assert.ok(typeof address === 'object')
  try {
    const result = await enroll({ server: `http://127.0.0.1:${address.port}`, token: 'once', name: 'test', enrollmentPath: '/api/worker-enrollments', socketPath: '/api/worker-connections' })
    assert.equal(result.credential, 'long-lived')
    assert.equal(result.identity.serverUrl, `ws://127.0.0.1:${address.port}/api/worker-connections`)
    assert.equal(result.identity.name, 'test', 'identity 必须携带注册名，start 时优先于 hostname')
    assert.ok(!JSON.stringify(result.identity).includes('once'))
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})
