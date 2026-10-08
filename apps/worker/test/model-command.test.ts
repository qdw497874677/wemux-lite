import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelId, NativeSessionRef, TurnId } from '@wemux/domain'
import type { WorkerCommand } from '@wemux/wire-protocol'
import type { AgentLaunchContextProvider } from '../src/application/ports/agent-launch-context.ts'
import type { RuntimeSessionAdapter, RuntimeSessionOpenInput } from '../src/application/ports/runtime-session.ts'
import { WorkerRuntime } from '../src/application/runtime.ts'
import { SqliteWorkerStore } from '../src/storage/sqlite-store.ts'
import { LocalProvisioner } from '../src/workspaces/local-provisioner.ts'
import { TestAgent } from '../src/agents/test-agent.ts'
import { ensureLocalInstallation } from '../src/application/local-installation.ts'
import { createLocalWorkbenchService } from '../src/application/local-workbench.ts'

function barrier() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
async function until(check: () => Promise<boolean>) { for (let n = 0; n < 300; n++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)) } throw Error('fixture deadline') }
async function fixture(t: TestContext, launchContexts?: AgentLaunchContextProvider) {
  const home = await mkdtemp(join(tmpdir(), 'model-command-'))
  const store = new SqliteWorkerStore(join(home, 'worker.sqlite'))
  const installation = ensureLocalInstallation(store, 'models'), workerId = `local-${installation.installationId}` as never
  const opens: RuntimeSessionOpenInput[] = [], commands: unknown[] = [], turns: { id: TurnId; modelId: ModelId | null; finish: ReturnType<typeof barrier> }[] = []
  const adapter: RuntimeSessionAdapter = { async openSession(input) { opens.push(input); return {
    async execute(request) { const finish = barrier(); let stopped = false; turns.push({ id: request.operationId as TurnId, modelId: input.modelId, finish }); return { signals: (async function* () { yield { kind: 'native-session' as const, nativeSession: 'fixture-native' as NativeSessionRef }; await finish.promise; yield { kind: 'finished' as const, outcome: { status: stopped ? 'cancelled' as const : 'completed' as const } } })(), async stop() { stopped = true; finish.release() } } },
    async command(request) { commands.push(request) }, async resolveApproval() {}, async close() {},
  } } }
  const runtime = new WorkerRuntime(store, new LocalProvisioner(home), [new TestAgent()], { send() {} }, workerId, 'models', launchContexts, undefined, new Map([['test', adapter]]))
  await runtime.initialize()
  store.saveCapabilities(store.capabilities().map(c => ({ ...c, modelSwap: true, models: [...c.models, { modelId: 'test-next' as ModelId, displayName: 'Next', source: 'configured' as const }] })))
  const service = createLocalWorkbenchService(store, runtime), directory = await service.addDirectory(home)
  const session = await service.createSession({ workspaceId: directory.workspaceId, agentKey: 'test', modelId: 'test' })
  t.after(async () => { for (const turn of turns) turn.finish.release(); await runtime.shutdown(); store.close(); await rm(home, { recursive: true, force: true }) })
  const change = (id: string, modelId = 'test-next') => runtime.executeLocal(id as never, { kind: 'runtime.command', sessionId: session.sessionId, operationId: id, name: 'set_model', arguments: { modelId } } as WorkerCommand)
  return { home, store, runtime, service, sessionId: session.sessionId, opens, commands, turns, change }
}

test('active Turn model is immutable; queued next Turn uses changed model with same native context', async t => {
  const f = await fixture(t)
  await f.service.enqueue(f.sessionId, 'first'); await until(async () => f.turns.length === 1)
  const first = f.turns[0]
  await until(async () => (await f.store.sessions.get(f.sessionId))?.nativeSession === 'fixture-native')
  await f.service.enqueue(f.sessionId, 'second')
  const receipt = await f.change('change')
  assert.equal(receipt.status, 'accepted')
  assert.equal((await f.store.sessions.get(f.sessionId))?.binding.modelId, 'test-next')
  assert.equal((await f.store.sessions.getTurn(first.id))?.modelId, 'test')
  assert.deepEqual(f.commands, [], 'never mutate a running provider process')
  assert.equal(f.turns.length, 1)
  assert.deepEqual(await f.change('change'), receipt)
  assert.equal((await f.change('change', 'test')).status, 'rejected')
  first.finish.release(); await until(async () => f.turns.length === 2)
  assert.equal(f.turns[1].modelId, 'test-next')
  assert.equal(f.opens.at(-1)?.sessionId, f.sessionId)
  assert.equal(f.opens.at(-1)?.resume, 'fixture-native')
  assert.equal((await f.store.sessions.getTurn(first.id))?.modelId, 'test')
  assert.equal((await f.store.sessions.getTurn(f.turns[1].id))?.modelId, 'test-next')
  f.turns[1].finish.release(); await until(async () => (await f.store.sessions.getTurn(f.turns[1].id))?.state === 'completed')
  const events = (await f.store.journal.read({ sessionId: f.sessionId, fromSeq: 1 as never, limit: 100 })).events
  assert.deepEqual(events.filter(e => e.payload.kind === 'turn.started').map(e => e.payload.modelId), ['test', 'test-next'])
  assert.equal(events.filter(e => e.payload.kind === 'model.changed').length, 1)
  const reopened = new SqliteWorkerStore(join(f.home, 'worker.sqlite'))
  try { assert.equal((await reopened.sessions.getTurn(first.id))?.modelId, 'test'); assert.equal((await reopened.sessions.get(f.sessionId))?.binding.modelId, 'test-next') } finally { reopened.close() }
})

test('model selection after claim but before native launch cannot change that Turn', async t => {
  const entered = barrier(), proceed = barrier()
  t.after(() => proceed.release())
  const f = await fixture(t, { async prepare() { entered.release(); await proceed.promise; return { context: null, cleanup: async () => {} } } })
  await f.service.enqueue(f.sessionId, 'first')
  await entered.promise
  const active = (await f.store.sessions.get(f.sessionId))!.activeTurnId!
  assert.equal((await f.store.sessions.getTurn(active))?.modelId, 'test')
  assert.equal((await f.change('between-claim-and-open')).status, 'accepted')
  assert.equal(f.opens.length, 0)
  proceed.release()
  await until(async () => f.turns.length === 1)
  assert.equal(f.opens[0].modelId, 'test')
  assert.equal(f.turns[0].modelId, 'test')
  f.turns[0].finish.release()
})

test('stop during preparation targets only the claimed Turn; queued successor executes once', async t => {
  const entered = barrier(), proceed = barrier()
  t.after(() => proceed.release())
  const f = await fixture(t, { async prepare() { entered.release(); await proceed.promise; return { context: null, cleanup: async () => {} } } })
  await f.service.enqueue(f.sessionId, 'first')
  await entered.promise
  const firstId = (await f.store.sessions.get(f.sessionId))!.activeTurnId!
  assert.ok(firstId)
  await f.service.enqueue(f.sessionId, 'second')
  const command = { kind: 'turn.stop', sessionId: f.sessionId, turnId: firstId } as WorkerCommand
  const stop = await f.runtime.executeLocal('stop-preparation' as never, command)
  assert.equal(stop.status, 'accepted')
  assert.deepEqual(await f.runtime.executeLocal('stop-preparation' as never, command), stop)
  assert.equal((await f.store.sessions.getTurn(firstId))?.state, 'stopping')
  proceed.release()
  await until(async () => f.turns.length === 2)
  const secondId = f.turns[1].id
  await until(async () => (await f.store.sessions.getTurn(firstId))?.state === 'cancelled')
  const late = await f.runtime.executeLocal('stop-after-successor-started' as never, command)
  assert.equal(late.status, 'accepted')
  assert.equal((await f.store.sessions.getTurn(secondId))?.state, 'running')
  f.turns[1].finish.release()
  await until(async () => (await f.store.sessions.getTurn(secondId))?.state === 'completed')
  const events = (await f.store.journal.read({ sessionId: f.sessionId, fromSeq: 1 as never, limit: 100 })).events
  assert.deepEqual(events.filter(event => event.payload.kind === 'turn.started').map(event => event.payload.turnId), [firstId, secondId])
  assert.equal(events.filter(event => event.payload.kind === 'turn.finished' && event.payload.turnId === firstId && event.payload.outcome === 'cancelled').length, 1)
  assert.equal(events.filter(event => event.payload.kind === 'turn.finished' && event.payload.turnId === secondId && event.payload.outcome === 'completed').length, 1)
})

test('new model intent rechecks availability, replay stays immutable after capability loss', async t => {
  const f = await fixture(t)
  assert.equal((await f.change('invalid', 'missing')).status, 'rejected')
  assert.equal((await f.store.sessions.get(f.sessionId))?.binding.modelId, 'test')
  const receipt = await f.change('valid'); assert.equal(receipt.status, 'accepted')
  f.store.saveCapabilities([])
  assert.deepEqual(await f.change('valid'), receipt)
  assert.equal((await f.change('new')).status, 'rejected')
  assert.deepEqual(f.commands, [])
})
