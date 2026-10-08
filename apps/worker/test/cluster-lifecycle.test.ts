import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import type { Timestamp, WorkerId } from '@wemux/domain'
import { SqliteWorkerStore } from '../src/storage/sqlite-store.js'
import { ensureLocalInstallation } from '../src/application/local-installation.js'
import { createLocalWorkbenchService } from '../src/application/local-workbench.js'
import { ClusterLifecycle, clusterCandidateUrls } from '../src/application/cluster-lifecycle.js'
import { TestAgent } from '../src/agents/test-agent.js'
import { TestRuntimeSessionAdapter } from '../src/agents/test-runtime-session-adapter.js'
import { WorkerRuntime } from '../src/application/runtime.js'
import { main } from '../src/cli.js'
import { WEMUX_ADK_PROFILE_V1, parseWorkerTransportFrame, type TransportWorkerHello } from '@wemux/wire-protocol'

function acceptTransportV2(socket: WebSocket) {
  socket.once('message', raw => {
    const hello = parseWorkerTransportFrame(JSON.parse(raw.toString()))
    assert.equal(hello.frameType, 'transport.hello')
    assert.equal(hello.side, 'worker')
    const workerHello = hello as TransportWorkerHello
    socket.send(JSON.stringify({
      frameType: 'transport.hello', side: 'server', selectedTransport: { major: 2, minor: 0 },
      selectedAdkProfile: WEMUX_ADK_PROFILE_V1, enabledFeatures: [],
      logicalConnectionId: randomUUID(), connectionEpoch: randomUUID(), resumeAccepted: true,
      authoritativeCursors: {
        workerToServer: workerHello.resume.workerToServer,
        serverToWorker: { deliveryEpoch: randomUUID(), ackThrough: 0 },
      },
      acceptedAt: new Date().toISOString(),
    }))
  })
}

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'wemux-lifecycle-'))
  const store = new SqliteWorkerStore(join(home, 'worker.sqlite'))
  ensureLocalInstallation(store, 'local-node')
  const lifecycle = new ClusterLifecycle(store, [new TestAgent(1)], { home, name: 'local-node', enrollmentPath: '/api/workers/enroll', socketPath: '/ws/worker', prefer: 'any' })
  const identity = (url = 'ws://127.0.0.1:1/ws/worker') => store.saveIdentity({ workerId: 'cluster-worker' as WorkerId, serverUrl: url, credentialRef: 'credential', enrolledAt: new Date().toISOString() as Timestamp })
  return { home, store, lifecycle, identity, async close() { await lifecycle.close(); store.close(); await rm(home, { recursive: true, force: true }) } }
}

async function waitFor(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('condition timed out')
}

for (const protocol of ['ws', 'wss']) test(`leave converts ${protocol} identity to HTTP(S) origin and bounds revocation`, async t => {
  const f = await fixture()
  try {
    f.identity(`${protocol}://example.test:8443/ws/worker`)
    await writeFile(join(f.home, 'credential'), 'secret')
    t.mock.method(globalThis, 'fetch', async (input: URL | string, init: RequestInit) => {
      assert.equal(String(input), `${protocol === 'ws' ? 'http' : 'https'}://example.test:8443/api/workers/cluster-worker/enrollment`)
      assert.equal(init.method, 'DELETE')
      assert.equal(init.redirect, 'error')
      assert.ok(init.signal instanceof AbortSignal)
      return new Response(null, { status: 204 })
    })
    await f.lifecycle.leave()
    assert.equal(f.store.identity(), null)
    await assert.rejects(readFile(join(f.home, 'credential')), /ENOENT/)
  } finally { await f.close() }
})

test('local managed Agent installation reports progress, prevents duplicates and retains prior selection on failure', async () => {
  const f = await fixture()
  try {
    let finish!: (value: Awaited<ReturnType<typeof import('../src/runtimes/management.js').installAgent>>) => void
    const pending = new Promise<Awaited<ReturnType<typeof import('../src/runtimes/management.js').installAgent>>>(resolve => { finish = resolve })
    const install = async () => pending
    assert.equal(f.lifecycle.beginAgentInstallation('pi', install).phase, 'installing')
    assert.throws(() => f.lifecycle.beginAgentInstallation('pi', install), /已有 Agent 安装/)
    finish({ key: 'pi', executable: '/unused', source: 'managed', package: 'pinned', version: '1', message: '重启 Worker 后生效' })
    await waitFor(() => f.lifecycle.agentInstallation()?.phase === 'ready')
    assert.match(f.lifecycle.agentInstallation()?.message ?? '', /重启 Worker/)
    f.lifecycle.beginAgentInstallation('pi', async () => { throw new Error('secret-looking-install-failure') })
    await waitFor(() => f.lifecycle.agentInstallation()?.phase === 'failed')
    assert.doesNotMatch(f.lifecycle.agentInstallation()?.message ?? '', /secret-looking/)
    assert.equal(await readFile(join(f.home, 'agents.json'), 'utf8').catch(() => ''), '')
  } finally { await f.close() }
})

test('connect failure restores local execution and pause/leave preserve local sessions and journal', async t => {
  const f = await fixture()
  try {
    await f.lifecycle.initializeLocalRuntime()
    const workbench = createLocalWorkbenchService(f.store, f.lifecycle)
    const directory = await workbench.addDirectory(f.home)
    const session = await workbench.createSession({ workspaceId: directory.workspaceId, agentKey: 'test', modelId: 'test' })
    await workbench.enqueue(session.sessionId, 'before connect')
    await waitFor(async () => (await workbench.journal(session.sessionId, 1, 200)).events.some(event => event.payload.kind === 'turn.finished'))
    const before = await workbench.journal(session.sessionId, 1, 200)
    f.identity()
    await assert.rejects(f.lifecycle.connect(), /ENOENT/)
    assert.equal(f.lifecycle.connection().phase, 'degraded')
    assert.equal((await workbench.enqueue(session.sessionId, 'after failure')).status, 'accepted')
    await f.lifecycle.pause()
    t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('fetch failed') })
    await writeFile(join(f.home, 'credential'), 'secret')
    await assert.rejects(f.lifecycle.leave(), /本地.*退出.*远端.*未确认/)
    assert.equal(f.store.identity(), null)
    assert.match(f.lifecycle.connection().failure!, /远端.*未确认/)
    assert.equal((await workbench.listSessions())[0].sessionId, session.sessionId)
    assert.deepEqual((await workbench.journal(session.sessionId, 1, 200)).events.slice(0, before.events.length), before.events)
    assert.equal((await workbench.enqueue(session.sessionId, 'after detach')).status, 'accepted')
  } finally { await f.close() }
})

test('leave timeout detaches locally and reports unconfirmed revocation', async t => {
  const f = await fixture()
  const timeout = AbortSignal.timeout.bind(AbortSignal)
  t.mock.method(AbortSignal, 'timeout', (ms: number) => { assert.equal(ms, 5000); return timeout(10) })
  t.mock.method(globalThis, 'fetch', async (_input: URL, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
  }))
  const keepAlive = setInterval(() => {}, 1000)
  try {
    f.identity()
    await writeFile(join(f.home, 'credential'), 'secret')
    await assert.rejects(f.lifecycle.leave(), /远端.*未确认/)
    assert.equal(f.store.identity(), null)
    await assert.rejects(readFile(join(f.home, 'credential')), /ENOENT/)
    const workbench = createLocalWorkbenchService(f.store, f.lifecycle)
    const directory = await workbench.addDirectory(f.home)
    assert.ok(await workbench.createSession({ workspaceId: directory.workspaceId, agentKey: 'test', modelId: 'test' }))
  } finally { clearInterval(keepAlive); await f.close() }
})

test('failed cluster runtime initialization is cleaned up and restores local runtime', async t => {
  const f = await fixture()
  const initialize = WorkerRuntime.prototype.initialize
  let attempts = 0
  t.mock.method(WorkerRuntime.prototype, 'initialize', async function (this: WorkerRuntime) {
    if (++attempts === 2) throw new Error('cluster initialization failed')
    await initialize.call(this)
  })
  try {
    await f.lifecycle.initializeLocalRuntime()
    f.identity()
    await writeFile(join(f.home, 'credential'), 'secret')
    await assert.rejects(f.lifecycle.connect(), /cluster initialization failed/)
    assert.equal(attempts, 3)
    const workbench = createLocalWorkbenchService(f.store, f.lifecycle)
    const directory = await workbench.addDirectory(f.home)
    assert.ok(await workbench.createSession({ workspaceId: directory.workspaceId, agentKey: 'test', modelId: 'test' }))
  } finally { await f.close() }
})

test('concurrent initialization and connect calls have one runtime and connection owner', async t => {
  const f = await fixture()
  let initialized = 0
  const initialize = WorkerRuntime.prototype.initialize
  t.mock.method(WorkerRuntime.prototype, 'initialize', async function (this: WorkerRuntime) { initialized++; await initialize.call(this) })
  const server = createServer()
  const sockets = new WebSocketServer({ server })
  let connections = 0
  sockets.on('connection', () => { connections++ })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    await Promise.all([f.lifecycle.initializeLocalRuntime(), f.lifecycle.initializeLocalRuntime()])
    assert.equal(initialized, 1)
    f.identity(`ws://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/ws/worker`)
    await writeFile(join(f.home, 'credential'), 'secret')
    await Promise.all([f.lifecycle.connect(), f.lifecycle.connect(), f.lifecycle.resume()])
    await waitFor(() => connections > 0)
    assert.equal(connections, 1)
    assert.equal(initialized, 2)
  } finally {
    await f.close()
    for (const socket of sockets.clients) socket.terminate()
    await new Promise<void>(resolve => sockets.close(() => resolve()))
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('concurrent enroll and connect serialize identity exchange and reject duplicate enrollment', async t => {
  const f = await fixture()
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => {
    requests++
    await new Promise(resolve => setTimeout(resolve, 20))
    return Response.json({ workerId: 'cluster-worker', credential: 'secret' })
  })
  try {
    const input = { serverUrl: 'http://127.0.0.1:1', token: 'token' }
    const results = await Promise.allSettled([f.lifecycle.enroll(input), f.lifecycle.enroll(input), f.lifecycle.connect()])
    assert.equal(results[0].status, 'fulfilled')
    assert.equal(results[1].status, 'rejected')
    assert.equal(results[2].status, 'fulfilled')
    assert.equal(requests, 1)
  } finally { await f.close() }
})

test('CLI persisted identity startup uses ClusterLifecycle as its single owner', async t => {
  const f = await fixture()
  f.identity()
  let connects = 0
  let closes = 0
  t.mock.method(ClusterLifecycle.prototype, 'connect', async () => { connects++ })
  const close = ClusterLifecycle.prototype.close
  t.mock.method(ClusterLifecycle.prototype, 'close', async function (this: ClusterLifecycle) { closes++; await close.call(this) })
  const running = main(['start', '--home', f.home])
  // Observe rejection immediately, including on the pre-fix CLI path.
  let failure: unknown
  const settled = running.catch(error => { failure = error })
  try {
    await waitFor(() => connects > 0 || failure !== undefined)
    assert.equal(failure, undefined)
    assert.equal(connects, 1)
    await waitFor(() => process.listenerCount('SIGTERM') > 0)
    process.emit('SIGTERM')
    await settled
    assert.equal(closes, 1)
  } finally {
    if (process.listenerCount('SIGTERM')) process.emit('SIGTERM')
    await settled
    await f.close()
  }
})

test('connect proceeds when previous runtime shutdown hangs on a stuck agent turn', async t => {
  // 回归：local runtime 上有一个永不结束的 turn（provider 子进程挂死、stop/close 均无响应）时，
  // connect() 不得被 previous.shutdown() 永久阻塞：先同步强杀，再限时等待旧 runtime 收尾。
  const f = await fixture()
  const server = createServer()
  const sockets = new WebSocketServer({ server })
  let connections = 0
  sockets.on('connection', socket => { connections++; acceptTransportV2(socket) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const closeAttempts: string[] = []
  let executeStarted = false
  let releaseProcess!: () => void
  const processExited = new Promise<void>(resolve => { releaseProcess = resolve })
  const stuckSession = {
    execute: async () => {
      executeStarted = true
      return {
        signals: (async function* () { await processExited })(),
        stop: async () => { await processExited },
      }
    },
    command: async () => {},
    resolveApproval: async () => {},
    close: async () => { closeAttempts.push('close'); await new Promise(() => {}) },
    kill: () => { closeAttempts.push('kill'); releaseProcess() },
  }
  t.mock.method(TestRuntimeSessionAdapter.prototype, 'openSession', async () => stuckSession)
  try {
    await f.lifecycle.initializeLocalRuntime()
    const workbench = createLocalWorkbenchService(f.store, f.lifecycle)
    const directory = await workbench.addDirectory(f.home)
    const session = await workbench.createSession({ workspaceId: directory.workspaceId, agentKey: 'test', modelId: 'test' })
    // 直接驱动 runtime 执行 turn（不经过 initialize 的重放），确保 execute() 被调用并卡死，
    // 从而占住 session serial 锁——这正是 connect() 必须绕过的挂起状态。
    const runtime = (f.lifecycle as unknown as { runtime: { executeLocal(commandId: string, command: unknown): Promise<unknown> } }).runtime
    await runtime.executeLocal('cmd-stuck', { kind: 'session.enqueue', sessionId: session.sessionId, message: { messageId: 'msg-stuck', content: 'hang forever' } })
    await waitFor(() => executeStarted)
    // turn 已进入卡死的 execute；现在 identity 就绪并 connect
    f.identity(`ws://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/ws/worker`)
    await writeFile(join(f.home, 'credential'), 'secret')
    const raced = await Promise.race([
      f.lifecycle.connect().then(() => 'connected', () => 'rejected'),
      new Promise(resolve => setTimeout(() => resolve('timeout'), 4000).unref()),
    ])
    assert.equal(raced, 'connected', 'connect() must not block on a hung previous runtime shutdown')
    await waitFor(() => connections > 0 && f.lifecycle.connection().phase === 'online')
    assert.deepEqual(closeAttempts.slice(0, 1), ['kill'], 'runtime replacement must synchronously kill the stuck provider')
  } finally {
    for (const socket of sockets.clients) socket.terminate()
    await new Promise<void>(resolve => sockets.close(() => resolve()))
    await new Promise<void>(resolve => server.close(() => resolve()))
    await f.close().catch(() => {})
  }
})

test('real capability gateway journals Connector expiry before local Turn cleanup and reopens durably', { timeout: 10000 }, async t => {
  const f = await fixture()
  let call: Promise<Response> | undefined, externalCalls = 0
  const { HttpConnectorExecutor } = await import('../src/connectors/http-executor.ts')
  t.mock.method(HttpConnectorExecutor.prototype, 'execute', async () => { externalCalls++; throw new Error('External execution forbidden in expiry test') })
  t.mock.method(TestRuntimeSessionAdapter.prototype, 'openSession', async () => ({
    execute: async input => ({
      signals: (async function* () {
        const context = input.launchContext!
        assert.ok(context.capabilityEndpoint); assert.ok(context.capabilityToken)
        call = fetch(`${context.capabilityEndpoint}/http.call`, { method: 'POST', headers: { authorization: `Bearer ${context.capabilityToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ connectorId: 'expiry-http', connectorRevision: 1, operationId: 'write', requestId: 'expiry-request', toolCallId: 'expiry-call', input: { body: {} } }) })
        // Observe failures immediately; final assertions still await the original call.
        void call.catch(() => {})
        await waitFor(() => f.lifecycle.listConnectorApprovals().length === 1)
        yield { kind: 'finished' as const, outcome: { status: 'completed' as const } }
      })(), stop: async () => {},
    }), command: async () => {}, resolveApproval: async () => {}, close: async () => {},
  }))
  try {
    const now = new Date().toISOString() as Timestamp
    await f.store.saveConnectorDefinition({ id: 'expiry-http' as never, projectId: 'local' as never, kind: 'http', name: 'Expiry fixture', description: null, revision: 1, enabled: true, allowedWorkerIds: [], credentialRef: null, credentialAvailability: 'not_required', riskDefaults: { requireApprovalForRead: false, allowMcpReadOnlyHint: false }, config: { baseUrl: 'https://fixture.example.test', authentication: 'none', publicHeaders: {}, allowedOperations: [{ id: 'write', method: 'POST', pathTemplate: '/items', allowedQueryNames: [], allowedRequestHeaderNames: [], requestContentTypes: ['application/json'] }], allowPrivateNetwork: false }, createdAt: now, updatedAt: now })
    await f.lifecycle.initializeLocalRuntime()
    const workbench = createLocalWorkbenchService(f.store, f.lifecycle)
    const directory = await workbench.addDirectory(f.home)
    const session = await workbench.createSession({ workspaceId: directory.workspaceId, agentKey: 'test', modelId: 'test' })
    await workbench.enqueue(session.sessionId, 'release approval on completion')
    await waitFor(async () => (await workbench.journal(session.sessionId, 1, 200)).events.some(e => e.payload.kind === 'approval.expired'))
    assert.ok(call)
    const response = await call
    assert.equal(response.status, 200)
    assert.equal((await response.json() as { error: { code: string } }).error.code, 'approval_denied')
    await waitFor(async () => (await f.store.sessions.get(session.sessionId))?.activeTurnId === null)
    const before = await workbench.journal(session.sessionId, 1, 200)
    const approvals = before.events.filter(e => e.payload.kind.startsWith('approval.'))
    assert.deepEqual(approvals.map(e => e.payload.kind), ['approval.requested', 'approval.expired'])
    const requested = approvals[0]!.payload, expired = approvals[1]!.payload
    assert.equal(requested.kind, 'approval.requested'); assert.equal(expired.kind, 'approval.expired')
    if (requested.kind === 'approval.requested' && expired.kind === 'approval.expired') {
      assert.equal(expired.reason, 'turn_released'); assert.equal(expired.turnId, requested.turnId); assert.equal(expired.approvalId, requested.approvalId)
    }
    assert.equal(externalCalls, 0); assert.deepEqual(f.lifecycle.listConnectorApprovals(), []); assert.deepEqual(await workbench.approvals(session.sessionId), [])
    await f.lifecycle.close()
    const reopened = new SqliteWorkerStore(join(f.home, 'worker.sqlite'))
    try { assert.deepEqual(await reopened.journal.read({ sessionId: session.sessionId, fromSeq: 1 as never, limit: 200 }), before) } finally { reopened.close() }
  } finally { await f.close() }
})

test('real local capability gateway persists timeout expiry before Turn release and across reopen', { timeout: 10000 }, async t => {
  const f = await fixture()
  const { HttpConnectorExecutor } = await import('../src/connectors/http-executor.ts')
  let externalCalls = 0
  t.mock.method(HttpConnectorExecutor.prototype, 'execute', async () => { externalCalls++; throw new Error('External execution forbidden in timeout test') })
  let call: Promise<Response> | undefined
  let approvalPending!: () => void
  t.mock.method(TestRuntimeSessionAdapter.prototype, 'openSession', async () => ({
    execute: async input => ({
      signals: (async function* () {
        const context = input.launchContext!
        call = fetch(`${context.capabilityEndpoint}/http.call`, {
          method: 'POST', headers: { authorization: `Bearer ${context.capabilityToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ connectorId: 'timeout-http', connectorRevision: 1, operationId: 'write', requestId: 'timeout-request', toolCallId: 'timeout-call', input: { body: {} } }),
        })
        void call.catch(() => {})
        const deadline = Date.now() + 3000
        while (f.lifecycle.listConnectorApprovals().length === 0 && Date.now() < deadline) await new Promise<void>(resolve => setImmediate(resolve))
        assert.equal(f.lifecycle.listConnectorApprovals().length, 1)
        approvalPending()
        await call
        yield { kind: 'finished' as const, outcome: { status: 'completed' as const } }
      })(), stop: async () => {},
    }), command: async () => {}, resolveApproval: async () => {}, close: async () => {},
  }))
  try {
    const now = new Date().toISOString() as Timestamp
    await f.store.saveConnectorDefinition({ id: 'timeout-http' as never, projectId: 'local' as never, kind: 'http', name: 'Timeout fixture', description: null, revision: 1, enabled: true, allowedWorkerIds: [], credentialRef: null, credentialAvailability: 'not_required', riskDefaults: { requireApprovalForRead: false, allowMcpReadOnlyHint: false }, config: { baseUrl: 'https://fixture.example.test', authentication: 'none', publicHeaders: {}, allowedOperations: [{ id: 'write', method: 'POST', pathTemplate: '/items', allowedQueryNames: [], allowedRequestHeaderNames: [], requestContentTypes: ['application/json'] }], allowPrivateNetwork: false }, createdAt: now, updatedAt: now })
    await f.lifecycle.initializeLocalRuntime()
    const workbench = createLocalWorkbenchService(f.store, f.lifecycle)
    const directory = await workbench.addDirectory(f.home)
    const session = await workbench.createSession({ workspaceId: directory.workspaceId, agentKey: 'test', modelId: 'test' })
    const pending = new Promise<void>(resolve => { approvalPending = resolve })
    t.mock.timers.enable({ apis: ['setTimeout'] })
    await workbench.enqueue(session.sessionId, 'time out approval')
    await pending
    const before = await workbench.journal(session.sessionId, 1, 100)
    assert.deepEqual(before.events.filter(event => event.payload.kind.startsWith('approval.')).map(event => event.payload.kind), ['approval.requested'])
    // Drive every idle watchdog tick separately so each pending-approval check
    // runs; one synchronous five-minute leap would conceal a watchdog failure.
    for (let interval = 0; interval < 10; interval++) {
      t.mock.timers.tick(30_000 - (interval === 9 ? 1 : 0))
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(f.lifecycle.listConnectorApprovals().length, 1, `approval remains pending through idle tick ${interval + 1}`)
      assert.notEqual((await f.store.sessions.get(session.sessionId))?.activeTurnId, null)
    }
    assert.equal(f.lifecycle.listConnectorApprovals().length, 1, 'approval must not expire before its five-minute deadline')
    assert.equal((await workbench.journal(session.sessionId, 1, 100)).events.some(event => event.payload.kind === 'approval.expired'), false)
    assert.notEqual((await f.store.sessions.get(session.sessionId))?.activeTurnId, null, 'idle watchdog must not terminate a Turn awaiting human approval')
    t.mock.timers.tick(1)
    assert.ok(call)
    const response = await call
    assert.equal((await response.json() as { error: { code: string } }).error.code, 'approval_denied')
    await waitFor(async () => (await workbench.journal(session.sessionId, 1, 100)).events.some(event => event.payload.kind === 'approval.expired'))
    const after = await workbench.journal(session.sessionId, 1, 100)
    const approvals = after.events.filter(event => event.payload.kind.startsWith('approval.'))
    assert.deepEqual(approvals.map(event => event.payload.kind), ['approval.requested', 'approval.expired'])
    assert.equal(approvals[1]?.payload.kind, 'approval.expired')
    if (approvals[1]?.payload.kind === 'approval.expired') assert.equal(approvals[1].payload.reason, 'timeout')
    assert.equal(externalCalls, 0)
    assert.deepEqual(f.lifecycle.listConnectorApprovals(), [])
    t.mock.timers.reset()
    await waitFor(async () => (await f.store.sessions.get(session.sessionId))?.activeTurnId === null)
    const settled = await workbench.journal(session.sessionId, 1, 100)
    assert.equal(settled.events.some(event => event.payload.kind === 'turn.finished' && event.payload.outcome === 'completed'), true, 'approval timeout does not kill an otherwise healthy Turn')
    await f.lifecycle.close()
    const reopened = new SqliteWorkerStore(join(f.home, 'worker.sqlite'))
    try { assert.deepEqual(await reopened.journal.read({ sessionId: session.sessionId, fromSeq: 1 as never, limit: 100 }), settled) }
    finally { reopened.close() }
  } finally { t.mock.timers.reset(); await f.close() }
})

test('explicit start candidates override persisted identity urls', () => {
  const identity = ['http://10.0.0.1:8010', 'http://10.0.0.2:8010']
  assert.deepEqual(clusterCandidateUrls(identity, ['http://100.64.0.9:8010'], 'cluster'), ['ws://100.64.0.9:8010/cluster'])
  assert.deepEqual(clusterCandidateUrls(identity, [], 'cluster'), ['ws://10.0.0.1:8010/cluster', 'ws://10.0.0.2:8010/cluster'])
  assert.deepEqual(clusterCandidateUrls(identity, undefined, 'cluster'), ['ws://10.0.0.1:8010/cluster', 'ws://10.0.0.2:8010/cluster'])
})

test('register refuses to silently no-op on an existing identity and --force replaces it', async t => {
  // 回归：服务器数据被重置后凭据失效，提示用户“重新注册”；若 register 直接拒绝，
  // 用户按提示执行却什么都没发生，节点就永远回不来。
  const f = await fixture()
  f.identity()
  await writeFile(join(f.home, 'credential'), 'stale-credential')
  await writeFile(join(f.home, 'transport.sqlite'), '')
  const args = ['register', '--home', f.home, '--server', 'http://127.0.0.1:1', '--token', 'enrollment-token']
  try {
    await assert.rejects(() => main(args), /--force/)
    t.mock.method(globalThis, 'fetch', async () => Response.json({ workerId: 'replacement-worker', credential: 'fresh-credential' }))
    await main([...args, '--force'])
    const store = new SqliteWorkerStore(join(f.home, 'worker.sqlite'))
    try {
      assert.equal(store.identity()?.workerId, 'replacement-worker')
      assert.equal((await readFile(join(f.home, 'credential'), 'utf8')).trim(), 'fresh-credential')
      await assert.rejects(() => readFile(join(f.home, 'transport.sqlite'), 'utf8'), /ENOENT/)
    } finally { store.close() }
  } finally { await f.close() }
})
