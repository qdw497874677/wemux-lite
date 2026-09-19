/**
 * Ticket 06（密码与邮箱恢复管理）与 Ticket 08（登录方式绑定与解绑）的验收：
 * 全程走真实路由、真实存储、真实邮件出件箱与真实 Google 替身 Provider（`fixtures/google-provider.ts`）。
 * 这些都是凭据边界，所以断言尽量落在落库结果、会话可用性与审计上，而不是只看响应体。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { CredentialId, Timestamp, UserId } from '@wemux/domain'
import { createWemuxServer } from '../server.js'
import { SqliteServerStore } from '../storage/sqlite/store.js'
import type { MailEnv } from '../application/mail/email-delivery.js'
import { hashSecret } from '../application/auth.js'
import { verifyPassword } from '../application/password.js'
import { googleIssuer } from '../application/google-oidc.js'
import { administratorEmail, seedLocalAccount } from './fixtures/administrator.js'
import { browser, fakeGoogle, googleProviderSettings, handoff } from './fixtures/google-provider.js'

const password = 'correct horse battery staple'
const newPassword = 'a-very-different-passphrase'
const sessionCookie = 'wemux_login_session'
const stateCookie = 'wemux_oauth_state'
const api = '/api'

const errorCode = (data: unknown): string | undefined => (data as { error?: { code?: string } } | null)?.error?.code

async function outboxMessages(dir: string): Promise<string[]> {
  const names = (await readdir(dir)).filter(name => name.endsWith('.eml'))
  const entries = await Promise.all(names.map(async name => ({ name, written: (await stat(join(dir, name))).mtimeMs })))
  entries.sort((a, b) => a.written - b.written || a.name.localeCompare(b.name))
  return Promise.all(entries.map(async entry => {
    const raw = await readFile(join(dir, entry.name), 'utf8')
    return Buffer.from(raw.slice(raw.indexOf('\r\n\r\n') + 4).replace(/\r\n/g, ''), 'base64').toString('utf8')
  }))
}

/** 出件箱里会累积历史邮件（旧链接已作废），所以从最新一封往前找。 */
async function linkToken(dir: string, pattern: RegExp): Promise<string> {
  for (const text of [...await outboxMessages(dir)].reverse()) {
    const match = pattern.exec(text)
    if (match) return match[1]!
  }
  throw new Error(`no link matching ${pattern} in outbox`)
}

const resetLink = /\/auth\/password\/reset\?token=([A-Za-z0-9_-]+)/
const confirmEmailLink = /\/auth\/confirm-email-change\?token=([A-Za-z0-9_-]+)/

async function fixture(t: { after: (fn: () => Promise<void> | void) => void }, options: { administratorEmails?: readonly string[]; mail?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'wemux-account-security-'))
  const outbox = join(directory, 'outbox')
  await mkdir(outbox, { recursive: true })
  const provider = await fakeGoogle()
  const mail: MailEnv = options.mail === false ? {} : {
    WEMUX_MAIL_OUTBOX: outbox,
    WEMUX_PUBLIC_URL: 'https://wemux.example.com',
    WEMUX_SMTP_FROM: 'Wemux <wemux@example.com>',
  }
  const databasePath = join(directory, 'server.sqlite')
  const app = createWemuxServer({
    databasePath, administratorEmails: options.administratorEmails ?? [administratorEmail], mail,
    ...googleProviderSettings(provider, 'https://wemux.example.com'),
  })
  const base = await app.listen(0, '127.0.0.1')
  // 只读的第二连接：绑定、撤销这类结论都以落库结果为准，而不是只信 HTTP 表面。
  const store = new SqliteServerStore(databasePath)
  t.after(async () => {
    store.close()
    await app.close()
    await provider.close()
    await rm(directory, { recursive: true, force: true })
  })
  return { app, store, base, outbox, provider }
}

type Fixture = Awaited<ReturnType<typeof fixture>>
type Client = ReturnType<typeof browser>

async function signInLocal(f: Fixture, username: string, secret = password): Promise<Client> {
  const client = browser(f.base)
  const response = await client.post(`${api}/auth/login`, { login: username, password: secret })
  assert.equal(response.status, 200, JSON.stringify(response.data))
  return client
}

/** 走完一次真实 Google 登录：start 拿授权地址，替身 Provider 校验 PKCE，再把 code 送回回调。 */
async function signInGoogle(f: Fixture, client = browser(f.base)) {
  const started = await client.post(`${api}/auth/oauth/google/start`, {})
  assert.equal(started.status, 202, JSON.stringify(started.data))
  const authorization = handoff(f.provider, (started.data as { authorizeUrl: string }).authorizeUrl)
  const callback = await client.get(`${api}/auth/oauth/google/callback?code=authorization-code&state=${authorization.state}`)
  return { client, started, authorization, callback }
}

/** 直接落库的 PAT：生产里由 CLI/接口签发，这里只关心撤销语义。 */
async function seedTokens(store: SqliteServerStore, userId: UserId, count: number): Promise<void> {
  await store.transaction(async tx => {
    for (let index = 0; index < count; index++) {
      await tx.identity.savePersonalAccessToken({
        id: randomUUID() as CredentialId, userId, tokenHash: hashSecret(`pat-${userId}-${index}`),
        expiresAt: '2099-01-01T00:00:00.000Z' as Timestamp, revokedAt: null,
      })
    }
  })
}

const liveSessions = async (f: Fixture, userId: UserId) => (await f.store.identity.listLoginSessions(userId)).filter(session => session.revokedAt === null)
const liveTokens = async (f: Fixture, userId: UserId) => (await f.store.identity.listPersonalAccessTokens()).filter(record => record.userId === userId && record.revokedAt === null)

test('忘记密码：未知邮箱同形响应，重置撤销全部会话与 PAT，链接只能消费一次', async t => {
  const f = await fixture(t)
  const ada = await seedLocalAccount(f.app.store, { username: 'ada', email: 'ada@example.com', password })
  const phone = await signInLocal(f, 'ada')
  const laptop = await signInLocal(f, 'ada')
  await seedTokens(f.store, ada.id, 2)
  assert.equal((await liveSessions(f, ada.id)).length, 2)

  const guest = browser(f.base)
  const known = await guest.post(`${api}/auth/password/forgot`, { email: 'ADA@example.com' })
  const unknown = await guest.post(`${api}/auth/password/forgot`, { email: 'nobody@example.com' })
  assert.equal(known.status, 202)
  assert.equal(unknown.status, 202)
  // 响应形状必须完全一致，只有脱敏地址不同；否则这就是一个账号枚举接口。
  assert.deepEqual(Object.keys(known.data as object).sort(), Object.keys(unknown.data as object).sort())
  assert.equal((known.data as { status: string }).status, 'accepted')
  assert.equal((known.data as { email: string }).email, 'a***@example.com')
  assert.equal((unknown.data as { email: string }).email, 'n***@example.com')

  const token = await linkToken(f.outbox, resetLink)
  const reset = await guest.post(`${api}/auth/password/reset`, { token, password: newPassword })
  assert.equal(reset.status, 200, JSON.stringify(reset.data))
  // 一次性：重放同一个链接拿不到第二次重置（旧链接已作废，不能改回第三个密码）。
  const replay = await guest.post(`${api}/auth/password/reset`, { token, password: 'yet-another-passphrase' })
  assert.equal(replay.status, 409)
  assert.equal(errorCode(replay.data), 'token_consumed')
  assert.equal((await browser(f.base).post(`${api}/auth/login`, { login: 'ada', password: 'yet-another-passphrase' })).status, 401)
  // 撤消是真实生效的：不只是库里的标记，旧设备确实不能再用了。
  assert.equal((await liveSessions(f, ada.id)).length, 0)
  assert.equal((await liveTokens(f, ada.id)).length, 0)
  assert.equal((await phone.get(`${api}/auth/me`)).status, 401)
  assert.equal((await laptop.get(`${api}/auth/me`)).status, 401)
  assert.equal((await browser(f.base).post(`${api}/auth/login`, { login: 'ada', password: newPassword })).status, 200)
  assert.equal((await browser(f.base).post(`${api}/auth/login`, { login: 'ada', password })).status, 401, '旧密码必须立即失效')
  const audit = (await f.store.identity.listAudit(50))
  const recorded = audit.find(entry => entry.action === 'credentials.reset')
  assert.ok(recorded, `审计缺少重置记录：${audit.map(entry => entry.action).join(',')}`)
  assert.equal(recorded.metadata.revokedSessions, 2, '审计必须记下被撤销的会话数')
  assert.ok(audit.some(entry => entry.action === 'credentials.reset_requested'))
})

test('改密码：需要当前密码并按当前参数重写哈希，其他会话与 PAT 撤销、当前会话保留', async t => {
  const f = await fixture(t)
  const ada = await seedLocalAccount(f.app.store, { username: 'ada', email: 'ada@example.com', password })
  const current = await signInLocal(f, 'ada')
  const other = await signInLocal(f, 'ada')
  await seedTokens(f.store, ada.id, 1)

  const missing = await current.post(`${api}/auth/password/change`, { newPassword })
  assert.equal(missing.status, 400)
  assert.equal(errorCode(missing.data), 'current_password_required')
  const wrong = await current.post(`${api}/auth/password/change`, { currentPassword: 'not-the-password', newPassword })
  // 400 而非 401：会话是好的，错的是请求体；401 会让 Web 端把用户登出（Ticket 06 的实现约束）。
  assert.equal(wrong.status, 400)
  assert.equal(errorCode(wrong.data), 'current_password_invalid')
  // 缺 CSRF 的凭据写操作必须被拒：Cookie 会话不能裸奔。
  const bare = await current.call(`${api}/auth/password/change`, { method: 'POST', csrf: null, body: { currentPassword: password, newPassword } })
  assert.equal(bare.status, 403)

  const changed = await current.post(`${api}/auth/password/change`, { currentPassword: password, newPassword })
  assert.equal(changed.status, 200, JSON.stringify(changed.data))
  assert.equal((changed.data as { created: boolean }).created, false)
  const credential = await f.store.identity.getLocalAccountCredential(ada.id)
  assert.equal((await verifyPassword(newPassword, credential!.passwordHash)).ok, true)
  assert.equal((await liveSessions(f, ada.id)).length, 1, '其他设备必须重新登录')
  assert.equal((await other.get(`${api}/auth/me`)).status, 401)
  assert.equal((await current.get(`${api}/auth/me`)).status, 200, '操作者自己不该被踢下线')
  assert.equal((await liveTokens(f, ada.id)).length, 0)
  const audit = (await f.store.identity.listAudit(50)).filter(entry => entry.action === 'credentials.password_changed')
  assert.equal(audit.length, 1)
  assert.equal(audit[0]!.metadata.channel, 'current_password')
})

test('改邮箱：确认前旧邮箱仍是登录标识，确认后旧邮箱交还，链接一次性', async t => {
  const f = await fixture(t)
  const ada = await seedLocalAccount(f.app.store, { username: 'ada', email: 'ada@example.com', password })
  await seedLocalAccount(f.app.store, { username: 'bob', email: 'bob@example.com', password: 'another-correct-horse' })
  const client = await signInLocal(f, 'ada')

  const taken = await client.post(`${api}/auth/email/change`, { newEmail: 'bob@example.com', currentPassword: password })
  assert.equal(taken.status, 409)
  assert.equal(errorCode(taken.data), 'email_taken')
  const unchanged = await client.post(`${api}/auth/email/change`, { newEmail: 'ada@example.com', currentPassword: password })
  assert.equal(unchanged.status, 400)
  assert.equal(errorCode(unchanged.data), 'email_unchanged')

  const requested = await client.post(`${api}/auth/email/change`, { newEmail: 'ada.new@example.com', currentPassword: password })
  assert.equal(requested.status, 200, JSON.stringify(requested.data))
  assert.equal((requested.data as { status: string }).status, 'accepted')
  assert.equal((requested.data as { email: string }).email, 'a***@example.com', '响应只回脱敏地址')
  // 变更未生效：新邮箱既不能登录，也不能被别人占用（还没落库）。
  assert.equal(await f.store.identity.getUserByEmail('ada.new@example.com'), null)
  assert.equal((await browser(f.base).post(`${api}/auth/login`, { login: 'ada.new@example.com', password })).status, 401)
  assert.equal((await browser(f.base).post(`${api}/auth/login`, { login: 'ada@example.com', password })).status, 200)
  const messages = await outboxMessages(f.outbox)
  assert.ok(messages.some(text => text.includes('确认新增 Wemux 账号邮箱')), '目标邮箱必须收到确认链接')
  assert.ok(messages.some(text => text.includes('有人请求把 Wemux 账号邮箱改为另一个地址')), '旧邮箱必须在变更生效前就收到提醒')

  const token = await linkToken(f.outbox, confirmEmailLink)
  const guest = browser(f.base)
  const confirmed = await guest.post(`${api}/auth/email/change/confirm`, { token })
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data))
  assert.equal((confirmed.data as { email: string }).email, 'ada.new@example.com')
  // 邮箱是唯一标识而不是别名：旧地址必须交还，不能两个地址同时指向一个账号。
  assert.equal(await f.store.identity.getUserByEmail('ada@example.com'), null)
  assert.equal((await f.store.identity.getUserEmail(ada.id))!.emailNormalized, 'ada.new@example.com')
  assert.equal((await browser(f.base).post(`${api}/auth/login`, { login: 'ada.new@example.com', password })).status, 200)
  assert.equal((await browser(f.base).post(`${api}/auth/login`, { login: 'ada@example.com', password })).status, 401)
  // 链接一次性：重放拿到的必须是明确的已消费错误。
  const replayed = await guest.post(`${api}/auth/email/change/confirm`, { token })
  assert.equal(replayed.status, 409)
  assert.equal(errorCode(replayed.data), 'token_consumed')
  // 未登录也能确认（链接本身就是凭证），但匿名读账号安全状态必须 401。
  assert.equal((await browser(f.base).get(`${api}/auth/account/security`)).status, 401)
})

test('账号安全视图：只读列出登录方式与投递状态，唯一登录方式不可解绑', async t => {
  const f = await fixture(t)
  await seedLocalAccount(f.app.store, { username: 'ada', email: 'ada@example.com', password })
  const client = await signInLocal(f, 'ada')
  const view = await client.get(`${api}/auth/account/security`)
  assert.equal(view.status, 200, JSON.stringify(view.data))
  const body = view.data as { methods: { kind: string; id: string; removable: boolean }[]; passwordSet: boolean; email: string | null; emailDelivery: boolean; reauthenticated: boolean; emailDeliveryReason: string | null }
  assert.equal(body.passwordSet, true)
  assert.equal(body.emailDelivery, true)
  assert.equal(body.emailDeliveryReason, null)
  assert.equal(body.email, 'ada@example.com')
  assert.deepEqual(body.methods.map(method => method.kind), ['password'])
  assert.equal(body.methods[0]!.removable, false, '唯一登录方式不可解绑')
  // 视图不泄露哈希、subject 或任何凭据材料。
  const serialized = JSON.stringify(body)
  assert.ok(!/passwordHash|subject|token/.test(serialized), `视图泄露了凭据字段：${serialized}`)
  const refused = await client.call(`${api}/auth/identities/password`, { method: 'DELETE', body: { currentPassword: password } })
  assert.equal(refused.status, 409)
  assert.equal(errorCode(refused.data), 'last_login_method')
  assert.equal(await f.store.identity.getLocalAccountCredential((await f.store.identity.getUserByEmail('ada@example.com'))!.id) !== null, true)
  // 未配置邮件投递时如实报告，而不是假装可用。
  const offline = await fixture(t, { mail: false })
  await seedLocalAccount(offline.app.store, { username: 'ada', email: 'ada@example.com', password })
  const fallback = await signInLocal(offline, 'ada')
  const reported = await fallback.get(`${api}/auth/account/security`)
  assert.equal((reported.data as { emailDelivery: boolean }).emailDelivery, false)
  assert.match(String((reported.data as { emailDeliveryReason: string | null }).emailDeliveryReason), /SMTP/)
})

test('绑定 Google：必须来自发起绑定的同一会话，落库后可解绑；两处失败路径分别归因', async t => {
  const f = await fixture(t)
  const ada = await seedLocalAccount(f.app.store, { username: 'ada', email: 'ada@example.com', password })
  await seedLocalAccount(f.app.store, { username: 'bob', email: 'bob@example.com', password: 'another-correct-horse' })
  const client = await signInLocal(f, 'ada')
  const started = await client.post(`${api}/auth/identities/google/start`, {})
  assert.equal(started.status, 200, JSON.stringify(started.data))
  const authorizeUrl = new URL((started.data as { authorizeUrl: string }).authorizeUrl)
  // 绑定用的是同一套授权参数：PKCE、nonce、一次性 state 一个不少。
  assert.equal(authorizeUrl.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(authorizeUrl.searchParams.get('prompt'), 'select_account')
  const authorization = handoff(f.provider, authorizeUrl.toString())

  // 换一个浏览器拿同一个 state 来收尾：没有登录态，绑定不成立。
  const stranger = await browser(f.base).get(`${api}/auth/oauth/google/callback?code=authorization-code&state=${authorization.state}`, { cookie: `${stateCookie}=${authorization.state}` })
  assert.equal(stranger.location, '/?oauth_error=session_required')
  // 同一个浏览器里换成了另一个账号：会话对不上，绑定照样不成立。
  const switched = await client.post(`${api}/auth/login`, { login: 'bob', password: 'another-correct-horse' })
  assert.equal(switched.status, 200)
  const mismatched = await client.get(`${api}/auth/oauth/google/callback?code=authorization-code&state=${authorization.state}`)
  assert.equal(mismatched.location, '/settings?link_error=session_mismatch')
  assert.equal(await f.store.identity.findLoginIdentity('google', googleIssuer, 'google-subject-1'), null, '失败的绑定不得留下身份行')

  // 回到 ada 自己完成绑定：登录态不变，只多一种登录方式。
  const owner = await signInLocal(f, 'ada')
  const retry = await owner.post(`${api}/auth/identities/google/start`, {})
  const retryAuthorization = handoff(f.provider, (retry.data as { authorizeUrl: string }).authorizeUrl.toString())
  const linked = await owner.get(`${api}/auth/oauth/google/callback?code=authorization-code&state=${retryAuthorization.state}`)
  assert.equal(linked.status, 302)
  assert.equal(linked.location, '/settings?linked=google')
  const identity = await f.store.identity.findLoginIdentity('google', googleIssuer, 'google-subject-1')
  assert.equal(identity!.userId, ada.id)
  const me = await owner.get(`${api}/auth/me`)
  assert.equal((me.data as { session: { authenticationMethod: string } }).session.authenticationMethod, 'password', '绑定不该换掉当前登录态')
  const view = await owner.get(`${api}/auth/account/security`)
  const methods = (view.data as { methods: { kind: string; id: string; removable: boolean }[] }).methods
  assert.deepEqual(methods.map(method => method.kind).sort(), ['google', 'password'])
  assert.ok(methods.every(method => method.removable), '两种方式并存时都允许解绑')
  const audit = (await f.store.identity.listAudit(100))
  assert.ok(audit.some(entry => entry.action === 'credentials.login_method_bound' && entry.metadata.provider === 'google'))
  assert.ok(audit.some(entry => entry.action === 'credentials.login_method_bind_rejected' && entry.metadata.reason === 'session_mismatch'))

  // 解绑需要当前密码；解绑后身份行消失，账号回到只有本地密码。
  const withoutPassword = await owner.call(`${api}/auth/identities/${identity!.id}`, { method: 'DELETE' })
  assert.equal(withoutPassword.status, 400)
  assert.equal(errorCode(withoutPassword.data), 'current_password_required')
  const unbound = await owner.call(`${api}/auth/identities/${identity!.id}`, { method: 'DELETE', body: { currentPassword: password } })
  assert.equal(unbound.status, 200, JSON.stringify(unbound.data))
  assert.equal(await f.store.identity.findLoginIdentity('google', googleIssuer, 'google-subject-1'), null)
  assert.equal((await owner.get(`${api}/auth/me`)).status, 200)
})

test('Google-only 账号：强认证窗口内可直接设定本地密码，之后再解绑 Google；他人身份不可抢绑', async t => {
  // 部署声明用大写邮箱：顺带验证「部署者即管理员」的规范化路径。
  const f = await fixture(t, { administratorEmails: ['ADA@example.com'] })
  const signed = await signInGoogle(f)
  assert.equal(signed.callback.location, '/')
  const client = signed.client
  const account = await client.get(`${api}/auth/me`)
  const userId = (account.data as { user: { id: UserId } }).user.id
  assert.equal((account.data as { user: { email: string | null } }).user.email, 'ada@example.com')

  const before = await client.get(`${api}/auth/account/security`)
  assert.equal((before.data as { passwordSet: boolean }).passwordSet, false)
  assert.equal((before.data as { reauthenticated: boolean }).reauthenticated, true, '刚完成 Google 登录就在强认证窗口内')
  const identity = await f.store.identity.findLoginIdentity('google', googleIssuer, 'google-subject-1')
  const refused = await client.call(`${api}/auth/identities/${identity!.id}`, { method: 'DELETE' })
  assert.equal(refused.status, 409, '唯一登录方式不能被解绑')
  assert.equal(errorCode(refused.data), 'last_login_method')

  // 无本地密码 ⇒ 没有旧密码可验，窗口内的强认证就足够设定密码（created=true）。
  const created = await client.post(`${api}/auth/password/change`, { newPassword })
  assert.equal(created.status, 200, JSON.stringify(created.data))
  assert.equal((created.data as { created: boolean }).created, true)
  assert.equal((await f.store.identity.getLocalAccountCredential(userId)) !== null, true)

  // 另一个账号想把同一个 Google 身份绑到自己名下：拒绝，绝不静默抢绑。
  await seedLocalAccount(f.app.store, { username: 'bob', email: 'bob@example.com', password })
  const bob = await signInLocal(f, 'bob')
  const started = await bob.post(`${api}/auth/identities/google/start`, {})
  const authorization = handoff(f.provider, (started.data as { authorizeUrl: string }).authorizeUrl.toString())
  const crossed = await bob.get(`${api}/auth/oauth/google/callback?code=authorization-code&state=${authorization.state}`)
  assert.equal(crossed.location, '/settings?link_error=identity_taken')
  assert.equal((await f.store.identity.findLoginIdentity('google', googleIssuer, 'google-subject-1'))!.userId, userId)
  assert.equal((await bob.get(`${api}/auth/account/security`)).data && (await bob.get(`${api}/auth/account/security`)).status, 200)

  // 已经绑到自己账号时重复绑定是幂等成功，而不是报错。
  const again = await client.post(`${api}/auth/identities/google/start`, {})
  const againAuthorization = handoff(f.provider, (again.data as { authorizeUrl: string }).authorizeUrl.toString())
  const relinked = await client.get(`${api}/auth/oauth/google/callback?code=authorization-code&state=${againAuthorization.state}`)
  assert.equal(relinked.location, '/settings?linked=google&already=1')
  assert.equal((await f.store.identity.listLoginIdentities(userId)).length, 1)

  const unbound = await client.call(`${api}/auth/identities/${identity!.id}`, { method: 'DELETE', body: { currentPassword: newPassword } })
  assert.equal(unbound.status, 200, JSON.stringify(unbound.data))
  assert.deepEqual((unbound.data as { methods: { kind: string }[] }).methods.map(method => method.kind), ['password'])
  // 解绑 Google 之后只能用新设定的密码登录；同一个 Google 身份再登录会被当成新账号，
  // 而邮箱已被既存账号占用，因此按冲突拒绝而不是滑进旧账号。
  assert.equal((await browser(f.base).post(`${api}/auth/login`, { login: 'ada@example.com', password: newPassword })).status, 200)
  assert.equal((await signInGoogle(f)).callback.location, '/?oauth_error=email_conflict')
})

test('邮件与审计都不含明文令牌、密码或完整地址', async t => {
  const f = await fixture(t)
  await seedLocalAccount(f.app.store, { username: 'ada', email: 'ada@example.com', password })
  const client = await signInLocal(f, 'ada')
  await client.post(`${api}/auth/password/forgot`, { email: 'ada@example.com' })
  await client.post(`${api}/auth/email/change`, { newEmail: 'ada.new@example.com', currentPassword: password })
  const token = await linkToken(f.outbox, confirmEmailLink)
  const entries = JSON.stringify(await f.store.identity.listAudit(100))
  assert.ok(!entries.includes(token), '审计泄露了一次性令牌')
  assert.ok(!entries.includes(password), '审计泄露了密码')
  assert.ok(!entries.includes('ada.new@example.com'), '审计写了完整邮箱而不是脱敏地址')
  assert.ok(!/"tokenHash"|"passwordHash"/.test(entries))
  assert.ok(!entries.includes(sessionCookie), '审计写了会话 Cookie 名')
})