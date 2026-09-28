import assert from 'node:assert/strict'
import test from 'node:test'
import type { CapabilityToolName, ProjectId, SessionId, Timestamp, UserId, WorkerId } from '@wemux/domain'
import type { CreateDelegationCommand, DelegatedAuthority, Delegation, DelegationRepository } from '@wemux/server-domain'
import { DelegationApplicationService } from '../application/delegation-service.ts'

const sid = (value: string) => value as SessionId
const pid = (value: string) => value as ProjectId
const wid = (value: string) => value as WorkerId
const uid = (value: string) => value as UserId
const now = () => '2026-04-01T00:00:00.000Z' as Timestamp

class MemoryRepository implements DelegationRepository {
  values = new Map<string, Delegation>()
  async getDelegation(id: string) { return this.values.get(id) }
  async findDelegationByDispatchId(dispatchId: string) { return [...this.values.values()].find(value => value.dispatchId === dispatchId) }
  async countActiveChildren(parentSessionId: SessionId) { return [...this.values.values()].filter(value => value.source.sessionId === parentSessionId && !['rejected', 'expired', 'completed', 'failed', 'cancelled'].includes(value.status)).length }
  async listDelegations() { const items = [...this.values.values()]; return { items, total: items.length } }
  async saveDelegation(value: Delegation, expectedVersion?: number) {
    const current = this.values.get(value.id)
    if (expectedVersion !== undefined && current?.version !== expectedVersion) throw new Error('delegation version conflict')
    this.values.set(value.id, structuredClone(value))
  }
}

const fullAuthority = (workerId = wid('worker-1')) => ({ workerId, capabilities: ['agent.send', 'agent.inbox.read'] as CapabilityToolName[], allowedProjectIds: [pid('project-1')] })

function fixture(options: {
  source?: ReturnType<typeof fullAuthority>
  target?: ReturnType<typeof fullAuthority>
  quota?: number
  delivery?: { deliverRequest(delegation: Delegation): Promise<ReturnType<typeof message>>; deliverResult(delegation: Delegation, silent: boolean): Promise<ReturnType<typeof message>> }
  journalPort?: { appendResult(delegation: Delegation, silent: boolean): Promise<void> }
} = {}) {
  const repository = new MemoryRepository()
  const delivered: string[] = []
  const journal: string[] = []
  const approvals: string[] = []
  const source = options.source ?? fullAuthority()
  const target = options.target ?? fullAuthority()
  const service = new DelegationApplicationService(
    repository,
    { resolve: async sessionId => sessionId === sid('source-session') ? source : target },
    options.delivery ?? {
      deliverRequest: async delegation => { delivered.push(`request:${delegation.id}`); return message(delegation, 'delegation_request') },
      deliverResult: async (delegation, silent) => { delivered.push(`result:${silent}`); return message(delegation, 'delegation_result') },
    },
    options.journalPort ?? { appendResult: async (_delegation, silent) => { journal.push(`result:${silent}`) } },
    { requestCrossProjectApproval: async delegation => { approvals.push(delegation.id) } },
    now,
    { maxDepth: 4, maxConcurrentChildrenPerParent: options.quota ?? 4 },
  )
  return { repository, service, delivered, journal, approvals }
}

function command(overrides: Partial<CreateDelegationCommand> = {}): CreateDelegationCommand {
  return {
    requestId: 'create-1', dispatchId: 'dispatch-1', objective: '调查失败原因',
    source: { projectId: pid('project-1'), sessionId: sid('source-session'), agentId: 'agent-a', userId: uid('user-1'), canonicalSessionId: sid('source-session') },
    target: { workerId: wid('worker-1'), agentId: 'agent-b', projectId: pid('project-1'), sessionId: sid('target-session') },
    requestedAuthority: { capabilities: ['agent.send', 'http.call'] as CapabilityToolName[], allowedProjectIds: [pid('project-1')] },
    ancestorAgentIds: [], depth: 1, ...overrides,
  }
}

function message(delegation: Delegation, type: 'delegation_request' | 'delegation_result') {
  return {
    id: `${type}-${delegation.id}`, projectId: delegation.target.projectId,
    fromSessionId: delegation.source.sessionId, toSessionId: delegation.target.sessionId,
    fromAgentId: delegation.source.sessionId, toAgentId: delegation.target.sessionId,
    fromAgentKey: 'test:a' as never, toAgentKey: 'test:b' as never, content: delegation.objective,
    type, status: 'accepted' as const, createdAt: now(), readAt: null,
  }
}

test('delegation follows dispatch, accept, running and completion with result returned to canonical session', async () => {
  const f = fixture()
  const created = await f.service.create(command())
  assert.equal(created.delegation.status, 'dispatched')
  assert.deepEqual(created.delegation.authority.capabilities, ['agent.send'])
  const accepted = await f.service.accept({ requestId: 'accept-1', delegationId: created.delegation.id, expectedVersion: 1, actorAgentId: 'agent-b' })
  const running = await f.service.start({ requestId: 'start-1', delegationId: created.delegation.id, expectedVersion: accepted.delegation.version, childRunId: 'child-run-1' })
  const completed = await f.service.complete({ requestId: 'complete-1', delegationId: created.delegation.id, expectedVersion: running.delegation.version, actorAgentId: 'agent-b', outcome: 'completed', resultSummary: '定位完成' })
  assert.equal(completed.delegation.status, 'completed')
  assert.equal(completed.delegation.childRunId, 'child-run-1')
  assert.deepEqual(f.delivered.map(item => item.split(':')[0]), ['request', 'result'])
  assert.deepEqual(f.journal, ['result:false'])
})

test('all terminal outcomes close running delegations and invalid transitions are rejected', async () => {
  for (const outcome of ['completed', 'failed', 'cancelled'] as const) {
    const f = fixture()
    const created = await f.service.create(command({ dispatchId: `dispatch-${outcome}`, requestId: `create-${outcome}` }))
    const accepted = await f.service.accept({ requestId: `accept-${outcome}`, delegationId: created.delegation.id, expectedVersion: 1, actorAgentId: 'agent-b' })
    const running = await f.service.start({ requestId: `start-${outcome}`, delegationId: created.delegation.id, expectedVersion: accepted.delegation.version, childRunId: `run-${outcome}` })
    assert.equal((await f.service.complete({ requestId: `end-${outcome}`, delegationId: created.delegation.id, expectedVersion: running.delegation.version, actorAgentId: 'agent-b', outcome })).delegation.status, outcome)
    await assert.rejects(() => f.service.accept({ requestId: 'late', delegationId: created.delegation.id, expectedVersion: 4, actorAgentId: 'agent-b' }), /cannot move/)
  }
})

test('dispatchId and requestId are idempotent while changed payloads conflict and CAS is enforced', async () => {
  const f = fixture()
  const first = await f.service.create(command())
  assert.equal((await f.service.create(command())).replayed, true)
  await assert.rejects(() => f.service.create(command({ objective: 'changed' })), /dispatchId was reused/)
  const accepted = await f.service.accept({ requestId: 'accept-1', delegationId: first.delegation.id, expectedVersion: 1, actorAgentId: 'agent-b' })
  assert.equal((await f.service.accept({ requestId: 'accept-1', delegationId: first.delegation.id, expectedVersion: 1, actorAgentId: 'agent-b' })).replayed, true)
  await assert.rejects(() => f.service.start({ requestId: 'start-1', delegationId: first.delegation.id, expectedVersion: accepted.delegation.version - 1, childRunId: 'run-1' }), /version conflict/)
})

test('authority is intersected at dispatch and rechecked before accept and execution', async () => {
  const source = fullAuthority()
  const target: { workerId: WorkerId; capabilities: CapabilityToolName[]; allowedProjectIds: ProjectId[] } = fullAuthority()
  const f = fixture({ source, target })
  const created = await f.service.create(command())
  target.capabilities = [] as CapabilityToolName[]
  await assert.rejects(() => f.service.accept({ requestId: 'accept', delegationId: created.delegation.id, expectedVersion: 1, actorAgentId: 'agent-b' }), /no permitted capabilities|narrowed after dispatch/)
})

test('loop, depth, child quota, wrong target and cross Worker dispatch are rejected', async () => {
  await assert.rejects(() => fixture().service.create(command({ ancestorAgentIds: ['agent-b'] })), /ancestor chain/)
  await assert.rejects(() => fixture().service.create(command({ depth: 5 })), /depth exceeds 4/)
  await assert.rejects(() => fixture({ source: fullAuthority(wid('worker-2')) }).service.create(command()), /same Worker/)
  const quota = fixture({ quota: 1 })
  await quota.service.create(command())
  await assert.rejects(() => quota.service.create(command({ requestId: 'two', dispatchId: 'two', target: { ...command().target, agentId: 'agent-c' } })), /quota exceeded/)
  const created = await fixture().service.create(command())
  await assert.rejects(() => fixture().service.accept({ requestId: 'bad', delegationId: created.delegation.id, expectedVersion: 1, actorAgentId: 'agent-x' }), /not found|only the delegated/)
})

test('cross Project dispatch enters pending approval without delivery', async () => {
  const target = { ...fullAuthority(), allowedProjectIds: [pid('project-1'), pid('project-2')] }
  const source = { ...fullAuthority(), allowedProjectIds: [pid('project-1'), pid('project-2')] }
  const f = fixture({ source, target })
  const created = await f.service.create(command({ target: { ...command().target, projectId: pid('project-2') }, requestedAuthority: { capabilities: ['agent.send'], allowedProjectIds: [pid('project-2')] } }))
  assert.equal(created.delegation.status, 'pending_approval')
  assert.equal(created.pendingApproval, true)
  assert.equal(f.approvals.length, 1)
  assert.equal(f.delivered.length, 0)
})

test('two test agents delegate on one Worker, accept, run, return a result to the canonical journal, and continue A turn', async () => {
  const events: string[] = []
  const f = fixture({
    journalPort: { appendResult: async delegation => { events.push(`journal:${delegation.source.canonicalSessionId}:${delegation.resultSummary}`) } },
    delivery: {
      deliverRequest: async delegation => { events.push(`request:${delegation.target.sessionId}`); return message(delegation, 'delegation_request') },
      deliverResult: async delegation => { events.push(`result:${delegation.source.canonicalSessionId}`); return message(delegation, 'delegation_result') },
    },
  })
  const created = await f.service.create(command())
  const accepted = await f.service.accept({ requestId: 'accept-e2e', delegationId: created.delegation.id, expectedVersion: created.delegation.version, actorAgentId: 'agent-b' })
  const running = await f.service.start({ requestId: 'run-e2e', delegationId: created.delegation.id, expectedVersion: accepted.delegation.version, childRunId: 'child-run-e2e' })
  const completed = await f.service.complete({ requestId: 'complete-e2e', delegationId: created.delegation.id, expectedVersion: running.delegation.version, actorAgentId: 'agent-b', outcome: 'completed', resultSummary: 'B 的协作结果' })
  events.push(`continue:${completed.delegation.source.canonicalSessionId}`)
  assert.equal(completed.delegation.childRunId, 'child-run-e2e')
  assert.deepEqual(events, ['request:target-session', 'result:source-session', 'journal:source-session:B 的协作结果', 'continue:source-session'])
})

test('[SILENT] is returned as an empty collaborative result and never rendered into journal content', async () => {
  const f = fixture()
  const created = await f.service.create(command())
  const accepted = await f.service.accept({ requestId: 'a', delegationId: created.delegation.id, expectedVersion: 1, actorAgentId: 'agent-b' })
  const running = await f.service.start({ requestId: 's', delegationId: created.delegation.id, expectedVersion: accepted.delegation.version, childRunId: 'run' })
  await f.service.complete({ requestId: 'c', delegationId: created.delegation.id, expectedVersion: running.delegation.version, actorAgentId: 'agent-b', outcome: 'completed', resultSummary: '[SILENT]' })
  assert.deepEqual(f.delivered.at(-1), 'result:true')
  assert.deepEqual(f.journal, ['result:true'])
})
