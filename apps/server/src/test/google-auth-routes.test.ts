/**
 * Ticket 07 的 HTTP 层验收：Google 登录的 start/callback 全程走真实路由，
 * 并对着一个本地替身 Provider 验证 ID token——签名、算法、issuer、audience、
 * nonce、PKCE 都由真实的 `createGoogleTokenVerifier` 校验，不用桩替换信任边界。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { UserId } from '@wemux/domain'
import { createWemuxServer } from '../server.js'
import { administratorEmail, seedLocalAccount } from './fixtures/administrator.js'
import { SqliteServerStore } from '../storage/sqlite/store.js'
import { hashSecret } from '../application/auth.js'
import { googleIssuer } from '../application/google-oidc.js'
import { googleCallbackPath } from '../application/google-authentication.js'
import { browser, fakeGoogle, googleClientId as clientId, googleClientSecret as clientSecret, googleProviderSettings, handoff } from './fixtures/google-provider.js'

const sessionCookie = 'wemux_login_session'
const stateCookie = 'wemux_oauth_state'

async function fixture(t: { after: (fn: () => Promise<void> | void) => void }, options: { google?: boolean; webStaticPath?: string; administratorEmails?: readonly string[] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'wemux-google-'))
  const databasePath = join(directory, 'server.sqlite')
  const provider = options.google === false ? null : await fakeGoogle()
  const app = createWemuxServer({
    databasePath, administratorEmails: options.administratorEmails ?? [administratorEmail], ...(options.webStaticPath ? { webStaticPath: options.webStaticPath } : {}),
    ...(provider ? googleProviderSettings(provider, 'http://localhost:4100') : {}),
  })
  const base = await app.listen(0, '127.0.0.1')
  // 只读的第二连接：用于断言真实的落库结果，而不是只信 HTTP 表面。
  const store = new SqliteServerStore(databasePath)
  t.after(async () => {
    store.close()
    await app.close()
    if (provider) await provider.close()
    await rm(directory, { recursive: true, force: true })
  })
  return { app, store, base, provider, browser: browser(base) }
}

/** 走完一次真实回调，返回授权参数。 */
async function signIn(f: Awaited<ReturnType<typeof fixture>>, client = f.browser, returnTo?: string) {
  const started = await client.post('/api/auth/oauth/google/start', returnTo === undefined ? {} : { returnTo })
  assert.equal(started.status, 202, JSON.stringify(started.data))
  const authorization = handoff(f.provider!, (started.data as { authorizeUrl: string }).authorizeUrl)
  const callback = await client.get(`/api/auth/oauth/google/callback?code=authorization-code&state=${authorization.state}`)
  return { started, authorization, callback }
}

/** 部署者登录并设定注册策略；管理员用独立浏览器，不影响 Google 流程的 Cookie。
 * 默认策略为 `invite_only`（`defaultRegistrationPolicy`），因此需要自助注册的用例必须先显式放开。 */
async function signInAdmin(
  f: Awaited<ReturnType<typeof fixture>>,
  body: { username: string; email?: string; password: string } = { username: 'admin', password: 'correct-horse-battery' },
  policy = 'open',
) {
  const email = body.email ?? administratorEmail
  await seedLocalAccount(f.app.store, { username: body.username, email, password: body.password, administrator: true })
  const admin = browser(f.base)
  const claim = await admin.post('/api/auth/login', { login: body.username, password: body.password })
  assert.equal(claim.status, 200, JSON.stringify(claim.data))
  const patched = await admin.call('/api/settings/registration-policy', { method: 'PATCH', body: { policy } })
  assert.equal(patched.status, 200, JSON.stringify(patched.data))
  return { admin, claim }
}

test('未配置 Google 时公开报告关闭，入口不假装可用', async t => {
  const f = await fixture(t, { google: false })
  const options = await f.browser.get('/api/auth/options')
  assert.equal(options.status, 200)
  const body = options.data as { google: { enabled: boolean; reason: string | null } }
  assert.equal(body.google.enabled, false)
  assert.match(String(body.google.reason), /WEMUX_GOOGLE_CLIENT_ID/)
  const start = await f.browser.post('/api/auth/oauth/google/start', {})
  assert.equal(start.status, 404)
  assert.equal(f.browser.errorCode(start), 'google_unconfigured')
})

test('授权请求带 PKCE S256、一次性 state 与 nonce，state 只回给发起浏览器', async t => {
  const f = await fixture(t)
  const options = await f.browser.get('/api/auth/options')
  assert.equal((options.data as { google: { enabled: boolean } }).google.enabled, true)
  const started = await f.browser.post('/api/auth/oauth/google/start', { returnTo: '/projects/ada?tab=tasks' })
  assert.equal(started.status, 202)
  const authorization = handoff(f.provider!, (started.data as { authorizeUrl: string }).authorizeUrl)
  const url = new URL((started.data as { authorizeUrl: string }).authorizeUrl)
  assert.equal(url.origin, 'https://accounts.google.com')
  assert.equal(url.searchParams.get('client_id'), clientId)
  assert.equal(url.searchParams.get('redirect_uri'), `http://localhost:4100${googleCallbackPath}`)
  assert.equal(url.searchParams.get('response_type'), 'code')
  assert.equal(url.searchParams.get('scope'), 'openid email profile')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('prompt'), 'select_account')
  assert.equal(url.searchParams.get('state'), authorization.state)
  assert.equal(url.searchParams.get('nonce'), authorization.nonce)
  assert.equal(url.searchParams.get('code_challenge'), authorization.challenge)
  // 明文 state 只存在于授权地址与本机 Cookie 两处：数据库只存哈希。
  assert.equal(f.browser.cookie(stateCookie), authorization.state)
  const stored = await f.store.identity.findOAuthTransactionByStateHash(hashSecret(authorization.state))
  assert.ok(stored)
  assert.notEqual(stored!.stateHash, authorization.state)
})

test('完整回调：验证 ID token 后签发 Cookie 会话并回到 returnTo', async t => {
  const f = await fixture(t)
  await signInAdmin(f)
  const { callback } = await signIn(f, f.browser, '/projects/ada?tab=tasks')
  assert.equal(callback.status, 302)
  assert.equal(callback.location, '/projects/ada?tab=tasks')
  assert.ok(f.browser.cookie(sessionCookie))
  assert.equal(f.browser.cookie(stateCookie), undefined)
  assert.equal(callback.headers.get('cache-control'), 'no-store')
  const me = await f.browser.get('/api/auth/me')
  assert.equal(me.status, 200)
  const account = me.data as { user: { id: string; email: string | null }; session: { authenticationMethod: string } }
  assert.equal(account.user.email, 'ada@example.com')
  assert.equal(account.session.authenticationMethod, 'google')
  // 身份主键是 (issuer, subject)，绑定落库且审计留痕。
  const identity = await f.store.identity.findLoginIdentity('google', googleIssuer, 'google-subject-1')
  assert.equal(identity!.userId, account.user.id)
  assert.equal(identity!.emailAtSignIn, 'ada@example.com')
  const audit = (await f.store.identity.listAudit(50)).map(entry => entry.action)
  assert.ok(audit.includes('identity.oauth_started'))
  assert.ok(audit.includes('identity.registered'))
})

test('state 缺失或跨浏览器时回调拒绝且不发会话', async t => {
  const f = await fixture(t)
  const started = await f.browser.post('/api/auth/oauth/google/start', {})
  const authorization = handoff(f.provider!, (started.data as { authorizeUrl: string }).authorizeUrl)
  const visitor = browser(f.base)
  const callback = await visitor.get(`/api/auth/oauth/google/callback?code=authorization-code&state=${authorization.state}`)
  assert.equal(callback.status, 302)
  assert.equal(callback.location, '/?oauth_error=state_mismatch')
  assert.equal(visitor.cookie(sessionCookie), undefined)
  const unknown = await f.browser.call(`/api/auth/oauth/google/callback?code=authorization-code&state=unknown`, { cookie: `${stateCookie}=unknown` })
  assert.equal(unknown.location, '/?oauth_error=invalid_state')
  assert.equal((await f.store.identity.listUsers()).length, 0)
})

test('state 是一次性的：重放与已消费事务都拿不到第二个会话', async t => {
  const f = await fixture(t)
  await signInAdmin(f)
  const { authorization, callback } = await signIn(f)
  assert.equal(callback.location, '/')
  const session = f.browser.cookie(sessionCookie)
  const me = await f.browser.get('/api/auth/me')
  const userId = (me.data as { user: { id: UserId } }).user.id
  assert.equal((await f.store.identity.listLoginSessions(userId)).length, 1)
  // 把同一个 state 塞回 Cookie 重放：事务已消费，第二个会话不会被签发。
  const replayed = await f.browser.call(`/api/auth/oauth/google/callback?code=authorization-code&state=${authorization.state}`, { cookie: `${stateCookie}=${authorization.state}` })
  assert.equal(replayed.location, '/?oauth_error=state_replayed')
  assert.equal((await f.store.identity.listLoginSessions(userId)).length, 1)
  assert.ok(session)
})

test('验签失败与令牌交换失败分别归因，且事务保留可重试', async t => {
  const f = await fixture(t)
  await signInAdmin(f)
  const started = await f.browser.post('/api/auth/oauth/google/start', {})
  const authorization = handoff(f.provider!, (started.data as { authorizeUrl: string }).authorizeUrl)
  // 回调无论成败都会清掉 state Cookie（浏览器流不能留着旧 state），重试时显式带回同一个事务的 state。
  const stateCookieHeader = { cookie: `${stateCookie}=${authorization.state}` }
  f.provider!.setBehavior('bad-audience')
  const rejected = await f.browser.get(`/api/auth/oauth/google/callback?code=authorization-code&state=${authorization.state}`, stateCookieHeader)
  assert.equal(rejected.location, '/?oauth_error=google_verification_failed')
  assert.equal(f.browser.cookie(sessionCookie), undefined)
  // 验签失败不消费事务：用户可以重新点击同一个 state 重试（网络抖动场景）。
  const stored = await f.store.identity.findOAuthTransactionByStateHash(hashSecret(authorization.state))
  assert.equal(stored!.consumedAt, null)
  // nonce 不符同样关闭认证。
  f.provider!.setBehavior('bad-nonce')
  const nonce = await f.browser.get(`/api/auth/oauth/google/callback?code=authorization-code&state=${authorization.state}`, stateCookieHeader)
  assert.equal(nonce.location, '/?oauth_error=google_verification_failed')
  f.provider!.setBehavior('http-500')
  const unavailable = await f.browser.get(`/api/auth/oauth/google/callback?code=authorization-code&state=${authorization.state}`, stateCookieHeader)
  assert.equal(unavailable.location, '/?oauth_error=google_unavailable')
  const audit = (await f.store.identity.listAudit(50)).filter(entry => entry.action === 'identity.oauth_failed')
  assert.deepEqual([...new Set(audit.map(entry => entry.metadata.stage))].sort(), ['id_token', 'token_exchange'])
})

test('同邮箱已被占用时拒绝静默合并，引导先登录再显式绑定', async t => {
  const f = await fixture(t)
  // 先占住 ada@example.com（就是替身 Google 返回的邮箱）：Google 首次登录不得滑进这个既存账号。
  const occupant = await seedLocalAccount(f.app.store, { username: 'ada', email: 'ada@example.com', password: 'correct-horse-battery' })
  // 部署者单独开注册策略（默认 invite_only，不放开就到不了邮箱冲突判定）。
  await signInAdmin(f)
  const { callback } = await signIn(f)
  assert.equal(callback.location, '/?oauth_error=email_conflict')
  const users = await f.store.identity.listUsers()
  assert.equal(users.length, 2, '冲突时只保留既存账号，不新建也不合并')
  assert.deepEqual(users.map(user => user.email).sort(), ['ada@example.com', administratorEmail])
  assert.equal(users.find(user => user.id === occupant.id)!.email, 'ada@example.com')
  assert.equal(await f.store.identity.findLoginIdentity('google', googleIssuer, 'google-subject-1'), null)
  const audit = (await f.store.identity.listAudit(50)).find(entry => entry.action === 'identity.oauth_email_conflict')
  assert.equal(audit!.metadata.email, 'a***@example.com')
})

test('首次 Google 登录服从 open/invite_only/closed 策略；已绑定用户不受策略收紧影响', async t => {
  const f = await fixture(t)
  const { admin } = await signInAdmin(f, { username: 'admin', password: 'correct-horse-battery' }, 'invite_only')
  const policy = (value: string) => admin.call('/api/settings/registration-policy', { method: 'PATCH', body: { policy: value } })
  // 默认 invite_only：Google 不能自助建号，必须先用团队邀请建立账号。
  const invited = await signIn(f)
  assert.equal(invited.callback.location, '/?oauth_error=invitation_required')
  assert.equal((await f.store.identity.listUsers()).length, 1)
  assert.equal((await policy('closed')).status, 200)
  const blocked = await signIn(f)
  assert.equal(blocked.callback.location, '/?oauth_error=registration_closed')
  assert.equal((await f.store.identity.listUsers()).length, 1)
  // 放开策略后注册，再收紧策略：已绑定用户仍能直接登录。
  assert.equal((await policy('open')).status, 200)
  const created = await signIn(f)
  assert.equal(created.callback.location, '/')
  const userId = (await f.store.identity.findLoginIdentity('google', googleIssuer, 'google-subject-1'))!.userId
  assert.equal((await policy('closed')).status, 200)
  const visitor = browser(f.base)
  const signedIn = await signIn(f, visitor)
  assert.equal(signedIn.callback.location, '/')
  const me = await visitor.get('/api/auth/me')
  assert.equal((me.data as { user: { id: UserId } }).user.id, userId)
  assert.equal((me.data as { session: { authenticationMethod: string } }).session.authenticationMethod, 'google')
  assert.equal((await f.store.identity.listUsers()).length, 2)
  // 两条拒绝路径都留痕，且只写原因不写参数。
  const rejected = (await f.store.identity.listAudit(50)).filter(entry => entry.action === 'identity.oauth_rejected').map(entry => entry.metadata.reason).sort()
  assert.deepEqual(rejected, ['invitation_required', 'registration_closed'])
})

test('部署声明里的邮箱不受注册策略约束：默认仅邀请也能完成部署者自己的建号', async t => {
  // 声明写成 Google 实际返回的那个邮箱（且大小写不同，顺手验规范化）：这就是“部署者即管理员”的落地路径。
  const f = await fixture(t, { administratorEmails: ['ADA@example.com'] })
  const { callback } = await signIn(f)
  assert.equal(callback.status, 302)
  assert.equal(callback.location, '/', '声明命中就不该再冒 invitation_required')
  const account = await f.browser.get('/api/auth/me')
  const user = (account.data as { user: { id: UserId; email: string | null } }).user
  assert.equal(user.email, 'ada@example.com')
  // 建号即提升：声明命中的人在登录那一刻拿到实例管理员归属，不靠额外初始化步骤。
  assert.equal((await f.store.identity.findInstanceAdministrator(user.id))?.source, 'declared')
  const audit = await f.store.identity.listAudit(50)
  assert.ok(audit.some(entry => entry.action === 'identity.oauth_registration_allowed' && entry.metadata.reason === 'declared_administrator'))
  assert.ok(audit.some(entry => entry.action === 'instance.administrator_assigned'))
})

test('审计与失败路径不记录 OAuth 参数、令牌与客户端秘密', async t => {
  const f = await fixture(t)
  await signInAdmin(f)
  await signIn(f)
  f.provider!.setBehavior('http-500')
  const failed = await signIn(f, browser(f.base))
  assert.equal(failed.callback.location, '/?oauth_error=google_unavailable')
  const entries = await f.store.identity.listAudit(100)
  const serialized = JSON.stringify(entries)
  for (const secret of ['authorization-code', clientSecret, 'fake-access-token-1']) assert.ok(!serialized.includes(secret), `审计泄露了 ${secret}`)
  assert.ok(!/"state"|code_verifier|codeVerifier|"nonce"|"stateHash"/.test(serialized))
})

test('returnTo 不接受站外地址，回调不会形成开放重定向', async t => {
  const f = await fixture(t)
  await signInAdmin(f)
  const { callback } = await signIn(f, f.browser, 'https://evil.example/steal')
  assert.equal(callback.location, '/')
})

test('回调是 API 路由：单源部署下不会被 SPA 回退截走', async t => {
  const staticRoot = await mkdtemp(join(tmpdir(), 'wemux-static-'))
  await writeFile(join(staticRoot, 'index.html'), '<!doctype html><title>spa</title>')
  const f = await fixture(t, { webStaticPath: staticRoot })
  t.after(() => rm(staticRoot, { recursive: true, force: true }))
  await signInAdmin(f)
  const { callback } = await signIn(f)
  assert.equal(callback.status, 302)
  assert.equal(callback.location, '/')
  assert.ok(!callback.text.includes('spa'))
  // 前台深链仍然回退到 index.html。
  const deepLink = await f.browser.get('/projects/ada', { accept: 'text/html', cookie: null })
  assert.equal(deepLink.status, 200)
  assert.ok(deepLink.text.includes('spa'))
})