import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import type { JournalEvent, SessionEventPayload, Timestamp, UserId } from '@wemux/domain'
import type { ApprovalPage, TimelinePage } from '@wemux/server-domain'
import { createWemuxServer } from '../server.ts'
import { TaskService } from '../application/task-service.ts'
import { validateEvent } from '../application/validation.ts'
import { hashSecret } from '../application/auth.ts'
import { administratorEmail, seedOperator, seedLocalAccount } from './fixtures/administrator.ts'

// Real HTTP + temporary SQLite; Journal and Worker capability are synthetic, not execution proof.
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'wemux-approval-projection-http-'))
  const databasePath = join(directory, 'server.sqlite')
  const options = { databasePath, administratorEmails: [administratorEmail], mail: {}, google: {} }
  let app = createWemuxServer(options)
  let base: string
  try {
    base = await app.listen(0)
    const owner = await seedOperator(app.store, app.service)
    const actor = 'projection-contributor' as UserId
    await seedLocalAccount(app.store, { userId: actor, username: actor, email: 'projection@example.test', password: 'local test password' })
    const at = new Date().toISOString() as Timestamp
    await app.store.transaction(async tx => {
      await tx.identity.saveMembership({ teamId: owner.team.id, userId: actor, role: 'member', joinedAt: at })
      await tx.identity.saveProjectGrant({ projectId: owner.project.id, userId: actor, role: 'contributor' })
      await tx.identity.savePersonalAccessToken({ id: 'projection-pat' as never, userId: actor, name: 'Test only', scopes: ['read', 'write'], tokenHash: hashSecret('projection-test-pat'), createdAt: at, expiresAt: '2099-01-01T00:00:00Z' as Timestamp, lastUsedAt: null, revokedAt: null })
    })
    const tasks = new TaskService(app.store, () => {}, app.service)
    const context = { actor: owner.userId, requestId: 'projection-setup' }
    const task = await tasks.create(owner.project.id, { title: 'Projection lifecycle' }, context)
    const enrollment = await app.service.createEnrollment({})
    const { worker } = await app.service.enroll({ token: enrollment.token, name: 'Synthetic Worker' })
    await app.store.transaction(tx => tx.resources.saveWorker({ ...worker, connectionState: 'online', capabilities: [{ agentKey: 'test' as never, displayName: 'Test', version: null, mode: 'execution', availability: { status: 'available' }, models: [{ modelId: 'model' as never, displayName: 'Model', source: 'configured' }] }] }))
    const created = await tasks.createWorkspace(task.projectId, task.id, { name: 'Test', workerId: worker.id, source: 'empty' }, context)
    await app.store.transaction(tx => tx.resources.saveWorkspace({ ...created.workspace, status: 'ready' }))
    const { session } = await tasks.createSession(task.projectId, task.id, {
      requestId: 'projection-session', title: 'Synthetic approvals', workspaceId: created.workspace.id, workerId: worker.id, agentKey: 'test', modelId: 'model',
    }, context)
    await app.store.transaction(async tx => {
      await tx.resources.saveSession({ ...session, shareScope: 'selected-members' })
      await tx.identity.saveSessionGrant({ sessionId: session.id, userId: actor })
    })
    const request = async (path: string, body?: unknown) => {
      const response = await fetch(`${base}/api${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer projection-test-pat', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      return { status: response.status, data: await response.json() }
    }
    let seq = 0
    const append = async (payload: SessionEventPayload) => {
      const event: JournalEvent = { sessionId: session.id, seq: ++seq as never, occurredAt: at, payload }
      await app.store.transaction(tx => tx.cache.applyEvents(session.id, [event]))
    }
    const snapshot = () => {
      const db = new DatabaseSync(databasePath)
      try { return ['commands', 'task_activity', 'review_requests', 'approval_decision_receipts', 'approval_decision_overlays'].map(name => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]) }
      finally { db.close() }
    }
    const approvals = async (query = '') => {
      const response = await request(`/approvals?sourceKind=session_tool${query}`)
      assert.equal(response.status, 200)
      return response.data as ApprovalPage
    }
    const timeline = async () => {
      const response = await request('/timeline?sourceKind=session')
      assert.equal(response.status, 200)
      return response.data as TimelinePage
    }
    const key = ['session_tool', session.id, 'turn-1', 'shared'].map(encodeURIComponent).join(':')
    const body = { decision: 'approve', requestId: 'first-decision', sourceRevision: '1' }
    return { get app() { return app }, actor, session, append, snapshot, approvals, timeline, body,
      decide: (input = body) => request(`/approvals/${encodeURIComponent(key)}/decisions`, input),
      async requestApproval(turnId = 'turn-1') { await append({ kind: 'approval.requested', turnId: turnId as never, approvalId: 'shared' as never, action: { tool: 'synthetic' } }) },
      async finish(outcome: 'completed' | 'failed' | 'cancelled') { await append({ kind: 'turn.finished', turnId: 'turn-1' as never, outcome, failure: null }) },
      async reopen() { await app.close(); app = createWemuxServer(options); base = await app.listen(0) },
      async close() { await app.close(); await rm(directory, { recursive: true, force: true }) },
    }
  } catch (error) { await app.close(); await rm(directory, { recursive: true, force: true }); throw error }
}

for (const outcome of ['completed', 'cancelled', 'failed'] as const) {
  test(`HTTP ${outcome} Turn expires pending approval, blocks new decision and command, isolates next Turn and stable pages`, async t => {
    const f = await fixture(); t.after(() => f.close())
    await f.requestApproval()
    assert.equal((await f.approvals()).items[0]?.status, 'pending')
    await f.finish(outcome)
    const before = f.snapshot()
    const expired = (await f.approvals('&status=expired')).items[0]!
    assert.ok(expired, 'finished unresolved approval must appear in expired filter'); assert.equal(expired.status, 'expired'); assert.equal(expired.decidedAt, null); assert.deepEqual(expired.decisionCapabilities, [])
    const response = await f.decide()
    assert.equal(response.status, 409); assert.equal(response.data.error.code, 'approval_stale')
    assert.deepEqual(f.snapshot(), before)
    await f.append({ kind: 'approval.resolved', turnId: 'turn-1' as never, approvalId: 'shared' as never, decision: 'approve' })
    await f.requestApproval('turn-2'); await f.requestApproval('turn-2')
    const all = await f.approvals()
    assert.deepEqual(all.items.map(row => [row.status, row.sourceRevision]), [['expired', '1'], ['pending', '4']])
    const first = await f.approvals('&limit=1')
    assert.ok(first.nextCursor)
    assert.deepEqual(await f.approvals('&limit=1'), first)
    const second = await f.approvals(`&limit=1&cursor=${encodeURIComponent(first.nextCursor)}`)
    assert.equal(second.items.length, 1); assert.equal(second.nextCursor, null)
    assert.notEqual(first.items[0]?.projectionKey, second.items[0]?.projectionKey)
    assert.equal((await f.approvals('&status=pending&limit=1')).items[0]?.sourceRevision, '4')
    assert.deepEqual(f.snapshot(), before)
  })
}

for (const reason of ['timeout', 'cancelled', 'turn_released', 'shutdown'] as const) test(`HTTP automatic ${reason} persists expired projection across reopen and rejects new decisions`, async t => {
  const f = await fixture(); t.after(() => f.close())
  await f.requestApproval()
  const payload = { kind: 'approval.expired' as const, turnId: 'turn-1' as never, approvalId: 'shared' as never, reason }
  validateEvent({ sessionId: f.session.id, seq: 2, occurredAt: new Date().toISOString(), payload })
  assert.throws(() => validateEvent({ sessionId: f.session.id, seq: 2, occurredAt: new Date().toISOString(), payload: { ...payload, reason: 'approve' } }))
  await f.append(payload)
  const before = f.snapshot()
  for (const reopen of [false, true]) {
    if (reopen) await f.reopen()
    const row = (await f.approvals('&status=expired')).items[0]!
    assert.equal(row.status, 'expired'); assert.equal(row.decidedAt, null); assert.deepEqual(row.decisionCapabilities, [])
    assert.equal((await f.approvals('&status=pending')).items.length, 0)
    assert.equal((await f.decide()).status, 409)
    assert.deepEqual(f.snapshot(), before)
  }
})

for (const terminal of ['expired', 'denied'] as const) {
  test(`HTTP Journal ${terminal} overrides optimistic admission; immutable receipt replay survives reopen without execution`, async t => {
    const f = await fixture(); t.after(() => f.close())
    await f.requestApproval()
    const receipt = await f.decide()
    assert.equal(receipt.status, 200); assert.equal(receipt.data.replayed, false)
    const admittedCommand = await f.app.store.commands.getPendingCommand(f.body.requestId as never)
    assert.equal(admittedCommand?.command.kind, 'runtime.approval.resolve')
    if (admittedCommand?.command.kind === 'runtime.approval.resolve') assert.deepEqual([admittedCommand.command.sessionId, admittedCommand.command.turnId, admittedCommand.command.approvalId], [f.session.id, 'turn-1', 'shared'])
    const admitted = f.snapshot()
    assert.equal((await f.approvals()).items[0]?.status, 'approved')
    assert.equal((await f.timeline()).items.length, 1)
    if (terminal === 'denied') await f.append({ kind: 'approval.resolved', turnId: 'turn-1' as never, approvalId: 'shared' as never, decision: 'deny' })
    await f.finish('completed')
    if (terminal === 'expired') await f.append({ kind: 'approval.resolved', turnId: 'turn-1' as never, approvalId: 'shared' as never, decision: 'approve' })
    for (const reopened of [false, true]) {
      if (reopened) await f.reopen()
      assert.equal((await f.approvals()).items[0]?.status, terminal)
      assert.deepEqual((await f.timeline()).items, [])
      const rejected = await f.decide({ ...f.body, requestId: 'new-decision' })
      assert.equal(rejected.status, 409); assert.equal(rejected.data.error.code, 'approval_stale')
      const replay = await f.decide()
      assert.equal(replay.status, 200); assert.deepEqual(replay.data, { ...receipt.data, replayed: true })
      assert.deepEqual(f.snapshot(), admitted)
    }
    await f.app.store.transaction(tx => tx.identity.removeSessionGrant(f.session.id, f.actor))
    const revoked = await f.decide()
    assert.equal(revoked.status, 404); assert.equal(revoked.data.approval, undefined)
    assert.deepEqual((await f.approvals()).items, []); assert.deepEqual((await f.timeline()).items, [])
    assert.deepEqual(f.snapshot(), admitted)
  })
}

test('HTTP pending Session overlay is removed from timeline after Session grant revocation despite visible Project', async t => {
  const f = await fixture(); t.after(() => f.close())
  await f.requestApproval(); assert.equal((await f.decide()).status, 200)
  assert.equal((await f.timeline()).items.length, 1)
  await f.app.store.transaction(tx => tx.identity.removeSessionGrant(f.session.id, f.actor))
  assert.deepEqual((await f.timeline()).items, [])
})
