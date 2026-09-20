import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createWemuxServer } from '../server.js'
import { seedLocalAccount } from './fixtures/administrator.js'

const password = 'correct horse battery staple'
const admin = 'admin@example.com'

function browser(base: string) {
  let cookie = '', csrf = ''
  return { async call(path: string, input: { method?: string; body?: unknown } = {}) { const response = await fetch(`${base}/api${path}`, { method: input.method ?? 'GET', headers: { Origin: base, ...(input.body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}) }, body: input.body === undefined ? undefined : JSON.stringify(input.body) }); cookie = response.headers.get('set-cookie')?.split(';')[0] ?? cookie; const data = await response.json() as any; if (data?.csrfToken) csrf = data.csrfToken; return { status: response.status, data } } }
}

async function setup(t: TestContext) {
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [admin] })
  await seedLocalAccount(app.store, { username: 'owner', email: 'owner@example.com', password })
  await seedLocalAccount(app.store, { username: 'target', email: 'target@example.com', password })
  const base = await app.listen(0); t.after(() => app.close())
  const owner = browser(base); await owner.call('/auth/login', { method: 'POST', body: { login: 'owner', password } })
  const team = await owner.call('/teams', { method: 'POST', body: { name: 'Agent Network' } })
  return { app, owner, base, teamId: team.data.id as string }
}

test('过期邀请不能接受', async t => {
  const { app, owner, base, teamId } = await setup(t)
  const issued = await owner.call(`/teams/${teamId}/invitations`, { method: 'POST', body: { email: 'target@example.com' } })
  const invitation = await app.store.identity.findTeamInvitationByTokenHash((await import('../application/auth.js')).hashSecret(issued.data.token))
  assert.ok(invitation)
  const rawStore = app.store as unknown as { db: import('node:sqlite').DatabaseSync }
  rawStore.db.prepare("UPDATE records SET data=json_set(data,'$.expiresAt',?) WHERE kind='team-invitation' AND id=?").run('2000-01-01T00:00:00.000Z', invitation.id)
  const target = browser(base); await target.call('/auth/login', { method: 'POST', body: { login: 'target', password } })
  const accepted = await target.call(`/team-invitations/${issued.data.token}/accept`, { method: 'POST' })
  assert.equal(accepted.status, 410)
  assert.equal(accepted.data.error.code, 'invitation_expired')
})

test('重复邀请邮箱冲突且并发接受只有一个成功', async t => {
  const { owner, base, teamId } = await setup(t)
  const issued = await owner.call(`/teams/${teamId}/invitations`, { method: 'POST', body: { email: 'target@example.com' } })
  const duplicate = await owner.call(`/teams/${teamId}/invitations`, { method: 'POST', body: { email: 'TARGET@example.com' } })
  assert.equal(duplicate.status, 409)
  assert.equal(duplicate.data.error.code, 'invitation_pending')
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', Origin: base }, body: JSON.stringify({ login: 'target', password }) })
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!
  const csrf = ((await login.json()) as { csrfToken: string }).csrfToken
  const results = await Promise.all([1, 2].map(() => fetch(`${base}/api/team-invitations/${issued.data.token}/accept`, { method: 'POST', headers: { cookie, Origin: base, 'x-csrf-token': csrf } })))
  const statuses = results.map(result => result.status).sort()
  assert.equal(statuses[0], 200)
  assert.equal(statuses[1], 409)
})

test('失去管理权限的邀请者不能让旧邀请继续生效', async t => {
  const { app, owner, base, teamId } = await setup(t)
  const issued = await owner.call(`/teams/${teamId}/invitations`, { method: 'POST', body: { email: 'target@example.com' } })
  const ownerUser = await app.store.identity.getUserByLogin('owner'); assert.ok(ownerUser)
  const adminUser = await seedLocalAccount(app.store, { username: 'replacement', email: 'replacement@example.com', password })
  await app.store.transaction(async tx => {
    await tx.identity.saveMembership({ teamId: teamId as any, userId: ownerUser.id, role: 'member', joinedAt: new Date().toISOString() as any })
    await tx.identity.saveMembership({ teamId: teamId as any, userId: adminUser.id, role: 'owner', joinedAt: new Date().toISOString() as any })
  })
  const target = browser(base); await target.call('/auth/login', { method: 'POST', body: { login: 'target', password } })
  const accepted = await target.call(`/team-invitations/${issued.data.token}/accept`, { method: 'POST' })
  assert.equal(accepted.status, 409)
  assert.equal(accepted.data.error.code, 'inviter_no_longer_authorized')
})
