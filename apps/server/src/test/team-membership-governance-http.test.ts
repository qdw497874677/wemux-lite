import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import type { AgentKey, CommandId, EventSeq, MessageId, ModelId, ProjectId, SessionId, TeamId, Timestamp, TurnId, UserId, WorkerId, WorkspaceId } from '@wemux/domain'
import { createWemuxServer } from '../server.js'
import { administratorEmail, seedLocalAccount } from './fixtures/administrator.js'

const password = 'correct horse battery staple'

function browser(base: string) {
  let cookie = ''
  let csrf = ''
  const request = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const headers: Record<string, string> = { Accept: 'application/json', Origin: base, 'Content-Type': 'application/json' }
    if (cookie) headers.Cookie = cookie
    if (csrf) headers['X-CSRF-Token'] = csrf
    const response = await fetch(`${base}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
    const setCookie = response.headers.getSetCookie().find(value => value.startsWith('wemux_login_session='))
    if (setCookie) cookie = setCookie.split(';')[0]!
    return response
  }
  return {
    callRaw: request,
    call: async (path: string, init: { method?: string; body?: unknown } = {}) => {
      const response = await request(path, init)
      const data = response.status === 204 ? null : await response.json() as any
      if (typeof data?.csrfToken === 'string') csrf = data.csrfToken
      return { status: response.status, data }
    },
  }
}

async function login(client: ReturnType<typeof browser>, username: string) {
  const response = await client.call('/auth/login', { method: 'POST', body: { login: username, password } })
  assert.equal(response.status, 200, JSON.stringify(response.data))
}

test('只有 Team owner 能在 admin 与 member 间调整角色，普通 PATCH 不能改变 owner', async t => {
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [administratorEmail] })
  await seedLocalAccount(app.store, { username: 'owner', email: 'owner@example.com', password })
  const adminUser = await seedLocalAccount(app.store, { username: 'admin', email: 'admin@example.com', password })
  const memberUser = await seedLocalAccount(app.store, { username: 'member', email: 'member@example.com', password })
  const base = await app.listen(0)
  t.after(() => app.close())

  const owner = browser(base)
  await login(owner, 'owner')
  const teamId = (await owner.call('/teams', { method: 'POST', body: { name: 'Roles' } })).data.id as string
  await app.store.transaction(async tx => {
    const joinedAt = new Date().toISOString() as never
    await tx.identity.saveMembership({ teamId: teamId as never, userId: adminUser.id, role: 'admin', joinedAt })
    await tx.identity.saveMembership({ teamId: teamId as never, userId: memberUser.id, role: 'member', joinedAt })
  })

  const promoted = await owner.call(`/teams/${teamId}/members/${memberUser.id}`, { method: 'PATCH', body: { role: 'admin' } })
  assert.equal(promoted.status, 200, JSON.stringify(promoted.data))
  assert.equal(promoted.data.role, 'admin')

  const admin = browser(base)
  await login(admin, 'admin')
  const denied = await admin.call(`/teams/${teamId}/members/${memberUser.id}`, { method: 'PATCH', body: { role: 'member' } })
  assert.equal(denied.status, 403)
  assert.equal(denied.data.error.code, 'team_owner_required')

  const ownerUser = (await app.store.identity.getUserByLogin('owner'))!
  const ownerPatch = await owner.call(`/teams/${teamId}/members/${ownerUser.id}`, { method: 'PATCH', body: { role: 'member' } })
  assert.equal(ownerPatch.status, 409)
  assert.equal(ownerPatch.data.error.code, 'ownership_transfer_required')

  const demoted = await owner.call(`/teams/${teamId}/members/${memberUser.id}`, { method: 'PATCH', body: { role: 'member' } })
  assert.equal(demoted.status, 200, JSON.stringify(demoted.data))
  assert.equal(demoted.data.role, 'member')
})

test('最后一个实例恢复管理员不能被降为 member 或移出 Team', async t => {
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [administratorEmail] })
  const ownerUser = await seedLocalAccount(app.store, { username: 'owner', email: 'owner@example.com', password })
  const recoveryUser = await seedLocalAccount(app.store, { username: 'recovery', email: 'recovery@example.com', password })
  const base = await app.listen(0)
  t.after(() => app.close())

  const owner = browser(base)
  await login(owner, 'owner')
  const teamId = (await owner.call('/teams', { method: 'POST', body: { name: 'Recovery protected' } })).data.id as TeamId
  const assignedAt = new Date().toISOString() as Timestamp
  await app.store.transaction(async tx => {
    await tx.identity.saveMembership({ teamId, userId: recoveryUser.id, role: 'admin', joinedAt: assignedAt })
    await tx.identity.saveInstanceAdministrator({ userId: recoveryUser.id, email: 'recovery@example.com', assignedAt, source: 'recovery' })
  })

  const demoted = await owner.call(`/teams/${teamId}/members/${recoveryUser.id}`, { method: 'PATCH', body: { role: 'member' } })
  assert.equal(demoted.status, 409)
  assert.equal(demoted.data.error.code, 'last_instance_administrator')

  const removed = await owner.call(`/teams/${teamId}/members/${recoveryUser.id}`, { method: 'DELETE' })
  assert.equal(removed.status, 409)
  assert.equal(removed.data.error.code, 'last_instance_administrator')

  const memberships = await app.store.identity.listTeamMemberships(teamId)
  assert.equal(memberships.find(value => value.userId === recoveryUser.id)?.role, 'admin')
  assert.equal(memberships.find(value => value.userId === ownerUser.id)?.role, 'owner')
})

test('移除成员与其 Project、Worker、Session Grant 在同一事务撤销', async t => {
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [administratorEmail] })
  const ownerUser = await seedLocalAccount(app.store, { username: 'owner', email: 'owner@example.com', password })
  const memberUser = await seedLocalAccount(app.store, { username: 'member', email: 'member@example.com', password })
  const base = await app.listen(0)
  t.after(() => app.close())

  const owner = browser(base)
  const member = browser(base)
  await login(owner, 'owner')
  await login(member, 'member')
  const teamId = (await owner.call('/teams', { method: 'POST', body: { name: 'Atomic removal' } })).data.id as TeamId
  const projectId = randomUUID() as ProjectId
  const workerId = randomUUID() as WorkerId
  const sessionId = randomUUID() as SessionId
  const workspaceId = randomUUID() as WorkspaceId
  const at = new Date().toISOString() as Timestamp
  await app.store.transaction(async tx => {
    await tx.identity.saveMembership({ teamId, userId: memberUser.id, role: 'member', joinedAt: at })
    await tx.resources.saveProject({ id: projectId, teamId, ownerId: ownerUser.id, name: 'Shared project', shareScope: 'selected-members', deletedAt: null })
    await tx.identity.saveProjectGrant({ projectId, userId: memberUser.id, role: 'contributor' })
    await tx.resources.saveWorker({ id: workerId, teamId, ownerId: ownerUser.id, name: 'Shared worker', shareScope: 'selected-members', connectionState: 'offline', version: '1', platform: 'linux', capabilities: [], lastSeenAt: at })
    await tx.identity.saveWorkerGrant({ workerId, userId: memberUser.id, role: 'use' })
    await tx.resources.saveWorkspace({ id: workspaceId, projectId, name: 'Shared workspace', spec: { kind: 'composite', memberWorkspaceIds: [] }, placements: [], deletedAt: null })
    await tx.resources.saveSession({ id: sessionId, projectId, ownerId: ownerUser.id, workspaceId, title: 'Shared session', shareScope: 'selected-members', binding: { workspaceId, agent: { workerId, agentKey: 'test' as AgentKey }, modelId: 'model' as ModelId }, runtimeState: 'idle', archivedAt: null, deletedAt: null })
    await tx.identity.saveSessionGrant({ sessionId, userId: memberUser.id })
  })

  assert.equal((await member.call('/teams')).data.items.length, 1)
  assert.equal((await member.call('/projects')).data.items.length, 1)
  assert.equal((await member.call('/workers')).data.items.length, 1)
  assert.equal((await member.call('/sessions')).data.items.length, 1)

  const removed = await owner.call(`/teams/${teamId}/members/${memberUser.id}`, { method: 'DELETE' })
  assert.equal(removed.status, 204, JSON.stringify(removed.data))

  assert.deepEqual((await member.call('/teams')).data, { items: [] })
  assert.deepEqual((await member.call('/projects')).data, { items: [] })
  assert.deepEqual((await member.call('/workers')).data, { items: [] })
  assert.deepEqual((await member.call('/sessions')).data, { items: [] })
  assert.deepEqual((await owner.call(`/projects/${projectId}/grants`)).data, { items: [] })
  assert.deepEqual((await owner.call(`/workers/${workerId}/grants`)).data, { items: [] })
  assert.deepEqual((await owner.call(`/sessions/${sessionId}/grants`)).data, { items: [] })

  const audit = await app.store.identity.listAudit(20)
  assert.equal(audit.some(entry => entry.action === 'team.member.remove' && entry.actorId === ownerUser.id && entry.metadata?.userId === memberUser.id), true)
})

test('成员移除提交后立即关闭已打开的 Session SSE，且不再发送后续私人事件', async t => {
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [administratorEmail] })
  const ownerUser = await seedLocalAccount(app.store, { username: 'owner', email: 'owner@example.com', password })
  const memberUser = await seedLocalAccount(app.store, { username: 'member', email: 'member@example.com', password })
  const base = await app.listen(0)
  t.after(() => app.close())

  const owner = browser(base)
  const member = browser(base)
  await login(owner, 'owner')
  await login(member, 'member')
  const teamId = (await owner.call('/teams', { method: 'POST', body: { name: 'Live revocation' } })).data.id as TeamId
  const projectId = randomUUID() as ProjectId
  const workerId = randomUUID() as WorkerId
  const sessionId = randomUUID() as SessionId
  const workspaceId = randomUUID() as WorkspaceId
  const assignedAt = new Date().toISOString() as Timestamp
  await app.store.transaction(async tx => {
    await tx.identity.saveMembership({ teamId, userId: memberUser.id, role: 'member', joinedAt: assignedAt })
    await tx.resources.saveProject({ id: projectId, teamId, ownerId: ownerUser.id, name: 'Private project', shareScope: 'selected-members', deletedAt: null })
    await tx.identity.saveProjectGrant({ projectId, userId: memberUser.id, role: 'viewer' })
    await tx.resources.saveWorker({ id: workerId, teamId, ownerId: ownerUser.id, name: 'Worker', shareScope: 'owner-only', connectionState: 'offline', version: '1', platform: 'linux', capabilities: [], lastSeenAt: assignedAt })
    await tx.resources.saveWorkspace({ id: workspaceId, projectId, name: 'Workspace', spec: { kind: 'composite', memberWorkspaceIds: [] }, placements: [], deletedAt: null })
    await tx.resources.saveSession({ id: sessionId, projectId, ownerId: ownerUser.id, workspaceId, title: 'Private session', shareScope: 'project', binding: { workspaceId, agent: { workerId, agentKey: 'test' as AgentKey }, modelId: 'model' as ModelId }, runtimeState: 'idle', archivedAt: null, deletedAt: null })
  })

  const response = await member.callRaw(`/sessions/${sessionId}/stream`)
  assert.equal(response.status, 200)
  const reader = response.body!.getReader()
  const first = await reader.read()
  assert.match(new TextDecoder().decode(first.value), /event: freshness/)

  const removed = await owner.call(`/teams/${teamId}/members/${memberUser.id}`, { method: 'DELETE' })
  assert.equal(removed.status, 204)
  const closed = reader.closed.then(() => true, () => true)
  assert.equal(await Promise.race([closed, new Promise<false>(resolve => setTimeout(() => resolve(false), 1_000))]), true)

  app.service.notifications.session(sessionId)
  assert.equal((await member.call(`/sessions/${sessionId}`)).status, 404)
})

test('移除成员会为其活跃 Turn 写入持久停止命令；Worker 离线时命令保持 pending', async t => {
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [administratorEmail] })
  const ownerUser = await seedLocalAccount(app.store, { username: 'owner', email: 'owner@example.com', password })
  const memberUser = await seedLocalAccount(app.store, { username: 'member', email: 'member@example.com', password })
  const base = await app.listen(0)
  t.after(() => app.close())
  const owner = browser(base)
  await login(owner, 'owner')
  const teamId = (await owner.call('/teams', { method: 'POST', body: { name: 'Cancel removed member work' } })).data.id as TeamId
  const projectId = randomUUID() as ProjectId
  const workerId = randomUUID() as WorkerId
  const workspaceId = randomUUID() as WorkspaceId
  const sessionId = randomUUID() as SessionId
  const messageId = randomUUID() as MessageId
  const turnId = randomUUID() as TurnId
  const at = new Date().toISOString() as Timestamp
  await app.store.transaction(async tx => {
    await tx.identity.saveMembership({ teamId, userId: memberUser.id, role: 'member', joinedAt: at })
    await tx.resources.saveProject({ id: projectId, teamId, ownerId: ownerUser.id, name: 'Project', shareScope: 'team', deletedAt: null })
    await tx.resources.saveWorker({ id: workerId, teamId, ownerId: ownerUser.id, name: 'Offline worker', shareScope: 'team', connectionState: 'offline', version: '1', platform: 'linux', capabilities: [], lastSeenAt: at })
    await tx.resources.saveWorkspace({ id: workspaceId, projectId, name: 'Workspace', spec: { kind: 'composite', memberWorkspaceIds: [] }, placements: [], deletedAt: null })
    await tx.resources.saveSession({ id: sessionId, projectId, ownerId: ownerUser.id, workspaceId, title: 'Session', shareScope: 'project', binding: { workspaceId, agent: { workerId, agentKey: 'test' as AgentKey }, modelId: 'model' as ModelId }, runtimeState: 'running', archivedAt: null, deletedAt: null })
    await tx.cache.applyEvents(sessionId, [
      { sessionId, seq: 1 as EventSeq, occurredAt: at, payload: { kind: 'message.queued', commandId: randomUUID() as CommandId, messageId, content: 'long task', position: 0, sentByAccountId: memberUser.id } },
      { sessionId, seq: 2 as EventSeq, occurredAt: at, payload: { kind: 'turn.started', messageId, turnId } },
    ])
  })

  const removed = await owner.call(`/teams/${teamId}/members/${memberUser.id}`, { method: 'DELETE' })
  assert.equal(removed.status, 204)
  const commands = await app.store.commands.list({ workerId, status: 'pending', limit: 20 })
  assert.equal(commands.length, 1)
  assert.equal(commands[0]!.status, 'pending')
  const pending = await app.store.commands.getPendingCommand(commands[0]!.commandId)
  assert.deepEqual(pending?.command, { kind: 'turn.stop', sessionId, turnId })
  assert.equal((await app.store.commands.listDeliverable(workerId, 20)).length, 1)
  const audit = await app.store.identity.listAudit(20)
  assert.equal(audit.find(entry => entry.action === 'team.member.remove')?.metadata?.stopCommands, '1')
})

test('Team owner 显式确认后原子转移所有权，原 owner 降为 admin', async t => {
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [administratorEmail] })
  const ownerUser = await seedLocalAccount(app.store, { username: 'owner', email: 'owner@example.com', password })
  const successor = await seedLocalAccount(app.store, { username: 'successor', email: 'successor@example.com', password })
  const base = await app.listen(0)
  t.after(() => app.close())

  const owner = browser(base)
  await login(owner, 'owner')
  const created = await owner.call('/teams', { method: 'POST', body: { name: 'Agent Network' } })
  assert.equal(created.status, 201, JSON.stringify(created.data))
  const teamId = created.data.id as string
  await app.store.transaction(tx => tx.identity.saveMembership({
    teamId: teamId as never,
    userId: successor.id,
    role: 'member',
    joinedAt: new Date().toISOString() as never,
  }))

  const missingConfirmation = await owner.call(`/teams/${teamId}/ownership-transfer`, {
    method: 'POST',
    body: { userId: successor.id, confirmation: 'wrong name' },
  })
  assert.equal(missingConfirmation.status, 400)
  assert.equal(missingConfirmation.data.error.code, 'ownership_confirmation_mismatch')

  const transferred = await owner.call(`/teams/${teamId}/ownership-transfer`, {
    method: 'POST',
    body: { userId: successor.id, confirmation: 'Agent Network' },
  })
  assert.equal(transferred.status, 200, JSON.stringify(transferred.data))
  assert.deepEqual(transferred.data, { teamId, ownerId: successor.id, previousOwnerId: ownerUser.id })

  const members = await owner.call(`/teams/${teamId}/members`)
  assert.equal(members.status, 200, JSON.stringify(members.data))
  assert.deepEqual(
    members.data.items.map((item: any) => ({ userId: item.user.id, role: item.role })).sort((left: any, right: any) => left.userId.localeCompare(right.userId)),
    [{ userId: ownerUser.id, role: 'admin' }, { userId: successor.id, role: 'owner' }].sort((left, right) => left.userId.localeCompare(right.userId)),
  )

  const audit = await app.store.identity.listAudit(20)
  assert.equal(audit.some(entry => entry.action === 'team.ownership.transfer' && entry.actorId === ownerUser.id && entry.metadata?.ownerId === successor.id), true)
})
