import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { SessionEventPayload, SessionId, TurnId } from '@wemux/domain'
import type { WorkerCommand, CommandReceipt, WorkerToServer } from '@wemux/wire-protocol'
import type { RuntimeSessionAdapter } from '../src/application/ports/runtime-session.ts'
import { WorkerRuntime } from '../src/application/runtime.ts'
import { SqliteWorkerStore } from '../src/storage/sqlite-store.ts'
import { LocalProvisioner } from '../src/workspaces/local-provisioner.ts'
import { TestAgent } from '../src/agents/test-agent.ts'
import { ensureLocalInstallation } from '../src/application/local-installation.ts'
import { createLocalWorkbenchService } from '../src/application/local-workbench.ts'
import { WorkerConnectorRuntime } from '../src/connectors/runtime.ts'

function barrier() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
async function until(check: () => Promise<boolean>) { for (let n = 0; n < 300; n++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)) } throw new Error('fixture deadline') }
const timestamp = () => new Date().toISOString() as never
async function fixture(t: TestContext, connector?: ConstructorParameters<typeof WorkerRuntime>[10]) {
  const home = await mkdtemp(join(tmpdir(), 'approval-identity-'))
  const store = new SqliteWorkerStore(join(home, 'worker.sqlite'))
  const installation = ensureLocalInstallation(store, 'identity')
  const workerId = `local-${installation.installationId}` as never
  const sent: WorkerToServer[] = []
  const calls: { sessionId: string; approvalId: string; decision: string }[] = []
  const finishes = new Map<string, ReturnType<typeof barrier>>()
  let native: () => Promise<void> = async () => {}
  const adapter: RuntimeSessionAdapter = { async openSession({ sessionId }) { return {
    async execute() { const finish = barrier(); finishes.set(sessionId, finish); return { signals: (async function* () { await finish.promise; yield { kind: 'finished' as const, outcome: { status: 'completed' as const } } })(), async stop() { finish.release() } } },
    async command() {}, async resolveApproval(approvalId, decision) { calls.push({ sessionId, approvalId, decision }); await native() }, async close() {},
  } } }
  const runtime = new WorkerRuntime(store, new LocalProvisioner(home), [new TestAgent(1)], { send(message) { sent.push(message) } }, workerId, 'identity', undefined, undefined, new Map([['test', adapter]]), null, connector)
  await runtime.initialize()
  const service = createLocalWorkbenchService(store, runtime)
  const directory = await service.addDirectory(home)
  t.after(async () => { for (const gate of finishes.values()) gate.release(); await runtime.shutdown(); store.close(); await rm(home, { recursive: true, force: true }) })
  let index = 0
  async function start(sessionId?: SessionId) {
    const session = sessionId ? (await store.sessions.get(sessionId))! : await service.createSession({ workspaceId: directory.workspaceId, agentKey: 'test', modelId: 'test' })
    finishes.delete(session.sessionId)
    await service.enqueue(session.sessionId, `turn-${++index}`)
    await until(async () => finishes.has(session.sessionId))
    return { sessionId: session.sessionId, turnId: (await store.sessions.get(session.sessionId))!.activeTurnId! }
  }
  const append = async (target: { sessionId: SessionId }, ...payloads: SessionEventPayload[]) => store.transaction(tx => tx.appendJournal(target.sessionId, payloads.map(payload => ({ occurredAt: timestamp(), payload }))))
  const request = async (target: { sessionId: SessionId; turnId: TurnId }, approvalId = 'approval') => append(target, { kind: 'approval.requested', turnId: target.turnId, approvalId: approvalId as never, action: { tool: 'fake' } })
  const body = (target: { sessionId: SessionId; turnId: TurnId }, extra: object = {}) => ({ kind: 'runtime.approval.resolve', ...target, approvalId: 'approval', decision: 'approve', ...extra }) as WorkerCommand
  const send = (target: { sessionId: SessionId; turnId: TurnId }, id: string, extra: object = {}) => runtime.executeLocal(id as never, body(target, extra))
  const finish = async (target: { sessionId: SessionId; turnId: TurnId }) => { finishes.get(target.sessionId)!.release(); await until(async () => (await store.sessions.getTurn(target.turnId))?.state === 'completed') }
  return { store, runtime, service, calls, sent, start, append, request, body, send, finish, native: (fn: () => Promise<void>) => { native = fn }, workerId }
}
function rejected(receipt: CommandReceipt, message?: RegExp) { assert.equal(receipt.status, 'rejected'); if (receipt.status === 'rejected' && message) assert.match(receipt.error.message, message) }

for (const invalid of ['missing-turn', 'empty-turn', 'wrong-turn', 'unknown', 'resolved', 'duplicate-after-resolved', 'expired', 'duplicate-after-expired', 'finished'] as const) test(`Worker approval rejects ${invalid} before native invocation`, async t => {
  const f = await fixture(t); const target = await f.start()
  if (invalid !== 'unknown') await f.request(target)
  if (invalid === 'resolved' || invalid === 'duplicate-after-resolved') await f.append(target, { kind: 'approval.resolved', turnId: target.turnId, approvalId: 'approval' as never, decision: 'deny' })
  if (invalid === 'expired' || invalid === 'duplicate-after-expired') await f.append(target, { kind: 'approval.expired', turnId: target.turnId, approvalId: 'approval' as never, reason: 'timeout' })
  if (invalid === 'duplicate-after-resolved' || invalid === 'duplicate-after-expired') await f.request(target)
  if (invalid === 'finished') await f.finish(target)
  const extra = invalid === 'missing-turn' ? { turnId: undefined } : invalid === 'empty-turn' ? { turnId: '' } : invalid === 'wrong-turn' ? { turnId: 'other' } : {}
  rejected(await f.send(target, 'decision', extra)); assert.equal(f.calls.length, 0)
})

test('pending fold scans all pages, ignores pre-request resolution and keeps exact Turn', async t => {
  const f = await fixture(t); const target = await f.start()
  await f.append(target, { kind: 'approval.resolved', turnId: target.turnId, approvalId: 'approval' as never, decision: 'deny' })
  await f.request(target)
  await f.append(target, ...Array.from({ length: 1100 }, () => ({ kind: 'assistant.text.delta' as const, turnId: target.turnId, text: 'padding' })))
  const receipt = await f.send(target, 'decision'); assert.equal(receipt.status, 'accepted'); assert.equal(f.calls.length, 1)
  const head = (await f.store.journal.listHeads()).find(head => head.sessionId === target.sessionId)!
  const last = await f.store.journal.getEvent(target.sessionId, head.lastSeq)
  assert.equal(last?.payload.kind, 'approval.resolved'); assert.equal((last?.payload as { turnId: string }).turnId, target.turnId)
  await f.finish(target)
  assert.deepEqual(await f.send(target, 'decision'), receipt); assert.equal(f.calls.length, 1)
  rejected(await f.send(target, 'decision', { decision: 'deny' }), /different payload/)
})

test('resolution and duplicate request beyond first page cannot reopen pending', async t => {
  const f = await fixture(t); const target = await f.start(); await f.request(target)
  await f.append(target, ...Array.from({ length: 600 }, () => ({ kind: 'assistant.text.delta' as const, turnId: target.turnId, text: 'padding' })), { kind: 'approval.resolved', turnId: target.turnId, approvalId: 'approval' as never, decision: 'deny' })
  await f.request(target); rejected(await f.send(target, 'decision')); assert.equal(f.calls.length, 0)
})

test('concurrent decisions serialize before native invocation and rejection stays replayable', async t => {
  const f = await fixture(t); const target = await f.start(); await f.request(target)
  const entered = barrier(), release = barrier(); f.native(async () => { entered.release(); await release.promise })
  const first = f.send(target, 'first'); await entered.promise
  const second = f.send(target, 'second', { decision: 'deny' }); const retry = f.send(target, 'first')
  assert.equal(f.calls.length, 1); release.release()
  assert.equal((await first).status, 'accepted'); rejected(await second); assert.equal((await retry).status, 'accepted'); assert.equal(f.calls.length, 1)
  const next = await f.start(await (async () => { await f.finish(target); return target.sessionId })()); await f.request(next)
  f.native(async () => { throw new Error('adapter rejected decision') })
  const denial = await f.send(next, 'native-reject'); rejected(denial, /adapter rejected/)
  assert.deepEqual(await f.send(next, 'native-reject'), denial); assert.equal(f.calls.length, 2)
})

test('native acceptance competing with committed finish retains uncertain rejection without resolution or replay', async t => {
  const f = await fixture(t); const target = await f.start(); await f.request(target)
  const entered = barrier(), release = barrier(); f.native(async () => { entered.release(); await release.promise })
  const decision = f.send(target, 'racing'); await entered.promise
  // Deliberate competing store authority, not the natural runner release/finish path.
  await f.store.transaction(tx => tx.sessions.finishTurn({ turnId: target.turnId, outcome: 'completed', finishedAt: timestamp() }))
  release.release(); const receipt = await decision; rejected(receipt, /accepted.*outcome.*unconfirmed/i)
  const events = (await f.store.journal.read({ sessionId: target.sessionId, fromSeq: 1 as never, limit: 100 })).events
  assert.equal(events.filter(event => event.payload.kind === 'approval.resolved').length, 0)
  assert.deepEqual(await f.send(target, 'racing'), receipt); rejected(await f.send(target, 'new')); assert.equal(f.calls.length, 1)
})

test('same approvalId across Sessions and Turns stays independent; delayed old Turn cannot target new one', async t => {
  const f = await fixture(t); const first = await f.start(), other = await f.start(); await f.request(first); await f.request(other)
  rejected(await f.send(other, 'foreign-turn', { turnId: first.turnId })); assert.equal(f.calls.length, 0)
  assert.equal((await f.send(first, 'first')).status, 'accepted'); await f.finish(first)
  const next = await f.start(first.sessionId); await f.request(next)
  rejected(await f.send(first, 'delayed')); assert.equal((await f.send(other, 'other')).status, 'accepted'); assert.equal((await f.send(next, 'next')).status, 'accepted'); assert.equal(f.calls.length, 3)
})

test('local explicit identities retry unchanged and automatic identity includes Turn', async t => {
  const f = await fixture(t); const first = await f.start(); await f.request(first)
  const resolve = (target: typeof first, id?: string, decision: 'approve' | 'deny' = 'approve') => f.service.resolveApproval(target.sessionId, 'approval', decision, id, target.turnId)
  const receipt = await resolve(first, 'client-id'); await f.finish(first)
  assert.deepEqual(await resolve(first, 'client-id'), receipt)
  await assert.rejects(resolve(first, 'client-id', 'deny'), /different payload/)
  const next = await f.start(first.sessionId); await f.request(next)
  await assert.rejects(resolve(next, 'client-id'), /different payload/)
  assert.equal((await resolve(next)).status, 'accepted')
  await f.finish(next); const third = await f.start(first.sessionId); await f.request(third); assert.equal((await resolve(third)).status, 'accepted'); assert.equal(f.calls.length, 3)
})

test('confirmed legacy local unbound identity blocks migration instead of reexecution', async t => {
  const f = await fixture(t); const target = await f.start(); await f.request(target)
  const commandId = createHash('sha256').update(`${f.workerId}:approval:${target.sessionId}:approval:resolve`).digest('hex') as never
  const command = f.body(target, { turnId: undefined })
  await f.store.transaction(tx => tx.commands.record({ commandId, command, payloadFingerprint: 'legacy' }, { commandId, status: 'accepted' }))
  await assert.rejects(f.service.resolveApproval(target.sessionId, 'approval', 'approve', 'new-id', target.turnId), /legacy-unbound.*migration/i)
  assert.equal(f.calls.length, 0)
})

test('connector control receives full identity only after pending and local host checks', async t => {
  const calls: unknown[] = []
  const f = await fixture(t, { async syncClusterDefinition() { throw new Error('unused') }, async testClusterDefinition() { throw new Error('unused') }, resolveApproval(...args: unknown[]) { calls.push(args); return true } })
  const target = await f.start()
  await f.append(target, { kind: 'approval.requested', turnId: target.turnId, approvalId: 'approval' as never, action: { kind: 'connector' } })
  rejected(await f.send(target, 'wrong', { turnId: 'wrong' })); assert.equal(calls.length, 0)
  await f.runtime.receive({ type: 'command', commandId: 'cluster-cross-host' as never, command: f.body(target) }); assert.equal(calls.length, 0)
  assert.equal((await f.send(target, 'correct')).status, 'accepted')
  assert.deepEqual(calls, [[{ sessionId: target.sessionId, turnId: target.turnId, approvalId: 'approval', decision: 'approve' }]]); assert.equal(f.calls.length, 0)
})

test('native approval bypasses a different Session connector with the same approvalId', { timeout: 5000 }, async t => {
  let connector: WorkerConnectorRuntime
  const f = await fixture(t, {
    async syncClusterDefinition() { throw new Error('unused') },
    async testClusterDefinition() { throw new Error('unused') },
    resolveApproval(identity) { return connector.resolveApproval(identity) },
  })
  const pending = barrier()
  let connectorCalls = 0
  connector = new WorkerConnectorRuntime(f.store, {
    onApproval(event) { if (event.kind === 'requested') pending.release() },
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    fetch: async () => { connectorCalls++; return new Response('{}', { headers: { 'content-type': 'application/json' } }) },
  })
  // Fixture cleanup closes the store; explicitly settle connector work before leaving the test.
  try {
    await f.store.saveConnectorDefinition({
      id: 'collision-http' as never, projectId: 'local' as never, kind: 'http', name: 'fixture', description: null,
      revision: 1, enabled: true, allowedWorkerIds: [], credentialRef: null, credentialAvailability: 'not_required',
      riskDefaults: { requireApprovalForRead: false, allowMcpReadOnlyHint: false },
      config: { baseUrl: 'https://fixture.example.test', authentication: 'none', publicHeaders: {}, allowPrivateNetwork: false,
        allowedOperations: [{ id: 'create', method: 'POST', pathTemplate: '/items', allowedQueryNames: [], allowedRequestHeaderNames: [], requestContentTypes: ['application/json'] }] },
      createdAt: timestamp(), updatedAt: timestamp(),
    })
    const a = await f.start(), b = await f.start()
    const registered = await connector.registerTurn((await f.store.sessions.getTurn(a.turnId))!, f.workerId)
    const operation = connector.handle('http.call', registered.token, { connectorId: 'collision-http', connectorRevision: 1, operationId: 'create', requestId: 'http-request', toolCallId: 'approval', input: { body: {} } })
    try {
      await pending.promise
      await f.append(a, { kind: 'approval.requested', turnId: a.turnId, approvalId: 'approval' as never, action: { kind: 'connector' } })
      await f.request(b)
      const receipt = await f.send(b, 'native-same-id')
      assert.equal(receipt.status, 'accepted')
      assert.deepEqual(f.calls, [{ sessionId: b.sessionId, approvalId: 'approval', decision: 'approve' }])
      assert.deepEqual(await f.send(b, 'native-same-id'), receipt)
      assert.equal(f.calls.length, 1)
      assert.equal(connector.listApprovals().length, 1)
      assert.equal(connector.listApprovals()[0].sessionId, a.sessionId)
      assert.equal(connectorCalls, 0)
      assert.equal((await f.send(a, 'connector-same-id')).status, 'accepted')
      await operation
      assert.equal(connectorCalls, 1)
      assert.equal(connector.listApprovals().length, 0)
      assert.equal(f.calls.length, 1)
    } finally {
      await connector.shutdown()
      await operation
      await registered.release()
    }
  } finally { await connector.shutdown() }
})

test('transaction readers see current writes, paginate, roll back receipt and Journal and release tail', { timeout: 3000 }, async t => {
  const f = await fixture(t); const target = await f.start(); await f.request(target)
  const before = await f.store.journal.read({ sessionId: target.sessionId, fromSeq: 1 as never, limit: 100 })
  await assert.rejects(f.store.transaction(async tx => {
    assert.equal((await tx.sessions.get(target.sessionId))?.activeTurnId, target.turnId)
    assert.equal((await tx.sessions.getTurn(target.turnId))?.sessionId, target.sessionId)
    await tx.sessions.finishTurn({ turnId: target.turnId, outcome: 'completed', finishedAt: timestamp() })
    assert.equal((await tx.sessions.get(target.sessionId))?.activeTurnId, null)
    assert.equal((await tx.sessions.getTurn(target.turnId))?.state, 'completed')
    const page = await tx.journal.read({ sessionId: target.sessionId, fromSeq: 1 as never, limit: 2 })
    assert.equal(page.hasMore, true)
    const tail = await tx.journal.read({ sessionId: target.sessionId, fromSeq: (Number(page.throughSeq) + 1) as never, limit: 100 })
    assert.ok(tail.events.some(event => event.payload.kind === 'turn.finished'))
    await tx.commands.record({ commandId: 'rollback' as never, command: f.body(target), payloadFingerprint: 'test' }, { commandId: 'rollback' as never, status: 'accepted' })
    throw new Error('deliberate rollback')
  }), /deliberate rollback/)
  assert.equal(await f.store.commands.get('rollback' as never), null)
  assert.deepEqual(await f.store.journal.read({ sessionId: target.sessionId, fromSeq: 1 as never, limit: 100 }), before)
  assert.equal((await f.send(target, 'after-rollback')).status, 'accepted')
})

test('approval queued body is snapshotted; receipt replay still checks host', async t => {
  const f = await fixture(t); const target = await f.start(); await f.request(target)
  const body = f.body(target)
  const pending = f.runtime.executeLocal('snapshot' as never, body)
  Object.assign(body, { turnId: 'changed-after-admission', decision: 'deny' })
  assert.equal((await pending).status, 'accepted')
  assert.equal((await f.send(target, 'snapshot')).status, 'accepted')
  await f.runtime.receive({ type: 'command', commandId: 'snapshot' as never, command: f.body(target) })
  assert.equal(f.calls.length, 1)
  const ack = f.sent.findLast(message => message.type === 'ack')
  assert.ok(ack?.type === 'ack'); rejected(ack.receipt, /host scope mismatch/)
  assert.equal((await f.store.commands.get('snapshot' as never))?.command.kind, 'runtime.approval.resolve')
})

test('expired connector pending cannot fall through to native runtime adapter', async t => {
  const f = await fixture(t, { async syncClusterDefinition() { throw new Error('unused') }, async testClusterDefinition() { throw new Error('unused') }, resolveApproval() { return false } })
  const target = await f.start()
  await f.append(target, { kind: 'approval.requested', turnId: target.turnId, approvalId: 'approval' as never, action: { kind: 'connector' } })
  rejected(await f.send(target, 'expired-connector'), /Connector approval is no longer pending/)
  assert.equal(f.calls.length, 0)
})

test('local approvals cannot cross cluster Session boundary even with matching pending Journal', async t => {
  const f = await fixture(t)
  const local = await f.start()
  const clusterId = 'cluster-session' as SessionId
  const binding = (await f.store.sessions.get(local.sessionId))!.binding
  await f.store.transaction(async tx => {
    await tx.sessions.createSession(clusterId, { ...binding, agent: { ...binding.agent, workerId: 'cluster-worker' as never } })
    await tx.sessions.enqueue({ sessionId: clusterId, submissionCommandId: 'cluster-enqueue' as never, message: { messageId: 'cluster-message' as never, content: 'cluster' }, queuedAt: timestamp() })
    const turn = (await tx.sessions.claimNext(clusterId))!
    await tx.appendJournal(clusterId, [{ occurredAt: timestamp(), payload: { kind: 'approval.requested', turnId: turn.id, approvalId: 'approval' as never, action: { kind: 'connector' } } }])
  })
  const turnId = (await f.store.sessions.get(clusterId))!.activeTurnId!
  await assert.rejects(f.service.resolveApproval(clusterId, 'approval', 'approve', 'cross-host', turnId), /本地会话不存在/)
  rejected(await f.send({ sessionId: clusterId, turnId }, 'runtime-cross-host'), /host scope mismatch/)
  assert.equal(f.calls.length, 0)
})

test('legacy migration block survives another Turn but unrelated record at legacy hash does not block', async t => {
  const f = await fixture(t); const target = await f.start(); await f.request(target)
  const id = createHash('sha256').update(`${f.workerId}:approval:${target.sessionId}:approval:resolve`).digest('hex') as never
  await f.store.transaction(tx => tx.commands.record({ commandId: id, command: f.body(target, { turnId: undefined }), payloadFingerprint: 'legacy' }, { commandId: id, status: 'accepted' }))
  await f.finish(target); const next = await f.start(target.sessionId); await f.request(next)
  for (const requestId of [undefined, 'fresh-request']) await assert.rejects(f.service.resolveApproval(next.sessionId, 'approval', 'approve', requestId, next.turnId), /legacy-unbound.*migration/)
  const other = await f.start(); await f.request(other)
  const unrelatedId = createHash('sha256').update(`${f.workerId}:approval:${other.sessionId}:approval:resolve`).digest('hex') as never
  await f.store.transaction(tx => tx.commands.record({ commandId: unrelatedId, command: { kind: 'turn.stop', sessionId: other.sessionId, turnId: other.turnId }, payloadFingerprint: 'unrelated' }, { commandId: unrelatedId, status: 'accepted' }))
  assert.equal((await f.service.resolveApproval(other.sessionId, 'approval', 'approve', undefined, other.turnId)).status, 'accepted')
  assert.equal(f.calls.length, 1)
})

test('request first observed after Turn finish expires rather than reopening', async t => {
  const f = await fixture(t); const target = await f.start(); await f.finish(target); await f.request(target)
  rejected(await f.send(target, 'after-finish')); assert.equal(f.calls.length, 0)
})

test('natural runner finish triggered by native decision records resolution before finished', async t => {
  const f = await fixture(t); const target = await f.start(); await f.request(target)
  let finishing: Promise<void> | undefined
  f.native(async () => { finishing = f.finish(target) })
  assert.equal((await f.send(target, 'natural-order')).status, 'accepted')
  await finishing
  const events = (await f.store.journal.read({ sessionId: target.sessionId, fromSeq: 1 as never, limit: 100 })).events
  const resolved = events.findIndex(event => event.payload.kind === 'approval.resolved')
  const finished = events.findIndex(event => event.payload.kind === 'turn.finished')
  assert.ok(resolved >= 0 && finished > resolved)
  assert.equal(f.calls.length, 1)
})

test('native acceptance racing another authoritative resolution is uncertain and cannot append duplicate', async t => {
  const f = await fixture(t); const target = await f.start(); await f.request(target)
  const entered = barrier(), release = barrier(); f.native(async () => { entered.release(); await release.promise })
  const decision = f.send(target, 'resolution-race'); await entered.promise
  await f.append(target, { kind: 'approval.resolved', turnId: target.turnId, approvalId: 'approval' as never, decision: 'deny' })
  release.release(); const receipt = await decision; rejected(receipt, /accepted.*outcome.*unconfirmed/i)
  assert.deepEqual(await f.send(target, 'resolution-race'), receipt)
  rejected(await f.send(target, 'new-after-race'))
  const events = (await f.store.journal.read({ sessionId: target.sessionId, fromSeq: 1 as never, limit: 100 })).events
  assert.equal(events.filter(event => event.payload.kind === 'approval.resolved').length, 1); assert.equal(f.calls.length, 1)
})
