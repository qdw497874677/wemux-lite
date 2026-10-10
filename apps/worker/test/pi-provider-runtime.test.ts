import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { authorizationBytes, type EnqueueAuthorization } from '@wemux/wire-protocol/command-assertion'
import type { AgentKey, ModelId, ProjectId, SessionId, WorkerId } from '@wemux/domain'
import type { AgentAdapter } from '../src/application/ports/agent-adapter.ts'
import type { RuntimeSessionAdapter } from '../src/application/ports/runtime-session.ts'
import { WorkerRuntime, type PiProviderResolver } from '../src/application/runtime.ts'
import { SqliteWorkerStore } from '../src/storage/sqlite-store.ts'
import { LocalProvisioner } from '../src/workspaces/local-provisioner.ts'

const workerId = 'worker-provider-fixture' as WorkerId
const agentKey = 'pi' as AgentKey
const modelId = 'openai-compatible::offline-model' as ModelId
const sessionId = 'provider-session' as SessionId
const secret = 'runtime-private-secret-8415'
const definition = { providerKey: 'openai-compatible' as const, endpoint: 'https://example.invalid/v1', modelIds: ['offline-model'], agentKeys: [agentKey], credential: { kind: 'worker-credential' as const, credentialRef: 'local-ref', variableNames: ['OPENAI_API_KEY'] } }
const agent: AgentAdapter = { agentKey, mode: 'execution', async detect() { return { agentKey, displayName: 'Fake Pi', version: '1', mode: 'execution' as const, executablePath: '/fake/pi', diagnostics: [], availability: { status: 'available' as const }, models: [{ modelId, displayName: 'Offline', source: 'configured' as const }] } }, async startTurn() { throw new Error('unexpected legacy adapter') } }
const until = async (predicate: () => Promise<boolean>) => { for (let i = 0; i < 200; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)) } throw new Error('Timed out waiting for provider Turn') }

async function fixture(resolver?: PiProviderResolver, controls?: { prepare?: import('../src/application/ports/agent-launch-context.ts').AgentLaunchContextProvider; authorize?: (commandId: import('@wemux/domain').CommandId) => Promise<boolean>; publish?: (message: unknown) => void; timeouts?: { idleMs: number; maxMs: number } }) {
  const home = await mkdtemp(join(tmpdir(), 'wemux-provider-runtime-'))
  const store = new SqliteWorkerStore(join(home, 'worker.sqlite'))
  const keys = generateKeyPairSync('ed25519')
  const publicKey = keys.publicKey.export({ format: 'pem', type: 'spki' }).toString()
  const keyId = createHash('sha256').update(publicKey).digest('hex')
  store.saveIdentity({ workerId, serverUrl: 'ws://localhost/ws', credentialRef: 'credential', enrolledAt: new Date().toISOString() as never, commandSigningKey: { keyId, publicKey } })
  const opened: string[] = []
  const adapter: RuntimeSessionAdapter = { async openSession(input) {
    opened.push(input.piProvider?.environment.OPENAI_API_KEY ?? 'missing')
    return {
      async execute() { return { signals: (async function* () { yield { kind: 'event' as const, event: { kind: 'assistant.text.delta' as const, text: 'offline-answer' } }; yield { kind: 'finished' as const, outcome: { status: 'completed' as const } } })(), async stop() {} } },
      async command() {}, async resolveApproval() {}, async close() {},
    }
  } }
  const runtime = new WorkerRuntime(store, new LocalProvisioner(join(home, 'workspaces')), [agent], { send(message) { controls?.publish?.(message) } }, workerId, 'fixture', controls?.prepare, controls?.timeouts, new Map([[agentKey, adapter]]), null, undefined, resolver, undefined, controls?.authorize ?? (async () => true))
  await runtime.initialize()
  if (resolver) runtime.providerConnected()
  const workspaceId = 'provider-workspace' as never
  const projectId = 'provider-project' as ProjectId
  const workspace = { workspace: { id: workspaceId, workerId, projectId, name: 'empty', spec: { kind: 'empty' as const }, status: 'pending' as const, failureReason: null }, repositories: [] }
  const send = (id: string, command: Parameters<typeof runtime.receive>[0]['command']) => {
    const assertion = command.kind === 'session.enqueue' ? (() => {
      const claims: EnqueueAuthorization = { version: 1, keyId, commandId: id as never, workerId, sessionId, projectId, workspaceId, taskId: null, actorId: 'actor' as never, actorAuthVersion: 0, commandDigest: createHash('sha256').update(JSON.stringify(command)).digest('hex'), issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120000).toISOString() }
      return { claims, signature: sign(null, authorizationBytes(claims), keys.privateKey).toString('base64url') }
    })() : undefined
    return runtime.receive({ type: 'command', commandId: id as never, command, ...(assertion ? { authorization: assertion } : {}) })
  }
  await send('provision-provider', { kind: 'workspace.provision', workspace } as never)
  await until(async () => (await store.workspaces.get(workspaceId))?.status === 'ready')
  await send('create-provider-session', { kind: 'session.create', session: { sessionId, binding: { workspaceId, agent: { workerId, agentKey }, modelId } } })
  return { home, store, runtime, opened, send, projectId, cleanup: async () => { await runtime.shutdown(); store.close(); await rm(home, { recursive: true, force: true }) } }
}

test('claimed cluster Turn revoked during delayed preparation never opens a private Agent', async () => {
  let release!: () => void
  let entered!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  const preparing = new Promise<void>(resolve => { entered = resolve })
  let allowed = true, checks = 0, cleaned = 0, resolved = 0
  const f = await fixture(async () => { resolved++; return { definition, environment: { OPENAI_API_KEY: secret }, credentialStamp: 'opaque', bindingId: 'binding' } }, {
    prepare: { async prepare() { entered(); await waiting; return { context: null, async cleanup() { cleaned++ } } } },
    async authorize() { checks++; return allowed },
  })
  try {
    await f.send('revoked-during-prepare', { kind: 'session.enqueue', sessionId, message: { messageId: 'revoked-preparation' as never, content: 'never run', sentByAccountId: 'actor' as never } })
    await preparing
    assert.equal((await f.store.sessions.get(sessionId))?.runtimeState, 'running')
    allowed = false
    release()
    await until(async () => (await f.store.sessions.get(sessionId))?.runtimeState === 'failed')
    assert.ok(checks >= 2)
    assert.equal(resolved, 0)
    assert.equal(cleaned, 1)
    assert.deepEqual(f.opened, [])
    assert.equal((await f.store.sessions.listQueued(sessionId)).length, 0)
    assert.equal((await f.store.sessions.get(sessionId))?.activeTurnId, null)
    const journal = await f.store.journal.read({ sessionId, fromSeq: 1 as never, limit: 100 })
    assert.ok(journal.events.some(event => event.payload.kind === 'turn.finished' && event.payload.outcome === 'failed' && event.payload.failure?.code === 'agent-unavailable' && event.payload.failure?.abortReason === 'authorization_unavailable' && event.payload.failure?.retryable === false))
    assert.ok(!journal.events.some(event => event.payload.kind === 'turn.finished' && event.payload.outcome === 'completed'))
    assert.doesNotMatch(JSON.stringify(journal), /runtime-private-secret-8415/)
  } finally { release(); await f.cleanup() }
})

test('revocation while private Provider resolution is pending prevents first iterator read', async () => {
  let release!: () => void
  let entered!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  const resolving = new Promise<void>(resolve => { entered = resolve })
  let allowed = true, checks = 0
  const f = await fixture(async () => { entered(); await waiting; return { definition, environment: { OPENAI_API_KEY: secret }, credentialStamp: 'opaque', bindingId: 'binding' } }, {
    async authorize() { checks++; return allowed },
  })
  try {
    await f.send('revoked-during-provider', { kind: 'session.enqueue', sessionId, message: { messageId: 'revoked-provider' as never, content: 'never run', sentByAccountId: 'actor' as never } })
    await resolving
    allowed = false
    release()
    await until(async () => (await f.store.sessions.get(sessionId))?.runtimeState === 'failed')
    assert.ok(checks >= 3)
    assert.deepEqual(f.opened, [], 'no first iterator.next can open a private child')
    assert.equal((await f.store.sessions.get(sessionId))?.activeTurnId, null)
    const journal = await f.store.journal.read({ sessionId, fromSeq: 1 as never, limit: 100 })
    assert.doesNotMatch(JSON.stringify(journal), /runtime-private-secret-8415/)
    assert.ok(journal.events.some(event => event.payload.kind === 'turn.finished' && event.payload.outcome === 'failed' && event.payload.failure?.code === 'agent-unavailable' && event.payload.failure?.abortReason === 'authorization_unavailable'))
  } finally { release(); await f.cleanup() }
})

for (const check of [2, 3, 4] as const) for (const result of ['denied', 'thrown'] as const) {
  test(`turn.stop wins over ${result} authorization at post-claim check ${check}`, async () => {
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const checking = new Promise<void>(resolve => { entered = resolve })
    let checks = 0, prepared = 0, cleaned = 0, resolved = 0
    const f = await fixture(async () => { resolved++; return { definition, environment: { OPENAI_API_KEY: secret }, credentialStamp: 'opaque', bindingId: 'binding' } }, {
      prepare: { async prepare() { prepared++; return { context: null, async cleanup() { cleaned++ } } } },
      async authorize() {
        if (++checks === check) {
          entered()
          await gate
          if (result === 'thrown') throw new Error('authorization backend unavailable')
          return false
        }
        return true
      },
    })
    try {
      await f.send(`stop-${check}-${result}`, { kind: 'session.enqueue', sessionId, message: { messageId: `stop-${check}-${result}` as never, content: 'never run', sentByAccountId: 'actor' as never } })
      await checking
      const turnId = (await f.store.sessions.get(sessionId))?.activeTurnId
      assert.ok(turnId)
      await f.send(`stop-command-${check}-${result}`, { kind: 'turn.stop', sessionId, turnId })
      assert.equal((await f.store.sessions.getTurn(turnId))?.state, 'stopping')
      release()
      await until(async () => (await f.store.sessions.getTurn(turnId))?.state === 'cancelled')
      assert.equal(checks, check)
      assert.equal(prepared, check === 2 ? 0 : 1)
      assert.equal(cleaned, prepared, 'prepared launch resources are released on cancellation')
      assert.equal(resolved, check === 4 ? 1 : 0)
      assert.deepEqual(f.opened, [])
      assert.equal((await f.store.sessions.listQueued(sessionId)).length, 0)
      assert.equal((await f.store.sessions.get(sessionId))?.activeTurnId, null)
      const journal = await f.store.journal.read({ sessionId, fromSeq: 1 as never, limit: 100 })
      const finished = journal.events.filter(event => event.payload.kind === 'turn.finished')
      assert.equal(finished.length, 1)
      assert.equal(finished[0]?.payload.kind, 'turn.finished')
      if (finished[0]?.payload.kind === 'turn.finished') {
        assert.equal(finished[0].payload.outcome, 'cancelled')
        assert.equal(finished[0].payload.failure, null)
      }
      assert.doesNotMatch(JSON.stringify(journal), /runtime-private-secret-8415|authorization backend unavailable/)
    } finally { release(); await f.cleanup() }
  })
}

test('final launch authorization denial fails claimed Turn with stable non-provider reason', async () => {
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const checking = new Promise<void>(resolve => { entered = resolve })
  let checks = 0, cleaned = 0
  const f = await fixture(async () => ({ definition, environment: { OPENAI_API_KEY: secret }, credentialStamp: 'opaque', bindingId: 'binding' }), {
    prepare: { async prepare() { return { context: null, async cleanup() { cleaned++ } } } },
    async authorize() { if (++checks === 5) { entered(); await gate; return false } return true },
  })
  try {
    await f.send('deny-final-check', { kind: 'session.enqueue', sessionId, message: { messageId: 'deny-before-read' as never, content: 'never run', sentByAccountId: 'actor' as never } })
    await checking
    release()
    await until(async () => (await f.store.sessions.get(sessionId))?.runtimeState === 'failed')
    assert.equal(checks, 5)
    assert.equal(cleaned, 1)
    assert.deepEqual(f.opened, [])
    assert.equal((await f.store.sessions.listQueued(sessionId)).length, 0)
    assert.equal((await f.store.sessions.get(sessionId))?.activeTurnId, null)
    const journal = await f.store.journal.read({ sessionId, fromSeq: 1 as never, limit: 100 })
    assert.ok(journal.events.some(event => event.payload.kind === 'turn.finished' && event.payload.outcome === 'failed' && event.payload.failure?.code === 'agent-unavailable' && event.payload.failure?.abortReason === 'authorization_unavailable' && event.payload.failure?.retryable === false))
    assert.doesNotMatch(JSON.stringify(journal), /runtime-private-secret-8415/)
  } finally { release(); await f.cleanup() }
})

for (const failure of ['denied', 'thrown'] as const) {
  test(`turn.stop wins over ${failure} final authorization without opening Agent work`, async () => {
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const checking = new Promise<void>(resolve => { entered = resolve })
    let checks = 0, cleaned = 0
    const f = await fixture(async () => ({ definition, environment: { OPENAI_API_KEY: secret }, credentialStamp: 'opaque', bindingId: 'binding' }), {
      prepare: { async prepare() { return { context: null, async cleanup() { cleaned++ } } } },
      async authorize() {
        if (++checks === 5) {
          entered()
          await gate
          if (failure === 'thrown') throw new Error('authorization backend unavailable')
          return false
        }
        return true
      },
    })
    try {
      await f.send(`stop-final-${failure}`, { kind: 'session.enqueue', sessionId, message: { messageId: `stop-final-${failure}` as never, content: 'never run', sentByAccountId: 'actor' as never } })
      await checking
      const turnId = (await f.store.sessions.get(sessionId))?.activeTurnId
      assert.ok(turnId)
      await f.send(`stop-check-${failure}`, { kind: 'turn.stop', sessionId, turnId })
      assert.equal((await f.store.sessions.getTurn(turnId))?.state, 'stopping')
      release()
      await until(async () => (await f.store.sessions.getTurn(turnId))?.state === 'cancelled')
      assert.equal(checks, 5, 'no additional authorization or duplicate launch')
      assert.equal(cleaned, 1)
      assert.deepEqual(f.opened, [])
      assert.equal((await f.store.sessions.get(sessionId))?.activeTurnId, null)
      assert.equal((await f.store.sessions.listQueued(sessionId)).length, 0)
      const journal = await f.store.journal.read({ sessionId, fromSeq: 1 as never, limit: 100 })
      const finished = journal.events.filter(event => event.payload.kind === 'turn.finished')
      assert.equal(finished.length, 1)
      assert.equal(finished[0]?.payload.kind, 'turn.finished')
      if (finished[0]?.payload.kind === 'turn.finished') {
        assert.equal(finished[0].payload.outcome, 'cancelled')
        assert.equal(finished[0].payload.failure, null)
      }
      assert.doesNotMatch(JSON.stringify(journal), /runtime-private-secret-8415|authorization backend unavailable/)
    } finally { release(); await f.cleanup() }
  })
}

test('turn.stop during final launch authorization cancels without starting Agent work', async () => {
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const checking = new Promise<void>(resolve => { entered = resolve })
  let checks = 0, cleaned = 0
  const f = await fixture(async () => ({ definition, environment: { OPENAI_API_KEY: secret }, credentialStamp: 'opaque', bindingId: 'binding' }), {
    prepare: { async prepare() { return { context: null, async cleanup() { cleaned++ } } } },
    async authorize() { if (++checks === 5) { entered(); await gate } return true },
  })
  try {
    await f.send('stop-during-final-check', { kind: 'session.enqueue', sessionId, message: { messageId: 'stop-before-read' as never, content: 'never run', sentByAccountId: 'actor' as never } })
    await checking
    const turnId = (await f.store.sessions.get(sessionId))?.activeTurnId
    assert.ok(turnId)
    await f.send('stop-while-checking', { kind: 'turn.stop', sessionId, turnId })
    assert.equal((await f.store.sessions.getTurn(turnId))?.state, 'stopping')
    release()
    await until(async () => (await f.store.sessions.getTurn(turnId))?.state === 'cancelled')
    assert.equal(checks, 5)
    assert.equal(cleaned, 1)
    assert.deepEqual(f.opened, [], 'an already stopped Turn must not read its Agent iterator')
    assert.equal((await f.store.sessions.get(sessionId))?.activeTurnId, null)
    assert.equal((await f.store.sessions.listQueued(sessionId)).length, 0)
    const journal = await f.store.journal.read({ sessionId, fromSeq: 1 as never, limit: 100 })
    const finished = journal.events.filter(event => event.payload.kind === 'turn.finished')
    assert.equal(finished.length, 1)
    assert.ok(finished[0]?.payload.kind === 'turn.finished' && finished[0].payload.outcome === 'cancelled' && finished[0].payload.failure === null)
    assert.doesNotMatch(JSON.stringify(journal), /runtime-private-secret-8415/)
  } finally { release(); await f.cleanup() }
})

test('cluster Pi Provider Turn uses Worker-only resolver and persists no Secret or native session', async () => {
  const calls: string[] = []
  const f = await fixture(async (projectId, selected) => { calls.push(`${projectId}/${selected}`); return { definition, environment: { OPENAI_API_KEY: secret }, credentialStamp: 'opaque', bindingId: 'provider-binding' } })
  try {
    await f.send('send-1', { kind: 'session.enqueue', sessionId, message: { messageId: 'message-1' as never, content: 'offline prompt', sentByAccountId: 'actor' as never } })
    await until(async () => (await f.store.sessions.get(sessionId))?.runtimeState === 'idle')
    assert.deepEqual(calls, [`${f.projectId}/${modelId}`])
    assert.deepEqual(f.opened, [secret])
    const journal = await f.store.journal.read({ sessionId, fromSeq: 1 as never, limit: 100 })
    assert.ok(journal.events.some(event => event.payload.kind === 'turn.finished' && event.payload.outcome === 'completed'))
    assert.doesNotMatch(JSON.stringify(journal), /runtime-private-secret-8415/)
    assert.equal((await f.store.sessions.get(sessionId))?.nativeSession, null)
    assert.equal((await f.store.sessions.get(sessionId))?.binding.modelId, modelId)
  } finally { await f.cleanup() }
})

test('Pi Provider Session refuses runtime model switching before the private child is touched', async () => {
  const f = await fixture(async () => { throw new Error('must not resolve') })
  try {
    await f.send('switch-provider', { kind: 'runtime.command', sessionId, operationId: 'switch' as never, name: 'set_model', arguments: { modelId: 'other::model' } })
    assert.equal((await f.store.sessions.get(sessionId))?.binding.modelId, modelId)
    assert.deepEqual(f.opened, [])
    const receipt = await f.store.commands.get('switch-provider' as never)
    assert.equal(receipt?.state, 'rejected')
  } finally { await f.cleanup() }
})

test('cluster Pi Provider Turn halts during disconnect and never reuses a credential on next Turn', async () => {
  let credential = secret
  const f = await fixture(async () => ({ definition, environment: { OPENAI_API_KEY: credential }, credentialStamp: credential, bindingId: 'provider-binding' }))
  try {
    await f.send('first-disconnect', { kind: 'session.enqueue', sessionId, message: { messageId: 'before-disconnect' as never, content: 'before', sentByAccountId: 'actor' as never } })
    await until(async () => (await f.store.sessions.get(sessionId))?.runtimeState === 'idle')
    f.runtime.providerDisconnected()
    credential = 'rotated-after-disconnect'
    await f.send('second-disconnect', { kind: 'session.enqueue', sessionId, message: { messageId: 'after-disconnect' as never, content: 'after', sentByAccountId: 'actor' as never } })
    await until(async () => (await f.store.sessions.get(sessionId))?.runtimeState === 'failed')
    assert.deepEqual(f.opened, [secret])
    f.runtime.providerConnected()
    await f.send('third-reconnect', { kind: 'session.enqueue', sessionId, message: { messageId: 'after-reconnect' as never, content: 'after reconnection', sentByAccountId: 'actor' as never } })
    await until(async () => (await f.store.sessions.get(sessionId))?.runtimeState === 'idle' && f.opened.length === 2)
    assert.deepEqual(f.opened, [secret, 'rotated-after-disconnect'])
  } finally { await f.cleanup() }
})

test('cluster Pi Provider Turn rejects a persisted native session before reading a credential', async () => {
  let resolved = false
  const f = await fixture(async () => { resolved = true; return { definition, environment: { OPENAI_API_KEY: secret }, credentialStamp: 'opaque', bindingId: 'provider-binding' } })
  try {
    await f.store.transaction(tx => tx.sessions.bindNativeSession({ sessionId, nativeSession: 'legacy-native' as never }))
    await f.send('send-resume', { kind: 'session.enqueue', sessionId, message: { messageId: 'resume-message' as never, content: 'offline prompt', sentByAccountId: 'actor' as never } })
    await until(async () => (await f.store.sessions.get(sessionId))?.runtimeState === 'failed')
    assert.equal(resolved, false)
    assert.deepEqual(f.opened, [])
  } finally { await f.cleanup() }
})

test('cluster Pi Provider Turn fails closed if resolver unavailable without leaking its error', async () => {
  for (const resolver of [undefined, (async () => { throw new Error(secret) }) as PiProviderResolver]) {
    const f = await fixture(resolver)
    try {
      await f.send('send-2', { kind: 'session.enqueue', sessionId, message: { messageId: 'message-2' as never, content: 'offline prompt', sentByAccountId: 'actor' as never } })
      await until(async () => (await f.store.sessions.get(sessionId))?.runtimeState === 'failed')
      assert.deepEqual(f.opened, [])
      const journal = await f.store.journal.read({ sessionId, fromSeq: 1 as never, limit: 100 })
      assert.doesNotMatch(JSON.stringify(journal), /runtime-private-secret-8415/)
      assert.ok(journal.events.some(event => event.payload.kind === 'turn.finished' && event.payload.outcome === 'failed'))
    } finally { await f.cleanup() }
  }
})

for (const rejected of ['stop', 'return', 'cleanup'] as const) {
  test(`prelaunch stop survives ${rejected} rejection and attempts every cleanup`, async () => {
    let release!: () => void, entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const checking = new Promise<void>(resolve => { entered = resolve })
    let checks = 0, stops = 0, returns = 0, cleanups = 0
    const f = await fixture(async () => ({ definition, environment: { OPENAI_API_KEY: secret }, credentialStamp: 'stamp', bindingId: 'binding' }), {
      prepare: { async prepare() { return { context: null, async cleanup() { cleanups++; if (rejected === 'cleanup') throw new Error('cleanup rejected') } } } },
      async authorize() { if (++checks === 5) { entered(); await gate; return false } return true },
    })
    const runner = (f.runtime as unknown as { agentRunner: { stop: (sessionId: SessionId, turnId: string) => Promise<void>; runWithPiProvider: (...args: unknown[]) => AsyncIterable<unknown> } }).agentRunner
    const originalStop = runner.stop.bind(runner)
    const originalRun = runner.runWithPiProvider.bind(runner)
    runner.stop = async (id, turnId) => { stops++; await originalStop(id, turnId); if (rejected === 'stop' && stops > 1) throw new Error('stop rejected') }
    runner.runWithPiProvider = (...args) => {
      originalRun(...args) // retain private Provider argument validation
      return { [Symbol.asyncIterator]() { return { async next() { throw new Error('must not launch') }, async return() { returns++; if (rejected === 'return') throw new Error('return rejected'); return { done: true, value: undefined } } } } }
    }
    try {
      await f.send(`cleanup-${rejected}`, { kind: 'session.enqueue', sessionId, message: { messageId: `cleanup-${rejected}` as never, content: 'never launch', sentByAccountId: 'actor' as never } })
      await checking
      const turnId = (await f.store.sessions.get(sessionId))?.activeTurnId
      assert.ok(turnId)
      await f.send(`stop-cleanup-${rejected}`, { kind: 'turn.stop', sessionId, turnId })
      release()
      await until(async () => (await f.store.sessions.getTurn(turnId))?.state === 'cancelled')
      assert.equal(stops >= 1, true)
      assert.equal(returns, 1)
      assert.equal(cleanups, 1)
      assert.deepEqual(f.opened, [])
      assert.equal((await f.store.sessions.get(sessionId))?.activeTurnId, null)
      const journal = await f.store.journal.read({ sessionId, fromSeq: 1 as never, limit: 100 })
      const finished = journal.events.filter(event => event.payload.kind === 'turn.finished')
      assert.equal(finished.length, 1)
      assert.equal(finished[0]?.payload.kind === 'turn.finished' && finished[0].payload.outcome, 'cancelled')
    } finally { release(); await f.cleanup() }
  })
}

test('a non-settling stop and releases quarantine the Session and finalize only the claimed Turn', async () => {
  let stops = 0, returns = 0, cleanups = 0, reads = 0
  const never = new Promise<never>(() => {})
  const f = await fixture(async () => ({ definition, environment: { OPENAI_API_KEY: secret }, credentialStamp: 'stamp', bindingId: 'binding' }), {
    timeouts: { idleMs: 25, maxMs: 200 },
    prepare: { async prepare() { return { context: null, async cleanup() { cleanups++; await never } } } },
  })
  const runner = (f.runtime as unknown as { agentRunner: { stop: (sessionId: SessionId, turnId: string) => Promise<void>; runWithPiProvider: (...args: unknown[]) => AsyncIterable<unknown> } }).agentRunner
  runner.stop = async () => { stops++; await never }
  runner.runWithPiProvider = () => ({ [Symbol.asyncIterator]() { return { async next() { reads++; throw new Error('child failed') }, async return() { returns++; await never } } } })
  try {
    await f.send('hung-first', { kind: 'session.enqueue', sessionId, message: { messageId: 'hung-first' as never, content: 'first', sentByAccountId: 'actor' as never } })
    await until(async () => reads === 1)
    await f.send('hung-second', { kind: 'session.enqueue', sessionId, message: { messageId: 'hung-second' as never, content: 'second', sentByAccountId: 'actor' as never } })
    await until(async () => (await f.store.sessions.get(sessionId))?.activeTurnId === null)
    assert.equal(stops, 1)
    assert.equal(returns, 1)
    assert.equal(cleanups, 1)
    assert.equal(reads, 1, 'a possible live child must block the successor')
    assert.equal((await f.store.sessions.listQueued(sessionId)).length, 1)
    const journal = await f.store.journal.read({ sessionId, fromSeq: 1 as never, limit: 100 })
    const finished = journal.events.filter(event => event.payload.kind === 'turn.finished')
    assert.equal(finished.length, 1)
    assert.equal(finished[0]?.payload.kind === 'turn.finished' && finished[0].payload.outcome, 'failed')
    await f.runtime.shutdown()
    assert.equal(reads, 1)
  } finally { await f.cleanup() }
})

test('publication rejection after claim still finalizes and allows the next queued Turn', async () => {
  let rejectClaim = false, rejected = false
  const f = await fixture(async () => ({ definition, environment: { OPENAI_API_KEY: secret }, credentialStamp: 'stamp', bindingId: 'binding' }), {
    publish(message) {
      if (rejectClaim && !rejected && typeof message === 'object' && message && 'type' in message && message.type === 'event' && 'event' in message && message.event && typeof message.event === 'object' && 'payload' in message.event && message.event.payload && typeof message.event.payload === 'object' && 'kind' in message.event.payload && message.event.payload.kind === 'turn.started') {
        rejected = true
        throw new Error('publication rejected')
      }
    },
  })
  try {
    rejectClaim = true
    await f.send('publish-failure-first', { kind: 'session.enqueue', sessionId, message: { messageId: 'first' as never, content: 'first', sentByAccountId: 'actor' as never } })
    await until(async () => rejected && (await f.store.sessions.get(sessionId))?.activeTurnId === null)
    assert.equal((await f.store.sessions.listQueued(sessionId)).length, 0)
    await f.send('publish-failure-next', { kind: 'session.enqueue', sessionId, message: { messageId: 'next' as never, content: 'next', sentByAccountId: 'actor' as never } })
    await until(async () => (await f.store.journal.read({ sessionId, fromSeq: 1 as never, limit: 100 })).events.filter(event => event.payload.kind === 'turn.finished').length === 2)
    assert.equal((await f.store.sessions.get(sessionId))?.activeTurnId, null)
    assert.deepEqual(f.opened, [secret], 'failed publication never launched the first Turn')
    const journal = await f.store.journal.read({ sessionId, fromSeq: 1 as never, limit: 100 })
    const finished = journal.events.filter(event => event.payload.kind === 'turn.finished')
    assert.equal(finished.length, 2)
    assert.equal(finished[0]?.payload.kind === 'turn.finished' && finished[0].payload.outcome, 'failed')
  } finally { await f.cleanup() }
})
