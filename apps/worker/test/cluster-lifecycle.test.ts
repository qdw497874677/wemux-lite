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
import { ClusterLifecycle } from '../src/application/cluster-lifecycle.js'
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
