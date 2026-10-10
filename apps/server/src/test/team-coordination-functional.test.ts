import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentKey, ModelId, ProjectId, Timestamp, UserId, WorkerId, WorkspaceId } from '@wemux/domain'
import { createWemuxServer } from '../server.ts'
import { administratorEmail, seedAdministrator, administratorToken } from './fixtures/administrator.ts'
import { hashSecret } from '../application/auth.ts'

const at = '2026-06-01T00:00:00Z' as Timestamp
const contributor = 'task-session-contributor' as UserId
const viewer = 'task-session-viewer' as UserId
const outsider = 'task-session-outsider' as UserId

/** Owned SQLite and synthetic resources only; no Worker connection or Runtime invocation. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'wemux-team-coordination-test-'))
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
  const workerId = 'task-session-worker' as WorkerId, workspaceId = 'task-session-workspace' as WorkspaceId
  await app.store.transaction(async tx => {
    for (const userId of [contributor, viewer, outsider]) {
      await tx.identity.saveUser({ id: userId, email: `${userId}@example.test`, username: userId, status: 'active', createdAt: at })
      await tx.identity.savePersonalAccessToken({ id: userId as never, userId, name: 'Synthetic test', scopes: ['read', 'write', 'execute', 'admin'], tokenHash: hashSecret(userId), createdAt: at, expiresAt: '2099-01-01T00:00:00Z' as Timestamp, lastUsedAt: null, revokedAt: null })
      if (userId === outsider) continue
      await tx.identity.saveMembership({ teamId: project.teamId, userId, role: 'member', joinedAt: at })
      await tx.identity.saveProjectGrant({ projectId: project.id, userId, role: userId === viewer ? 'viewer' : 'contributor' })
    }
    await tx.resources.saveWorker({ id: workerId, teamId: project.teamId, ownerId: project.ownerId, name: 'Synthetic Worker', shareScope: 'team', connectionState: 'online', version: '1', platform: 'linux', lastSeenAt: at, capabilities: [{ agentKey: 'test' as AgentKey, displayName: 'Test', version: '1', mode: 'execution', availability: { status: 'available' }, models: [{ modelId: 'model' as ModelId, displayName: 'Model', source: 'configured' }, { modelId: 'second' as ModelId, displayName: 'Second', source: 'configured' }] }] })
    for (const [id, projectId] of [[workspaceId, project.id], ['other-workspace', otherProject.id]]) {
      await tx.resources.saveWorkspace({ id: id as WorkspaceId, projectId: projectId as ProjectId, name: id, spec: { kind: 'composite', memberWorkspaceIds: [] }, placements: [{ workerId, status: 'ready', failureReason: null, location: null }], deletedAt: null })
    }
  })
  const request = { requestId: 'create-session', title: 'Task conversation', workspaceId, workerId, agentKey: 'test', modelId: 'model' }
  return { get app() { return app }, call, project, task, request,
    async reopen() { await app.close(); app = createWemuxServer(options); origin = await app.listen(0) },
    async close() { await app.close(); await rm(root, { recursive: true, force: true }) },
  }
}

test('coordination first send binds a reusable Team Task and Project Workspace, replays without duplicate send', async () => {
  const f = await fixture()
  try {
    const path = '/teams/default-team/coordination/sessions'
    const body = { ...f.request, content: 'First handoff', commandId: 'first-coordination-command' }
    assert.equal((await f.call('/teams/default-team/coordination/availability')).data.status, 'enabled')
    const initial = await f.call(path, body, contributor)
    assert.equal(initial.status, 201, JSON.stringify(initial.data))
    assert.equal(initial.data.session.projectId, f.project.id)
    assert.equal(initial.data.session.binding.workspaceId, f.request.workspaceId)
    const id = initial.data.session.taskId
    assert.ok(id.startsWith('coordination:'))
    const task = await f.app.store.tasks.get(id)
    assert.equal(task?.projectId, 'team:default-team')
    assert.equal(task?.teamCoordination?.ownerId, contributor)
    assert.equal(initial.data.messageCommandId, body.commandId)
    const command = await f.app.store.commands.getPendingCommand(body.commandId as never)
    assert.equal(command?.command.kind, 'session.enqueue')
    if (command?.command.kind !== 'session.enqueue') throw Error('Missing first enqueue')
    assert.equal(command.command.capabilities?.snapshot.projectId, f.project.id, 'ordinary Project and Workspace capability binding')
    assert.ok(command.command.capabilities?.snapshot.allowedTools.includes('task.create'), 'coordination Agent keeps ordinary Project-scoped tools')
    const again = await f.call(path, body, contributor)
    assert.equal(again.status, 201, JSON.stringify(again.data))
    assert.equal(again.data.created, false)
    assert.equal(again.data.session.id, initial.data.session.id)
    assert.equal((await f.app.store.commands.list({ limit: 1000 })).filter(c => c.commandId === body.commandId).length, 1)
    const next = await f.call(path, { ...body, requestId: 'another-first-send', commandId: 'second-coordination-command', content: 'Next handoff' }, contributor)
    assert.equal(next.status, 201, JSON.stringify(next.data))
    assert.equal(next.data.session.taskId, id)
    assert.notEqual(next.data.session.id, initial.data.session.id)
    assert.equal((await f.call(path, undefined, contributor)).data.items.length, 2)
    assert.equal((await f.call(`/sessions/${initial.data.session.id}`, undefined, viewer)).status, 404, 'another Team member cannot reopen owner conversation')
    const share = await f.call(`/sessions/${initial.data.session.id}/access`, { shareScope: 'project' }, contributor, 'PATCH')
    assert.equal(share.status, 409, JSON.stringify(share.data))
    const subsequent = await f.call(`/sessions/${initial.data.session.id}/messages`, { commandId: 'following-message', content: 'Follow up' }, contributor)
    assert.ok([200, 201, 202].includes(subsequent.status), JSON.stringify(subsequent.data))
    await f.reopen()
    const replay = await f.call(path, body, contributor)
    assert.equal(replay.status, 201, JSON.stringify(replay.data))
    assert.equal(replay.data.session.id, initial.data.session.id)
  } finally { await f.close() }
})

test('coordination rejects untrusted identity, unauthorized Team/Worker/Workspace/model and revocation', async () => {
  const f = await fixture()
  try {
    const path = '/teams/default-team/coordination/sessions'
    const body = { ...f.request, content: 'Private handoff', commandId: 'first-coordination-command' }
    for (const token of [viewer, outsider]) assert.ok([403, 404].includes((await f.call(path, body, token)).status))
    const foreignTeam = (await f.call('/teams', { name: 'Other Team' })).data
    const foreignProject = (await f.call('/projects', { teamId: foreignTeam.id, name: 'Foreign Project' })).data
    await f.app.store.transaction(async tx => {
      await tx.identity.saveMembership({ teamId: foreignTeam.id, userId: contributor, role: 'member', joinedAt: at })
      await tx.identity.saveProjectGrant({ projectId: foreignProject.id, userId: contributor, role: 'contributor' })
      await tx.resources.saveWorkspace({ id: 'foreign-workspace' as WorkspaceId, projectId: foreignProject.id, name: 'Foreign Workspace', spec: { kind: 'composite', memberWorkspaceIds: [] }, placements: [{ workerId: body.workerId, status: 'ready', failureReason: null, location: null }], deletedAt: null })
    })
    assert.ok([403, 404].includes((await f.call(path, { ...body, workspaceId: 'foreign-workspace' }, contributor)).status))
    for (const patch of [{ workspaceId: 'other-workspace' }, { workspaceId: 'not-found' }, { workerId: 'not-found' }, { modelId: 'not-found' }, { ownerId: contributor }, { taskId: f.task.id }]) {
      const failed = await f.call(path, { ...body, ...patch }, contributor)
      assert.ok([400, 403, 404, 409].includes(failed.status), JSON.stringify(failed.data))
    }
    assert.equal((await f.call(path, undefined, outsider)).status, 403)
    assert.equal((await f.call(path, body, contributor)).status, 201)
    await f.app.store.transaction(tx => tx.identity.removeProjectGrant(f.project.id, contributor))
    assert.ok([403, 404].includes((await f.call(path, body, contributor)).status))
    assert.equal((await f.call(path, undefined, contributor)).data.items.length, 0)
  } finally { await f.close() }
})
