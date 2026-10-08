import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentKey, ModelId, SessionId, Timestamp, UserId, WorkerId, WorkspaceId } from '@wemux/domain'
import { createWemuxServer } from '../server.ts'
import { administratorEmail, seedAdministrator, administratorToken } from './fixtures/administrator.ts'
import { hashSecret } from '../application/auth.ts'
import { CapabilityTokenService } from '../application/capability-token-service.ts'
import { coordinationTaskId, teamCoordinationTask } from '../application/team-coordination-task.ts'

const at = '2026-06-01T00:00:00Z' as Timestamp
const contributor = 'task-projection-contributor' as UserId
const outsider = 'task-projection-outsider' as UserId
const capabilitySecret = 'synthetic-task-projection-secret-for-tests'

/** Real SQLite, real Journal cache, real capability tokens; no Worker connection and no Runtime invocation. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'wemux-task-projection-'))
  const options = { databasePath: join(root, 'server.sqlite'), administratorEmails: [administratorEmail], mail: {}, google: {}, capabilitySecret }
  const app = createWemuxServer(options)
  const origin = await app.listen(0)
  const call = async (path: string, body?: unknown, token = administratorToken, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(`${origin}/api${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, data: response.status === 204 ? null : await response.json() }
  }
  await seedAdministrator(app.store)
  assert.equal((await call('/bootstrap', {})).status, 200)
  const project = (await call('/projects', { teamId: 'default-team', name: 'Projection project' })).data
  const otherProject = (await call('/projects', { teamId: 'default-team', name: 'Other project' })).data
  const workerId = 'projection-worker' as WorkerId, workspaceId = 'projection-workspace' as WorkspaceId
  await app.store.transaction(async tx => {
    for (const userId of [contributor, outsider]) {
      await tx.identity.saveUser({ id: userId, email: `${userId}@example.test`, username: userId, status: 'active', createdAt: at })
      await tx.identity.savePersonalAccessToken({ id: `${userId}-token` as never, userId, name: 'Synthetic test', scopes: ['read', 'write', 'execute', 'admin'], tokenHash: hashSecret(userId), createdAt: at, expiresAt: '2099-01-01T00:00:00Z' as Timestamp, lastUsedAt: null, revokedAt: null })
      if (userId === outsider) continue
      await tx.identity.saveMembership({ teamId: project.teamId, userId, role: 'member', joinedAt: at })
      await tx.identity.saveProjectGrant({ projectId: project.id, userId, role: 'contributor' })
    }
    await tx.resources.saveWorker({ id: workerId, teamId: project.teamId, ownerId: project.ownerId, name: 'Synthetic Worker', shareScope: 'team', connectionState: 'online', version: '1', platform: 'linux', lastSeenAt: at, capabilities: [{ agentKey: 'test' as AgentKey, displayName: 'Test', version: '1', mode: 'execution', availability: { status: 'available' }, models: [{ modelId: 'model' as ModelId, displayName: 'Model', source: 'configured' }] }] })
    await tx.resources.saveWorkspace({ id: workspaceId, projectId: project.id as never, name: 'Projection space', spec: { kind: 'composite', memberWorkspaceIds: [] }, placements: [{ workerId, status: 'ready', failureReason: null, location: null }], deletedAt: null })
  })
  const createTask = async (title: string, token = administratorToken) => (await call(`/projects/${project.id}/tasks`, { title }, token)).data
  /** Creates a task-scoped Session and returns the Turn capability token the sender receives for it. */
  const openSession = async (taskId: string, token = administratorToken, title = 'Projection session') => {
    const created = await call(`/projects/${project.id}/tasks/${taskId}/sessions`, { requestId: `session-${taskId}-${title}`, title, workspaceId, workerId, agentKey: 'test', modelId: 'model' }, token)
    assert.equal(created.status, 201, JSON.stringify(created.data))
    const session = created.data.session
    const submitted = await call(`/sessions/${session.id}/messages`, { content: 'projection fixture' }, token)
    assert.equal(submitted.status, 202, JSON.stringify(submitted.data))
    const pending = await app.store.commands.getPendingCommand(submitted.data.commandId)
    if (pending?.command.kind !== 'session.enqueue') throw new Error('Expected an enqueue command')
    const bearer = pending.command.capabilities?.token
    assert.ok(bearer, 'Turn capability must be issued from an authenticated sender')
    return { session, bearer, commandId: submitted.data.commandId as string }
  }
  /** The same events the Web plan card folds; written through the Journal cache port, never through the projection. */
  const writePlan = async (sessionId: SessionId, steps: readonly string[], turnId = 'plan-turn') => {
    await app.store.transaction(tx => tx.cache.applyEvents(sessionId, [
      { sessionId, seq: 1 as never, occurredAt: at, payload: { kind: 'turn.started', turnId } },
      { sessionId, seq: 2 as never, occurredAt: at, payload: { kind: 'assistant.text.delta', turnId, streamKind: 'plan_text', text: steps.map((step, index) => `${index + 1}. ${step}`).join('\n') } },
      { sessionId, seq: 3 as never, occurredAt: at, payload: { kind: 'turn.finished', turnId, outcome: 'completed' } },
    ] as never))
  }
  const ask = async (name: string, input: object = {}, token: string) => {
    const response = await fetch(`${origin}/api/agent-capabilities/${name}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(input) })
    return { status: response.status, data: await response.json() }
  }
  return { get app() { return app }, origin, options, call, ask, project, otherProject, workerId, workspaceId, contributor, createTask, openSession, writePlan,
    async close() { await app.close(); await rm(root, { recursive: true, force: true }) } }
}

test('Agent Task projection returns the Journal-derived plan and the review requirement the launch path pins', async () => {
  const f = await fixture()
  try {
    const task = await f.createTask('Planned work')
    const { session, bearer } = await f.openSession(task.id)
    await f.writePlan(session.id as SessionId, ['建立基线', '补齐投影'])

    const detail = await f.ask('task.get', { projectId: f.project.id, taskId: task.id }, bearer)
    assert.equal(detail.status, 200, JSON.stringify(detail.data))
    const projected = detail.data.task
    assert.deepEqual(projected.projection.plan, { turnId: 'plan-turn', text: '1. 建立基线\n2. 补齐投影', steps: ['建立基线', '补齐投影'], journalSeq: 3, occurredAt: at, sessionId: session.id, status: 'pending' },
      'the plan is the latest completed proposal from the same journal window the Web card folds, and it is not presented as an approved binding version')
    assert.deepEqual(projected.projection.window, { sessionId: session.id, fromSeq: 1, throughSeq: 3, events: 3 })
    assert.equal(projected.projection.review.policy, 'none', 'a Project without policy inherits none')
    assert.equal(projected.projection.review.source, 'project')
    assert.equal(projected.projection.review.frozen, false, 'nothing has been frozen before execution starts')
    // Existing fields keep their meaning: the projection adds facts instead of redefining them.
    const stored = await f.app.store.tasks.get(task.id)
    assert.equal(projected.title, stored?.title)
    assert.equal(projected.status, stored?.status)
    assert.equal(projected.version, stored?.version)
    const listed = await f.ask('task.list', { projectId: f.project.id }, bearer)
    assert.equal(listed.status, 200)
    const summary = listed.data.items.find((item: { id: string }) => item.id === task.id)
    assert.deepEqual(summary.projection.plan.steps, ['建立基线', '补齐投影'], 'list and get derive the plan identically')
    assert.equal(summary.projection.window.throughSeq, 3)
    for (const invalid of [0, 101, '1']) assert.equal((await f.ask('task.list', { projectId: f.project.id, limit: invalid }, bearer)).status, 400)
  } finally { await f.close() }
})

test('Task projection resolves the review requirement from the Task pin, legacy fail-closed and the Project default', async () => {
  const f = await fixture()
  try {
    const pinned = await f.createTask('Pinned policy')
    const legacy = await f.createTask('Legacy execution')
    const inherited = await f.createTask('Inherited policy')
    const { bearer } = await f.openSession(pinned.id)
    const legacySession = await f.openSession(legacy.id, administratorToken, 'Legacy session')
    await f.app.store.transaction(async tx => {
      await tx.resources.saveProject({ ...(await tx.resources.getProject(f.project.id as never))!, reviewPolicy: 'agent' })
      const current = await tx.tasks.get(pinned.id)
      await tx.tasks.save({ ...current!, metadataJson: { schemaVersion: 1, values: { reviewPolicy: 'human', reviewPolicyFrozen: true } } })
      await tx.tasks.saveRun({ id: 'legacy-run', taskId: legacy.id, projectId: f.project.id, requestId: 'legacy-run', attempt: 1, sessionId: legacySession.session.id,
        snapshot: { workspaceId: f.workspaceId, workerId: f.workerId, agentKey: 'test', modelId: 'model' },
        status: 'succeeded', request: { requestId: 'legacy-run', mode: 'reuse', reuseSessionId: legacySession.session.id, prompt: 'legacy', assignment: { workspaceId: f.workspaceId, workerId: f.workerId, agentKey: 'test', modelId: 'model' } },
        fingerprint: 'a'.repeat(64), createdAt: at, startedAt: at, finishedAt: at, cancelRequestedAt: null, createCommandId: null, enqueueCommandId: legacySession.commandId, messageId: null, turnId: null, cancelCommandIds: [], failure: null, resultSummary: 'legacy', lastProjectedSeq: 0 } as never)
    })
    const read = async (taskId: string) => (await f.ask('task.get', { projectId: f.project.id, taskId }, bearer)).data.task.projection.review
    assert.deepEqual(await read(pinned.id), { policy: 'human', source: 'task', frozen: true })
    assert.deepEqual(await read(legacy.id), { policy: 'human', source: 'legacy', frozen: false }, 'a Run without a pinned snapshot cannot prove the Project default it started under')
    assert.deepEqual(await read(inherited.id), { policy: 'agent', source: 'project', frozen: false }, 'the Project default applies while nothing is frozen')
  } finally { await f.close() }
})

test('Task projection omits a Session the caller may not read instead of leaking it', async () => {
  const f = await fixture()
  try {
    const visible = await f.createTask('Visible plan')
    const hidden = await f.createTask('Hidden plan')
    const { bearer } = await f.openSession(visible.id)
    const owned = await f.openSession(hidden.id, contributor, 'Contributor session')
    assert.equal((await f.call(`/sessions/${owned.session.id}/access`, { shareScope: 'owner-only' }, contributor, 'PATCH')).status, 200)
    await f.writePlan(owned.session.id as SessionId, ['隐藏计划步骤'], 'hidden-turn')
    const detail = await f.ask('task.get', { projectId: f.project.id, taskId: hidden.id }, bearer)
    assert.equal(detail.status, 200, 'an unreadable Session must not fail the Task read')
    assert.equal(detail.data.task.projection.plan, null)
    assert.equal(detail.data.task.projection.window, null)
    assert.equal(detail.data.task.title, 'Hidden plan', 'the Task itself stays readable')
    assert.ok(!JSON.stringify(detail.data).includes('隐藏计划步骤') && !JSON.stringify(detail.data).includes(owned.session.id), 'the unreadable window must not leak through any field')
    const listed = await f.ask('task.list', { projectId: f.project.id }, bearer)
    const summary = listed.data.items.find((item: { id: string }) => item.id === hidden.id)
    assert.equal(summary.projection.plan, null)
    assert.ok(!JSON.stringify(listed.data).includes('隐藏计划步骤'))
  } finally { await f.close() }
})

test('Task list filters by authority before pagination and never exposes coordination Tasks', async () => {
  const f = await fixture()
  try {
    const first = await f.createTask('First')
    const second = await f.createTask('Second')
    const third = await f.createTask('Third')
    const { bearer } = await f.openSession(first.id)
    const identity = { teamId: f.project.teamId, ownerId: contributor, workerId: f.workerId, agentKey: 'test' as AgentKey }
    await f.app.store.transaction(tx => teamCoordinationTask(tx, identity, 'coordination-fixture'))
    const hiddenId = coordinationTaskId(identity)
    const stored = (await f.app.store.transaction(tx => tx.tasks.list(f.project.id))).map(task => task.id).sort((a, b) => a.localeCompare(b))
    assert.deepEqual(stored, [first.id, second.id, third.id].sort((a, b) => a.localeCompare(b)), 'the coordination Task never enters a Project listing')
    const full = await f.ask('task.list', { projectId: f.project.id }, bearer)
    assert.deepEqual(full.data.items.map((item: { id: string }) => item.id), stored, 'ordering and count stay stable with a hidden coordination Task present')
    const paged: string[] = []
    let cursor: string | null = null
    do {
      const page = await f.ask('task.list', { projectId: f.project.id, limit: 1, ...(cursor === null ? {} : { cursor }) }, bearer)
      assert.equal(page.status, 200)
      paged.push(...page.data.items.map((item: { id: string }) => item.id))
      cursor = page.data.nextCursor
      assert.ok(paged.length <= stored.length, 'pagination must advance')
    } while (cursor !== null)
    assert.deepEqual(paged, stored, 'filtering happens before pagination, so the hidden row never shifts a page')
    assert.ok(!paged.some(id => id.startsWith('coordination:')), 'coordination identity must not appear in any page')
    assert.equal((await f.ask('task.get', { projectId: f.project.id, taskId: hiddenId }, bearer)).status, 404, 'a coordination Task is not an ordinary Project Task')
    assert.ok((await f.app.store.transaction(tx => tx.tasks.get(hiddenId))), 'the coordination Task exists and is simply outside the Project scope')
  } finally { await f.close() }
})

test('Revoked, unprivileged, cross-Project and expired capability tokens cannot read hidden or foreign Tasks', async () => {
  const f = await fixture()
  try {
    const task = await f.createTask('Guarded work')
    const foreign = (await f.call(`/projects/${f.otherProject.id}/tasks`, { title: 'Foreign work' })).data
    const owned = await f.openSession(task.id, contributor)
    const bearer = owned.bearer
    assert.equal((await f.ask('task.get', { projectId: f.project.id, taskId: task.id }, bearer)).status, 200)
    const crossProject = await f.ask('task.get', { projectId: f.otherProject.id, taskId: foreign.id }, bearer)
    assert.equal(crossProject.status, 404, 'a Turn grant stays bound to its Project')
    assert.ok(!JSON.stringify(crossProject.data).includes('Foreign work'))
    const claims = new CapabilityTokenService(capabilitySecret, () => at).verify(bearer)
    const reissue = (grantId: string, clock: Timestamp, actorUserId = claims.actorUserId) => new CapabilityTokenService(capabilitySecret, () => clock).issue({
      grantId, sessionId: claims.sessionId, turnId: claims.turnId, actorAgentId: claims.actorAgentId, projectId: claims.projectId, workspaceId: claims.workspaceId,
      allowedTools: claims.allowedTools, allowedConnectorIds: claims.allowedConnectorIds,
      ...(actorUserId ? { actorUserId, actorAuthVersion: claims.actorAuthVersion ?? 0 } : {}) })
    const expired = reissue('expired-grant', '2025-01-01T00:00:00.000Z' as Timestamp)
    assert.equal((await f.ask('task.list', { projectId: f.project.id }, expired.token)).status, 401, 'an expired token is refused before any Task fact is read')
    const unprivileged = reissue('outsider-grant', new Date().toISOString() as Timestamp, outsider)
    const denied = await f.ask('task.get', { projectId: f.project.id, taskId: task.id }, unprivileged.token)
    assert.ok([403, 404].includes(denied.status), `an account without a Project grant is refused (${denied.status})`)
    assert.ok(!JSON.stringify(denied.data).includes('Guarded work'), 'a refused read leaks neither Tasks nor counts')
    await f.app.store.transaction(tx => tx.identity.removeProjectGrant(f.project.id, contributor))
    const revoked = await f.ask('task.list', { projectId: f.project.id }, bearer)
    assert.ok([403, 404].includes(revoked.status), `removing the grant revokes the Turn grant authority with it (${revoked.status})`)
    assert.ok(!JSON.stringify(revoked.data).includes('Guarded work'))
  } finally { await f.close() }
})