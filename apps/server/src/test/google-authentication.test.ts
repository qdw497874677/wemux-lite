import test from 'node:test'
import assert from 'node:assert/strict'
import type { Timestamp, UserId } from '@wemux/domain'
import type { RegistrationPolicy, UserEmail } from '@wemux/server-domain'
import { SqliteServerStore } from '../storage/sqlite/store.js'
import { IdentityService } from '../application/identity-service.js'
import { InstanceSettingsService } from '../application/instance-settings.js'
import { GoogleAuthenticationService, googleCallbackPath, googleTransactionMs, resolveGoogleSettings } from '../application/google-authentication.js'
import { GoogleExchangeError, GoogleVerificationError, googleIssuer, normalizeGoogleIssuer, safeReturnTo, type GoogleIdentityClaims, type GoogleTokenVerificationInput } from '../application/google-oidc.js'
import { AppError } from '../application/errors.js'
import { hashSecret } from '../application/auth.js'
import { instanceOperatorId, administratorDirectory } from './fixtures/administrator.js'

const at = (value: string): Timestamp => value as Timestamp
const MINUTE = 60 * 1000
const actor = instanceOperatorId

class TestClock {
  private current = new Date('2026-05-01T09:00:00.000Z')
  now(): Date { return this.current }
  advance(ms: number): void { this.current = new Date(this.current.getTime() + ms) }
}

const settings = { clientId: 'client-id.apps.googleusercontent.com', clientSecret: 'client-secret', issuer: googleIssuer, publicUrl: 'https://wemux.example.com', redirectUri: `https://wemux.example.com${googleCallbackPath}` }

function claims(overrides: Partial<GoogleIdentityClaims> = {}): GoogleIdentityClaims {
  return { issuer: googleIssuer, subject: 'google-subject-1', email: 'person@example.com', emailVerified: true, hostedDomain: null, displayName: 'Person One', ...overrides }
}

/** 记录调用参数的可编程验证器：能精确区分“验签失败”和“交换失败”。 */
class FakeVerifier {
  readonly calls: GoogleTokenVerificationInput[] = []
  constructor(private readonly outcome: GoogleIdentityClaims | Error = claims()) {}
  async verify(input: GoogleTokenVerificationInput): Promise<GoogleIdentityClaims> {
    this.calls.push(input)
    if (this.outcome instanceof Error) throw this.outcome
    return this.outcome
  }
}

async function fixture(t: { after: (fn: () => unknown | Promise<unknown>) => void }, options: { policy?: RegistrationPolicy; verifier?: FakeVerifier; google?: typeof settings | null; reason?: string | null } = {}) {
  const store = new SqliteServerStore(':memory:')
  t.after(() => store.close())
  const clock = new TestClock()
  const identity = new IdentityService(store, administratorDirectory(store), clock)
  const instanceSettings = new InstanceSettingsService(store, clock)
  if (options.policy) await instanceSettings.setPolicy(options.policy, actor)
  const verifier = options.verifier ?? new FakeVerifier()
  const google = new GoogleAuthenticationService({ store, identity, settings: instanceSettings, google: options.google === undefined ? settings : options.google, reason: options.reason, clock, verifier })
  return { store, identity, instanceSettings, google, verifier, clock }
}

/** 走完整流程：start 拿 state，再用同一个 state 完成回调。 */
async function signIn(f: Awaited<ReturnType<typeof fixture>>, input: { code?: string; returnTo?: unknown; cookieState?: string; supersede?: Parameters<GoogleAuthenticationService['finish']>[0]['supersede'] } = {}) {
  const started = await f.google.start({ returnTo: input.returnTo ?? '/workbench' })
  const state = new URL(started.authorizeUrl).searchParams.get('state')!
  const finished = await f.google.finish({ code: input.code ?? 'code-1', state, cookieState: input.cookieState ?? state, client: 'browser-1', supersede: input.supersede })
  return { started, state, finished }
}

test('未配置 Provider 时能力为关闭，入口直接拒绝而不是假装可用', async t => {
  const f = await fixture(t, { google: null, reason: '未配置 WEMUX_GOOGLE_CLIENT_ID / WEMUX_GOOGLE_CLIENT_SECRET' })
  assert.deepEqual(f.google.capability(), { enabled: false, reason: '未配置 WEMUX_GOOGLE_CLIENT_ID / WEMUX_GOOGLE_CLIENT_SECRET' })
  await assert.rejects(f.google.start({}), (error: AppError) => error.status === 404 && error.code === 'google_unconfigured')
  await assert.rejects(f.google.finish({ code: 'c', state: 's', cookieState: 's' }), (error: AppError) => error.status === 404)
  const enabled = await fixture(t)
  assert.deepEqual(enabled.google.capability(), { enabled: true, reason: null })
})

test('配置解析拒绝半配置与明文回调，localhost 开发例外', () => {
  assert.deepEqual(resolveGoogleSettings({}), { settings: null, reason: '未配置 WEMUX_GOOGLE_CLIENT_ID / WEMUX_GOOGLE_CLIENT_SECRET' })
  assert.throws(() => resolveGoogleSettings({ WEMUX_GOOGLE_CLIENT_ID: 'id' }), /必须同时配置/)
  assert.throws(() => resolveGoogleSettings({ WEMUX_GOOGLE_CLIENT_ID: 'id', WEMUX_GOOGLE_CLIENT_SECRET: 'secret' }), /WEMUX_PUBLIC_URL is required/)
  assert.throws(() => resolveGoogleSettings({ WEMUX_GOOGLE_CLIENT_ID: 'id', WEMUX_GOOGLE_CLIENT_SECRET: 'secret', WEMUX_PUBLIC_URL: 'http://wemux.example.com' }), /must be an HTTPS origin/)
  const resolved = resolveGoogleSettings({ WEMUX_GOOGLE_CLIENT_ID: 'id', WEMUX_GOOGLE_CLIENT_SECRET: 'secret', WEMUX_PUBLIC_URL: 'https://wemux.example.com/' })
  assert.equal(resolved.settings!.redirectUri, `https://wemux.example.com${googleCallbackPath}`)
  assert.equal(resolved.settings!.issuer, googleIssuer)
  assert.ok(resolveGoogleSettings({ WEMUX_GOOGLE_CLIENT_ID: 'id', WEMUX_GOOGLE_CLIENT_SECRET: 'secret', WEMUX_PUBLIC_URL: 'http://localhost:8010' }).settings)
})

test('授权请求使用 PKCE S256、一次性 state 与 nonce，数据库只留哈希', async t => {
  const f = await fixture(t)
  const started = await f.google.start({ returnTo: '/workbench/sessions/abc' })
  const url = new URL(started.authorizeUrl)
  assert.equal(url.origin, 'https://accounts.google.com')
  assert.equal(url.pathname, '/o/oauth2/v2/auth')
  assert.equal(url.searchParams.get('client_id'), settings.clientId)
  assert.equal(url.searchParams.get('redirect_uri'), settings.redirectUri)
  assert.equal(url.searchParams.get('response_type'), 'code')
  assert.equal(url.searchParams.get('scope'), 'openid email profile')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('prompt'), 'select_account')
  assert.equal(url.searchParams.get('state'), started.state)
  const nonce = url.searchParams.get('nonce')!
  const challenge = url.searchParams.get('code_challenge')!
  assert.notEqual(challenge, nonce)
  // state 只以哈希入库：明文永远查不到，重放者无法从数据库反推。
  assert.equal(await f.store.identity.findOAuthTransactionByStateHash(started.state), null)
  const stored = (await f.store.identity.findOAuthTransactionByStateHash(hashSecret(started.state)))!
  assert.equal(stored.intent, 'login')
  assert.equal(stored.returnTo, '/workbench/sessions/abc')
  assert.equal(stored.nonce, nonce)
  assert.ok(stored.codeVerifier.length >= 32)
  assert.equal(stored.consumedAt, null)
  assert.equal(stored.expiresAt, new Date(Date.parse(stored.createdAt) + googleTransactionMs).toISOString())
  assert.equal(started.expiresAt, stored.expiresAt)
  // 授权 URL 里不出现 client secret；审计里不出现 state/nonce/verifier。
  assert.equal(started.authorizeUrl.includes('client-secret'), false)
  const started_ = (await f.store.identity.listAudit(50)).filter(entry => entry.action === 'identity.oauth_started')
  assert.deepEqual(started_.map(entry => entry.metadata), [{ provider: 'google', intent: 'login', returnTo: '/workbench/sessions/abc' }])
})

test('returnTo 只接受站内路径，其余一律丢弃', async t => {
  const f = await fixture(t)
  for (const hostile of ['https://evil.example/steal', '//evil.example', 'javascript:alert(1)', '/ok\\..\\..', '', null, undefined, `/${'a'.repeat(300)}`]) {
    const started = await f.google.start({ returnTo: hostile })
    const stored = (await f.store.identity.findOAuthTransactionByStateHash(hashSecret(started.state)))!
    assert.equal(stored.returnTo, null, `returnTo ${String(hostile)} must not be stored`)
  }
  assert.equal(safeReturnTo('/workbench?tab=1'), '/workbench?tab=1')
  assert.equal(safeReturnTo('/a\nb'), null)
})

test('首次 Google 登录按策略建号并直接签发 google 会话', async t => {
  const f = await fixture(t, { policy: 'open', verifier: new FakeVerifier(claims({ email: 'person@gmail.com' })) })
  const { started, finished } = await signIn(f, { returnTo: '/workbench' })
  assert.equal(finished.returnTo, '/workbench')
  assert.equal(finished.issued.session.authenticationMethod, 'google')
  assert.equal(finished.issued.session.client, 'browser-1')
  assert.equal(finished.issued.user.username, 'person-one')
  assert.equal(finished.issued.user.email, 'person@gmail.com')
  const users = await f.store.identity.listUsers()
  assert.equal(users.length, 1)
  const bound = (await f.store.identity.findLoginIdentity('google', googleIssuer, 'google-subject-1'))!
  assert.equal(bound.userId, users[0]!.id)
  assert.equal(bound.emailAtSignIn, 'person@gmail.com')
  assert.equal(bound.emailVerified, true)
  assert.equal(bound.lastSignInAt, bound.createdAt)
  // 权威邮箱（Gmail / 域名与 hd 一致的 Workspace）落成本站已验证主邮箱；其余见边界用例。
  assert.equal((await f.store.identity.getUserEmail(users[0]!.id))!.emailNormalized, 'person@gmail.com')
  // 会话能被 Cookie 令牌解析回来；Google-only 账号没有本地密码凭据，也没有团队成员资格。
  assert.equal((await f.identity.resolveSession(finished.issued.token))!.userId, users[0]!.id)
  assert.equal(await f.store.identity.getLocalAccountCredential(users[0]!.id), null)
  assert.deepEqual(await f.store.identity.listMemberships(users[0]!.id), [])
  const registered = (await f.store.identity.listAudit(50)).filter(entry => entry.action === 'identity.registered')
  assert.equal(registered.length, 1)
  assert.equal(registered[0]!.result, 'succeeded')
  assert.equal(registered[0]!.actorId, users[0]!.id)
  assert.equal(JSON.stringify(registered[0]!.metadata).includes(started.state), false)
})

test('Provider 未声明邮箱已验证时不占用本站主邮箱', async t => {
  const f = await fixture(t, { policy: 'open', verifier: new FakeVerifier(claims({ emailVerified: false })) })
  const { finished } = await signIn(f)
  assert.equal(finished.issued.user.email, null)
  assert.equal(await f.store.identity.getUserEmail(finished.issued.user.id), null)
  // 身份仍以 (issuer, subject) 建立，账号可正常登录。
  assert.equal((await f.store.identity.findLoginIdentity('google', googleIssuer, 'google-subject-1'))!.emailVerified, false)
})

test('issuer 归一：https 写法的声明与裸 issuer 落到同一身份', async t => {
  const f = await fixture(t, { policy: 'open', verifier: new FakeVerifier(claims({ issuer: 'https://accounts.google.com' })) })
  const first = await signIn(f, { })
  assert.ok(await f.store.identity.findLoginIdentity('google', googleIssuer, 'google-subject-1'))
  assert.equal(await f.store.identity.findLoginIdentity('google', 'https://accounts.google.com', 'google-subject-1'), null)
  const second = await signIn(f)
  assert.equal(second.finished.issued.user.id, first.finished.issued.user.id)
  assert.equal((await f.store.identity.listUsers()).length, 1)
  assert.equal(normalizeGoogleIssuer('https://Accounts.Google.com/'), googleIssuer)
})

test('邮箱已被其他账号占用时拒绝自动合并，引导先登录后显式绑定', async t => {
  const f = await fixture(t, { policy: 'open', verifier: new FakeVerifier(claims({ email: 'person@gmail.com' })) })
  const owner = 'local-owner' as UserId
  const email: UserEmail = { emailNormalized: 'person@gmail.com', userId: owner, emailDisplay: 'person@gmail.com', createdAt: at('2026-04-01T00:00:00.000Z') }
  await f.store.transaction(async tx => {
    await tx.identity.saveUser({ id: owner, username: 'local-owner', email: 'person@gmail.com', createdAt: at('2026-04-01T00:00:00.000Z') })
    await tx.identity.saveUserEmail(email)
  })
  const started = await f.google.start({})
  const state = new URL(started.authorizeUrl).searchParams.get('state')!
  await assert.rejects(f.google.finish({ code: 'code-1', state, cookieState: state }), (error: AppError) => error.status === 409 && error.code === 'email_conflict')
  // 拒绝即拒绝：没有新账号、没有绑定、没有会话，事务照常消费（不能靠重放同一 state 反复试）。
  assert.equal((await f.store.identity.listUsers()).length, 1)
  assert.equal(await f.store.identity.findLoginIdentity('google', googleIssuer, 'google-subject-1'), null)
  assert.deepEqual(await f.store.identity.listLoginSessions(owner), [])
  assert.notEqual((await f.store.identity.findOAuthTransactionByStateHash(hashSecret(state)))!.consumedAt, null)
  const conflicts = (await f.store.identity.listAudit(50)).filter(entry => entry.action === 'identity.oauth_email_conflict')
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0]!.result, 'failed')
  assert.equal(conflicts[0]!.metadata.email, 'p***@gmail.com')
})

test('第三方邮箱即使声明已验证，也不是本站邮箱证明：不落库、不参与冲突判定', async t => {
  const f = await fixture(t, { policy: 'open', verifier: new FakeVerifier(claims({ email: 'person@yahoo.com' })) })
  const owner = 'local-owner' as UserId
  await f.store.transaction(async tx => {
    await tx.identity.saveUser({ id: owner, username: 'local-owner', email: 'person@yahoo.com', createdAt: at('2026-04-01T00:00:00.000Z') })
    await tx.identity.saveUserEmail({ emailNormalized: 'person@yahoo.com', userId: owner, emailDisplay: 'person@yahoo.com', createdAt: at('2026-04-01T00:00:00.000Z') })
  })
  const { finished } = await signIn(f)
  // 同邮箱不被视为同一人：不报冲突、不复用既有账号，也不把该邮箱落成新账号的已验证邮箱。
  assert.equal(finished.issued.user.email, null)
  assert.equal(await f.store.identity.getUserEmail(finished.issued.user.id), null)
  assert.equal((await f.store.identity.listUsers()).length, 2)
  const bound = (await f.store.identity.findLoginIdentity('google', googleIssuer, 'google-subject-1'))!
  assert.equal(bound.emailAtSignIn, 'person@yahoo.com', '登录身份仍原样记录 Provider 声明的邮箱用于展示与排查')
  const audit = (await f.store.identity.listAudit(50)).filter(entry => entry.action === 'identity.registered')
  assert.equal(audit.length, 1)
  assert.equal(audit[0]!.metadata.emailAuthority, 'provider_claim')
  assert.equal(audit[0]!.metadata.email, null)
})

test('Workspace 域名与邮箱一致（hd）才落本站已验证邮箱，googlemail 同样算权威域名', async t => {
  const workspace = await fixture(t, { policy: 'open', verifier: new FakeVerifier(claims({ email: 'person@acme.com', hostedDomain: 'acme.com' })) })
  const trusted = await signIn(workspace)
  assert.equal(trusted.finished.issued.user.email, 'person@acme.com')
  assert.equal((await workspace.store.identity.getUserEmail(trusted.finished.issued.user.id))!.emailNormalized, 'person@acme.com')

  const mismatched = await fixture(t, { policy: 'open', verifier: new FakeVerifier(claims({ email: 'person@other.com', hostedDomain: 'acme.com' })) })
  const rejected = await signIn(mismatched)
  assert.equal(rejected.finished.issued.user.email, null, 'hd 域名与邮箱域名不一致时不能当作本站邮箱证明')
  assert.equal(await mismatched.store.identity.getUserEmail(rejected.finished.issued.user.id), null)

  const googlemail = await fixture(t, { policy: 'open', verifier: new FakeVerifier(claims({ email: 'person@googlemail.com' })) })
  const alias = await signIn(googlemail)
  assert.equal(alias.finished.issued.user.email, 'person@googlemail.com')
})

test('已有绑定直接登录原账号并推进最近登录时间；策略收紧不影响老用户', async t => {
  const f = await fixture(t, { policy: 'open' })
  const first = await signIn(f)
  f.clock.advance(2 * MINUTE)
  const second = await signIn(f)
  assert.equal(second.finished.issued.user.id, first.finished.issued.user.id)
  assert.equal((await f.store.identity.listUsers()).length, 1)
  const bound = (await f.store.identity.findLoginIdentity('google', googleIssuer, 'google-subject-1'))!
  assert.equal(bound.lastSignInAt, '2026-05-01T09:02:00.000Z')
  assert.equal(bound.createdAt, '2026-05-01T09:00:00.000Z')
  assert.equal((await f.store.identity.listLoginSessions(first.finished.issued.user.id)).length, 2)
  await f.instanceSettings.setPolicy('closed', actor)
  const third = await signIn(f)
  assert.equal(third.finished.issued.user.id, first.finished.issued.user.id)
  assert.equal((await f.store.identity.listLoginSessions(first.finished.issued.user.id)).length, 3)
  const events = (await f.store.identity.listAudit(50)).filter(entry => entry.action === 'identity.oauth_signed_in' || entry.action === 'identity.registered')
  assert.equal(events.length, 3)
  assert.equal(events.filter(entry => entry.action === 'identity.registered').length, 1)
  assert.equal(events[2]!.metadata.authenticationMethod, 'google')
})

test('授权事务一次性：state 重放、过期、跨浏览器与未知 state 都拿不到会话', async t => {
  const f = await fixture(t, { policy: 'open' })
  const first = await signIn(f)
  const state = new URL(first.started.authorizeUrl).searchParams.get('state')!
  await assert.rejects(f.google.finish({ code: 'code-1', state, cookieState: state }), (error: AppError) => error.status === 409 && error.code === 'state_replayed')
  await assert.rejects(f.google.finish({ code: 'code-2', state, cookieState: 'other' }), (error: AppError) => error.status === 400 && error.code === 'state_mismatch')
  await assert.rejects(f.google.finish({ code: 'code-2', state: 'unknown-state', cookieState: 'unknown-state' }), (error: AppError) => error.status === 400 && error.code === 'invalid_state')
  await assert.rejects(f.google.finish({ code: 'code-2' }), (error: AppError) => error.status === 400 && error.code === 'invalid_state')
  // 过期事务：state 合法但超过 5 分钟窗口，且不能被消费。
  const expiring = await f.google.start({})
  const expiringState = new URL(expiring.authorizeUrl).searchParams.get('state')!
  f.clock.advance(googleTransactionMs + 1)
  await assert.rejects(f.google.finish({ code: 'code-3', state: expiringState, cookieState: expiringState }), (error: AppError) => error.status === 410 && error.code === 'state_expired')
  assert.equal((await f.store.identity.findOAuthTransactionByStateHash(hashSecret(expiringState)))!.consumedAt, null)
  // 重放与过期都没有签发第二个会话。
  assert.equal((await f.store.identity.listLoginSessions(first.finished.issued.user.id)).length, 1)
})

test('绑定意图的事务不能用于登录', async t => {
  const f = await fixture(t, { policy: 'open' })
  const owned = await signIn(f)
  const started = await f.google.start({})
  const state = new URL(started.authorizeUrl).searchParams.get('state')!
  const stored = (await f.store.identity.findOAuthTransactionByStateHash(hashSecret(state)))!
  await f.store.transaction(tx => tx.identity.saveOAuthTransaction({ ...stored, id: 'link-transaction', stateHash: hashSecret('link-state'), intent: 'link', userId: owned.finished.issued.user.id, sessionId: owned.finished.issued.session.id }))
  await assert.rejects(f.google.finish({ code: 'code-1', state: 'link-state', cookieState: 'link-state' }), (error: AppError) => error.status === 409 && error.code === 'intent_mismatch')
  // 绑定流程的事务不能被登录复用：被拒绝且未被消费。
  assert.equal((await f.store.identity.findOAuthTransactionByStateHash(hashSecret('link-state')))!.consumedAt, null)
  assert.equal((await f.store.identity.listLoginSessions(owned.finished.issued.user.id)).length, 1)
})

test('验签失败中止本次登录但保留事务可重试，交换失败报告为 Provider 不可用', async t => {
  const rejected = await fixture(t, { policy: 'open', verifier: new FakeVerifier(new GoogleVerificationError('ID token nonce does not match the login transaction')) })
  const started = await rejected.google.start({})
  const state = new URL(started.authorizeUrl).searchParams.get('state')!
  await assert.rejects(rejected.google.finish({ code: 'code-1', state, cookieState: state }), (error: AppError) => error.status === 401 && error.code === 'google_verification_failed')
  // 未被消费：网络/时钟抖动后可以用同一个 state 重试，而不是让用户重新打开 Google。
  assert.equal((await rejected.store.identity.findOAuthTransactionByStateHash(hashSecret(state)))!.consumedAt, null)
  assert.equal((await rejected.store.identity.listUsers()).length, 0)
  const retryVerifier = new FakeVerifier()
  const retry = await fixture(t, { policy: 'open', verifier: retryVerifier })
  const retryStart = await retry.google.start({ returnTo: '/settings' })
  const retryState = new URL(retryStart.authorizeUrl).searchParams.get('state')!
  const retried = await retry.google.finish({ code: 'code-1', state: retryState, cookieState: retryState })
  assert.equal(retried.returnTo, '/settings')
  assert.equal(retryVerifier.calls[0]!.codeVerifier.length >= 32, true)
  assert.equal(retryVerifier.calls[0]!.expectedIssuer, googleIssuer)
  assert.equal(retryVerifier.calls[0]!.redirectUri, settings.redirectUri)
  assert.equal(retryVerifier.calls[0]!.clientSecret, 'client-secret')
  // 令牌交换失败：如实报告 Provider 不可用，且审计只记阶段与原因，不记 code/nonce。
  const unavailable = await fixture(t, { policy: 'open', verifier: new FakeVerifier(new GoogleExchangeError('Google token endpoint is unreachable')) })
  const unavailableStart = await unavailable.google.start({})
  const unavailableState = new URL(unavailableStart.authorizeUrl).searchParams.get('state')!
  await assert.rejects(unavailable.google.finish({ code: 'code-1', state: unavailableState, cookieState: unavailableState }), (error: AppError) => error.status === 502 && error.code === 'google_unavailable')
  const failures = (await unavailable.store.identity.listAudit(50)).filter(entry => entry.action === 'identity.oauth_failed')
  assert.equal(failures.length, 1)
  assert.equal(failures[0]!.result, 'failed')
  assert.equal(failures[0]!.metadata.stage, 'token_exchange')
  assert.equal(JSON.stringify(failures[0]!.metadata).includes('code-1'), false)
})

test('首次登录受注册策略约束：invite_only 与 closed 都不建号', async t => {
  for (const policy of ['invite_only', 'closed'] as const) {
    const f = await fixture(t, { policy })
    const started = await f.google.start({})
    const state = new URL(started.authorizeUrl).searchParams.get('state')!
    await assert.rejects(f.google.finish({ code: 'code-1', state, cookieState: state }), (error: AppError) => error.status === 403 && error.code === (policy === 'closed' ? 'registration_closed' : 'invitation_required'))
    assert.equal((await f.store.identity.listUsers()).length, 0)
    assert.equal(await f.store.identity.findLoginIdentity('google', googleIssuer, 'google-subject-1'), null)
    // 策略拒绝也要留痕，失败结果如实记录。
    const rejected = (await f.store.identity.listAudit(50)).filter(entry => entry.action === 'identity.oauth_rejected')
    assert.equal(rejected.length, 1)
    assert.equal(rejected[0]!.result, 'failed')
  }
})

test('把当前浏览器会话作为 supersede 传入时旧会话立即退役', async t => {
  const f = await fixture(t, { policy: 'open' })
  const first = await signIn(f)
  const second = await signIn(f, { supersede: first.finished.issued.session })
  const sessions = await f.store.identity.listLoginSessions(first.finished.issued.user.id)
  assert.equal(sessions.length, 2)
  assert.notEqual(sessions.find(session => session.id === first.finished.issued.session.id)!.revokedAt, null)
  assert.equal(sessions.find(session => session.id === second.finished.issued.session.id)!.revokedAt, null)
  assert.equal(await f.identity.resolveSession(first.finished.issued.token), null)
  assert.equal((await f.identity.resolveSession(second.finished.issued.token))!.id, second.finished.issued.session.id)
})

test('同一 subject 的第二次完整流程复用唯一账号与唯一绑定', async t => {
  const f = await fixture(t, { policy: 'open' })
  const first = await signIn(f)
  const second = await signIn(f)
  assert.equal(second.finished.issued.user.id, first.finished.issued.user.id)
  assert.equal((await f.store.identity.listUsers()).length, 1)
  assert.equal((await f.store.identity.listLoginIdentities(first.finished.issued.user.id)).length, 1)
})