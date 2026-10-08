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

// Public cookie-authenticated HTTP admission, no Worker/native runtime. SQLite is isolated.
for (const operation of ['cancel', 'stop'] as const) test(`${operation} admission replays one persisted command, conflicts on changed target and rechecks current authorization`, async t => {
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [administratorEmail] })
  const owner = await seedLocalAccount(app.store, { username: 'owner', email: administratorEmail, password })
  const contributor = await seedLocalAccount(app.store, { username: 'contributor', email: 'contributor@example.com', password })
  const teamId = randomUUID() as TeamId, projectId = randomUUID() as ProjectId, workerId = randomUUID() as WorkerId
  const workspaceId = randomUUID() as WorkspaceId, sessionId = randomUUID() as SessionId
  await app.store.transaction(async tx => {
    await tx.identity.saveTeam({ id: teamId, name: 'Shared team', createdAt: at })
    for (const userId of [owner.id, contributor.id]) await tx.identity.saveMembership({ teamId, userId, role: userId === owner.id ? 'owner' : 'member', joinedAt: at })
    await tx.resources.saveProject({ id: projectId, teamId, ownerId: owner.id, name: 'Shared project', shareScope: 'selected-members', deletedAt: null })
    await tx.identity.saveProjectGrant({ projectId, userId: contributor.id, role: 'contributor' })
    await tx.resources.saveWorker({ id: workerId, teamId, ownerId: owner.id, name: 'Worker', shareScope: 'owner-only', connectionState: 'online', version: '1', platform: 'linux', capabilities: [{ agentKey: 'test' as AgentKey, displayName: 'Test', version: '1', mode: 'execution', availability: { status: 'available' }, models: [{ modelId: 'model' as ModelId, displayName: 'Model', source: 'configured' }] }], lastSeenAt: at })
    await tx.resources.saveWorkspace({ id: workspaceId, projectId, name: 'Workspace', spec: { kind: 'composite', memberWorkspaceIds: [] }, placements: [{ workerId, status: 'ready', failureReason: null, location: null }], deletedAt: null })
    await tx.resources.saveSession({ id: sessionId, projectId, ownerId: owner.id, workspaceId, title: 'Secret shared title', shareScope: 'project', binding: { workspaceId, agent: { workerId, agentKey: 'test' as AgentKey }, modelId: 'model' as ModelId }, runtimeState: 'idle', archivedAt: null, deletedAt: null })
  })
  const base = await app.listen(0); t.after(() => app.close())
  const contributorClient = browser(base)
  await login(contributorClient, 'contributor')

  const call = (path: string, body: unknown) => contributorClient.call(path, { body })
  const sessionPath = `/sessions/${sessionId}`
  const message = { commandId: 'enqueue', messageId: 'message-not-command', content: 'hello' }
  assert.equal((await call(`${sessionPath}/messages`, message)).status, 202)
  assert.equal((await call(`${sessionPath}/messages`, { commandId: 'enqueue-two', content: 'later' })).status, 202)
  const turnId = 'turn-one' as TurnId
  await app.store.transaction(async tx => tx.cache.applyEvents(sessionId, [
    { sessionId, seq: 1 as EventSeq, occurredAt: at, payload: { kind: 'message.queued', commandId: 'enqueue' as CommandId, messageId: 'message-not-command' as never, content: 'hello', position: 0, sentByAccountId: contributor.id } },
    { sessionId, seq: 2 as EventSeq, occurredAt: at, payload: { kind: 'turn.started', turnId, messageId: 'message-not-command' as never } },
  ]))
  const path = operation === 'cancel' ? `${sessionPath}/messages/enqueue/cancel` : `${sessionPath}/turn/stop`
  const body = operation === 'cancel' ? { commandId: 'control' } : { commandId: 'control', turnId }
  const admitted = await call(path, body)
  assert.equal(admitted.status, 202, JSON.stringify(admitted.data))
  assert.deepEqual(admitted.data, { commandId: 'control' }, 'admission is not cancelled/stopped or no-op outcome')
  // Consume the committed response, then simulate its loss to the caller by retrying original.
  const replay = await call(path, body)
  assert.equal(replay.status, 202); assert.deepEqual(replay.data, admitted.data)
  if (operation === 'stop') {
    await app.store.transaction(async tx => tx.cache.applyEvents(sessionId, [
      { sessionId, seq: 3 as EventSeq, occurredAt: at, payload: { kind: 'turn.finished', turnId, outcome: 'completed', failure: null } },
      { sessionId, seq: 4 as EventSeq, occurredAt: at, payload: { kind: 'turn.started', turnId: 'turn-two' as TurnId, messageId: 'enqueue-two' as never } },
    ]))
    // Manager can control others; the original explicit target remains turn-one.
    await app.store.transaction(tx => tx.identity.saveProjectGrant({ projectId, userId: contributor.id, role: 'manager' }))
    assert.equal((await call(path, body)).status, 202)
    assert.equal((await call(path, { commandId: 'control', turnId: 'turn-two' })).status, 409)
  } else {
    assert.equal((await call(`${sessionPath}/messages/enqueue-two/cancel`, body)).status, 409)
    assert.equal((await call(`${sessionPath}/messages/message-not-command/cancel`, { commandId: 'wrong-target' })).status, 404)
  }
  const stored = await app.store.commands.getPendingCommand('control' as CommandId)
  assert.deepEqual(stored?.command, operation === 'cancel'
    ? { kind: 'session.cancel-queued', sessionId, submissionCommandId: 'enqueue' }
    : { kind: 'turn.stop', sessionId, turnId })
  assert.equal((await app.service.listCommands({})).filter(c => c.commandId === 'control').length, 1)
  assert.equal((await app.store.commands.get('enqueue' as CommandId))?.status, 'pending', 'admission does not cancel enqueue or clear following work')
  assert.equal((await app.store.commands.get('enqueue-two' as CommandId))?.status, 'pending')
  // Even exact replay requires current authorization; a durable receipt is not permission.
  await app.store.transaction(tx => tx.identity.saveProjectGrant({ projectId, userId: contributor.id, role: 'viewer' }))
  assert.equal((await call(path, body)).status, 403)
  assert.equal((await call(path, { ...body, commandId: 'denied-new' })).status, 403)
  assert.equal(await app.store.commands.get('denied-new' as CommandId), null)
  assert.equal((await app.service.listCommands({})).filter(c => c.commandId === 'control').length, 1)
})
