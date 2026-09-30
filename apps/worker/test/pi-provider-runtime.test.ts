import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

async function fixture(resolver?: PiProviderResolver) {
  const home = await mkdtemp(join(tmpdir(), 'wemux-provider-runtime-'))
  const store = new SqliteWorkerStore(join(home, 'worker.sqlite'))
  const opened: string[] = []
  const adapter: RuntimeSessionAdapter = { async openSession(input) {
    opened.push(input.piProvider?.environment.OPENAI_API_KEY ?? 'missing')
    return {
      async execute() { return { signals: (async function* () { yield { kind: 'event' as const, event: { kind: 'assistant.text.delta' as const, text: 'offline-answer' } }; yield { kind: 'finished' as const, outcome: { status: 'completed' as const } } })(), async stop() {} } },
      async command() {}, async resolveApproval() {}, async close() {},
    }
  } }
  const runtime = new WorkerRuntime(store, new LocalProvisioner(join(home, 'workspaces')), [agent], { send() {} }, workerId, 'fixture', undefined, undefined, new Map([[agentKey, adapter]]), null, undefined, resolver)
  await runtime.initialize()
  if (resolver) runtime.providerConnected()
  const workspaceId = 'provider-workspace' as never
  const projectId = 'provider-project' as ProjectId
  const workspace = { workspace: { id: workspaceId, workerId, projectId, name: 'empty', spec: { kind: 'empty' as const }, status: 'pending' as const, failureReason: null }, repositories: [] }
  const send = (id: string, command: Parameters<typeof runtime.receive>[0]['command']) => runtime.receive({ type: 'command', commandId: id as never, command })
  await send('provision-provider', { kind: 'workspace.provision', workspace } as never)
  await until(async () => (await store.workspaces.get(workspaceId))?.status === 'ready')
  await send('create-provider-session', { kind: 'session.create', session: { sessionId, binding: { workspaceId, agent: { workerId, agentKey }, modelId } } })
  return { home, store, runtime, opened, send, projectId, cleanup: async () => { await runtime.shutdown(); store.close(); await rm(home, { recursive: true, force: true }) } }
}

test('cluster Pi Provider Turn uses Worker-only resolver and persists no Secret or native session', async () => {
  const calls: string[] = []
  const f = await fixture(async (projectId, selected) => { calls.push(`${projectId}/${selected}`); return { definition, environment: { OPENAI_API_KEY: secret }, credentialStamp: 'opaque', bindingId: 'provider-binding' } })
  try {
    await f.send('send-1', { kind: 'session.enqueue', sessionId, message: { messageId: 'message-1' as never, content: 'offline prompt' } })
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
    await f.send('first-disconnect', { kind: 'session.enqueue', sessionId, message: { messageId: 'before-disconnect' as never, content: 'before' } })
    await until(async () => (await f.store.sessions.get(sessionId))?.runtimeState === 'idle')
    f.runtime.providerDisconnected()
    credential = 'rotated-after-disconnect'
    await f.send('second-disconnect', { kind: 'session.enqueue', sessionId, message: { messageId: 'after-disconnect' as never, content: 'after' } })
    await until(async () => (await f.store.sessions.get(sessionId))?.runtimeState === 'failed')
    assert.deepEqual(f.opened, [secret])
    f.runtime.providerConnected()
    await f.send('third-reconnect', { kind: 'session.enqueue', sessionId, message: { messageId: 'after-reconnect' as never, content: 'after reconnection' } })
    await until(async () => (await f.store.sessions.get(sessionId))?.runtimeState === 'idle' && f.opened.length === 2)
    assert.deepEqual(f.opened, [secret, 'rotated-after-disconnect'])
  } finally { await f.cleanup() }
})

test('cluster Pi Provider Turn rejects a persisted native session before reading a credential', async () => {
  let resolved = false
  const f = await fixture(async () => { resolved = true; return { definition, environment: { OPENAI_API_KEY: secret }, credentialStamp: 'opaque', bindingId: 'provider-binding' } })
  try {
    await f.store.transaction(tx => tx.sessions.bindNativeSession({ sessionId, nativeSession: 'legacy-native' as never }))
    await f.send('send-resume', { kind: 'session.enqueue', sessionId, message: { messageId: 'resume-message' as never, content: 'offline prompt' } })
    await until(async () => (await f.store.sessions.get(sessionId))?.runtimeState === 'failed')
    assert.equal(resolved, false)
    assert.deepEqual(f.opened, [])
  } finally { await f.cleanup() }
})

test('cluster Pi Provider Turn fails closed if resolver unavailable without leaking its error', async () => {
  for (const resolver of [undefined, (async () => { throw new Error(secret) }) as PiProviderResolver]) {
    const f = await fixture(resolver)
    try {
      await f.send('send-2', { kind: 'session.enqueue', sessionId, message: { messageId: 'message-2' as never, content: 'offline prompt' } })
      await until(async () => (await f.store.sessions.get(sessionId))?.runtimeState === 'failed')
      assert.deepEqual(f.opened, [])
      const journal = await f.store.journal.read({ sessionId, fromSeq: 1 as never, limit: 100 })
      assert.doesNotMatch(JSON.stringify(journal), /runtime-private-secret-8415/)
      assert.ok(journal.events.some(event => event.payload.kind === 'turn.finished' && event.payload.outcome === 'failed'))
    } finally { await f.cleanup() }
  }
})
