import { randomBytes, randomUUID } from 'node:crypto'
import type { AuditEntryId, TeamId, Timestamp, UserId } from '@wemux/domain'
import type { LoginSession, User } from '@wemux/server-domain'
import type { ServerStore } from './ports/server-store.ts'
import type { AdministratorDirectory } from './administrator-directory.ts'
import { AppError } from './errors.ts'
import { hashSecret } from './auth.ts'
import { PasswordPolicyError, assertPasswordPolicy, hashPassword, passwordPolicy, verifyPassword } from './password.ts'

/** Injectable clock: idle/absolute expiry and rotation windows must be testable without waiting. */
export interface Clock { now(): Date }
export const systemClock: Clock = { now: () => new Date() }

/**
 * 冻结的会话默认值见 `docs/design/account-identity-system.md` 第 5 节：
 * 空闲 24 小时、绝对 7 天、重新认证窗口 5 分钟。绝对期限从不延长以伪装无限续期。
 */
export interface LoginSessionPolicy {
  readonly idleMs: number
  readonly absoluteMs: number
  /** 活跃请求最多每 5 分钟写一次 lastSeenAt，避免每请求一次写放大。 */
  readonly touchIntervalMs: number
  readonly reauthenticateMs: number
}

export const defaultLoginSessionPolicy: LoginSessionPolicy = {
  idleMs: 24 * 60 * 60 * 1000,
  absoluteMs: 7 * 24 * 60 * 60 * 1000,
  touchIntervalMs: 5 * 60 * 1000,
  reauthenticateMs: 5 * 60 * 1000,
}

/** Cookie 名可按安装隔离，避免同一主机/端口的两套部署误收对方会话。 */
export const defaultSessionCookieName = 'wemux_login_session'

export interface LoginSessionView {
  readonly id: string
  readonly current: boolean
  readonly authenticationMethod: string
  readonly client: string | null
  readonly authenticatedAt: Timestamp
  readonly createdAt: Timestamp
  readonly lastSeenAt: Timestamp
  readonly idleExpiresAt: Timestamp
  readonly absoluteExpiresAt: Timestamp
  readonly revokedAt: Timestamp | null
}

export interface IssuedLoginSession {
  /** 32 字节随机不透明令牌，明文只在本次响应出现一次。 */
  readonly token: string
  readonly csrfToken: string
  readonly session: LoginSession
  readonly user: User
  readonly teamId: TeamId | null
  readonly expiresAt: Timestamp
}

/** 落地页需要知道“有没有可用管理员”，但不得暴露声明邮箱本身。 */
export interface InstanceAccessOptions {
  /** 部署是否声明了管理员邮箱（`WEMUX_ADMIN_EMAILS` 非空）。 */
  readonly administratorConfigured: boolean
  /** 声明邮箱是否已经对应到一个已存在的账号；false 时部署者需要先注册该邮箱。 */
  readonly administratorRegistered: boolean
  readonly passwordMinimumLength: number
}

export interface AccountView {
  readonly user: User
  readonly teamId: TeamId | null
  readonly session: LoginSessionView
  /** 实例级权限：部署声明的管理员邮箱命中即 true（登录时已落盘归属）。Team 内角色不在此列，也不自动升级。 */
  readonly instanceAdministrator: boolean
  /** 仅在本次刷新轮换出新的 CSRF 令牌时出现，明文只此一次。 */
  readonly csrfToken?: string
  readonly csrfTokenRotated?: boolean
}

const maximumClientLength = 200
const timestamp = (date: Date): Timestamp => date.toISOString() as Timestamp
const clientLabel = (userAgent: string | undefined): string | null => {
  const value = userAgent?.trim()
  if (!value) return null
  return value.length > maximumClientLength ? value.slice(0, maximumClientLength) : value
}

/** 登录失败限流：单进程内滑动窗口，避免用登录请求打满 scrypt 与 CPU。 */
export class LoginThrottle {
  private readonly failures = new Map<string, number[]>()
  private readonly clock: Clock
  private readonly limit: number
  private readonly windowMs: number
  constructor(clock: Clock, limit = 10, windowMs = 15 * 60 * 1000) { this.clock = clock; this.limit = limit; this.windowMs = windowMs;}
  private recent(key: string, now: number): number[] {
    const kept = (this.failures.get(key) ?? []).filter(at => now - at < this.windowMs)
    if (kept.length) this.failures.set(key, kept)
    else this.failures.delete(key)
    return kept
  }
  /** @throws AppError 429 with Retry-After semantics when the window is exhausted. */
  assertAllowed(key: string): void {
    const now = this.clock.now().getTime()
    const kept = this.recent(key, now)
    if (kept.length < this.limit) return
    const retryAfterMs = this.windowMs - (now - kept[0]!)
    throw new AppError(429, `登录尝试过于频繁，请在 ${Math.max(1, Math.ceil(retryAfterMs / 60000))} 分钟后重试`, 'login_throttled')
  }
  recordFailure(key: string): void {
    const now = this.clock.now().getTime()
    this.failures.set(key, [...this.recent(key, now), now])
  }
  recordSuccess(key: string): void { this.failures.delete(key) }
}

const cookieNamePattern = /^[A-Za-z0-9._-]{1,64}$/

export class IdentityService {
  readonly cookieName: string
  private readonly throttle: LoginThrottle
  /** 无账号时的等价代价校验对象，避免用响应时间枚举账号。 */
  private readonly dummyHash: Promise<string>
  private readonly store: ServerStore
  private readonly administrators: AdministratorDirectory
  private readonly clock: Clock
  private readonly policy: LoginSessionPolicy
  constructor(
    store: ServerStore,
    administrators: AdministratorDirectory,
    clock: Clock = systemClock,
    policy: LoginSessionPolicy = defaultLoginSessionPolicy,
    cookieName = defaultSessionCookieName,
  ) { this.store = store; this.administrators = administrators; this.clock = clock; this.policy = policy;
    if (!cookieNamePattern.test(cookieName)) throw new Error('Session cookie name must be a simple token')
    this.cookieName = cookieName
    this.throttle = new LoginThrottle(clock)
    this.dummyHash = hashPassword(randomBytes(24).toString('base64url'))
  }

  static fromEnvironment(store: ServerStore, administrators: AdministratorDirectory, environment: NodeJS.ProcessEnv = process.env, clock: Clock = systemClock): IdentityService {
    return new IdentityService(store, administrators, clock, defaultLoginSessionPolicy, environment.WEMUX_SESSION_COOKIE_NAME ?? defaultSessionCookieName)
  }

  private assertPassword(password: unknown): asserts password is string {
    if (typeof password !== 'string') throw new AppError(400, '密码必须是字符串', 'invalid_request')
    try { assertPasswordPolicy(password) } catch (error) {
      if (error instanceof PasswordPolicyError) throw new AppError(400, error.message, 'invalid_request')
      throw error
    }
  }

  /**
   * 公开安全配置，供落地页决定显示“声明管理员”还是“登录”。
   * 不泄露账号名单、声明邮箱或任何哈希：只回答“声明了没有 / 该邮箱建号了没有”。
   */
  async options(): Promise<InstanceAccessOptions> {
    return {
      administratorConfigured: this.administrators.configured,
      administratorRegistered: this.administrators.configured ? await this.administrators.active() : false,
      passwordMinimumLength: passwordPolicy.minimumLength,
    }
  }

  private async defaultTeamId(userId: UserId): Promise<TeamId | null> {
    const memberships = await this.store.identity.listMemberships(userId)
    return memberships[0]?.teamId ?? null
  }

  private newSession(input: { user: User; authenticatedAt: Timestamp; client: string | null; method: LoginSession['authenticationMethod'] }): { session: LoginSession; token: string; csrfToken: string } {
    const token = randomBytes(32).toString('base64url')
    const csrfToken = randomBytes(32).toString('base64url')
    const createdAtMs = this.clock.now().getTime()
    const idleExpiresAtMs = Math.min(createdAtMs + this.policy.idleMs, Date.parse(input.authenticatedAt) + this.policy.absoluteMs - 1)
    const session: LoginSession = {
      id: randomUUID(),
      userId: input.user.id,
      tokenHash: hashSecret(token),
      csrfTokenHash: hashSecret(csrfToken),
      authenticationMethod: input.method,
      authVersion: input.user.authVersion ?? 0,
      authenticatedAt: input.authenticatedAt,
      createdAt: timestamp(new Date(createdAtMs)),
      lastSeenAt: timestamp(new Date(createdAtMs)),
      idleExpiresAt: timestamp(new Date(Math.max(idleExpiresAtMs, createdAtMs + 1))),
      absoluteExpiresAt: timestamp(new Date(Date.parse(input.authenticatedAt) + this.policy.absoluteMs)),
      revokedAt: null,
      client: input.client,
    }
    return { session, token, csrfToken }
  }

  /**
   * 建立登录会话并返回一次性明文令牌；调用方只把令牌写进 HttpOnly Cookie。
   * 声明邮箱命中的账号在同一事务里懒提升为实例管理员，因此升级既有部署不需要额外迁移命令。
   */
  async issue(user: User, client: string | undefined, method: LoginSession['authenticationMethod'] = 'password', supersede?: LoginSession | null): Promise<IssuedLoginSession> {
    const { session, token, csrfToken } = this.newSession({ user, authenticatedAt: timestamp(this.clock.now()), client: clientLabel(client), method })
    await this.store.transaction(async tx => {
      await tx.identity.saveLoginSession(session)
      // 登录即轮换：同浏览器先前持有的会话在成功登录后立即退役，避免留下无人持有的活跃令牌。
      if (supersede && supersede.userId === user.id && supersede.revokedAt === null) await tx.identity.revokeLoginSession(supersede.id, session.createdAt)
      await tx.audit.append({
        id: randomUUID() as AuditEntryId, actorId: user.id, action: 'session.login', resource: { kind: 'user', id: user.id },
        result: 'succeeded', occurredAt: session.createdAt, metadata: { sessionId: session.id, authenticationMethod: method },
      })
      await this.administrators.ensure(tx, user)
    })
    return { token, csrfToken, session, user, teamId: await this.defaultTeamId(user.id), expiresAt: session.idleExpiresAt }
  }

  /** 解析 Cookie 令牌；无效、被撤销或过期都返回 null，不区分原因以免探测。 */
  async resolveSession(token: string | undefined): Promise<LoginSession | null> {
    if (!token || token.length > 200) return null
    const tokenHash = hashSecret(token)
    const read = async (identity: ServerStore['identity']): Promise<'missing' | 'rejected' | LoginSession> => {
      const session = await identity.findLoginSessionByTokenHash(tokenHash)
      if (!session) return 'missing'
      if (session.revokedAt !== null) return 'rejected'
      const user = await identity.getUser(session.userId)
      if (!user || (user.status ?? 'active') !== 'active' || (user.authVersion !== undefined && (session.authVersion ?? 0) !== user.authVersion)) return 'rejected'
      const now = this.clock.now().getTime()
      if (now >= Date.parse(session.absoluteExpiresAt) || now >= Date.parse(session.idleExpiresAt)) return 'rejected'
      return session
    }
    const resolved = await read(this.store.identity)
    // Renewal cannot create a missing row or change an existing row's token hash.
    if (resolved === 'missing') return null
    if (resolved !== 'rejected') return resolved
    // Only a candidate rejection pays for BEGIN IMMEDIATE. A renewal may have
    // committed while the user read waited; recheck records and time in one FIFO lease.
    return this.store.transaction(async tx => {
      const rechecked = await read(tx.identity)
      return typeof rechecked === 'string' ? null : rechecked
    })
  }

  /** 空闲窗口滑动：仅在超过 touch 间隔时写一次，且不越过绝对期限。 */
  async touch(session: LoginSession): Promise<LoginSession> {
    return this.store.transaction(async tx => {
      // Read after the FIFO wait: another request may have renewed or revoked this snapshot.
      const current = await tx.identity.getLoginSession(session.id)
      const now = this.clock.now().getTime()
      if (!current || current.revokedAt !== null || now >= Date.parse(current.absoluteExpiresAt) || now >= Date.parse(current.idleExpiresAt)) throw new AppError(401, 'Unauthorized')
      if (now - Date.parse(current.lastSeenAt) < this.policy.touchIntervalMs) return current
      const idleExpiresAt = timestamp(new Date(Math.min(
        Math.max(Date.parse(current.idleExpiresAt), now + this.policy.idleMs),
        Date.parse(current.absoluteExpiresAt) - 1,
      )))
      const lastSeenAt = timestamp(new Date(now))
      await tx.identity.touchLoginSession({ id: current.id, lastSeenAt, idleExpiresAt })
      return { ...current, lastSeenAt, idleExpiresAt }
    })
  }

  /**
   * 浏览器刷新/新标签页后的 CSRF 引导：携带匹配令牌时不轮换（不影响其他标签页），
   * 缺失或不匹配则签发新令牌并返回明文一次。
   */
  async ensureCsrfToken(session: LoginSession, presented: string | undefined): Promise<{ session: LoginSession; csrfToken?: string }> {
    if (presented && hashSecret(presented) === session.csrfTokenHash) return { session }
    const csrfToken = randomBytes(32).toString('base64url')
    const csrfTokenHash = hashSecret(csrfToken)
    await this.store.transaction(tx => tx.identity.rotateLoginSessionCsrf({ id: session.id, csrfTokenHash }))
    return { session: { ...session, csrfTokenHash }, csrfToken }
  }

  /** Cookie 会话的跨站写保护：Origin 与 Host 必须一致，且必须回传 CSRF 令牌。 */
  assertUnsafeCookieRequestAllowed(session: LoginSession, input: { csrfToken?: string; origin?: string; host?: string }): void {
    if (input.origin) {
      let originHost: string
      try { originHost = new URL(input.origin).host } catch { throw new AppError(403, 'Origin 不合法', 'origin_rejected') }
      if (!input.host || originHost !== input.host) throw new AppError(403, '跨站请求被拒绝', 'origin_rejected')
    }
    if (!input.csrfToken || hashSecret(input.csrfToken) !== session.csrfTokenHash) throw new AppError(403, 'CSRF 令牌缺失或不匹配', 'csrf_rejected')
  }

  async login(input: { login: string; password: string; client?: string; throttleKey: string; supersede?: LoginSession | null }): Promise<IssuedLoginSession> {
    this.throttle.assertAllowed(input.throttleKey)
    const identity = input.login?.trim()
    if (!identity || identity.length > 320) throw new AppError(401, '账号或密码不正确', 'invalid_credentials')
    const user = await this.store.identity.getUserByLogin(identity) ?? await this.store.identity.getUserByLogin(identity.toLowerCase())
    const credential = user ? await this.store.identity.getLocalAccountCredential(user.id) : null
    if (typeof input.password !== 'string' || input.password.length > passwordPolicy.maximumLength) {
      this.throttle.recordFailure(input.throttleKey)
      throw new AppError(401, '账号或密码不正确', 'invalid_credentials')
    }
    // 未知账号也支付一次等价校验代价，避免以响应时间枚举账号。
    const verified = credential ? await verifyPassword(input.password, credential.passwordHash) : { ok: await verifyPassword(input.password, await this.dummyHash).then(result => result.ok), needsRehash: false }
    if (!user || !credential || !verified.ok || (user.status ?? 'active') !== 'active') {
      this.throttle.recordFailure(input.throttleKey)
      throw new AppError(401, '账号或密码不正确', 'invalid_credentials')
    }
    if (verified.needsRehash) {
      // 参数升级：验证成功（持有旧哈希的有效密码）后按当前参数重写，不改变账号归属。
      const upgraded = await hashPassword(input.password)
      await this.store.transaction(tx => tx.identity.saveLocalAccountCredential({ userId: user.id, passwordHash: upgraded, updatedAt: timestamp(this.clock.now()) }))
    }
    this.throttle.recordSuccess(input.throttleKey)
    return this.issue(user, input.client, 'password', input.supersede ?? null)
  }

  /** 部署声明的管理员邮箱命中即实例管理员；登录时已落盘归属，此判定可直接用于响应组装。 */
  async isAdministrator(userId: UserId): Promise<boolean> {
    return await this.administrators.isAdministrator(this.store.identity, userId)
  }

  /**
   * 声明命中（不管账号是否已存在）：部署者声明的邮箱就是授权根本身，
   * 注册流程据此豁免注册策略——否则默认 `invite_only` 会让部署者自己进不了门。
   */
  declaresAdministrator(email: string | null | undefined): boolean { return this.administrators.declares(email) }

  /** 会话归属用户：账号被删除时按未授权处理，不泄露原因。 */
  async user(userId: UserId): Promise<User> {
    const user = await this.store.identity.getUser(userId)
    if (!user || (user.status ?? 'active') !== 'active') throw new AppError(401, 'Unauthorized')
    return user
  }

  async logout(session: LoginSession): Promise<void> {
    const at = timestamp(this.clock.now())
    await this.store.transaction(async tx => {
      await tx.identity.revokeLoginSession(session.id, at)
      await tx.audit.append({ id: randomUUID() as AuditEntryId, actorId: session.userId, action: 'session.logout', resource: { kind: 'user', id: session.userId }, result: 'succeeded', occurredAt: at, metadata: { sessionId: session.id } })
    })
  }

  async logoutAll(userId: UserId, keep?: LoginSession): Promise<number> {
    const at = timestamp(this.clock.now())
    return this.store.transaction(async tx => {
      const sessions = await tx.identity.listLoginSessions(userId)
      let revoked = 0
      for (const session of sessions) {
        if (session.revokedAt !== null || session.id === keep?.id) continue
        await tx.identity.revokeLoginSession(session.id, at)
        revoked++
      }
      await tx.audit.append({ id: randomUUID() as AuditEntryId, actorId: userId, action: 'session.logout_all', resource: { kind: 'user', id: userId }, result: 'succeeded', occurredAt: at, metadata: { revoked } })
      return revoked
    })
  }

  view(session: LoginSession, currentId: string): LoginSessionView {
    return {
      id: session.id, current: session.id === currentId, authenticationMethod: session.authenticationMethod, client: session.client ?? null,
      authenticatedAt: session.authenticatedAt, createdAt: session.createdAt, lastSeenAt: session.lastSeenAt,
      idleExpiresAt: session.idleExpiresAt, absoluteExpiresAt: session.absoluteExpiresAt, revokedAt: session.revokedAt,
    }
  }

  /** 设备会话列表只暴露可安全展示的字段，绝不返回令牌或哈希；已撤销的会话不再计入活跃设备。 */
  async listSessions(userId: UserId, currentId: string): Promise<readonly LoginSessionView[]> {
    const sessions = await this.store.identity.listLoginSessions(userId)
    return sessions.filter(session => session.revokedAt === null).map(session => this.view(session, currentId))
  }

  async revokeSession(userId: UserId, sessionId: string): Promise<void> {
    const session = await this.store.identity.getLoginSession(sessionId)
    if (!session || session.userId !== userId) throw new AppError(404, '会话不存在', 'not_found')
    if (session.revokedAt !== null) return
    const at = timestamp(this.clock.now())
    await this.store.transaction(async tx => {
      await tx.identity.revokeLoginSession(sessionId, at)
      await tx.audit.append({ id: randomUUID() as AuditEntryId, actorId: userId, action: 'session.revoked', resource: { kind: 'user', id: userId }, result: 'succeeded', occurredAt: at, metadata: { sessionId } })
    })
  }

  async account(user: User, session: LoginSession, csrfToken?: string): Promise<AccountView> {
    return {
      user, teamId: await this.defaultTeamId(user.id), session: this.view(session, session.id),
      instanceAdministrator: await this.administrators.isAdministrator(this.store.identity, user.id),
      ...(csrfToken ? { csrfToken, csrfTokenRotated: true } : {}),
    }
  }
}