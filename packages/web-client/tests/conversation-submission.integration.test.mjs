// Real owned ephemeral Server + public client; synthetic Worker only, no Runtime/browser claims.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tsImport } from 'tsx/esm/api'
import { createClusterClient, createConversationSubmission, toAccountSession } from '@wemux/web-client'

const { createWemuxServer } = await tsImport('../../../apps/server/src/server.ts', import.meta.url)
const { administratorEmail, seedAdministrator, administratorToken, seedLocalAccount } = await tsImport('../../../apps/server/src/test/fixtures/administrator.ts', import.meta.url)

test('ordinary-user public client replays lost POST response after reload as one authoritative command, without admin receipts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wemux-submission-http-'))
  const app = createWemuxServer({ databasePath: join(root, 'server.sqlite'), administratorEmails: [administratorEmail], mail: {}, google: {} })
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }) })
  const origin = await app.listen(0)
  await seedAdministrator(app.store)
  const admin = async (path, body) => {
    const response = await fetch(`${origin}/api${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${administratorToken}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const data = await response.json(); assert.ok(response.ok, JSON.stringify(data)); return data
  }
  await admin('/bootstrap', {})
  const project = await admin('/projects', { teamId: 'default-team', name: 'Submission fixture' })
  const task = await admin(`/projects/${project.id}/tasks`, { title: 'Message replay' })
  const user = await seedLocalAccount(app.store, { userId: 'submission-member', username: 'submission-member', email: 'submission-member@example.test', password: 'owned-test-password-123' })
  const at = new Date().toISOString(), workerId = 'submission-worker', workspaceId = 'submission-workspace'
  await app.store.transaction(async tx => {
    await tx.identity.saveMembership({ teamId: project.teamId, userId: user.id, role: 'member', joinedAt: at })
    await tx.identity.saveProjectGrant({ projectId: project.id, userId: user.id, role: 'contributor' })
    await tx.resources.saveWorker({ id: workerId, teamId: project.teamId, ownerId: project.ownerId, name: 'Synthetic Worker', shareScope: 'team', connectionState: 'online', version: '1', platform: 'linux', lastSeenAt: at, capabilities: [{ agentKey: 'test', displayName: 'Test', version: '1', mode: 'execution', availability: { status: 'available' }, models: [{ modelId: 'model', displayName: 'Model', source: 'configured' }] }] })
    await tx.resources.saveWorkspace({ id: workspaceId, projectId: project.id, name: 'Synthetic Workspace', spec: { kind: 'composite', memberWorkspaceIds: [] }, placements: [{ workerId, status: 'ready', failureReason: null, location: null }], deletedAt: null })
  })
  let cookie = '', loseResponse = true
  const calls = [], bodies = []
  const fetcher = async (url, init) => {
    calls.push(url.pathname)
    const response = await fetch(url, { ...init, headers: { ...init.headers, ...(cookie ? { Cookie: cookie } : {}) } })
    const setCookie = response.headers.get('set-cookie')
    if (setCookie) cookie = setCookie.split(';')[0]
    if (url.pathname.endsWith('/messages')) {
      bodies.push(init.body)
      assert.equal(response.status, 202)
      if (loseResponse) { loseResponse = false; await response.arrayBuffer(); throw Error('owned loss after HTTP admission') }
    }
    return response
  }
  const login = createClusterClient(undefined, undefined, { origin, fetcher })
  const account = await login.login(user.username, 'owned-test-password-123')
  login.dispose()
  assert.equal(account.instanceAdministrator, false)
  const client = createClusterClient({ ...toAccountSession(account), teamId: project.teamId }, () => assert.fail('unexpected identity invalidation'), { origin, fetcher })
  t.after(() => client.dispose())
  const creation = await client.createTaskSession(project.id, task.id, { requestId: 'owned-create-not-message-id', title: 'Conversation', workspaceId, workerId, agentKey: 'test', modelId: 'model' })
  const scope = { host: origin, accountId: user.id, teamId: project.teamId, projectId: project.id, taskId: task.id, sessionId: creation.session.id }
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) } }
  const make = () => createConversationSubmission(scope, { storage: () => storage, send: client.sendMessage })
  const before = await app.store.commands.list({ limit: 1000 })
  const first = make(); first.load(); first.edit('  exact original\n你好  '); await first.submit()
  assert.equal(first.getSnapshot().status, 'uncertain')
  const body = first.getSnapshot().intent.body
  assert.notEqual(body.commandId, 'owned-create-not-message-id')
  first.dispose()
  assert.equal((await app.store.commands.list({ limit: 1000 })).length, before.length + 1)
  const reloaded = make(); reloaded.load()
  assert.equal(bodies.length, 1); assert.equal(reloaded.getSnapshot().status, 'uncertain')
  reloaded.edit('new draft while original uncertain')
  await reloaded.retry()
  assert.equal(reloaded.getSnapshot().status, 'admitted'); assert.equal(reloaded.getSnapshot().admission.status, 'pending')
  assert.equal(reloaded.getSnapshot().draft, 'new draft while original uncertain')
  assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1]); assert.deepEqual(JSON.parse(bodies[1]), body)
  const after = await app.store.commands.list({ limit: 1000 })
  assert.equal(after.length, before.length + 1)
  assert.equal(after.filter(command => command.commandId === body.commandId).length, 1)
  const stored = await app.store.commands.getPendingCommand(body.commandId)
  assert.equal(stored.command.kind, 'session.enqueue'); assert.equal(stored.command.sessionId, scope.sessionId)
  assert.deepEqual(stored.command.message, { messageId: body.messageId, content: body.content, sentByAccountId: user.id })
  assert.equal((await client.getSession(scope.sessionId)).runtimeState, 'idle')
  assert.equal(calls.filter(path => path.startsWith('/api/commands/')).length, 0)
  // Access remains admin-only; the production submission controller never calls it.
  await assert.rejects(client.commandReceipt(body.commandId), error => error.status === 403)
  reloaded.dispose()
})
