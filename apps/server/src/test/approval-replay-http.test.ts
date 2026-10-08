import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import type { Timestamp, UserId } from '@wemux/domain'
import { createWemuxServer } from '../server.ts'
import { TaskService } from '../application/task-service.ts'
import { saveRunProjection } from '../application/run-projection.ts'
import { hashSecret } from '../application/auth.ts'
import { administratorEmail, administratorToken, seedOperator, seedLocalAccount } from './fixtures/administrator.ts'

const actor = 'approval-contributor' as UserId
const password = 'local test password only'
async function fixture(kind: 'session_tool' | 'task_review' | 'task_review_legacy') {
  const directory = await mkdtemp(join(tmpdir(), 'wemux-approval-replay-'))
  const databasePath = join(directory, 'server.sqlite')
  const options = { databasePath, administratorEmails: [administratorEmail], mail: {}, google: {} }
  let app = createWemuxServer(options), base = await app.listen(0)
  const owner = await seedOperator(app.store, app.service)
  await seedLocalAccount(app.store, { userId: actor, username: actor, email: 'approval@example.test', password })
  const at = new Date().toISOString() as Timestamp
  await app.store.transaction(async tx => {
    await tx.identity.saveMembership({ teamId: owner.team.id, userId: actor, role: 'member', joinedAt: at })
    // canDecideHumanReview 要求 actor !== submitter 且（是 Project owner 或具备 membership + manager 授权）。
    // 提交人是 owner，所以这个重放 actor 必须拿 manager 授权，task_review 审批才可能可操作；
    // 后面的 viewer / project-grant / membership 丢失用例仍会把授权改回更弱或直接移除。
    await tx.identity.saveProjectGrant({ projectId: owner.project.id, userId: actor, role: 'manager' })
    await tx.identity.savePersonalAccessToken({ id: 'approval-pat' as never, userId: actor, name: 'Test only', scopes: ['read', 'write'], tokenHash: hashSecret('approval-test-pat'), createdAt: at, expiresAt: '2099-01-01T00:00:00Z' as Timestamp, lastUsedAt: null, revokedAt: null })
  })
  const tasks = new TaskService(app.store, () => {}, app.service)
  const context = { actor: owner.userId, requestId: 'setup' }
  let task = await tasks.create(owner.project.id, { title: 'Receipt isolation' }, context)
  const enrollment = await app.service.createEnrollment({})
  const { worker } = await app.service.enroll({ token: enrollment.token, name: 'Synthetic Worker' })
  await app.store.transaction(tx => tx.resources.saveWorker({ ...worker, connectionState: 'online', capabilities: [{ agentKey: 'test' as never, displayName: 'Test', version: null, mode: 'execution', availability: { status: 'available' }, models: [{ modelId: 'model' as never, displayName: 'Model', source: 'configured' }] }] }))
  const created = await tasks.createWorkspace(task.projectId, task.id, { name: 'Test', workerId: worker.id, source: 'empty' }, context)
  await app.store.transaction(tx => tx.resources.saveWorkspace({ ...created.workspace, status: 'ready' }))
  const assignment = { workspaceId: created.workspace.id, workerId: worker.id, agentKey: 'test', modelId: 'model' }
  task = await tasks.assignment(task.projectId, task.id, { version: task.version, assignee: assignment }, false, context)
  if (kind === 'task_review') {
    // launch() 在首个 Run 的同一事务里把审查要求从 Project 钉入 Task（reviewPolicyFrozen），
    // 执行开始后不得追溯修改；所以配置化 human 审查必须在 launch 之前就存在。
    await app.store.transaction(tx => tx.resources.saveProject({ ...owner.project, reviewPolicy: 'human' }))
  }
  const { run } = await tasks.launch(task.projectId, task.id, { requestId: 'launch', mode: 'new', reuseSessionId: null, prompt: 'Synthetic', assignment }, context)
  await app.store.transaction(async tx => {
    await saveRunProjection(tx, { ...run, status: 'succeeded', finishedAt: at })
    const session = (await tx.resources.getSession(run.sessionId as never))!
    await tx.resources.saveSession({ ...session, shareScope: 'selected-members' })
    await tx.identity.saveSessionGrant({ sessionId: session.id, userId: actor })
    await tx.cache.applyEvents(session.id, [{ sessionId: session.id, seq: 1 as never, occurredAt: at, payload: { kind: 'approval.requested', turnId: 'turn-1' as never, approvalId: 'approval-1' as never, action: { tool: 'synthetic' }, reason: 'Synthetic request' } }])
  })
  if (kind === 'task_review' || kind === 'task_review_legacy') {
    task = await tasks.get(task.projectId, task.id, context)
    task = await tasks.patch(task.projectId, task.id, { version: task.version, status: 'todo' }, context)
    task = await tasks.patch(task.projectId, task.id, { version: task.version, status: 'in_progress' }, context)
    if (kind === 'task_review_legacy') {
      // Legacy no-policy review: projection-service approvals() and task-service decideHumanReview()
      // both deny capabilities unless the Task carries a frozen reviewPolicy 'human' and sits in
      // in_review with the latest succeeded Run, so this shape is listed but never actionable.
      await tasks.reviewAction(task.projectId, task.id, run.id, { version: task.version, status: 'requested' }, context)
    } else {
      // Configured human-review workflow: submitHumanReview pins reviewPolicy/reviewPolicyFrozen,
      // transitions to in_review and opens the review. This is the only actionable task_review shape.
      const submitted = await tasks.submitHumanReview(task.projectId, task.id, { version: task.version, requestId: 'fixture-review-submission', runId: run.id, summary: 'Synthetic submission', evidence: [] }, context)
      task = submitted.task
    }
  }
  const request = async (path: string, body?: unknown, headers: Record<string, string> = { authorization: 'Bearer approval-test-pat' }) => {
    const response = await fetch(`${base}/api${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...headers, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, data: await response.json() }
  }
  // task_review_legacy 只是夹具内部区分，对外 sourceKind 仍是 task_review（服务端校验枚举）。
  const sourceKind = kind === 'task_review_legacy' ? 'task_review' : kind
  const approval = (await request(`/approvals?sourceKind=${sourceKind}`)).data.items[0]
  assert.ok(approval)
  const body = { decision: 'approve', requestId: 'receipt-request', sourceRevision: approval.sourceRevision }
  const decide = (key = approval.projectionKey, value = body, headers?: Record<string, string>) => request(`/approvals/${encodeURIComponent(key)}/decisions`, value, headers)
  const snapshot = () => {
    const db = new DatabaseSync(databasePath)
    try { return ['commands', 'task_activity', 'review_requests', 'approval_decision_receipts', 'approval_decision_overlays'].map(name => {
      // Table names are selected from this owned fixture, never external input.
      return [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]
    }) } finally { db.close() }
  }
  return { get app() { return app }, owner, task, run, approval, body, decide, request, snapshot, databasePath,
    async cookie() {
      const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ login: actor, password }) })
      const cookie = login.headers.getSetCookie().find(v => v.startsWith('wemux_login_session='))!.split(';')[0]!
      const me = await request('/auth/me', undefined, { cookie })
      return { cookie, origin: base, 'x-csrf-token': me.data.csrfToken }
    },
    async reopen() { await app.close(); app = createWemuxServer(options); base = await app.listen(0) },
    async close() { await app.close(); await rm(directory, { recursive: true, force: true }) },
  }
}

test('legacy pending-review decisions stay hidden from HTTP and the review requirement cannot be retro-fitted after execution starts', async t => {
  const f = await fixture('task_review_legacy'); t.after(() => f.close())
  const tasks = new TaskService(f.app.store, () => {}, f.app.service)
  const current = await tasks.get(f.task.projectId, f.task.id, { actor: f.owner.userId, requestId: 'policy-test' })
  const prePatch = f.snapshot()
  // 执行已开始（in_progress + 已有 succeeded Run），审查要求被冻结：
  // 不允许事后把 legacy 审查追溯升级成配置化 human 审查。
  await assert.rejects(
    () => tasks.patch(current.projectId, current.id, { version: current.version, metadataJson: { schemaVersion: 1, values: { reviewPolicy: 'human' } } }, { actor: f.owner.userId, requestId: 'policy-test' }),
    /cannot be changed after execution starts/)
  assert.deepEqual(f.snapshot(), prePatch)
  const response = await f.request('/approvals?sourceKind=task_review')
  assert.equal(response.status, 200)
  const review = response.data.items[0]
  assert.deepEqual(review.decisionCapabilities, [])
  const before = f.snapshot()
  const rejected = await f.decide(review.projectionKey, { ...f.body, sourceRevision: review.sourceRevision })
  assert.equal(rejected.status, 409)
  assert.equal(rejected.data.error.code, 'approval_stale')
  assert.deepEqual(f.snapshot(), before)
})

for (const kind of ['session_tool', 'task_review'] as const) {
  test(`${kind} HTTP receipts bind exact projection, actor and body; reopen and archive replay are read-only`, async t => {
    const f = await fixture(kind); t.after(() => f.close())
    const cookie = await f.cookie()
    const { 'x-csrf-token': _, ...noCsrf } = cookie
    assert.equal((await f.decide(undefined, undefined, noCsrf)).status, 403)
    const first = await f.decide(undefined, undefined, cookie)
    assert.equal(first.status, 200, JSON.stringify(first.data))
    const before = f.snapshot()
    for (const response of await Promise.all(Array.from({ length: 6 }, () => f.decide()))) {
      assert.equal(response.status, 200); assert.equal(response.data.replayed, true)
    }
    const crossKey = await f.decide(`${f.approval.projectionKey}-other`)
    assert.equal(crossKey.status, 409); assert.equal(crossKey.data.approval, undefined)
    assert.equal((await f.decide(undefined, { ...f.body, decision: kind === 'session_tool' ? 'deny' : 'changes_requested' })).status, 409)
    const other = await f.decide(undefined, undefined, { authorization: `Bearer ${administratorToken}` })
    assert.notEqual(other.status, 200); assert.equal(other.data.approval, undefined)
    assert.deepEqual(f.snapshot(), before)
    await f.reopen()
    assert.equal((await f.decide()).data.replayed, true)
    await f.app.store.transaction(async tx => {
      const session = (await tx.resources.getSession(f.run.sessionId as never))!
      await tx.resources.saveSession({ ...session, archivedAt: new Date().toISOString() as Timestamp })
    })
    assert.equal((await f.decide()).data.replayed, true)
    assert.deepEqual(f.snapshot(), before)
    if (kind === 'task_review') assert.deepEqual(await f.app.store.tasks.pendingReviews(f.task.projectId), [])
  })

  for (const loss of ['viewer', 'project-grant', 'membership', 'project-deleted', 'task-deleted', ...(kind === 'session_tool' ? ['session-grant', 'session-deleted'] : [])]) {
    test(`${kind} HTTP replay rechecks current ${loss} authority without effects or receipt disclosure`, async t => {
      const f = await fixture(kind); t.after(() => f.close())
      assert.equal((await f.decide()).status, 200)
      await f.app.store.transaction(async tx => {
        if (loss === 'viewer') await tx.identity.saveProjectGrant({ projectId: f.owner.project.id, userId: actor, role: 'viewer' })
        if (loss === 'project-grant') {
          await tx.resources.saveProject({ ...f.owner.project, shareScope: 'selected-members' })
          await tx.identity.removeProjectGrant(f.owner.project.id, actor)
        }
        if (loss === 'membership') await tx.identity.removeMembership(f.owner.team.id, actor)
        if (loss === 'project-deleted') await tx.resources.saveProject({ ...f.owner.project, deletedAt: new Date().toISOString() as Timestamp })
        if (loss === 'task-deleted') await tx.tasks.save({ ...(await tx.tasks.get(f.task.id))!, deletedAt: new Date().toISOString() })
        if (loss === 'session-grant') await tx.identity.removeSessionGrant(f.run.sessionId as never, actor)
        if (loss === 'session-deleted') await tx.resources.saveSession({ ...(await tx.resources.getSession(f.run.sessionId as never))!, deletedAt: new Date().toISOString() as Timestamp })
      })
      const before = f.snapshot(), response = await f.decide()
      assert.ok([403, 404, 410].includes(response.status), JSON.stringify(response))
      assert.equal(response.data.approval, undefined); assert.equal(response.data.replayed, undefined)
      assert.deepEqual(f.snapshot(), before)
    })
  }
}

for (const kind of ['session_tool', 'task_review'] as const) {
  test(`${kind} HTTP malformed and legacy receipt bindings fail closed without writes`, async t => {
    const f = await fixture(kind); t.after(() => f.close())
    assert.equal((await f.decide()).status, 200)
    const db = new DatabaseSync(f.databasePath); t.after(() => db.close())
    const row = db.prepare('SELECT data FROM approval_decision_receipts WHERE actor_id=? AND request_id=?').get(actor, f.body.requestId)!
    const original = JSON.parse(String(row.data))
    const variants = [
      null, {}, { ...original, actorId: 'another-actor' }, { ...original, requestId: 'another-request' },
      { ...original, result: null },
      { ...original, result: { ...original.result, approval: { ...original.result.approval, projectionKey: undefined } } },
      { ...original, result: { ...original.result, approval: { ...original.result.approval, source: {} } } },
      { ...original, result: { ...original.result, approval: { ...original.result.approval, projectId: 'missing-project' } } },
      { ...original, result: { ...original.result, approval: { ...original.result.approval, source: { ...original.result.approval.source, [kind === 'session_tool' ? 'sessionId' : 'taskId']: 'another-resource' } } } },
    ]
    for (const variant of variants) {
      db.prepare('UPDATE approval_decision_receipts SET data=? WHERE actor_id=? AND request_id=?').run(JSON.stringify(variant), actor, f.body.requestId)
      const before = f.snapshot(), response = await f.decide()
      assert.ok([404, 409].includes(response.status), JSON.stringify(response))
      assert.equal(response.data.approval, undefined); assert.deepEqual(f.snapshot(), before)
    }
    // Pre-fix receipts already had the durable result binding: no migration or fingerprint change needed.
    db.prepare('UPDATE approval_decision_receipts SET data=? WHERE actor_id=? AND request_id=?').run(JSON.stringify(original), actor, f.body.requestId)
    assert.equal((await f.decide()).data.replayed, true)
  })
}

for (const kind of ['session_tool', 'task_review'] as const) {
  test(`${kind} receipt project must match its real resource, even if both Projects are visible`, async t => {
    const f = await fixture(kind); t.after(() => f.close())
    assert.equal((await f.decide()).status, 200)
    const other = await f.app.service.createProject({ teamId: f.owner.team.id, name: 'Other visible Project' }, actor)
    const db = new DatabaseSync(f.databasePath); t.after(() => db.close())
    db.prepare("UPDATE approval_decision_receipts SET data=json_set(data,'$.result.approval.projectId',?) WHERE actor_id=? AND request_id=?").run(other.id, actor, f.body.requestId)
    const before = f.snapshot(), response = await f.decide()
    assert.equal(response.status, 404, JSON.stringify(response.data))
    assert.equal(response.data.approval, undefined); assert.deepEqual(f.snapshot(), before)
  })
}

for (const kind of ['session_tool', 'task_review'] as const) {
  test(`${kind} receipt with a missing authoritative resource fails closed`, async t => {
    const f = await fixture(kind); t.after(() => f.close())
    assert.equal((await f.decide()).status, 200)
    const db = new DatabaseSync(f.databasePath); t.after(() => db.close())
    const receipt = JSON.parse(String(db.prepare('SELECT data FROM approval_decision_receipts WHERE actor_id=? AND request_id=?').get(actor, f.body.requestId)!.data))
    const approval = receipt.result.approval
    if (kind === 'session_tool') approval.source.sessionId = 'missing-session'
    else approval.source.reviewId = 'missing-review'
    const source = approval.source
    approval.projectionKey = (kind === 'session_tool' ? [kind, source.sessionId, source.turnId, source.approvalId] : [kind, source.taskId, source.runId, source.reviewId]).map(encodeURIComponent).join(':')
    db.prepare('UPDATE approval_decision_receipts SET data=? WHERE actor_id=? AND request_id=?').run(JSON.stringify(receipt), actor, f.body.requestId)
    const before = f.snapshot(), response = await f.decide(approval.projectionKey)
    assert.equal(response.status, 404); assert.equal(response.data.approval, undefined)
    assert.deepEqual(f.snapshot(), before)
  })
}

/** Root creation now binds a dedicated Task. Legacy fixtures are separate stored
 * records, not production updates that remove immutable provenance. */
async function rootSessionFixture(legacy?: 'absent' | 'null') {
  const f = await fixture('session_tool')
  try {
    const runSession = (await f.app.store.resources.getSession(f.run.sessionId as never))!
    await f.app.store.transaction(tx => tx.identity.saveWorkerGrant({ workerId: runSession.binding.agent.workerId, userId: actor, role: 'use' }))
    const created = await f.request('/sessions', {
      requestId: 'root-session-create', title: 'Retained root Session', workspaceId: runSession.workspaceId,
      workerId: runSession.binding.agent.workerId, agentKey: runSession.binding.agent.agentKey, modelId: runSession.binding.modelId,
    }, await f.cookie())
    assert.equal(created.status, 201, JSON.stringify(created.data))
    let session = created.data.session
    assert.equal(session.ownerId, actor)
    assert.ok(session.taskId); assert.equal(session.runId, null)
    assert.equal(session.shareScope, 'owner-only')
    if (legacy) {
      const { taskId: _task, runId: _run, creation: _creation, ...original } = session
      session = { ...original, id: `${session.id}-legacy`, ...(legacy === 'null' ? { taskId: null, runId: null } : {}) }
      await f.app.store.transaction(tx => tx.resources.saveSession(session))
    }
    assert.ok(!(await f.app.store.tasks.runs(f.task.id)).some(run => run.sessionId === session.id))
    await f.app.store.transaction(tx => tx.cache.applyEvents(session.id, [{
      sessionId: session.id, seq: 1 as never, occurredAt: new Date().toISOString() as Timestamp,
      payload: { kind: 'approval.requested', turnId: 'root-turn' as never, approvalId: 'root-approval' as never, action: { tool: 'synthetic' }, reason: 'Root compatibility only' },
    }]))
    const key = ['session_tool', session.id, 'root-turn', 'root-approval'].map(encodeURIComponent).join(':')
    const body = { decision: 'approve', requestId: 'root-approval-receipt', sourceRevision: '1' }
    return { ...f, get app() { return f.app }, session, decideRoot: () => f.decide(key, body) }
  } catch (error) { await f.close(); throw error }
}

for (const association of ['dedicated', 'absent', 'null'] as const) {
  test(`root Session HTTP receipt replays ${association} associations before/after reopen and preserves owner authority policy`, async t => {
    const f = await rootSessionFixture(association === 'dedicated' ? undefined : association); t.after(() => f.close())
    const first = await f.decideRoot()
    assert.equal(first.status, 200, JSON.stringify(first.data)); assert.equal(first.data.replayed, false)
    const before = f.snapshot()
    const replay = await f.decideRoot()
    assert.equal(replay.status, 200, JSON.stringify(replay.data))
    assert.deepEqual(replay.data, { ...first.data, replayed: true }); assert.deepEqual(f.snapshot(), before)
    await f.reopen()
    const reopened = await f.decideRoot()
    assert.equal(reopened.status, 200, JSON.stringify(reopened.data))
    assert.deepEqual(reopened.data, { ...first.data, replayed: true }); assert.deepEqual(f.snapshot(), before)

    // Session ownership retains write authority with a viewer Project grant.
    await f.app.store.transaction(tx => tx.identity.saveProjectGrant({ projectId: f.owner.project.id, userId: actor, role: 'viewer' }))
    const downgraded = await f.decideRoot()
    assert.equal(downgraded.status, 200, JSON.stringify(downgraded.data))
    assert.deepEqual(downgraded.data, { ...first.data, replayed: true }); assert.deepEqual(f.snapshot(), before)

    // Session ownership does not bypass current Project visibility / Team membership.
    await f.app.store.transaction(tx => tx.identity.removeMembership(f.owner.team.id, actor))
    const denied = await f.decideRoot()
    assert.equal(denied.status, 404); assert.equal(denied.data.approval, undefined); assert.equal(denied.data.replayed, undefined)
    assert.deepEqual(f.snapshot(), before)
  })
}

for (const binding of ['missing-task', 'missing-run', 'foreign-session-run', 'deleted-task'] as const) {
  test(`root Session receipt rejects explicitly recorded ${binding} binding without effects`, async t => {
    const f = await rootSessionFixture(); t.after(() => f.close())
    assert.equal((await f.decideRoot()).status, 200)
    if (binding === 'deleted-task') await f.app.store.transaction(async tx => {
      await tx.tasks.save({ ...(await tx.tasks.get(f.task.id))!, deletedAt: new Date().toISOString() })
    })
    const db = new DatabaseSync(f.databasePath)
    try {
      // Deliberate corrupt/legacy provenance in our disposable SQLite only. Restore
      // validation triggers immediately; production creation/update policy is not changed.
      const triggers = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name IN ('session_creation_provenance','session_task_scope','session_source_update')").all()
      db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE')
      try {
        for (const trigger of triggers) db.exec(`DROP TRIGGER ${trigger.name}`)
        const patch = binding === 'missing-task' ? { taskId: 'missing-task' }
          : binding === 'missing-run' ? { runId: 'missing-run' }
          : binding === 'foreign-session-run' ? { runId: f.run.id } : { taskId: f.task.id }
        db.prepare("UPDATE records SET data=json_patch(data,?) WHERE kind='session' AND id=?").run(JSON.stringify(patch), f.session.id)
        for (const trigger of triggers) db.exec(String(trigger.sql))
        db.exec('COMMIT')
      } catch (error) { db.exec('ROLLBACK'); throw error }
    } finally { db.close() }
    const before = f.snapshot(), response = await f.decideRoot()
    assert.equal(response.status, binding === 'deleted-task' ? 410 : 404, JSON.stringify(response.data))
    assert.equal(response.data.approval, undefined); assert.equal(response.data.replayed, undefined)
    assert.deepEqual(f.snapshot(), before)
  })
}
