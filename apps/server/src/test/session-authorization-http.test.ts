import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import type { AgentKey, CommandId, EventSeq, ModelId, ProjectId, SessionId, TeamId, Timestamp, TurnId, UserId, WorkerId, WorkspaceId } from '@wemux/domain'
import { createWemuxServer } from '../server.js'
import { administratorEmail, seedLocalAccount } from './fixtures/administrator.js'

const password = 'correct horse battery staple'
const at = '2026-03-24T00:00:00.000Z' as Timestamp

function browser(base: string) {
  let cookie = '', csrf = ''
  return { call: async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const headers: Record<string, string> = { Accept: 'application/json', Origin: base, Host: new URL(base).host, 'Content-Type': 'application/json' }
    if (cookie) headers.Cookie = cookie
    if (csrf) headers['X-CSRF-Token'] = csrf
    const response = await fetch(`${base}${path}`, { method: init.method ?? (init.body === undefined ? 'GET' : 'POST'), headers, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) })
    const setCookie = response.headers.getSetCookie().find(value => value.startsWith('wemux_login_session='))
    if (setCookie) cookie = setCookie.split(';')[0]!
    const data = response.status === 204 ? null : await response.json() as any
    if (typeof data?.csrfToken === 'string') csrf = data.csrfToken
    return { status: response.status, data }
  } }
}

async function login(client: ReturnType<typeof browser>, username: string) {
  const response = await client.call('/auth/login', { method: 'POST', body: { login: username, password } })
  assert.equal(response.status, 200, JSON.stringify(response.data))
}

test('Session policy separates read, write and control while hiding unauthorized metadata', async t => {
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [administratorEmail] })
  const owner = await seedLocalAccount(app.store, { username: 'owner', email: administratorEmail, password })
  const contributor = await seedLocalAccount(app.store, { username: 'contributor', email: 'contributor@example.com', password })
  const viewer = await seedLocalAccount(app.store, { username: 'viewer', email: 'viewer@example.com', password })
  const manager = await seedLocalAccount(app.store, { username: 'manager', email: 'manager@example.com', password })
  const outsider = await seedLocalAccount(app.store, { username: 'outsider', email: 'outsider@example.com', password })
  const teamId = randomUUID() as TeamId, projectId = randomUUID() as ProjectId, workerId = randomUUID() as WorkerId
  const workspaceId = randomUUID() as WorkspaceId, sessionId = randomUUID() as SessionId
  await app.store.transaction(async tx => {
    await tx.identity.saveTeam({ id: teamId, name: 'Shared team', createdAt: at })
    for (const userId of [owner.id, contributor.id, viewer.id, manager.id]) await tx.identity.saveMembership({ teamId, userId, role: userId === owner.id ? 'owner' : 'member', joinedAt: at })
    await tx.resources.saveProject({ id: projectId, teamId, ownerId: owner.id, name: 'Shared project', shareScope: 'selected-members', deletedAt: null })
    await tx.identity.saveProjectGrant({ projectId, userId: contributor.id, role: 'contributor' })
    await tx.identity.saveProjectGrant({ projectId, userId: viewer.id, role: 'viewer' })
    await tx.identity.saveProjectGrant({ projectId, userId: manager.id, role: 'manager' })
    await tx.resources.saveWorker({ id: workerId, teamId, ownerId: owner.id, name: 'Worker', shareScope: 'owner-only', connectionState: 'online', version: '1', platform: 'linux', capabilities: [{ agentKey: 'test' as AgentKey, displayName: 'Test', version: '1', mode: 'execution', availability: { status: 'available' }, models: [{ modelId: 'model' as ModelId, displayName: 'Model', source: 'configured' }] }], lastSeenAt: at })
    await tx.resources.saveWorkspace({ id: workspaceId, projectId, name: 'Workspace', spec: { kind: 'composite', memberWorkspaceIds: [] }, placements: [{ workerId, status: 'ready', failureReason: null, location: null }], deletedAt: null })
    await tx.resources.saveSession({ id: sessionId, projectId, ownerId: owner.id, workspaceId, title: 'Secret shared title', shareScope: 'project', binding: { workspaceId, agent: { workerId, agentKey: 'test' as AgentKey }, modelId: 'model' as ModelId }, runtimeState: 'idle', archivedAt: null, deletedAt: null })
  })
  const base = await app.listen(0); t.after(() => app.close())
  const ownerClient = browser(base), contributorClient = browser(base), viewerClient = browser(base), managerClient = browser(base), outsiderClient = browser(base)
  await Promise.all([
    login(ownerClient, 'owner'), login(contributorClient, 'contributor'), login(viewerClient, 'viewer'), login(managerClient, 'manager'), login(outsiderClient, 'outsider'),
  ])

  const outsiderList = await outsiderClient.call('/sessions')
  assert.equal(outsiderList.status, 200)
  assert.deepEqual(outsiderList.data, { items: [] })
  assert.equal((await outsiderClient.call(`/sessions/${sessionId}`)).status, 404)
  assert.equal((await outsiderClient.call(`/sessions/${sessionId}/events`)).status, 404)

  const viewerView = await viewerClient.call(`/sessions/${sessionId}`)
  assert.equal(viewerView.status, 200, JSON.stringify(viewerView.data))
  assert.deepEqual(viewerView.data.access, { canRead: true, canWrite: false, canControl: false, projectRole: 'viewer' })
  assert.equal((await viewerClient.call(`/sessions/${sessionId}/messages`, { method: 'POST', body: { commandId: 'viewer-message', content: 'no' } })).status, 403)

  const sent = await contributorClient.call(`/sessions/${sessionId}/messages`, { method: 'POST', body: { commandId: 'contributor-message', content: 'hello' } })
  assert.equal(sent.status, 202, JSON.stringify(sent.data))
  const command = await app.store.commands.getPendingCommand('contributor-message' as CommandId)
  assert.equal(command?.command.kind, 'session.enqueue')
  if (command?.command.kind !== 'session.enqueue') assert.fail('Expected session.enqueue command')
  assert.equal(command.command.message.sentByAccountId, contributor.id)

  const messageId = command.command.message.messageId
  assert.equal((await contributorClient.call(`/sessions/${sessionId}/messages/${command.commandId}/cancel`, { method: 'POST', body: { commandId: 'contributor-cancel-own' } })).status, 202)
  const turnId = 'owner-turn' as TurnId
  await app.store.transaction(async tx => tx.cache.applyEvents(sessionId, [
    { sessionId, seq: 1 as EventSeq, occurredAt: at, payload: { kind: 'message.queued', commandId: 'owner-message' as CommandId, messageId: 'owner-message' as never, content: 'owner work', position: 0, sentByAccountId: owner.id } },
    { sessionId, seq: 2 as EventSeq, occurredAt: at, payload: { kind: 'turn.started', turnId, messageId: 'owner-message' as never } },
  ]))
  assert.equal((await contributorClient.call(`/sessions/${sessionId}/turn/stop`, { method: 'POST', body: { commandId: 'contributor-stop', turnId } })).status, 403)
  const contributorTurn = 'contributor-turn' as TurnId
  await app.store.transaction(async tx => tx.cache.applyEvents(sessionId, [
    { sessionId, seq: 3 as EventSeq, occurredAt: at, payload: { kind: 'turn.finished', turnId, outcome: 'completed', failure: null } },
    { sessionId, seq: 4 as EventSeq, occurredAt: at, payload: { kind: 'message.queued', commandId: 'contributor-message' as CommandId, messageId, content: 'hello', position: 0, sentByAccountId: contributor.id } },
    { sessionId, seq: 5 as EventSeq, occurredAt: at, payload: { kind: 'turn.started', turnId: contributorTurn, messageId } },
  ]))
  assert.equal((await contributorClient.call(`/sessions/${sessionId}/turn/stop`, { method: 'POST', body: { commandId: 'contributor-stop-own', turnId: contributorTurn } })).status, 202)
  const managerStop = await managerClient.call(`/sessions/${sessionId}/turn/stop`, { method: 'POST', body: { commandId: 'manager-stop', turnId: contributorTurn } })
  assert.equal(managerStop.status, 202, JSON.stringify(managerStop.data))

  const access = await ownerClient.call(`/sessions/${sessionId}/access`, { method: 'PATCH', body: { shareScope: 'selected-members' } })
  assert.equal(access.status, 200, JSON.stringify(access.data))
  assert.equal((await ownerClient.call(`/sessions/${sessionId}/grants`, { method: 'POST', body: { userId: contributor.id } })).status, 201)
  assert.equal((await contributorClient.call(`/sessions/${sessionId}`)).status, 200)
  assert.equal((await viewerClient.call(`/sessions/${sessionId}`)).status, 404)
  assert.equal((await ownerClient.call(`/sessions/${sessionId}/grants/${contributor.id}`, { method: 'DELETE' })).status, 204)
  assert.equal((await contributorClient.call(`/sessions/${sessionId}`)).status, 404)

  const audit = await app.store.identity.listAudit(100)
  assert.equal(audit.some(entry => entry.action === 'session.enqueue' && entry.actorId === contributor.id), true)
  assert.equal(audit.some(entry => entry.action === 'turn.stop' && entry.actorId === manager.id), true)
  void messageId; void outsider
})
