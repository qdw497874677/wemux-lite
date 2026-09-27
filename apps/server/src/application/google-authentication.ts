/**
 * Google 注册与登录的编排：一次性 state/nonce/PKCE、身份解析、按策略建号、签发会话。
 *
 * 设计（`docs/design/account-identity-system.md` 第 2.1/2.2 节与 Ticket 07）：
 * - Server 自己换取并验证 ID token；客户端提交的任何资料都不作为身份依据。
 * - 身份主键是规范 `(issuer, subject)`，邮箱不是身份主键，也绝不据同邮箱静默合并账号。
 * - 首次登录受实例注册策略约束；已有绑定直接登录原账号，并更新 Provider 声明的最近登录时间。
 * - 未绑定但邮箱已被其他账号占用时拒绝登录，引导用户先登录后显式绑定。
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { AuditEntryId, Timestamp, UserId } from '@wemux/domain'
import type { ExternalLoginIdentity, LoginSession, User, UserEmail } from '@wemux/server-domain'
import type { ServerStore } from './ports/server-store.ts'
import { AppError } from './errors.ts'
import { deriveUsername } from './email-registration.ts'
import { maskEmail } from './email-address.ts'
import { hashSecret } from './auth.ts'
import { systemClock, type Clock, type IdentityService, type IssuedLoginSession } from './identity-service.ts'
import type { InstanceSettingsService } from './instance-settings.ts'
import { GoogleExchangeError, GoogleVerificationError, createGoogleTokenVerifier, googleIssuer, normalizeGoogleIssuer, safeReturnTo, type GoogleIdentityClaims, type GoogleTokenVerifier } from './google-oidc.ts'

export interface GoogleEnvironment {
  readonly [key: string]: string | undefined
}

export interface GoogleSettings {
  readonly clientId: string
  readonly clientSecret: string
  /** 规范化后的 issuer；当前固定为 `accounts.google.com`。 */
  readonly issuer: string
  /** 站点公开 Origin；回调地址必须由它推导，不能取自请求头。 */
  readonly publicUrl: string
  readonly redirectUri: string
}

/** 回调路径固定：Google Cloud Console 里登记的地址必须与此完全一致（设计第 2.1/2.2 节）。 */
export const googleCallbackPath = '/api/auth/oauth/google/callback'

const googleAuthorizeEndpoint = 'https://accounts.google.com/o/oauth2/v2/auth'
const googleScopes = 'openid email profile'

/** 授权事务的有效期：够用户完成一次登录，又不会让 state 长期可重放。 */
export const googleTransactionMs = 5 * 60 * 1000

/**
 * 解析 Google Provider 配置。未配置时返回 `settings: null` 与原因（前端据此不展示假按钮）；
 * 半配置或非法组合直接抛错，让部署在启动时就失败，而不是等用户点击后报 500。
 */
export function resolveGoogleSettings(env: GoogleEnvironment): { settings: GoogleSettings | null; reason: string | null } {
  const clientId = (env.WEMUX_GOOGLE_CLIENT_ID ?? '').trim()
  const clientSecret = (env.WEMUX_GOOGLE_CLIENT_SECRET ?? '').trim()
  const publicUrl = (env.WEMUX_PUBLIC_URL ?? '').trim().replace(/\/+$/, '')
  if (clientId.length === 0 && clientSecret.length === 0) {
    return { settings: null, reason: '未配置 WEMUX_GOOGLE_CLIENT_ID / WEMUX_GOOGLE_CLIENT_SECRET' }
  }
  if (clientId.length === 0 || clientSecret.length === 0) throw new Error('WEMUX_GOOGLE_CLIENT_ID 与 WEMUX_GOOGLE_CLIENT_SECRET 必须同时配置')
  if (publicUrl.length === 0) throw new Error('WEMUX_PUBLIC_URL is required when Google login is configured (the callback URL must not be built from request headers)')
  let url: URL
  try { url = new URL(publicUrl) } catch { throw new Error('WEMUX_PUBLIC_URL is not a valid URL') }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !loopback) throw new Error('WEMUX_PUBLIC_URL must be an HTTPS origin when Google login is configured (only locally hosted development may use HTTP)')
  return { settings: { clientId, clientSecret, issuer: googleIssuer, publicUrl, redirectUri: `${publicUrl}${googleCallbackPath}` }, reason: null }
}

/**
 * Google 邮箱权威边界（设计 2.4）：只有 Gmail/Googlemail，或 Workspace 账号（ID token 带 `hd`）且邮箱域名与
 * `hd` 一致时，Google 对该邮箱的验证才算本站可信的邮箱证明；其他第三方邮箱即使 `email_verified` 为真，
 * 也只作为登录身份的展示信息，不在本站落成已验证邮箱，也不参与同邮箱冲突判定。
 */
export function isGoogleAuthoritativeEmail(claims: GoogleIdentityClaims): boolean {
  if (!claims.emailVerified || !claims.email) return false
  const domain = claims.email.slice(claims.email.indexOf('@') + 1)
  if (domain === 'gmail.com' || domain === 'googlemail.com') return true
  return claims.hostedDomain !== null && claims.hostedDomain.toLowerCase() === domain
}

export interface GoogleAuthenticationInput {
  readonly store: ServerStore
  readonly identity: IdentityService
  readonly settings: InstanceSettingsService
  readonly google?: GoogleSettings | null
  readonly reason?: string | null
  readonly clock?: Clock
  readonly verifier?: GoogleTokenVerifier
  readonly transactionMs?: number
}

export interface GoogleStart {
  readonly authorizeUrl: string
  /** 一次性 state：同时写入发起浏览器的短时 Cookie，回调必须两处一致。 */
  readonly state: string
  readonly expiresAt: Timestamp
}

export interface GoogleFinish {
  readonly issued: IssuedLoginSession
  readonly returnTo: string | null
}

/** 绑定回调结果：不签发新会话，只带回绑定行与「本来就绑着」标记。 */
export interface GoogleLinkFinish {
  readonly identity: ExternalLoginIdentity
  readonly alreadyBound: boolean
  readonly returnTo: string | null
}

export class GoogleAuthenticationService {
  private readonly clock: Clock
  private readonly verifier: GoogleTokenVerifier
  private readonly transactionMs: number
  private readonly input: GoogleAuthenticationInput
  constructor(input: GoogleAuthenticationInput) { this.input = input;
    this.clock = input.clock ?? systemClock
    this.verifier = input.verifier ?? createGoogleTokenVerifier()
    this.transactionMs = input.transactionMs ?? googleTransactionMs
  }

  /** 公开能力：未配置时前端不渲染 Google 按钮，后端也拒绝入口。 */
  capability(): { readonly enabled: boolean; readonly reason: string | null } {
    return this.input.google ? { enabled: true, reason: null } : { enabled: false, reason: this.input.reason ?? '本实例未配置 Google 登录' }
  }

  private provider(): GoogleSettings {
    if (!this.input.google) throw new AppError(404, '本实例未配置 Google 登录', 'google_unconfigured')
    return this.input.google
  }

  /** 生成授权 URL 与一次性事务；事务只存 state 哈希，明文 state 只回给发起浏览器。 */
  async start(input: { readonly returnTo?: unknown } = {}): Promise<GoogleStart> {
    const provider = this.provider()
    const at = this.clock.now()
    const state = randomBytes(32).toString('base64url')
    const nonce = randomBytes(16).toString('base64url')
    const codeVerifier = randomBytes(32).toString('base64url')
    const expiresAt = new Date(at.getTime() + this.transactionMs).toISOString() as Timestamp
    const returnTo = safeReturnTo(input.returnTo)
    const transaction = {
      id: randomUUID(),
      provider: 'google' as const,
      issuer: provider.issuer,
      stateHash: hashSecret(state),
      nonce,
      codeVerifier,
      intent: 'login' as const,
      userId: null,
      sessionId: null,
      returnTo,
      createdAt: at.toISOString() as Timestamp,
      expiresAt,
      consumedAt: null,
    }
    await this.input.store.transaction(async tx => {
      await tx.identity.saveOAuthTransaction(transaction)
      await tx.audit.append({
        id: randomUUID() as AuditEntryId, actorId: null, action: 'identity.oauth_started',
        resource: { kind: 'user', id: 'oauth-pending' as UserId }, result: 'succeeded', occurredAt: transaction.createdAt,
        metadata: { provider: 'google', intent: 'login', returnTo },
      })
    })
    const query = new URLSearchParams({
      client_id: provider.clientId,
      redirect_uri: provider.redirectUri,
      response_type: 'code',
      scope: googleScopes,
      state,
      nonce,
      code_challenge: createHash('sha256').update(codeVerifier).digest('base64url'),
      code_challenge_method: 'S256',
      // 总是让用户选择账号：避免上一次登录的账号被静默复用，也让“换账号登录”成为显式动作。
      prompt: 'select_account',
    })
    return { authorizeUrl: `${googleAuthorizeEndpoint}?${query.toString()}`, state, expiresAt }
  }

  private async loadTransaction(state: unknown, cookieState: unknown, expectedIntent: 'login' | 'link' | null): Promise<{ id: string; stateHash: string; nonce: string; codeVerifier: string; returnTo: string | null; issuer: string; intent: 'login' | 'link'; userId: UserId | null; sessionId: string | null }> {
    if (typeof state !== 'string' || state.length === 0 || state.length > 200) throw new AppError(400, '登录状态缺失或无效，请重新发起 Google 登录', 'invalid_state')
    // state 必须来自发起它的浏览器：只有拿到同一个 Cookie 才能继续，避免把回调塞给别人的浏览器。
    if (typeof cookieState !== 'string' || cookieState !== state) throw new AppError(400, '登录状态与发起浏览器不匹配，请在同一个浏览器里重新发起 Google 登录', 'state_mismatch')
    const transaction = await this.input.store.identity.findOAuthTransactionByStateHash(hashSecret(state))
    if (!transaction) throw new AppError(400, '登录状态无效或已过期，请重新发起 Google 登录', 'invalid_state')
    if (expectedIntent !== null && transaction.intent !== expectedIntent) throw new AppError(409, expectedIntent === 'link' ? '该登录状态不属于绑定流程，请重新发起绑定' : '该登录状态不属于登录流程，请重新发起', 'intent_mismatch')
    if (transaction.consumedAt !== null) throw new AppError(409, '该登录状态已被使用，请重新发起 Google 登录', 'state_replayed')
    if (Date.parse(transaction.expiresAt) <= this.clock.now().getTime()) throw new AppError(410, '登录状态已过期，请重新发起 Google 登录', 'state_expired')
    return { id: transaction.id, stateHash: transaction.stateHash, nonce: transaction.nonce, codeVerifier: transaction.codeVerifier, returnTo: transaction.returnTo, issuer: transaction.issuer, intent: transaction.intent, userId: transaction.userId, sessionId: transaction.sessionId }
  }

  /**
   * 回调总入口：同一地址既处理登录也处理绑定，先看事务意图再分发。
   * 让路由层自己猜意图的话，以后新增一种意图就要在两处同步改判断，早晚会漏一处。
   */
  async callback(input: { readonly code?: unknown; readonly state?: unknown; readonly cookieState?: unknown; readonly client?: string; readonly session: LoginSession | null }): Promise<{ readonly kind: 'login'; readonly login: GoogleFinish } | { readonly kind: 'link'; readonly link: GoogleLinkFinish }> {
    if (await this.intentOf(input.state, input.cookieState) === 'link') {
      return { kind: 'link', link: await this.finishLink(input) }
    }
    return { kind: 'login', login: await this.finish({ ...input, supersede: input.session }) }
  }

  /** 只读意图探测：真正的校验仍由 finish/finishLink 做，探测失败一律当作登录流（错误文案更通用）。 */
  private async intentOf(state: unknown, cookieState: unknown): Promise<'login' | 'link'> {
    try {
      return (await this.loadTransaction(state, cookieState, null)).intent
    } catch {
      return 'login'
    }
  }

  /**
   * 回调：验证 ID token → 解析或建立账号 → 原子消费 state → 签发会话。
   * state 在验证成功后才消费：网络抖动可重试同一事务，而重放永远拿不到第二个会话。
   */
  async finish(input: { readonly code?: unknown; readonly state?: unknown; readonly cookieState?: unknown; readonly client?: string; readonly supersede?: LoginSession | null }): Promise<GoogleFinish> {
    const provider = this.provider()
    const transaction = await this.loadTransaction(input.state, input.cookieState, 'login')
    const code = input.code
    if (typeof code !== 'string' || code.length === 0 || code.length > 4096) throw new AppError(400, '缺少 Google 授权码，请重新发起登录', 'invalid_request')
    let claims: GoogleIdentityClaims
    try {
      claims = await this.verifier.verify({
        code,
        redirectUri: provider.redirectUri,
        codeVerifier: transaction.codeVerifier,
        expectedNonce: transaction.nonce,
        expectedIssuer: provider.issuer,
        clientId: provider.clientId,
        clientSecret: provider.clientSecret,
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 200) : String(error)
      await this.note('identity.oauth_failed', { provider: 'google', reason, stage: error instanceof GoogleExchangeError ? 'token_exchange' : error instanceof GoogleVerificationError ? 'id_token' : 'unknown' })
      if (error instanceof GoogleExchangeError) throw new AppError(502, 'Google 令牌交换失败，本次登录已中止；请稍后重新发起', 'google_unavailable')
      throw new AppError(401, 'Google 身份校验失败，本次登录已中止；请重新发起登录', 'google_verification_failed')
    }
    const at = this.clock.now()
    const consumedAt = at.toISOString() as Timestamp
    // 单次消费：并发回调只有一个能拿到会话。
    if (!(await this.input.store.transaction(tx => tx.identity.consumeOAuthTransaction({ stateHash: transaction.stateHash, consumedAt })))) {
      throw new AppError(409, '该登录状态已被使用，请重新发起 Google 登录', 'state_replayed')
    }
    const issued = await this.resolveAccount({ claims, client: input.client, supersede: input.supersede ?? null, returnTo: transaction.returnTo, consumedAt })
    return issued
  }

  /**
   * 发起绑定（Ticket 08 ②）：与登录同一套 state/nonce/PKCE，但事务记下发起账号与会话。
   * 回调必须来自同一个会话，否则一次误点就能把别人的 Google 身份绑到自己账号上。
   */
  async startLink(input: { readonly userId: UserId; readonly sessionId: string; readonly returnTo?: unknown }): Promise<GoogleStart> {
    const provider = this.provider()
    const at = this.clock.now()
    const state = randomBytes(32).toString('base64url')
    const nonce = randomBytes(16).toString('base64url')
    const codeVerifier = randomBytes(32).toString('base64url')
    const expiresAt = new Date(at.getTime() + this.transactionMs).toISOString() as Timestamp
    // 没传 returnTo 时回到全局设置页：账号安全面板就在这里，而 `/account` 并不是可路由地址。
    const returnTo = safeReturnTo(input.returnTo) ?? '/settings'
    const transaction = {
      id: randomUUID(),
      provider: 'google' as const,
      issuer: provider.issuer,
      stateHash: hashSecret(state),
      nonce,
      codeVerifier,
      intent: 'link' as const,
      userId: input.userId,
      sessionId: input.sessionId,
      returnTo,
      createdAt: at.toISOString() as Timestamp,
      expiresAt,
      consumedAt: null,
    }
    await this.input.store.transaction(async tx => {
      await tx.identity.saveOAuthTransaction(transaction)
      await tx.audit.append({
        id: randomUUID() as AuditEntryId, actorId: input.userId, action: 'credentials.login_method_bind_started',
        resource: { kind: 'user', id: input.userId }, result: 'succeeded', occurredAt: transaction.createdAt,
        metadata: { provider: 'google', intent: 'link' },
      })
    })
    const query = new URLSearchParams({
      client_id: provider.clientId,
      redirect_uri: provider.redirectUri,
      response_type: 'code',
      scope: googleScopes,
      state,
      nonce,
      code_challenge: createHash('sha256').update(codeVerifier).digest('base64url'),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    })
    return { authorizeUrl: `${googleAuthorizeEndpoint}?${query.toString()}`, state, expiresAt }
  }

  /**
   * 绑定回调：验证 ID token → 校验发起会话 → 单次消费 state → 落库绑定行。
   * 已绑到自己账号视为成功（幂等），已绑到别的账号一律 409，绝不静默抢绑。
   */
  async finishLink(input: { readonly code?: unknown; readonly state?: unknown; readonly cookieState?: unknown; readonly session: LoginSession | null }): Promise<GoogleLinkFinish> {
    const provider = this.provider()
    const transaction = await this.loadTransaction(input.state, input.cookieState, 'link')
    // 发起时的会话必须还活着且仍是同一个账号：退出登录、换账号、换浏览器都不能继续这次绑定。
    if (!input.session) throw new AppError(401, '绑定必须在发起它的已登录浏览器里完成，请重新登录后再试', 'session_required')
    if (transaction.userId === null || transaction.sessionId === null || input.session.id !== transaction.sessionId || input.session.userId !== transaction.userId) {
      await this.note('credentials.login_method_bind_rejected', { provider: 'google', reason: 'session_mismatch' }, transaction.userId)
      throw new AppError(409, '绑定请求来自另一个会话或账号，请在发起绑定的那个浏览器里完成', 'session_mismatch')
    }
    const code = input.code
    if (typeof code !== 'string' || code.length === 0 || code.length > 4096) throw new AppError(400, '缺少 Google 授权码，请重新发起绑定', 'invalid_request')
    let claims: GoogleIdentityClaims
    try {
      claims = await this.verifier.verify({
        code,
        redirectUri: provider.redirectUri,
        codeVerifier: transaction.codeVerifier,
        expectedNonce: transaction.nonce,
        expectedIssuer: provider.issuer,
        clientId: provider.clientId,
        clientSecret: provider.clientSecret,
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 200) : String(error)
      await this.note('credentials.login_method_bind_failed', { provider: 'google', reason, stage: error instanceof GoogleExchangeError ? 'token_exchange' : error instanceof GoogleVerificationError ? 'id_token' : 'unknown' }, transaction.userId)
      if (error instanceof GoogleExchangeError) throw new AppError(502, 'Google 令牌交换失败，本次绑定已中止；请稍后重新发起', 'google_unavailable')
      // 400 而不是 401：发起绑定的会话是好的，错的是这次回传的身份凭据；
      // 401 会被 Web 的全局拦截当成“会话失效”把用户登出。
      throw new AppError(400, 'Google 身份校验失败，本次绑定已中止；请重新发起', 'google_verification_failed')
    }
    const consumedAt = this.clock.now().toISOString() as Timestamp
    if (!(await this.input.store.transaction(tx => tx.identity.consumeOAuthTransaction({ stateHash: transaction.stateHash, consumedAt })))) {
      throw new AppError(409, '该绑定状态已被使用，请重新发起', 'state_replayed')
    }
    const issuer = normalizeGoogleIssuer(claims.issuer)
    const existing = await this.input.store.identity.findLoginIdentity('google', issuer, claims.subject)
    if (existing && existing.userId !== transaction.userId) {
      await this.note('credentials.login_method_bind_rejected', { provider: 'google', reason: 'identity_taken', identityId: existing.id }, transaction.userId)
      throw new AppError(409, '该 Google 账号已经绑定到本实例的另一个账号；请先在那个账号上解绑', 'identity_taken')
    }
    if (existing) {
      await this.note('credentials.login_method_bind_skipped', { provider: 'google', reason: 'already_bound', identityId: existing.id }, transaction.userId)
      return { identity: existing, alreadyBound: true, returnTo: transaction.returnTo }
    }
    const identity: ExternalLoginIdentity = {
      id: randomUUID(), provider: 'google', issuer, subject: claims.subject, userId: transaction.userId,
      emailAtSignIn: claims.email, emailVerified: claims.emailVerified, createdAt: consumedAt, lastSignInAt: consumedAt,
    }
    try {
      await this.input.store.transaction(async tx => {
        await tx.identity.saveLoginIdentity(identity)
        await tx.audit.append({
          id: randomUUID() as AuditEntryId, actorId: transaction.userId, action: 'credentials.login_method_bound',
          resource: { kind: 'user', id: transaction.userId! }, result: 'succeeded', occurredAt: consumedAt,
          metadata: { provider: 'google', identityId: identity.id, email: claims.email ? maskEmail(claims.email) : null, emailAuthority: isGoogleAuthoritativeEmail(claims) ? 'site_verified' : 'provider_claim' },
        })
      })
    } catch (error) {
      // 并发绑定：另一请求先落库，这里按既成事实返回，不产生第二行。
      if (error instanceof AppError && error.status === 409 && String(error.message).includes('登录身份')) {
        const raced = await this.input.store.identity.findLoginIdentity('google', issuer, claims.subject)
        if (raced && raced.userId === transaction.userId) return { identity: raced, alreadyBound: true, returnTo: transaction.returnTo }
      }
      throw error
    }
    return { identity, alreadyBound: false, returnTo: transaction.returnTo }
  }

  private async resolveAccount(input: { readonly claims: GoogleIdentityClaims; readonly client?: string; readonly supersede: LoginSession | null; readonly returnTo: string | null; readonly consumedAt: Timestamp }): Promise<GoogleFinish> {
    // 归一 issuer：两种等价写法必须落到同一个身份，不能让同一个人被当成两个账号。
    const claims: GoogleIdentityClaims = { ...input.claims, issuer: normalizeGoogleIssuer(input.claims.issuer) }
    const bound = await this.input.store.identity.findLoginIdentity('google', claims.issuer, claims.subject)
    if (bound) return this.signInBound({ ...input, bound })
    await this.assertRegistrationAllowed(claims.email)
    // Provider 声明的邮箱只有通过权威边界（设计 2.4）且本实例没有其他账号占用时，才能落成本站已验证主邮箱。
    const primaryEmail = isGoogleAuthoritativeEmail(claims) ? claims.email : null
    if (primaryEmail) {
      const owner = await this.input.store.identity.getUserByEmail(primaryEmail)
      if (owner) {
        await this.note('identity.oauth_email_conflict', { provider: 'google', email: maskEmail(primaryEmail) })
        throw new AppError(409, '该邮箱在本实例已有账号；请先用原有方式登录，再到账号安全设置里显式绑定 Google', 'email_conflict')
      }
    }
    const created = await this.createAccount({ claims, primaryEmail, at: input.consumedAt })
    if (created.raced) return this.signInBound({ ...input, bound: created.raced })
    await this.note(created.reused ? 'identity.oauth_signed_in' : 'identity.registered', {
      provider: 'google', authenticationMethod: 'google', subject: claims.subject,
      email: primaryEmail ? maskEmail(primaryEmail) : null, hostedDomain: claims.hostedDomain,
      emailAuthority: primaryEmail ? 'site_verified' : 'provider_claim',
    }, created.user.id)
    const issued = await this.input.identity.issue(created.user, input.client, 'google', input.supersede)
    return { issued, returnTo: input.returnTo }
  }

  private async signInBound(input: { readonly claims: GoogleIdentityClaims; readonly client?: string; readonly supersede: LoginSession | null; readonly returnTo: string | null; readonly consumedAt: Timestamp; readonly bound: ExternalLoginIdentity }): Promise<GoogleFinish> {
    const user = await this.input.store.identity.getUser(input.bound.userId)
    if (!user || (user.status ?? 'active') !== 'active') {
      await this.note('identity.oauth_orphaned_identity', { provider: 'google', identityId: input.bound.id })
      throw new AppError(409, '该 Google 身份绑定的账号不可用，请联系实例管理员', 'identity_orphaned')
    }
    await this.input.store.transaction(tx => tx.identity.touchLoginIdentity({ id: input.bound.id, lastSignInAt: input.consumedAt }))
    await this.note('identity.oauth_signed_in', { provider: 'google', authenticationMethod: 'google', identityId: input.bound.id }, user.id)
    const issued = await this.input.identity.issue(user, input.client, 'google', input.supersede)
    return { issued, returnTo: input.returnTo }
  }

  private async assertRegistrationAllowed(email?: string | null): Promise<void> {
    // 部署声明里写了这个邮箱：Google 首次登录也是实例管理员自己的建号路径，不受注册策略阻拦。
    if (this.input.identity.declaresAdministrator(email)) {
      await this.note('identity.oauth_registration_allowed', { provider: 'google', reason: 'declared_administrator' })
      return
    }
    const policy = await this.input.settings.policy()
    if (policy === 'closed') {
      await this.note('identity.oauth_rejected', { provider: 'google', reason: 'registration_closed' })
      throw new AppError(403, '本实例已关闭新账号注册；Google 登录仅对已有账号可用', 'registration_closed')
    }
    if (policy === 'invite_only') {
      await this.note('identity.oauth_rejected', { provider: 'google', reason: 'invitation_required' })
      throw new AppError(403, '本实例仅限邀请注册：请先通过团队邀请创建账号，再用 Google 登录', 'invitation_required')
    }
  }

  private async createAccount(input: { readonly claims: GoogleIdentityClaims; readonly primaryEmail: string | null; readonly at: Timestamp }): Promise<{ user: User; reused: boolean; raced: ExternalLoginIdentity | null }> {
    const { claims } = input
    // 非权威邮箱仍可用于推导展示名与用户名，但不写进本站已验证邮箱。
    const derivedFrom = input.primaryEmail ?? claims.email
    const display = claims.displayName ?? (derivedFrom ? derivedFrom.split('@')[0]! : `google-${claims.subject}`)
    try {
      const user = await this.input.store.transaction(async tx => {
        const taken = new Set((await tx.identity.listUsers()).map(candidate => candidate.username))
        const created: User = { id: randomUUID() as UserId, username: deriveUsername(display, name => taken.has(name)), email: input.primaryEmail, createdAt: input.at, status: 'active', authVersion: 0, statusChangedAt: input.at, deletedAt: null }
        const identity: ExternalLoginIdentity = {
          id: randomUUID(), provider: 'google', issuer: claims.issuer, subject: claims.subject, userId: created.id,
          emailAtSignIn: claims.email, emailVerified: claims.emailVerified, createdAt: input.at, lastSignInAt: input.at,
        }
        await tx.identity.saveUser(created)
        await tx.identity.saveLoginIdentity(identity)
        if (input.primaryEmail) {
          const email: UserEmail = { emailNormalized: input.primaryEmail, userId: created.id, emailDisplay: input.primaryEmail, createdAt: input.at }
          await tx.identity.saveUserEmail(email)
        }
        return created
      })
      return { user, reused: false, raced: null }
    } catch (error) {
      if (error instanceof AppError && error.status === 409 && String(error.message).includes('邮箱')) {
        await this.note('identity.oauth_email_conflict', { provider: 'google', email: input.primaryEmail ? maskEmail(input.primaryEmail) : null })
        throw new AppError(409, '该邮箱在本实例已有账号；请先用原有方式登录，再到账号安全设置里显式绑定 Google', 'email_conflict')
      }
      // 并发回调：另一个请求先建好了绑定，这里直接按既有绑定登录，不产生第二个账号。
      if (error instanceof AppError && error.status === 409 && String(error.message).includes('登录身份')) {
        const raced = await this.input.store.identity.findLoginIdentity('google', claims.issuer, claims.subject)
        if (raced) {
          const user = await this.input.store.identity.getUser(raced.userId)
          if (user) return { user, reused: true, raced }
        }
      }
      throw error
    }
  }

  /** 失败路径也要留痕；审计绝不写入 state、nonce、code 或 ID token。 */
  private async note(action: string, metadata: Readonly<Record<string, string | number | boolean | null>>, actorId: UserId | null = null): Promise<void> {
    try {
      await this.input.store.transaction(async tx => {
        await tx.audit.append({
          id: randomUUID() as AuditEntryId, actorId, action,
          resource: { kind: 'user', id: actorId ?? ('oauth-pending' as UserId) }, result: action.endsWith('_failed') || action.endsWith('_rejected') || action.endsWith('_conflict') || action.endsWith('_orphaned_identity') ? 'failed' : 'succeeded',
          occurredAt: this.clock.now().toISOString() as Timestamp, metadata,
        })
      })
    } catch { /* 审计失败不能把认证结果改成 500：主流程的可观测性由 session/账号事件兜底 */ }
  }
}
