import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWemuxServer } from '../server.js'
import { administratorEmail, seedLocalAccount } from './fixtures/administrator.js'

const password = 'correct horse battery staple'
const cookieName = 'wemux_login_session'

function browser(base: string) {
  let cookie = ''
  let csrf = ''
  const call = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const headers: Record<string, string> = { Accept: 'application/json', Origin: base }
    if (cookie) headers.Cookie = cookie
    if (csrf) headers['X-CSRF-Token'] = csrf
    const response = await fetch(`${base}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
    const setCookie = response.headers.getSetCookie().find(value => value.startsWith(`${cookieName}=`))
    if (setCookie) cookie = setCookie.split(';')[0]!
    const data = response.status === 204 ? null : await response.json() as Record<string, unknown>
    if (data && typeof data.csrfToken === 'string') csrf = data.csrfToken
    return { status: response.status, data }
  }
  return { call }
}

test('已登录用户创建 Team 后只有自己成为 owner', async t => {
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [administratorEmail] })
  const creator = await seedLocalAccount(app.store, { username: 'creator', email: 'creator@example.com', password })
  await seedLocalAccount(app.store, { username: 'other', email: 'other@example.com', password })
  const base = await app.listen(0)
  t.after(() => app.close())

  const client = browser(base)
  const login = await client.call('/auth/login', { method: 'POST', body: { login: 'creator', password } })
  assert.equal(login.status, 200, JSON.stringify(login.data))

  const created = await client.call('/teams', { method: 'POST', body: { name: 'Agent Network' } })
  assert.equal(created.status, 201, JSON.stringify(created.data))
  const team = created.data as unknown as { id: string; name: string; role: string; memberCount: number }
  assert.equal(team.name, 'Agent Network')
  assert.equal(team.role, 'owner')
  assert.equal(team.memberCount, 1)

  const listed = await client.call('/teams')
  assert.equal(listed.status, 200, JSON.stringify(listed.data))
  assert.deepEqual((listed.data as unknown as { items: unknown[] }).items, [team])

  const memberships = await app.store.identity.listMemberships(creator.id)
  assert.deepEqual(memberships.map(value => ({ teamId: value.teamId, userId: value.userId, role: value.role })), [
    { teamId: team.id, userId: creator.id, role: 'owner' },
  ])
  assert.equal((await app.store.identity.listMemberships((await app.store.identity.getUserByLogin('other'))!.id)).length, 0)
})

test('owner 邀请指定邮箱，目标账号接受后原子成为 member', async t => {
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [administratorEmail] })
  await seedLocalAccount(app.store, { username: 'owner', email: 'owner@example.com', password })
  const invitedUser = await seedLocalAccount(app.store, { username: 'invited', email: 'Invited@Example.com', password })
  await seedLocalAccount(app.store, { username: 'wrong', email: 'wrong@example.com', password })
  const base = await app.listen(0)
  t.after(() => app.close())

  const owner = browser(base)
  assert.equal((await owner.call('/auth/login', { method: 'POST', body: { login: 'owner', password } })).status, 200)
  const created = await owner.call('/teams', { method: 'POST', body: { name: 'Agent Network' } })
  const teamId = (created.data as unknown as { id: string }).id

  const invitation = await owner.call(`/teams/${teamId}/invitations`, { method: 'POST', body: { email: ' invited@example.com ' } })
  assert.equal(invitation.status, 201, JSON.stringify(invitation.data))
  const issued = invitation.data as unknown as { id: string; token: string; email: string; role: string }
  assert.equal(issued.email, 'invited@example.com')
  assert.equal(issued.role, 'member')
  assert.match(issued.token, /^[A-Za-z0-9_-]{32,}$/)

  const invitations = await owner.call(`/teams/${teamId}/invitations`)
  assert.equal(invitations.status, 200, JSON.stringify(invitations.data))
  assert.deepEqual((invitations.data as unknown as { items: unknown[] }).items, [{
    id: issued.id,
    teamId,
    email: 'invited@example.com',
    role: 'member',
    status: 'pending',
    invitedBy: (await app.store.identity.getUserByLogin('owner'))!.id,
    createdAt: (invitations.data as any).items[0].createdAt,
    expiresAt: (invitations.data as any).items[0].expiresAt,
  }])
  assert.equal(JSON.stringify(invitations.data).includes(issued.token), false)

  const preview = await fetch(`${base}/api/team-invitations/${issued.token}`).then(async response => ({ status: response.status, data: await response.json() }))
  assert.equal(preview.status, 200, JSON.stringify(preview.data))
  assert.deepEqual(preview.data, { team: { id: teamId, name: 'Agent Network' }, email: 'invited@example.com', role: 'member', status: 'pending' })

  const wrong = browser(base)
  assert.equal((await wrong.call('/auth/login', { method: 'POST', body: { login: 'wrong', password } })).status, 200)
  const rejected = await wrong.call(`/team-invitations/${issued.token}/accept`, { method: 'POST' })
  assert.equal(rejected.status, 403)
  assert.equal((rejected.data as any).error.code, 'invitation_email_mismatch')

  const invited = browser(base)
  assert.equal((await invited.call('/auth/login', { method: 'POST', body: { login: 'invited', password } })).status, 200)
  const accepted = await invited.call(`/team-invitations/${issued.token}/accept`, { method: 'POST' })
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data))
  assert.deepEqual(accepted.data, { teamId, role: 'member' })

  const memberships = await app.store.identity.listMemberships(invitedUser.id)
  assert.deepEqual(memberships.map(value => ({ teamId: value.teamId, role: value.role })), [{ teamId, role: 'member' }])
  const members = await owner.call(`/teams/${teamId}/members`)
  assert.equal(members.status, 200, JSON.stringify(members.data))
  assert.equal((members.data as unknown as { items: unknown[] }).items.length, 2)

  const replay = await invited.call(`/team-invitations/${issued.token}/accept`, { method: 'POST' })
  assert.equal(replay.status, 409)
  assert.equal((replay.data as any).error.code, 'invitation_consumed')
})

test('邀请只有 owner/admin 可管理，且撤销后不能接受', async t => {
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [administratorEmail] })
  const ownerUser = await seedLocalAccount(app.store, { username: 'owner', email: 'owner@example.com', password })
  const memberUser = await seedLocalAccount(app.store, { username: 'member', email: 'member@example.com', password })
  await seedLocalAccount(app.store, { username: 'target', email: 'target@example.com', password })
  const base = await app.listen(0)
  t.after(() => app.close())

  const owner = browser(base)
  assert.equal((await owner.call('/auth/login', { method: 'POST', body: { login: 'owner', password } })).status, 200)
  const teamId = ((await owner.call('/teams', { method: 'POST', body: { name: 'Agent Network' } })).data as any).id as string
  await app.store.transaction(tx => tx.identity.saveMembership({ teamId: teamId as any, userId: memberUser.id, role: 'member', joinedAt: new Date().toISOString() as any }))

  const member = browser(base)
  assert.equal((await member.call('/auth/login', { method: 'POST', body: { login: 'member', password } })).status, 200)
  const denied = await member.call(`/teams/${teamId}/invitations`, { method: 'POST', body: { email: 'target@example.com' } })
  assert.equal(denied.status, 403)
  assert.equal((denied.data as any).error.code, 'team_admin_required')

  const issued = await owner.call(`/teams/${teamId}/invitations`, { method: 'POST', body: { email: 'target@example.com' } })
  assert.equal(issued.status, 201, JSON.stringify(issued.data))
  const { id, token } = issued.data as any
  const revoked = await owner.call(`/teams/${teamId}/invitations/${id}`, { method: 'DELETE' })
  assert.equal(revoked.status, 200, JSON.stringify(revoked.data))
  assert.equal((revoked.data as any).status, 'revoked')

  const target = browser(base)
  assert.equal((await target.call('/auth/login', { method: 'POST', body: { login: 'target', password } })).status, 200)
  const acceptance = await target.call(`/team-invitations/${token}/accept`, { method: 'POST' })
  assert.equal(acceptance.status, 409)
  assert.equal((acceptance.data as any).error.code, 'invitation_revoked')
  assert.equal((await app.store.identity.listMemberships((await app.store.identity.getUserByLogin('target'))!.id)).length, 0)

  const audit = await app.store.identity.listAudit(20)
  assert.equal(audit.some(entry => entry.actorId === ownerUser.id && entry.action === 'team.invitation.revoke'), true)
})

test('受邀邮箱没有账号时可从邀请注册并原子加入团队', async t => {
  const outbox = await mkdtemp(join(tmpdir(), 'wemux-team-invitation-'))
  t.after(() => rm(outbox, { recursive: true, force: true }))
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [administratorEmail], mail: { WEMUX_MAIL_OUTBOX: outbox, WEMUX_PUBLIC_URL: 'https://wemux.example.com', WEMUX_SMTP_FROM: 'Wemux <wemux@example.com>' } })
  await seedLocalAccount(app.store, { username: 'owner', email: 'owner@example.com', password })
  const base = await app.listen(0)
  t.after(() => app.close())

  const owner = browser(base)
  assert.equal((await owner.call('/auth/login', { method: 'POST', body: { login: 'owner', password } })).status, 200)
  const teamId = ((await owner.call('/teams', { method: 'POST', body: { name: 'Agent Network' } })).data as any).id as string
  const invitation = await owner.call(`/teams/${teamId}/invitations`, { method: 'POST', body: { email: 'New.User@example.com' } })
  assert.equal(invitation.status, 201, JSON.stringify(invitation.data))
  const token = (invitation.data as any).token as string

  const newcomer = browser(base)
  const registered = await newcomer.call('/auth/register', {
    method: 'POST',
    body: { username: 'new-user', email: 'new.user@example.com', password, displayName: 'New User', invitationToken: token },
  })
  assert.equal(registered.status, 202, JSON.stringify(registered.data))
  const names = (await readdir(outbox)).filter(name => name.endsWith('.eml'))
  const entries = await Promise.all(names.map(async name => ({ name, written: (await stat(join(outbox, name))).mtimeMs })))
  entries.sort((left, right) => right.written - left.written || right.name.localeCompare(left.name))
  const rawMail = await readFile(join(outbox, entries[0]!.name), 'utf8')
  const textMail = Buffer.from(rawMail.slice(rawMail.indexOf('\r\n\r\n') + 4).replace(/\r\n/g, ''), 'base64').toString('utf8')
  const verificationToken = /verify-email\?token=([A-Za-z0-9_-]+)/.exec(textMail)?.[1]
  assert.ok(verificationToken)
  const verified = await newcomer.call('/auth/email/verify', { method: 'POST', body: { token: verificationToken } })
  assert.equal(verified.status, 200, JSON.stringify(verified.data))
  await newcomer.call('/auth/login', { method: 'POST', body: { login: 'newcomer@example.com', password } })
  const me = await newcomer.call('/auth/me')
  assert.equal(me.status, 200)
  assert.equal((me.data as any).user.email, 'new.user@example.com')
  const teams = await newcomer.call('/teams')
  assert.equal(teams.status, 200)
  assert.deepEqual((teams.data as any).items.map((value: any) => ({ id: value.id, role: value.role })), [{ id: teamId, role: 'member' }])

  const replay = await browser(base).call('/auth/register', {
    method: 'POST',
    body: { username: 'another', email: 'new.user@example.com', password, invitationToken: token },
  })
  assert.equal(replay.status, 409)
  assert.equal((replay.data as any).error.code, 'invitation_consumed')
})

test('邀请与注册记录持久化后，重启仍可完成邮箱验证并加入团队', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wemux-team-restart-'))
  const outbox = join(root, 'outbox')
  const databasePath = join(root, 'server.sqlite')
  t.after(() => rm(root, { recursive: true, force: true }))
  const options = { databasePath, administratorEmails: [administratorEmail], mail: { WEMUX_MAIL_OUTBOX: outbox, WEMUX_PUBLIC_URL: 'https://wemux.example.com', WEMUX_SMTP_FROM: 'Wemux <wemux@example.com>' } }

  const first = createWemuxServer(options)
  const ownerUser = await seedLocalAccount(first.store, { username: 'owner', email: 'owner@example.com', password })
  const firstBase = await first.listen(0)
  const owner = browser(firstBase)
  await owner.call('/auth/login', { method: 'POST', body: { login: 'owner', password } })
  const teamId = ((await owner.call('/teams', { method: 'POST', body: { name: 'Durable Team' } })).data as any).id as string
  const invitation = await owner.call(`/teams/${teamId}/invitations`, { method: 'POST', body: { email: 'restart@example.com' } })
  const token = (invitation.data as any).token as string
  const anonymous = browser(firstBase)
  const registered = await anonymous.call('/auth/register', { method: 'POST', body: { displayName: 'Restart User', email: 'restart@example.com', password, invitationToken: token } })
  assert.equal(registered.status, 202, JSON.stringify(registered.data))
  await first.close()

  const second = createWemuxServer(options)
  const secondBase = await second.listen(0)
  t.after(() => second.close())
  const names = (await readdir(outbox)).filter(name => name.endsWith('.eml'))
  const entries = await Promise.all(names.map(async name => ({ name, written: (await stat(join(outbox, name))).mtimeMs })))
  entries.sort((left, right) => right.written - left.written || right.name.localeCompare(left.name))
  const rawMail = await readFile(join(outbox, entries[0]!.name), 'utf8')
  const textMail = Buffer.from(rawMail.slice(rawMail.indexOf('\r\n\r\n') + 4).replace(/\r\n/g, ''), 'base64').toString('utf8')
  const verificationToken = /verify-email\?token=([A-Za-z0-9_-]+)/.exec(textMail)?.[1]
  assert.ok(verificationToken)
  const newcomer = browser(secondBase)
  const verified = await newcomer.call('/auth/email/verify', { method: 'POST', body: { token: verificationToken } })
  assert.equal(verified.status, 200, JSON.stringify(verified.data))
  assert.equal((await second.store.identity.listMemberships((await second.store.identity.getUserByLogin('restart@example.com'))!.id)).some(value => value.teamId === teamId), true)
  assert.equal((await second.store.identity.listMemberships(ownerUser.id)).some(value => value.teamId === teamId), true)
})
