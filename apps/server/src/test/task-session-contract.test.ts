import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentKey, ModelId, ProjectId, Timestamp, UserId, WorkerId, WorkspaceId } from '@wemux/domain'
import { createWemuxServer } from '../server.ts'
import { administratorEmail, seedAdministrator, administratorToken } from './fixtures/administrator.ts'
import { hashSecret } from '../application/auth.ts'
import { createHash } from 'node:crypto'
import { canonicalCommand } from '../application/server-service.ts'

const at = '2026-06-01T00:00:00Z' as Timestamp
const contributor = 'task-session-contributor' as UserId
const viewer = 'task-session-viewer' as UserId
const outsider = 'task-session-outsider' as UserId

/** Owned SQLite and synthetic resources only; no Worker connection or Runtime invocation. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'wemux-task-session-test-'))
  const options = { databasePath: join(root, 'server.sqlite'), administratorEmails: [administratorEmail], mail: {}, google: {}, capabilitySecret: 'synthetic-test-only-secret-for-restart' }
  let app = createWemuxServer(options), origin = await app.listen(0)
  const call = async (path: string, body?: unknown, token = administratorToken, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(`${origin}/api${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, data: response.status === 204 ? null : await response.json() }
  }
  await seedAdministrator(app.store)
  assert.equal((await call('/bootstrap', {})).status, 200)
  const project = (await call('/projects', { teamId: 'default-team', name: 'Task Session project' })).data
  const otherProject = (await call('/projects', { teamId: 'default-team', name: 'Other project' })).data
  const task = (await call(`/projects/${project.id}/tasks`, { title: 'Conversation' })).data
  const otherTask = (await call(`/projects/${project.id}/tasks`, { title: 'Other task' })).data
  const workerId = 'task-session-worker' as WorkerId, workspaceId = 'task-session-workspace' as WorkspaceId
  await app.store.transaction(async tx => {
    for (const userId of [contributor, viewer, outsider]) {
      await tx.identity.saveUser({ id: userId, email: `${userId}@example.test`, username: userId, status: 'active', createdAt: at })
      await tx.identity.savePersonalAccessToken({ id: userId as never, userId, name: 'Synthetic test', scopes: ['read', 'write', 'execute'], tokenHash: hashSecret(userId), createdAt: at, expiresAt: '2099-01-01T00:00:00Z' as Timestamp, lastUsedAt: null, revokedAt: null })
      if (userId === outsider) continue
      await tx.identity.saveMembership({ teamId: project.teamId, userId, role: 'member', joinedAt: at })
      await tx.identity.saveProjectGrant({ projectId: project.id, userId, role: userId === viewer ? 'viewer' : 'contributor' })
    }
    await tx.resources.saveWorker({ id: workerId, teamId: project.teamId, ownerId: project.ownerId, name: 'Synthetic Worker', shareScope: 'team', connectionState: 'online', version: '1', platform: 'linux', lastSeenAt: at, capabilities: [{ agentKey: 'test' as AgentKey, displayName: 'Test', version: '1', mode: 'execution', availability: { status: 'available' }, models: [{ modelId: 'model' as ModelId, displayName: 'Model', source: 'configured' }, { modelId: 'second' as ModelId, displayName: 'Second', source: 'configured' }] }] })
    for (const [id, projectId] of [[workspaceId, project.id], ['other-workspace', otherProject.id], ['second-workspace', project.id]]) {
      await tx.resources.saveWorkspace({ id: id as WorkspaceId, projectId: projectId as ProjectId, name: id, spec: { kind: 'composite', memberWorkspaceIds: [] }, placements: [{ workerId, status: 'ready', failureReason: null, location: null }], deletedAt: null })
    }
  })
  const path = `/projects/${project.id}/tasks/${task.id}/sessions`
  const request = { requestId: 'create-session', title: 'Task conversation', workspaceId, workerId, agentKey: 'test', modelId: 'model' }
  return { get app() { return app }, get origin() { return origin }, call, path, project, otherProject, task, otherTask, request,
    async reopen() { await app.close(); app = createWemuxServer(options); origin = await app.listen(0) },
    async close() { await app.close(); await rm(root, { recursive: true, force: true }) },
  }
}

test('quick Sessions atomically reuse a dedicated Project Task across model changes and SQLite reopen', async () => {
  const f = await fixture()
  try {
    const before = (await f.app.store.tasks.list(f.project.id)).length
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => f.call('/sessions', { ...f.request, requestId: `trial-${i}`, modelId: i % 2 ? 'second' : 'model' })))
    for (const r of results) assert.equal(r.status, 201, JSON.stringify(r.data))
    const taskId = results[0].data.session.taskId
    assert.ok(taskId, 'root quick creation must bind a Task')
    assert.equal(new Set(results.map(r => r.data.session.taskId)).size, 1)
    assert.equal(new Set(results.map(r => r.data.session.id)).size, 6)
    assert.equal((await f.app.store.tasks.list(f.project.id)).length, before + 1)
    assert.equal((await f.app.store.tasks.activity(taskId, 0)).filter(a => a.type === 'task.created').length, 1)
    assert.equal((await f.app.store.tasks.runs(taskId)).length, 0)
    assert.equal(await f.app.store.tasks.binding(f.request.workspaceId), null)
    await f.reopen()
    const replay = await f.call('/sessions', { ...f.request, requestId: 'trial-0' })
    assert.equal(replay.status, 201, JSON.stringify(replay.data))
    assert.equal(replay.data.created, false)
    assert.equal(replay.data.session.id, results[0].data.session.id)
    const next = await f.call('/sessions', { ...f.request, requestId: 'after-reopen' })
    assert.equal(next.data.session.taskId, taskId)
    assert.equal((await f.call(`/projects/${f.project.id}/tasks/${taskId}/sessions`)).data.items.length, 7)
  } finally { await f.close() }
})

test('dedicated Project Task reuse separates actor, Workspace and scenario; rejects client-supplied binding', async () => {
  const f = await fixture()
  try {
    const root = await f.call('/sessions', { ...f.request, requestId: 'root-trial' })
    assert.equal(root.status, 201)
    const variants = [
      await f.call('/sessions', { ...f.request, requestId: 'other-actor' }, contributor),
      await f.call('/sessions', { ...f.request, requestId: 'other-space', workspaceId: 'second-workspace' }),
      await f.call('/sessions', { ...f.request, requestId: 'other-scenario', scenario: 'agent-test' }),
    ]
    for (const r of variants) assert.equal(r.status, 201, JSON.stringify(r.data))
    assert.equal(new Set([root, ...variants].map(r => r.data.session.taskId)).size, 4)
    const before = (await f.app.store.tasks.list(f.project.id)).length
    for (const patch of [{ scenario: 'forged' }, { taskId: f.task.id }, { ownerId: contributor }]) assert.equal((await f.call('/sessions', { ...f.request, requestId: 'invalid', ...patch })).status, 400)
    assert.equal((await f.app.store.tasks.list(f.project.id)).length, before)
    const conflict = await f.call('/sessions', { ...f.request, requestId: 'root-trial', scenario: 'agent-test' })
    assert.equal(conflict.status, 409)
    assert.equal((await f.app.store.tasks.list(f.project.id)).length, before, 'conflict rolls back any new Task')
  } finally { await f.close() }
})

test('dedicated Task creation validates authority and environment before writes, including replay', async () => {
  const f = await fixture()
  try {
    const before = (await f.app.store.tasks.list(f.project.id)).length
    for (const token of [viewer, outsider]) assert.ok([403, 404].includes((await f.call('/sessions', f.request, token)).status))
    assert.equal((await f.call('/sessions', { ...f.request, modelId: 'missing' })).status, 409)
    assert.equal((await f.app.store.tasks.list(f.project.id)).length, before)
    const created = await f.call('/sessions', f.request, contributor)
    assert.equal(created.status, 201)
    assert.ok(created.data.session.taskId)
    await f.app.store.transaction(tx => tx.identity.removeProjectGrant(f.project.id, contributor))
    assert.ok([403, 404].includes((await f.call('/sessions', f.request, contributor)).status))
    assert.equal((await f.app.store.tasks.list(f.project.id)).length, before + 1)
  } finally { await f.close() }
})

for (const association of ['absent', 'null'] as const) test(`legacy root create receipt replays ${association} provenance without allocating a Task`, async () => {
  const f = await fixture()
  try {
    const template = (await f.call(f.path, { ...f.request, requestId: 'template' }, contributor)).data.session
    const { taskId: _task, runId: _run, ...base } = template
    const fingerprint = createHash('sha256').update(canonicalCommand({ workspaceId: f.request.workspaceId, workerId: f.request.workerId, agentKey: f.request.agentKey, modelId: f.request.modelId, title: f.request.title, shareScope: 'owner-only' })).digest('hex')
    const legacy = { ...base, id: `legacy-${association}`, shareScope: 'owner-only', ...(association === 'null' ? { taskId: null, runId: null } : {}), creation: { commandId: `legacy-command-${association}`, requestId: f.request.requestId, fingerprint } }
    // Independent persisted pre-upgrade record and matching command; no dedicated
    // Task exists for this tuple, so accidental allocation is observable.
    await f.app.store.transaction(async tx => {
      await tx.resources.saveSession(legacy)
      const command = { kind: 'session.create' as const, session: { sessionId: legacy.id, binding: legacy.binding, storageMode: 'local' as const } }
      await tx.commands.insertPending({ commandId: legacy.creation.commandId as never, workerId: f.request.workerId, command, payloadFingerprint: createHash('sha256').update(canonicalCommand(command)).digest('hex'), createdAt: at })
    })
    const counts = async () => [ (await f.app.store.tasks.list(f.project.id)).length, (await f.app.store.commands.list({ limit: 1000 })).length, (await f.app.store.resources.listSessions()).length ]
    const before = await counts()
    for (const reopen of [false, true]) {
      if (reopen) await f.reopen()
      const replay = await f.call('/sessions', f.request, contributor)
      assert.equal(replay.status, 201, JSON.stringify(replay.data))
      assert.equal(replay.data.created, false)
      assert.equal(replay.data.session.id, legacy.id)
      assert.equal(replay.data.commandId, legacy.creation.commandId)
      assert.equal(replay.data.session.taskId, legacy.taskId)
      for (const patch of [{ title: 'changed' }, { modelId: 'second' }, { scenario: 'agent-test' }]) assert.equal((await f.call('/sessions', { ...f.request, ...patch }, contributor)).status, 409)
      assert.deepEqual(await counts(), before)
    }
    await f.app.store.transaction(tx => tx.identity.removeProjectGrant(f.project.id, contributor))
    assert.ok([403, 404].includes((await f.call('/sessions', f.request, contributor)).status))
    assert.deepEqual(await counts(), before)
  } finally { await f.close() }
})

for (const mismatch of ['actor', 'workspace', 'worker', 'agent', 'matching'] as const) test(`dedicated explicit Task Session enforces ${mismatch} identity and owner-only sharing`, async () => {
  const f = await fixture()
  try {
    const root = await f.call('/sessions', f.request)
    assert.equal(root.status, 201)
    const worker = (await f.app.store.resources.getWorker(f.request.workerId))!
    const workspace = (await f.app.store.resources.getWorkspace(f.request.workspaceId))!
    await f.app.store.transaction(async tx => {
      await tx.resources.saveWorker({ ...worker, capabilities: [...worker.capabilities, { ...worker.capabilities[0], agentKey: 'alternate' as AgentKey }] })
      await tx.resources.saveWorker({ ...worker, id: 'alternate-worker' as WorkerId })
      await tx.resources.saveWorkspace({ ...workspace, placements: [...workspace.placements, { ...workspace.placements[0], workerId: 'alternate-worker' as WorkerId }] })
    })
    const before = (await f.app.store.commands.list({ limit: 1000 })).length
    const body = { ...f.request, requestId: `explicit-${mismatch}`, modelId: 'second', ...(mismatch === 'workspace' ? { workspaceId: 'second-workspace' } : mismatch === 'worker' ? { workerId: 'alternate-worker' } : mismatch === 'agent' ? { agentKey: 'alternate' } : {}) }
    const path = `/projects/${f.project.id}/tasks/${root.data.session.taskId}/sessions`
    const result = await f.call(path, body, mismatch === 'actor' ? contributor : administratorToken)
    if (mismatch === 'matching') {
      assert.equal(result.status, 201, JSON.stringify(result.data))
      assert.equal(result.data.session.shareScope, 'owner-only')
      assert.equal(result.data.session.binding.modelId, 'second')
      assert.equal((await f.call(path, body)).data.session.id, result.data.session.id)
    } else {
      assert.equal(result.status, 409, JSON.stringify(result.data))
      // Task routes retain their stable conflict envelope and actionable message.
      assert.equal(result.data.error.code, 'runtime_unavailable')
      assert.match(result.data.error.message, /Dedicated Task requires its original user/)
      assert.equal((await f.app.store.commands.list({ limit: 1000 })).length, before)
      assert.equal((await f.app.store.resources.listSessions()).length, 1)
    }
  } finally { await f.close() }
})

test('Task Session HTTP creation replays concurrent requests and lost responses across SQLite reopen', async () => {
  const f = await fixture()
  try {
    const before = await f.app.store.commands.list({ limit: 1000 })
    const responses = await Promise.all(Array.from({ length: 6 }, () => f.call(f.path, f.request)))
    for (const response of responses) assert.equal(response.status, 201, JSON.stringify(response.data))
    const first = responses[0].data
    assert.equal(responses.filter(r => r.data.created).length, 1)
    for (const { data } of responses) { assert.equal(data.session.id, first.session.id); assert.equal(data.commandId, first.commandId) }
    assert.equal(first.session.taskId, f.task.id)
    assert.equal(first.session.runId, null)
    assert.equal(first.session.shareScope, 'project')
    assert.equal((await f.app.store.commands.list({ limit: 1000 })).length, before.length + 1)
    assert.equal((await f.app.store.tasks.activity(f.task.id, 0)).filter(a => a.payload.action === 'session.created').length, 1)
    assert.equal((await f.app.store.tasks.get(f.task.id))?.assignee, null)
    assert.equal(await f.app.store.tasks.binding(f.request.workspaceId), null)
    await f.reopen() // committed response deliberately not used to construct the retry
    const replay = await f.call(f.path, f.request)
    assert.equal(replay.status, 201, JSON.stringify(replay.data))
    assert.equal(replay.data.created, false)
    assert.equal(replay.data.session.id, first.session.id)
    assert.equal(replay.data.commandId, first.commandId)
    assert.equal((await f.app.store.commands.list({ limit: 1000 })).length, before.length + 1)
    const second = await f.call(f.path, { ...f.request, requestId: 'second' })
    assert.equal(second.status, 201)
    assert.notEqual(second.data.session.id, first.session.id)
    assert.deepEqual(new Set((await f.call(f.path)).data.items.map((s: { id: string }) => s.id)), new Set([first.session.id, second.data.session.id]))
    assert.equal((await f.app.store.tasks.runs(f.task.id)).length, 0)
  } finally { await f.close() }
})

test('Task Session request identity conflicts and binding cannot be changed', async () => {
  const f = await fixture()
  try {
    const first = await f.call(f.path, f.request)
    assert.equal(first.status, 201, JSON.stringify(first.data))
    for (const patch of [{ title: 'Changed' }, { modelId: 'second' }, { workspaceId: 'second-workspace' }]) {
      const result = await f.call(f.path, { ...f.request, ...patch })
      assert.equal(result.status, 409)
      assert.equal(result.data.error.code, 'request_id_conflict')
    }
    const changedTask = await f.call(`/projects/${f.project.id}/tasks/${f.otherTask.id}/sessions`, f.request)
    assert.equal(changedTask.status, 409)
    assert.equal(changedTask.data.error.code, 'request_id_conflict')
    assert.equal((await f.call(`/sessions/${first.data.session.id}`, { taskId: f.otherTask.id }, administratorToken, 'PATCH')).status, 400)
    assert.equal((await f.app.store.resources.getSession(first.data.session.id))?.taskId, f.task.id)
    const { requestId: _, ...missing } = f.request
    assert.equal((await f.call(f.path, missing)).status, 400)
    for (const requestId of ['', ' ', 'nul\0value']) assert.equal((await f.call(f.path, { ...f.request, requestId })).status, 400)
    assert.equal((await f.call(f.path, { ...f.request, requestId: 'new', taskId: f.otherTask.id })).status, 400)
    assert.equal((await f.app.store.resources.listSessions()).length, 1)
  } finally { await f.close() }
})

test('Task Session discovery filters intersect and never expose invisible Session metadata', async () => {
  const f = await fixture()
  try {
    const visible = await f.call(f.path, f.request)
    assert.equal(visible.status, 201, JSON.stringify(visible.data))
    const privateSession = await f.call(f.path, { ...f.request, requestId: 'private', title: 'Secret title' })
    assert.equal((await f.call(`/sessions/${privateSession.data.session.id}/access`, { shareScope: 'owner-only' }, administratorToken, 'PATCH')).status, 200)
    const unrelated = await f.call(`/projects/${f.project.id}/tasks/${f.otherTask.id}/sessions`, { ...f.request, requestId: 'unrelated' })
    assert.equal(unrelated.status, 201)
    const root = await f.call('/sessions', { ...f.request, requestId: 'root', workspaceId: 'other-workspace' })
    assert.equal(root.status, 201)
    const list = await f.call(f.path, undefined, viewer)
    assert.equal(list.status, 200)
    assert.deepEqual(list.data.items.map((s: { id: string }) => s.id), [visible.data.session.id])
    assert.ok(!JSON.stringify(list).includes('Secret title'))
    for (const query of [`projectId=${f.otherProject.id}`, 'workspaceId=second-workspace', `taskId=${f.otherTask.id}`, 'archived=true']) {
      assert.deepEqual((await f.call(`${f.path}?${query}`, undefined, viewer)).data.items, [])
    }
    assert.equal((await f.call(`${f.path}?archived=invalid`, undefined, viewer)).status, 400)
    assert.equal((await f.call(`/sessions/${privateSession.data.session.id}/access`, { shareScope: 'selected-members' }, administratorToken, 'PATCH')).status, 200)
    assert.equal((await f.call(`/sessions/${privateSession.data.session.id}/grants`, { userId: viewer })).status, 201)
    assert.equal((await f.call(f.path, undefined, viewer)).data.items.length, 2)
    assert.equal((await f.call(`/sessions/${privateSession.data.session.id}/grants/${viewer}`, undefined, administratorToken, 'DELETE')).status, 204)
    assert.equal((await f.call(f.path, undefined, viewer)).data.items.length, 1)
    assert.equal((await f.call(`/sessions/${visible.data.session.id}`, { archived: true }, administratorToken, 'PATCH')).status, 200)
    assert.equal((await f.call(`${f.path}?archived=true`, undefined, viewer)).data.items.length, 1)
    assert.deepEqual((await f.call(`${f.path}?archived=false`, undefined, viewer)).data.items, [])
    const generic = await f.call(`/sessions?projectId=${f.project.id}&workspaceId=${f.request.workspaceId}&taskId=${f.task.id}`, undefined, viewer)
    assert.deepEqual(generic.data.items.map((s: { id: string }) => s.id), [visible.data.session.id])
    for (const query of [`projectId=${f.otherProject.id}&workspaceId=${f.request.workspaceId}`, `projectId=${f.project.id}&workspaceId=other-workspace`, `taskId=${f.task.id}&workspaceId=other-workspace`]) {
      assert.deepEqual((await f.call(`/sessions?${query}`)).data.items, [])
    }
    assert.equal((await f.call(f.path, undefined, outsider)).status, 403)
    assert.deepEqual((await f.call('/sessions', undefined, outsider)).data.items, [])
    await f.app.store.transaction(tx => tx.identity.removeProjectGrant(f.project.id, viewer))
    assert.equal((await f.call(f.path, undefined, viewer)).status, 403)
    assert.deepEqual((await f.call(`/sessions?taskId=${f.task.id}`, undefined, viewer)).data.items, [])
  } finally { await f.close() }
})

test('Agent project queries share Task/Session authorization, filter before pagination and reject expired or revoked grants', async () => {
  const f = await fixture()
  try {
    const first = (await f.call(f.path, f.request)).data.session
    const hidden = (await f.call(f.path, { ...f.request, requestId: 'hidden-query-session', title: 'Never reveal this title' })).data.session
    assert.equal((await f.call(`/sessions/${hidden.id}/access`, { shareScope: 'owner-only' }, administratorToken, 'PATCH')).status, 200)
    const second = (await f.call(f.path, { ...f.request, requestId: 'second-query-session' })).data.session
    const submitted = await f.call(`/sessions/${first.id}/messages`, { content: 'query fixture' }, contributor)
    assert.equal(submitted.status, 202, JSON.stringify(submitted.data))
    const pending = await f.app.store.commands.getPendingCommand(submitted.data.commandId)
    assert.equal(pending?.command.kind, 'session.enqueue')
    if (pending?.command.kind !== 'session.enqueue') throw new Error('Missing enqueue command')
    const bearer = pending.command.capabilities?.token
    assert.ok(bearer, 'Turn capability must be issued from authenticated sender')
    const ask = async (name: string, input: object = {}, token = bearer) => {
      const response = await fetch(`${f.origin}/api/agent-capabilities/${name}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(input) })
      return { status: response.status, data: await response.json() }
    }
    // The actual user can read both Projects; a Turn grant remains bound to its
    // originating Project rather than inheriting every user-visible resource.
    await f.app.store.transaction(tx => tx.identity.saveProjectGrant({ projectId: f.otherProject.id, userId: contributor, role: 'viewer' }))
    assert.equal((await f.call(`/projects/${f.otherProject.id}`, undefined, contributor)).status, 200)
    const projectList = await ask('project.list')
    assert.equal(projectList.status, 200, JSON.stringify(projectList.data))
    assert.deepEqual(projectList.data.items.map((item: { id: string }) => item.id), [f.project.id])
    assert.equal((await ask('project.get', { projectId: f.otherProject.id })).status, 404, 'user visibility must not expand the Turn grant')
    const originalWorker = await f.app.store.resources.getWorker(f.request.workerId as WorkerId)
    assert.ok(originalWorker)
    await f.app.store.transaction(async tx => {
      const worker = await tx.resources.getWorker(f.request.workerId as WorkerId)
      assert.ok(worker)
      await tx.resources.saveWorker({ ...worker, capabilities: [{ ...worker.capabilities[0], displayName: '/tmp/worker-private/secret-sentinel',
        availability: { status: 'unavailable', reason: 'spawn /tmp/worker-private/secret-sentinel credential=secret-sentinel' },
        models: [{ modelId: 'model' as ModelId, displayName: '/tmp/worker-private/secret-sentinel', source: 'configured' }] }] })
    })
    const repositoryId = 'project-agent-repository' as never
    await f.app.store.transaction(async tx => {
      await tx.resources.saveRepository({ id: repositoryId, projectId: f.project.id, name: 'Project source', gitUrl: 'https://user:secret-sentinel@example.test/repo', defaultBranch: 'main' })
      await tx.resources.saveRepository({ id: 'foreign-agent-repository' as never, projectId: f.otherProject.id, name: 'Other secret', gitUrl: 'https://other-secret@example.test/foreign', defaultBranch: 'main' })
      await tx.resources.saveWorkspace({ id: 'repository-space' as WorkspaceId, projectId: f.project.id, name: 'Source Workspace', spec: { kind: 'repository', repositoryId, ownership: { kind: 'standalone' } }, placements: [], deletedAt: null })
    })
    const teamDiscover = await ask('project.resources', { projectId: f.project.id })
    assert.equal(teamDiscover.status, 200)
    assert.equal(teamDiscover.data.workers.length, 1, 'Team-shared Worker is discoverable')
    assert.deepEqual(teamDiscover.data.repositories, [{ id: repositoryId, name: 'Project source' }])
    assert.ok(!JSON.stringify(teamDiscover.data).includes('secret-sentinel'), 'embedded git credentials must not leave Project resources')
    assert.ok(!JSON.stringify(teamDiscover.data).includes('other-secret'), 'another Project repository must not be listed')
    assert.ok(!JSON.stringify(teamDiscover.data).includes('secret-sentinel'), 'Agent labels, reasons and model labels must not leak Worker diagnostics')
    assert.ok(!JSON.stringify(teamDiscover.data).includes('/tmp/worker-private'), 'Agent metadata must not reveal Worker-local paths')
    assert.deepEqual(teamDiscover.data.workers[0].agents[0].availability, { status: 'unavailable' })
    await f.app.store.transaction(async tx => {
      const worker = await tx.resources.getWorker(f.request.workerId as WorkerId)
      assert.ok(worker)
      await tx.resources.saveWorker({ ...worker, shareScope: 'owner-only' })
    })
    const discover = await ask('project.resources', { projectId: f.project.id })
    assert.equal(discover.status, 200, JSON.stringify(discover.data))
    assert.deepEqual(discover.data.workers, [], 'ungranted owner-only Worker metadata must not leak')
    assert.deepEqual(discover.data.workspaces.map((space: { id: string; placements: unknown[] }) => [space.id, space.placements.length]).sort(), [['repository-space', 0], ['second-workspace', 0], [f.request.workspaceId, 0]])
    assert.ok(!JSON.stringify(discover.data).includes('/tmp/'), 'Worker-local placement paths must not leave resource discovery')
    assert.equal((await ask('project.resources', { projectId: f.otherProject.id })).status, 404)
    await f.app.store.transaction(tx => tx.resources.saveWorker(originalWorker))
    assert.equal((await ask('task.get', { projectId: f.project.id, taskId: f.task.id })).status, 200)
    const taskInput = { projectId: f.project.id, requestId: 'agent-task-once', title: 'Agent planned Task' }
    const beforeAgentCreate = (await f.app.store.tasks.list(f.project.id)).length
    assert.equal((await ask('task.create', { projectId: f.project.id, title: 'Missing identity' })).status, 400)
    assert.equal((await ask('task.create', { projectId: f.project.id, title: 'Missing identity', requestId: '  ' })).status, 400)
    assert.equal((await f.app.store.tasks.list(f.project.id)).length, beforeAgentCreate, 'missing id cannot create a Task or receipt')
    const createdTask = await ask('task.create', taskInput)
    assert.equal(createdTask.status, 200, JSON.stringify(createdTask.data))
    assert.equal(createdTask.data.task.origin, 'manual')
    assert.equal(createdTask.data.task.projectId, f.project.id)
    const duplicateTask = await ask('task.create', taskInput)
    assert.equal(duplicateTask.status, 200)
    assert.equal(duplicateTask.data.task.id, createdTask.data.task.id)
    assert.equal((await ask('task.create', { ...taskInput, title: 'Conflicting request' })).status, 409)
    assert.equal((await ask('task.create', { ...taskInput, projectId: f.otherProject.id, requestId: 'forged-agent-project' })).status, 404)
    assert.equal((await ask('task.create', { ...taskInput, requestId: 'invalid-extra', ownerId: contributor })).status, 400)
    assert.equal((await ask('task.create', { ...taskInput, requestId: 'invalid-team', teamId: f.project.teamId })).status, 400)
    await f.app.store.transaction(tx => tx.identity.saveProjectGrant({ projectId: f.project.id, userId: contributor, role: 'viewer' }))
    const deniedTask = { ...taskInput, requestId: 'not-writable-as-viewer' }
    const beforeDenied = (await f.app.store.tasks.list(f.project.id)).length
    assert.equal((await ask('task.create', deniedTask)).status, 403, 'read-capable viewer cannot write through Agent tool')
    assert.equal((await ask('task.create', taskInput)).status, 403, 'viewer cannot replay a previously successful create')
    assert.equal((await f.app.store.tasks.list(f.project.id)).length, beforeDenied)
    assert.equal((await ask('task.list', { projectId: f.project.id })).status, 200, 'viewer may still query')
    await f.app.store.transaction(tx => tx.identity.saveProjectGrant({ projectId: f.project.id, userId: contributor, role: 'contributor' }))
    assert.equal((await ask('task.create', deniedTask)).status, 200, 'denied attempt must leave no create receipt')
    assert.equal((await ask('task.get', { projectId: f.otherProject.id, taskId: f.task.id })).status, 404)
    assert.equal((await ask('task.get', { projectId: f.project.id, taskId: f.otherTask.id })).status, 200)
    const taskList = await ask('task.list', { projectId: f.project.id })
    assert.equal(taskList.status, 200)
    const expectedTaskIds = taskList.data.items.map((item: { id: string }) => item.id)
    assert.ok(expectedTaskIds.length > 2)
    assert.deepEqual(expectedTaskIds, [...expectedTaskIds].sort((a: string, b: string) => a.localeCompare(b)))
    const pagedTaskIds: string[] = []
    let taskCursor: string | null = null
    do {
      const page = await ask('task.list', { projectId: f.project.id, limit: 1, ...(taskCursor === null ? {} : { cursor: taskCursor }) })
      assert.equal(page.status, 200)
      assert.equal(page.data.items.length, 1)
      pagedTaskIds.push(page.data.items[0].id)
      taskCursor = page.data.nextCursor
      assert.ok(pagedTaskIds.length <= expectedTaskIds.length, 'pagination must advance')
    } while (taskCursor !== null)
    assert.deepEqual(pagedTaskIds, expectedTaskIds)
    for (const invalid of [0, -1, 1.5, 101, '1']) assert.equal((await ask('task.list', { projectId: f.project.id, limit: invalid })).status, 400)
    for (const invalid of ['-1', '1.5', '01', String(Number.MAX_SAFE_INTEGER + 1)]) assert.equal((await ask('task.list', { projectId: f.project.id, cursor: invalid })).status, 400)
    assert.equal((await ask('task.get', { projectId: f.project.id, taskId: 'missing-task' })).status, 404)
    const foreign = (await f.call(`/projects/${f.otherProject.id}/tasks`, { title: 'Foreign task' })).data
    assert.equal((await ask('task.get', { projectId: f.project.id, taskId: foreign.id })).status, 404)
    assert.equal((await ask('task.sessions', { projectId: f.project.id, taskId: foreign.id })).status, 404)
    const all = await ask('task.sessions', { projectId: f.project.id, taskId: f.task.id })
    assert.equal(all.status, 200, JSON.stringify(all.data))
    assert.deepEqual(new Set(all.data.items.map((item: { id: string }) => item.id)), new Set([first.id, second.id]))
    const page1 = await ask('task.sessions', { projectId: f.project.id, taskId: f.task.id, limit: 1 })
    const page2 = await ask('task.sessions', { projectId: f.project.id, taskId: f.task.id, limit: 1, cursor: page1.data.nextCursor })
    assert.equal(page1.data.items.length, 1)
    assert.equal(page2.data.items.length, 1)
    assert.equal(page2.data.nextCursor, null)
    assert.deepEqual(new Set([...page1.data.items, ...page2.data.items].map((item: { id: string }) => item.id)), new Set([first.id, second.id]))
    assert.ok(!JSON.stringify([all.data, page1.data, page2.data]).includes('Never reveal this title'))
    assert.equal((await ask('task.sessions', { projectId: f.project.id, taskId: f.otherTask.id })).data.items.length, 0)
    assert.equal((await ask('session.events', { sessionId: hidden.id })).status, 404)
    const visibleSession = await ask('session.get', { sessionId: first.id })
    assert.equal(visibleSession.status, 200)
    assert.equal(visibleSession.data.session.taskId, f.task.id)
    assert.ok(visibleSession.data.session.freshness?.status)
    assert.equal((await ask('session.get', { sessionId: hidden.id })).status, 404)
    const history = await ask('session.events', { sessionId: first.id, fromSeq: 1, limit: 1 })
    assert.equal(history.status, 200)
    assert.equal(history.data.runtimeState, 'idle')
    assert.equal(history.data.activeTurnId, null)
    assert.ok(history.data.freshness?.status, 'freshness must be returned alongside authorized history')
    const journalEvent = (seq: number) => ({ sessionId: first.id, seq: seq as never, occurredAt: at,
      payload: { kind: 'assistant.text.delta', turnId: 'freshness-turn', text: `part-${seq}` } })
    await f.app.store.transaction(tx => tx.cache.applyEvents(first.id, [journalEvent(2) as never]))
    const gapHistory = await ask('session.events', { sessionId: first.id, fromSeq: 1 })
    assert.equal(gapHistory.data.freshness.status, 'gap')
    assert.deepEqual(gapHistory.data.events, [], 'out-of-order event must not be exposed ahead of the contiguous cursor')
    assert.equal((await ask('session.get', { sessionId: first.id })).data.session.freshness.status, 'gap')
    await f.app.store.transaction(async tx => {
      await tx.cache.applyEvents(first.id, [journalEvent(1) as never])
      await tx.cache.recordWorkerHead(first.id, 2 as never)
    })
    const recoveredFirst = await ask('session.events', { sessionId: first.id, fromSeq: 1, limit: 1 })
    assert.equal(recoveredFirst.status, 200)
    assert.equal(recoveredFirst.data.freshness.status, 'synced')
    assert.equal((await ask('session.get', { sessionId: first.id })).data.session.freshness.status, 'synced')
    assert.deepEqual(recoveredFirst.data.events.map((event: { seq: number; payload: { text: string } }) => [event.seq, event.payload.text]), [[1, 'part-1']])
    assert.equal(recoveredFirst.data.nextSeq, 2)
    const recoveredHistory = await ask('session.events', { sessionId: first.id, fromSeq: recoveredFirst.data.nextSeq, limit: 1 })
    assert.equal(recoveredHistory.status, 200)
    assert.equal(recoveredHistory.data.freshness.status, 'synced')
    assert.deepEqual(recoveredHistory.data.events.map((event: { seq: number; payload: { text: string } }) => [event.seq, event.payload.text]), [[2, 'part-2']])
    assert.equal(recoveredHistory.data.nextSeq, null)
    await f.app.store.transaction(tx => tx.cache.markWorkerOffline(f.request.workerId as WorkerId))
    assert.equal((await ask('session.events', { sessionId: first.id, fromSeq: 1 })).data.freshness.status, 'offline')
    assert.equal((await ask('session.get', { sessionId: first.id })).data.session.freshness.status, 'offline')
    assert.equal((await ask('task.list', { projectId: f.project.id, limit: 101 })).status, 400)
    assert.equal((await ask('task.sessions', { projectId: f.project.id, taskId: f.task.id, cursor: '-1' })).status, 400)
    assert.equal((await ask('project.list', {}, 'tampered.token')).status, 401)
    await f.app.store.transaction(async tx => {
      const account = await tx.identity.getUser(contributor)
      assert.ok(account)
      await tx.identity.saveUser({ ...account, status: 'disabled', authVersion: (account.authVersion ?? 0) + 1 })
    })
    assert.equal((await ask('project.list')).status, 403, 'disabled actor loses copied capability without project revoke')
    await f.app.store.transaction(async tx => {
      const account = await tx.identity.getUser(contributor)
      assert.ok(account)
      await tx.identity.saveUser({ ...account, status: 'active' })
    })
    assert.equal((await ask('project.list')).status, 403, 'restore cannot reactivate pre-disable grant')
    await f.app.store.transaction(tx => tx.identity.savePersonalAccessToken({ id: 'post-restore-pat' as never, userId: contributor, name: 'Synthetic restored', scopes: ['read', 'write', 'execute'], tokenHash: hashSecret('post-restore-contributor'), authVersion: 1, createdAt: at, expiresAt: '2099-01-01T00:00:00Z' as Timestamp, lastUsedAt: null, revokedAt: null }))
    const fresh = await f.call(`/sessions/${first.id}/messages`, { content: 'fresh generation for revoke' }, 'post-restore-contributor')
    assert.equal(fresh.status, 202)
    const freshCommand = await f.app.store.commands.getPendingCommand(fresh.data.commandId)
    assert.equal(freshCommand?.command.kind, 'session.enqueue')
    if (freshCommand?.command.kind !== 'session.enqueue') throw new Error('Missing fresh enqueue')
    const freshToken = freshCommand.command.capabilities?.token
    assert.ok(freshToken)
    assert.equal((await ask('project.list', {}, freshToken)).status, 200)
    await f.reopen()
    assert.equal((await ask('project.list', {}, freshToken)).status, 200, 'same signed grant is replayable after durable server restart')
    await f.app.store.transaction(tx => tx.identity.removeProjectGrant(f.project.id, contributor))
    assert.equal((await ask('project.list', {}, freshToken)).status, 404, 'grant removal independently invalidates currently live token')
    assert.equal((await ask('task.sessions', { projectId: f.project.id, taskId: f.task.id }, freshToken)).status, 404)
    assert.equal((await ask('project.list')).status, 403, 'old grant remains invalid after account authVersion changes')
  } finally { await f.close() }
})

test('Task Session creation rejects invalid relationships and revoked access without side effects', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.call(f.path, f.request, 'invalid-token')).status, 401)
    assert.equal((await f.call(f.path, undefined, 'invalid-token')).status, 401)
    assert.equal((await f.call(f.path, f.request, viewer)).status, 403)
    assert.equal((await f.call(f.path, f.request, outsider)).status, 403)
    assert.equal((await f.call(`/projects/${f.otherProject.id}/tasks/${f.task.id}/sessions`, f.request)).status, 404)
    assert.equal((await f.call(f.path.replace(f.task.id, 'missing-task'), f.request)).status, 404)
    for (const [patch, status] of [[{ workspaceId: 'missing' }, 404], [{ workspaceId: 'other-workspace' }, 403], [{ workerId: 'missing' }, 404], [{ agentKey: 'missing' }, 409], [{ modelId: 'missing' }, 409]] as const) {
      const result = await f.call(f.path, { ...f.request, ...patch })
      assert.equal(result.status, status, JSON.stringify(result.data))
    }
    const workspace = (await f.app.store.resources.getWorkspace(f.request.workspaceId))!
    for (const patch of [{ deletedAt: at }, { status: 'failed' as const, placements: workspace.placements.map(p => ({ ...p, status: 'failed' as const })) }]) {
      await f.app.store.transaction(tx => tx.resources.saveWorkspace({ ...workspace, ...patch }))
      assert.equal((await f.call(f.path, f.request)).status, patch.deletedAt ? 404 : 409)
    }
    await f.app.store.transaction(async tx => {
      await tx.resources.saveWorkspace(workspace)
      await tx.tasks.bind({ taskId: f.otherTask.id, projectId: f.project.id, workspaceId: workspace.id, createdAt: at })
    })
    const bound = await f.call(f.path, f.request)
    assert.equal(bound.status, 409)
    assert.equal(bound.data.error.code, 'workspace_bound')
    await f.app.store.transaction(tx => tx.tasks.unbind(f.otherTask.id, workspace.id))
    const worker = (await f.app.store.resources.getWorker(f.request.workerId))!
    await f.app.store.transaction(tx => tx.resources.saveWorker({ ...worker, id: 'unplaced-worker' as WorkerId }))
    assert.equal((await f.call(f.path, { ...f.request, workerId: 'unplaced-worker' })).status, 409)
    for (const patch of [{ connectionState: 'revoked' as const }, { capabilities: [] }, { capabilities: worker.capabilities.map(agent => ({ ...agent, availability: { status: 'authentication-required' as const, reason: 'Synthetic unauthenticated Agent' } })) }, { shareScope: 'owner-only' as const }]) {
      await f.app.store.transaction(tx => tx.resources.saveWorker({ ...worker, ...patch }))
      assert.equal((await f.call(f.path, f.request, contributor)).status, patch.shareScope ? 404 : 409)
    }
    await f.app.store.transaction(async tx => {
      await tx.resources.saveWorker(worker)
      await tx.tasks.save({ ...(await tx.tasks.get(f.task.id))!, deletedAt: at })
    })
    const deleted = await f.call(f.path, f.request)
    assert.equal(deleted.status, 410)
    assert.equal(deleted.data.error.code, 'task_deleted')
    assert.equal((await f.app.store.resources.listSessions()).length, 0)
    assert.equal((await f.app.store.commands.list({ limit: 1000 })).length, 0)
  } finally { await f.close() }
})

test('Task Session fallback selection and omitted model normalization conflict instead of duplicating', async () => {
  const f = await fixture()
  try {
    const fallback = { requestId: 'fallback', title: 'Assigned conversation' }
    assert.equal((await f.call(f.path, fallback)).data.error.code, 'assignment_changed')
    const { workspaceId, workerId, agentKey, modelId } = f.request
    await f.app.store.transaction(async tx => {
      await tx.tasks.bind({ taskId: f.task.id, projectId: f.project.id, workspaceId, createdAt: at })
      await tx.tasks.save({ ...(await tx.tasks.get(f.task.id))!, assignee: { workspaceId, workerId, agentKey, modelId } })
    })
    const first = await f.call(f.path, fallback)
    assert.equal(first.status, 201, JSON.stringify(first.data))
    assert.equal((await f.call(f.path, fallback)).data.session.id, first.data.session.id)
    await f.app.store.transaction(async tx => tx.tasks.save({ ...(await tx.tasks.get(f.task.id))!, assignee: { workspaceId, workerId, agentKey, modelId: 'second' } }))
    const changed = await f.call(f.path, fallback)
    assert.equal(changed.status, 409)
    assert.equal(changed.data.error.code, 'request_id_conflict')
    const { modelId: _, ...omitted } = { ...f.request, requestId: 'omitted' }
    const defaulted = await f.call(f.path, omitted)
    assert.equal(defaulted.status, 201)
    assert.equal(defaulted.data.session.binding.modelId, 'model')
    assert.equal((await f.call(f.path, { ...omitted, modelId: null })).data.session.id, defaulted.data.session.id)
    const worker = (await f.app.store.resources.getWorker(workerId))!
    await f.app.store.transaction(tx => tx.resources.saveWorker({ ...worker, capabilities: worker.capabilities.map(agent => ({ ...agent, models: [...agent.models].reverse() })) }))
    const reordered = await f.call(f.path, omitted)
    assert.equal(reordered.status, 409)
    assert.equal(reordered.data.error.code, 'request_id_conflict')
    // A concrete model makes the retry independent of advertised ordering.
    assert.equal((await f.call(f.path, { ...omitted, modelId: 'model' })).data.session.id, defaulted.data.session.id)
    assert.equal((await f.app.store.resources.listSessions()).length, 2)
  } finally { await f.close() }
})

test('Task Session retries recheck current Worker, Project and retained Session lifecycle', async () => {
  const f = await fixture()
  try {
    const created = await f.call(f.path, f.request, contributor)
    assert.equal(created.status, 201, JSON.stringify(created.data))
    const commands = await f.app.store.commands.list({ limit: 1000 })
    const worker = (await f.app.store.resources.getWorker(f.request.workerId))!
    await f.app.store.transaction(tx => tx.resources.saveWorker({ ...worker, shareScope: 'owner-only' }))
    assert.equal((await f.call(f.path, f.request, contributor)).status, 404)
    await f.app.store.transaction(tx => tx.resources.saveWorker({ ...worker, connectionState: 'revoked' }))
    assert.equal((await f.call(f.path, f.request, contributor)).status, 409)
    await f.app.store.transaction(async tx => {
      await tx.resources.saveWorker(worker)
      await tx.identity.removeProjectGrant(f.project.id, contributor)
    })
    assert.equal((await f.call(f.path, f.request, contributor)).status, 403)
    const task = (await f.app.store.tasks.get(f.task.id))!
    await f.app.store.transaction(async tx => {
      await tx.identity.saveProjectGrant({ projectId: f.project.id, userId: contributor, role: 'contributor' })
      await tx.tasks.save({ ...task, deletedAt: at })
    })
    assert.equal((await f.call(f.path, f.request, contributor)).status, 410)
    assert.equal((await f.call(f.path, undefined, contributor)).status, 410)
    await f.app.store.transaction(async tx => {
      await tx.tasks.save(task)
      await tx.resources.saveProject({ ...f.project, deletedAt: at })
    })
    assert.equal((await f.call(f.path, f.request, contributor)).status, 404)
    await f.app.store.transaction(async tx => {
      await tx.resources.saveProject(f.project)
      await tx.identity.saveProjectGrant({ projectId: f.project.id, userId: contributor, role: 'contributor' })
      await tx.resources.saveSession({ ...(await tx.resources.getSession(created.data.session.id))!, deletedAt: at })
    })
    assert.equal((await f.call(f.path, f.request, contributor)).status, 404)
    assert.deepEqual((await f.call(f.path)).data.items, [])
    assert.deepEqual(await f.app.store.commands.list({ limit: 1000 }), commands)
    assert.equal((await f.app.store.resources.listSessions()).length, 1)
  } finally { await f.close() }
})

test('Task Session transaction rolls back receipt, command, audit and Task activity together', async () => {
  const f = await fixture()
  try {
    const { TaskService } = await import('../application/task-service.ts')
    const store = f.app.store
    const snapshot = async () => ({ sessions: await store.resources.listSessions(), commands: await store.commands.list({ limit: 1000 }), audit: await store.identity.listAudit(1000), task: await store.tasks.get(f.task.id), activity: await store.tasks.activity(f.task.id, 0) })
    const before = await snapshot()
    let notifications = 0
    const stop = f.app.service.notifications.onCommands(f.request.workerId, () => { notifications++ })
    const failingStore: import('../application/ports/server-store.ts').ServerStore = {
      fileWrites: store.fileWrites, resources: store.resources, tasks: store.tasks, commands: store.commands, identity: store.identity, cache: store.cache,
      transaction: work => store.transaction(async tx => { await work(tx); throw new Error('forced Task Session rollback') }),
    }
    const tasks = new TaskService(failingStore, () => { notifications++ }, f.app.service)
    await assert.rejects(tasks.createSession(f.project.id, f.task.id, f.request, { actor: f.project.ownerId, requestId: 'trace-only' }), /forced Task Session rollback/)
    assert.deepEqual(await snapshot(), before)
    assert.equal(notifications, 0)
    const created = await f.call(f.path, f.request)
    assert.equal(created.status, 201)
    assert.equal(created.data.created, true)
    assert.equal(notifications, 1)
    assert.equal((await f.call(f.path, f.request)).data.created, false)
    assert.equal(notifications, 1)
    stop()
    await assert.rejects(store.transaction(tx => tx.resources.saveSession({ ...created.data.session, taskId: f.otherTask.id })), /provenance/)
    await assert.rejects(store.transaction(tx => tx.resources.saveSession({ ...created.data.session, taskId: null })), /provenance/)
  } finally { await f.close() }
})

test('Generic root Session create/send compatibility retains owner-only and independent request identity', async () => {
  const f = await fixture()
  try {
    const root = await f.call('/sessions', f.request)
    assert.equal(root.status, 201, JSON.stringify(root.data))
    assert.ok(root.data.session.taskId)
    assert.deepEqual((await f.app.store.tasks.get(root.data.session.taskId))?.dedicatedConversation, { ownerId: f.project.ownerId, workspaceId: f.request.workspaceId, workerId: f.request.workerId, agentKey: 'test', scenario: 'quick-chat' })
    assert.equal(root.data.session.shareScope, 'owner-only')
    const replay = await f.call('/sessions', f.request)
    assert.equal(replay.data.session.id, root.data.session.id)
    assert.equal(replay.data.commandId, root.data.commandId)
    const conflict = await f.call(f.path, f.request)
    assert.equal(conflict.status, 409)
    assert.equal(conflict.data.error.code, 'request_id_conflict')
    const message = { commandId: 'root-message', content: 'Synthetic message; no Worker connected' }
    const sent = await f.call(`/sessions/${root.data.session.id}/messages`, message)
    assert.equal(sent.status, 202, JSON.stringify(sent.data))
    assert.equal((await f.call(`/sessions/${root.data.session.id}/messages`, message)).data.commandId, sent.data.commandId)
    assert.equal((await f.app.store.commands.list({ limit: 1000 })).length, 2)
  } finally { await f.close() }
})
