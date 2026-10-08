import assert from 'node:assert/strict'
import test from 'node:test'
import { ProjectionService, decodeProjectionCursor } from '../application/projection-service.ts'
import type { ApprovalView } from '@wemux/server-domain'

const now = '2026-04-01T12:00:00.000Z'
function serviceFixture(overlays: readonly ApprovalView[] = [], projectRole: 'owner' | 'manager' | 'viewer' | 'contributor' = 'owner', options: { submitter?: string; membership?: boolean; reviewPolicy?: string; frozen?: boolean; runStatus?: string; newerRun?: boolean; closed?: boolean } = {}) {
  const projects = [{ id: 'project-visible', name: 'Visible', teamId: 'team-1', ownerId: projectRole === 'owner' ? 'viewer' : 'other' }]
  const task = { id: 'task-1', projectId: 'project-visible', title: 'Ship approval', version: 3, status: 'in_review', deletedAt: null, currentReviewId: 'review-1', blockedFrom: null, cancelledFrom: null, assignee: null, metadataJson: { schemaVersion: 1, values: { reviewPolicy: options.reviewPolicy ?? 'human', reviewPolicyFrozen: options.frozen ?? true } } }
  const review = { id: 'review-1', taskId: 'task-1', projectId: 'project-visible', taskRunId: 'run-1', actor: options.submitter ?? 'user-reviewer', requestedAt: now, status: 'requested', closedAt: options.closed ? now : null, decidedAt: null, reviewer: null }
  const session = { id: 'session-1', projectId: 'project-visible', title: 'Connector session', binding: { agent: { agentKey: 'pi' } } }
  const store = {
    tasks: {
      pendingReviews: async (projectId: string) => projectId === 'project-visible' ? [review] : [],
      get: async (id: string) => id === 'task-1' ? task : null,
      projectActivity: async () => [{ activity: { taskId: 'task-1', seq: 1, type: 'review.requested', requestId: 'request-review', occurredAt: now, actor: 'user-reviewer' } }],
    },
    cache: {
      getFreshness: async () => ({ status: 'synced', contiguousSeq: 2 }),
      readEvents: async () => ({ events: [
        { sessionId: 'session-1', seq: 1, occurredAt: '2026-04-01T11:59:00.000Z', payload: { kind: 'approval.requested', approvalId: 'approval-1', turnId: 'turn-1', reason: '允许连接外部服务' } },
        { sessionId: 'session-1', seq: 2, occurredAt: '2026-04-01T12:00:00.000Z', payload: { kind: 'turn.started', turnId: 'turn-1' } },
      ] }),
    },
    identity: { queryAudit: async () => ({ items: [{ id: 'audit-1', actorId: 'user-reviewer', action: 'review.requested', resource: { kind: 'project', id: 'project-visible' }, metadata: { requestId: 'request-review' }, occurredAt: now, result: 'success' }] }), getIdentityRecords: async () => ({ membership: { role: 'member' }, projectGrant: null }) },
    transaction: async (work: (tx: unknown) => Promise<unknown>) => { const run = { id: 'run-1', taskId: task.id, projectId: task.projectId, attempt: 1, sessionId: 'session-1', status: options.runStatus ?? 'succeeded', snapshot: { workspaceId: 'workspace-1', workerId: 'worker-1', agentKey: 'pi', modelId: 'model-1' } }; return work({ tasks: { run: async () => run, runs: async () => options.newerRun ? [run, { ...run, id: 'run-2', attempt: 2 }] : [run], review: async () => review, reviewById: async () => review }, resources: { getProject: async () => projects[0], getWorkspace: async () => null, getWorker: async () => null }, identity: { getIdentityRecords: async () => ({ membership: options.membership === false ? null : { role: 'member' }, projectGrant: projectRole === 'owner' ? null : { role: projectRole } }) } }) },
  }
  return new ProjectionService(store as never, { list: async () => projects } as never, { list: async () => [session] } as never, { listOverlays: async () => overlays } as never)
}

test('projection service aggregates task and session approvals with freshness and stable cursor', async () => {
  const service = serviceFixture()
  const first = await service.approvals('viewer' as never, { limit: 1 })
  assert.equal(first.items.length, 1); assert.ok(first.nextCursor); assert.equal(first.items[0]?.freshness.status, 'current')
  const cursor = decodeProjectionCursor(first.nextCursor ?? undefined); assert.equal(cursor?.occurredAt, now)
  const second = await service.approvals('viewer' as never, { limit: 1, cursor: first.nextCursor ?? undefined })
  assert.equal(second.items.length, 1); assert.notEqual(second.items[0]?.projectionKey, first.items[0]?.projectionKey)
})

for (const role of ['owner', 'manager', 'contributor', 'viewer'] as const) {
  test(`human review projection advertises decisions only to non-submitting owner/manager: ${role}`, async () => {
    const view = (await serviceFixture([], role).approvals('viewer' as never, { sourceKind: 'task_review', status: 'pending' })).items[0]
    assert.ok(view)
    assert.deepEqual(view.decisionCapabilities, role === 'owner' || role === 'manager' ? ['approve', 'changes_requested'] : [])
    const submitted = (await serviceFixture([], role, { submitter: 'viewer' }).approvals('viewer' as never, { sourceKind: 'task_review' })).items[0]
    assert.ok(submitted)
    assert.deepEqual(submitted.decisionCapabilities, [])
  })
}

test('human review projection rechecks membership instead of trusting a visible manager Project', async () => {
  const revoked = (await serviceFixture([], 'manager', { membership: false }).approvals('viewer' as never, { sourceKind: 'task_review' })).items[0]
  assert.ok(revoked)
  assert.deepEqual(revoked.decisionCapabilities, [])
  const owner = (await serviceFixture([], 'owner', { membership: false }).approvals('viewer' as never, { sourceKind: 'task_review' })).items[0]
  assert.deepEqual(owner?.decisionCapabilities, ['approve', 'changes_requested'])
})

for (const options of [{ reviewPolicy: 'none' }, { reviewPolicy: 'agent' }, { frozen: false }, { runStatus: 'failed' }, { runStatus: 'running' }, { newerRun: true }, { closed: true }]) {
  test(`human review projection withholds decisions outside the current eligible human stage: ${JSON.stringify(options)}`, async () => {
    const view = (await serviceFixture([], 'manager', options).approvals('viewer' as never, { sourceKind: 'task_review' })).items[0]
    assert.ok(view)
    assert.deepEqual(view.decisionCapabilities, [])
  })
}

test('projection service filters inaccessible projects and deduplicates timeline authority', async () => {
  const service = serviceFixture()
  assert.deepEqual(await service.approvals('viewer' as never, { projectId: 'project-hidden' as never }), { items: [], nextCursor: null })
  const timeline = await service.timeline('viewer' as never, {})
  assert.equal(timeline.items.length, 1); assert.equal(timeline.items[0]?.sourceKind, 'task_activity')
})

test('projection service filters approvals by status before pagination', async () => {
  const service = serviceFixture()
  assert.equal((await service.approvals('viewer' as never, { status: 'pending' })).items.length, 2)
  assert.equal((await service.approvals('viewer' as never, { status: 'approved' })).items.length, 0)
})

test('projection service reads a persisted decision overlay and exposes the corresponding timeline event', async () => {
  const pending = (await serviceFixture().approvals('viewer' as never, { sourceKind: 'task_review' })).items[0]
  assert.ok(pending)
  const decided: ApprovalView = { ...pending, status: 'approved', decidedAt: '2026-04-01T12:01:00.000Z' as never, decisionCapabilities: [] }
  const service = serviceFixture([decided])
  assert.equal((await service.approvals('viewer' as never, { sourceKind: 'task_review' })).items[0]?.status, 'approved')
  assert.ok((await service.timeline('viewer' as never, {})).items.some(item => item.action === 'approval.decided'))
})

// Synthetic Journal fixtures exercise read projection only, not Worker/native execution.
function lifecycleFixture() {
  const journals = new Map<string, import('@wemux/domain').JournalEvent[]>()
  let visible = ['session-a', 'session-b']
  let overlays: readonly ApprovalView[] = []
  const service = new ProjectionService({
    tasks: { pendingReviews: async () => [], projectActivity: async () => [] },
    identity: { queryAudit: async () => ({ items: [] }) },
    cache: {
      getFreshness: async (id: string) => ({ status: 'synced', contiguousSeq: Math.max(0, ...(journals.get(id) ?? []).map(e => e.seq)) }),
      readEvents: async (id: string) => ({ events: journals.get(id) ?? [] }),
    },
  } as never, { list: async () => [{ id: 'project-visible' }] } as never, {
    list: async () => visible.map(id => ({ id, projectId: 'project-visible', title: id, binding: { agent: { agentKey: 'test' } } })),
  } as never, { listOverlays: async () => overlays } as never)
  function event(sessionId: string, seq: number, payload: Record<string, unknown>, occurredAt = now) {
    const events = journals.get(sessionId) ?? []
    events.push({ sessionId, seq, occurredAt, payload } as unknown as import('@wemux/domain').JournalEvent)
    journals.set(sessionId, events)
  }
  return { service, journals, event, overlays(value: readonly ApprovalView[]) { overlays = value }, visible(value: string[]) { visible = value },
    request(session: string, seq: number, turnId = 'turn-1', approvalId = 'shared') { event(session, seq, { kind: 'approval.requested', turnId, approvalId, action: {}, reason: `request-${seq}` }) },
    resolve(session: string, seq: number, turnId: string, decision: 'approve' | 'deny') { event(session, seq, { kind: 'approval.resolved', turnId, approvalId: 'shared', decision }) },
    finish(session: string, seq: number, turnId: string, outcome = 'completed') { event(session, seq, { kind: 'turn.finished', turnId, outcome, failure: null }) },
    async rows() { return (await service.approvals('viewer' as never, { sourceKind: 'session_tool' })).items },
  }
}

test('session approval identity includes Session and Turn even with opposite decisions for reused approvalId', async () => {
  const f = lifecycleFixture()
  f.request('session-a', 1); f.resolve('session-a', 2, 'turn-1', 'approve')
  f.request('session-a', 3, 'turn-2'); f.resolve('session-a', 4, 'turn-2', 'deny')
  f.request('session-b', 1); f.resolve('session-b', 2, 'turn-1', 'deny')
  f.request('session-b', 3, 'turn-2')
  const rows = await f.rows()
  assert.deepEqual(rows.map(r => [r.projectionKey, r.status, r.sourceRevision]), [
    ['session_tool:session-a:turn-1:shared', 'approved', '1'], ['session_tool:session-a:turn-2:shared', 'denied', '3'],
    ['session_tool:session-b:turn-1:shared', 'denied', '1'], ['session_tool:session-b:turn-2:shared', 'pending', '3'],
  ])
})

for (const outcome of ['completed', 'cancelled', 'failed']) {
  test(`unresolved approval expires only on matching Turn ${outcome}; stale resolution cannot resurrect it`, async () => {
    const f = lifecycleFixture()
    f.request('session-a', 1); f.request('session-a', 2, 'turn-2')
    f.finish('session-a', 3, 'turn-1', outcome)
    f.resolve('session-a', 4, 'turn-1', 'approve')
    const [expired, pending] = await f.rows()
    assert.equal(expired?.status, 'expired'); assert.deepEqual(expired?.decisionCapabilities, []); assert.equal(expired?.decidedAt, null)
    assert.equal(pending?.status, 'pending'); assert.deepEqual(pending?.decisionCapabilities, ['approve', 'deny'])
  })
}

for (const reason of ['timeout', 'cancelled', 'turn_released', 'shutdown']) test(`automatic ${reason} expires exact pending identity without a human decision`, async () => {
  const f = lifecycleFixture()
  f.request('session-a', 1); f.request('session-a', 2, 'turn-2'); f.request('session-b', 1)
  f.event('session-a', 3, { kind: 'approval.expired', turnId: 'turn-1', approvalId: 'shared', reason })
  f.resolve('session-a', 4, 'turn-1', 'approve'); f.request('session-a', 5)
  const rows = await f.rows()
  assert.deepEqual(rows.map(r => r.status), ['expired', 'pending', 'pending'])
  assert.equal(rows[0]?.decidedAt, null); assert.deepEqual(rows[0]?.decisionCapabilities, [])
  assert.equal(rows[0]?.sourceRevision, '1')
  f.resolve('session-a', 6, 'turn-2', 'deny')
  f.event('session-a', 7, { kind: 'approval.expired', turnId: 'turn-2', approvalId: 'shared', reason })
  assert.equal((await f.rows())[1]?.status, 'denied')
})

test('Journal sequence, not timestamp or input array order, determines first terminal decision before finish', async () => {
  const f = lifecycleFixture()
  f.finish('session-a', 4, 'turn-1')
  f.event('session-a', 2, { kind: 'approval.resolved', turnId: 'turn-1', approvalId: 'shared', decision: 'approve' }, '2026-04-01T08:00:00.000Z')
  f.event('session-a', 3, { kind: 'approval.resolved', turnId: 'turn-1', approvalId: 'shared', decision: 'deny' }, '2026-04-01T07:00:00.000Z')
  f.request('session-a', 1)
  const [row] = await f.rows()
  assert.equal(row?.status, 'approved'); assert.equal(row?.decidedAt, '2026-04-01T08:00:00.000Z'); assert.equal(row?.sourceRevision, '1')
})

test('resolution before request is not applicable; first request after finish is expired', async () => {
  const f = lifecycleFixture()
  f.resolve('session-a', 1, 'turn-1', 'approve'); f.request('session-a', 2)
  f.finish('session-a', 3, 'turn-2'); f.request('session-a', 4, 'turn-2'); f.resolve('session-a', 5, 'turn-2', 'deny')
  const rows = await f.rows()
  assert.deepEqual(rows.map(r => [r.status, r.sourceRevision, r.decidedAt]), [['pending', '2', null], ['expired', '4', null]])
})

test('duplicate requests and observations preserve first request revision, content, order and filtered cursor pages', async () => {
  const f = lifecycleFixture()
  f.request('session-a', 1); f.request('session-a', 2, 'turn-2'); f.request('session-b', 1)
  const first = await f.service.approvals('viewer' as never, { limit: 1, status: 'pending', sourceKind: 'session_tool' })
  f.event('session-a', 3, { kind: 'approval.requested', turnId: 'turn-1', approvalId: 'shared', action: { changed: true }, reason: 'not authoritative' }, '2026-04-02T00:00:00.000Z')
  f.journals.get('session-a')!.push(f.journals.get('session-a')![0]!)
  const repeated = await f.service.approvals('viewer' as never, { limit: 1, status: 'pending', sourceKind: 'session_tool' })
  assert.equal(repeated.nextCursor, first.nextCursor)
  assert.deepEqual(repeated.items.map(({ freshness: _, ...row }) => row), first.items.map(({ freshness: _, ...row }) => row))
  const second = await f.service.approvals('viewer' as never, { limit: 1, status: 'pending', sourceKind: 'session_tool', cursor: first.nextCursor! })
  const third = await f.service.approvals('viewer' as never, { limit: 1, status: 'pending', sourceKind: 'session_tool', cursor: second.nextCursor! })
  assert.equal(third.nextCursor, null)
  assert.equal(new Set([...first.items, ...second.items, ...third.items].map(r => r.projectionKey)).size, 3)
  assert.equal((await f.rows())[0]?.reason, 'request-1'); assert.equal((await f.rows())[0]?.sourceRevision, '1')
  f.finish('session-a', 4, 'turn-1'); f.request('session-a', 5)
  assert.equal((await f.rows())[0]?.status, 'expired')
  assert.equal((await f.service.approvals('viewer' as never, { status: 'expired', limit: 1 })).items.length, 1)
  assert.equal((await f.service.approvals('viewer' as never, { status: 'pending' })).items.length, 2)
})

for (const mismatch of ['session', 'turn', 'approval', 'revision', 'project']) {
  test(`session overlay with mismatched ${mismatch} is ignored in approvals and timeline`, async () => {
    const f = lifecycleFixture(); f.request('session-a', 1)
    const pending = (await f.rows())[0]!
    assert.equal(pending.source.kind, 'session_tool')
    const source = pending.source as Extract<ApprovalView['source'], { kind: 'session_tool' }>
    const overlay: ApprovalView = { ...pending, status: 'approved', decidedAt: now as never, decisionCapabilities: [],
      source: { ...source, ...(mismatch === 'session' ? { sessionId: 'other' as never } : mismatch === 'turn' ? { turnId: 'other' as never } : mismatch === 'approval' ? { approvalId: 'other' as never } : {}) },
      ...(mismatch === 'revision' ? { sourceRevision: '99' } : mismatch === 'project' ? { projectId: 'other' as never } : {}),
    }
    f.overlays([overlay])
    assert.equal((await f.rows())[0]?.status, 'pending')
    assert.deepEqual((await f.service.timeline('viewer' as never, {})).items, [])
  })
}

for (const terminal of ['approved', 'denied', 'expired']) {
  test(`authoritative ${terminal} beats matching optimistic overlay; timeline does not contradict Journal`, async () => {
    const f = lifecycleFixture(); f.request('session-a', 1)
    const pending = (await f.rows())[0]!
    f.overlays([{ ...pending, status: terminal === 'approved' ? 'denied' : 'approved', decidedAt: now as never, decisionCapabilities: [] }])
    assert.equal((await f.rows())[0]?.status, terminal === 'approved' ? 'denied' : 'approved')
    assert.equal((await f.service.timeline('viewer' as never, {})).items.length, 1)
    if (terminal === 'expired') f.finish('session-a', 2, 'turn-1')
    else { f.resolve('session-a', 2, 'turn-1', terminal === 'approved' ? 'approve' : 'deny'); f.finish('session-a', 3, 'turn-1') }
    const row = (await f.rows())[0]!
    assert.equal(row.status, terminal); assert.equal(row.sourceRevision, '1'); assert.deepEqual(row.decisionCapabilities, [])
    assert.deepEqual((await f.service.timeline('viewer' as never, {})).items, [])
  })
}

test('session overlay timeline requires current Session visibility and a known request, not just Project visibility', async () => {
  const f = lifecycleFixture(); f.request('session-a', 1)
  const pending = (await f.rows())[0]!
  f.overlays([{ ...pending, status: 'approved', decidedAt: now as never, decisionCapabilities: [] }])
  assert.equal((await f.service.timeline('viewer' as never, {})).items.length, 1)
  f.visible(['session-b'])
  assert.deepEqual(await f.rows(), []); assert.deepEqual((await f.service.timeline('viewer' as never, {})).items, [])
  f.visible(['session-a']); f.journals.clear()
  assert.deepEqual((await f.service.timeline('viewer' as never, {})).items, [])
})


test('duplicate request after resolution retains first request and decision rather than reopening approval', async () => {
  const f = lifecycleFixture(); f.request('session-a', 1); f.resolve('session-a', 2, 'turn-1', 'deny')
  f.request('session-a', 3); f.resolve('session-a', 4, 'turn-1', 'approve'); f.finish('session-a', 5, 'turn-1')
  const rows = await f.rows()
  assert.equal(rows.length, 1); assert.equal(rows[0]?.status, 'denied'); assert.equal(rows[0]?.sourceRevision, '1')
  assert.equal(rows[0]?.reason, 'request-1'); assert.deepEqual(rows[0]?.decisionCapabilities, [])
})

test('foreign Session Journal observations cannot finish or resolve the same Turn and approval identity', async () => {
  const f = lifecycleFixture(); f.request('session-a', 1)
  f.resolve('session-b', 2, 'turn-1', 'deny'); f.finish('session-b', 3, 'turn-1'); f.request('session-b', 4)
  f.journals.get('session-a')!.push(...f.journals.get('session-b')!)
  const rows = await f.rows()
  assert.deepEqual(rows.map(row => [row.projectionKey, row.status]), [
    ['session_tool:session-a:turn-1:shared', 'pending'], ['session_tool:session-b:turn-1:shared', 'expired'],
  ])
})
