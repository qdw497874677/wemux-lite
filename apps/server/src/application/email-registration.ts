import { randomBytes, randomUUID } from 'node:crypto'
import type { AuditEntryId, Timestamp, UserId } from '@wemux/domain'
import type { LocalAccountCredential, RegistrationAttempt, RegistrationPolicy, User, UserEmail, VerificationChallenge } from '@wemux/server-domain'
import type { ServerStore, ServerStoreTx } from './ports/server-store.js'
import { AppError } from './errors.js'
import { hashSecret } from './auth.js'
import { invalidEmailReason, maskEmail, normalizeEmail, type NormalizedEmail } from './email-address.js'
import { PasswordPolicyError, assertPasswordPolicy, hashPassword, passwordPolicy } from './password.js'
import { verificationLink, passwordResetLink, type MailSettings, type OutgoingMail } from './mail/email-delivery.js'
import { systemClock, type Clock, type IdentityService, type IssuedLoginSession } from './identity-service.js'
import type { InstanceSettingsService } from './instance-settings.js'

/**
 * 邮箱注册、验证与找回（Ticket 05）。
 *
 * 设计依据 `docs/design/account-identity-system.md` 第 2.2、2.3、5 节：
 * - 策略决定允许哪些流程，路由只负责收集输入；服务端判定绝不依赖前端隐藏按钮；
 * - 待验证注册不产生 User、不授予任何资源权限，验证成功时原子创建账号；
 * - 验证邮件 24 小时、重置 30 分钟，挑战只存哈希、单次消费、用途不可互换；
 * - 重复注册/重发/找回返回统一提示并受多维限流，不泄漏账号是否存在；
 * - 没有邮件配置就明确不可用，绝不模拟“邮件已发送”。
 */

export interface EmailVerificationPolicy {
  /** 验证邮件有效期（设计建议 24 小时）。 */
  readonly verificationMs: number
  /** 重置密码有效期（设计建议 30 分钟）。 */
  readonly resetMs: number
}

export const defaultEmailVerificationPolicy: EmailVerificationPolicy = {
  verificationMs: 24 * 60 * 60 * 1000,
  resetMs: 30 * 60 * 1000,
}

export interface ThrottleRule {
  /** 键前缀，例如 `ip:`、`email:`、`global`。 */
  readonly prefix: string
  readonly limit: number
}

/**
 * 滑动窗口限流：注册、重发、找回各一组维度。
 * 计数在进程内存里，重启清零；键数量有上限，避免被随机邮箱撑爆内存。
 */
export class FlowThrottle {
  private readonly hits = new Map<string, number[]>()

  constructor(
    private readonly clock: Clock = systemClock,
    private readonly windowMs: number = 15 * 60 * 1000,
    private readonly rules: readonly ThrottleRule[] = [],
    private readonly maxKeys = 5_000,
  ) {}

  private limitFor(key: string): number {
    const rule = this.rules.find(candidate => key.startsWith(candidate.prefix))
    return rule?.limit ?? Number.MAX_SAFE_INTEGER
  }

  private prune(now: number): void {
    for (const [key, stamps] of this.hits) {
      const kept = stamps.filter(stamp => now - stamp < this.windowMs)
      if (kept.length === 0) this.hits.delete(key)
      else this.hits.set(key, kept)
    }
    while (this.hits.size > this.maxKeys) {
      const oldest = this.hits.keys().next().value
      if (oldest === undefined) break
      this.hits.delete(oldest)
    }
  }

  /** 记录本次请求并判定：本请求计入窗口，超限抛 429 且给出可重试秒数。 */
  consume(keys: readonly string[]): void {
    const now = this.clock.now().getTime()
    this.prune(now)
    for (const key of keys) this.hits.set(key, [...(this.hits.get(key) ?? []), now])
    for (const key of keys) {
      const stamps = this.hits.get(key) ?? []
      const limit = this.limitFor(key)
      if (stamps.length <= limit) continue
      const oldest = stamps[stamps.length - limit]!
      const seconds = Math.max(1, Math.ceil((this.windowMs - (now - oldest)) / 1000))
      throw new AppError(429, `请求过于频繁，请在 ${seconds} 秒后重试`, 'rate_limited')
    }
  }
}

export interface RegistrationCapabilities {
  readonly registrationPolicy: RegistrationPolicy
  readonly emailDelivery: boolean
  readonly emailDeliveryReason: string | null
  readonly passwordMinimumLength: number
  readonly passwordMaximumLength: number
  readonly verificationTtlMs: number
  readonly resetTtlMs: number
}

/** 统一提示：新注册、重复注册、已存在账号都返回同一形状，不泄漏账号是否存在。 */
export interface AcceptedOutcome {
  readonly status: 'accepted'
  readonly email: string
}

export interface VerifiedOutcome {
  readonly status: 'verified'
  readonly issued: IssuedLoginSession
}

export interface AccountExistsOutcome {
  readonly status: 'account_exists'
  readonly email: string
}

export interface ResetOutcome {
  readonly status: 'reset'
  readonly revokedSessions: number
  readonly revokedTokens: number
}

export interface EmailRegistrationServiceInput {
  readonly store: ServerStore
  readonly identity: IdentityService
  readonly settings: InstanceSettingsService
  /** null 表示没有邮件投递路径：邮箱自助注册/找回一律不可用。 */
  readonly mail: MailSettings | null
  readonly mailReason?: string | null
  readonly clock?: Clock
  readonly policy?: EmailVerificationPolicy
  readonly throttles?: Readonly<{ register: FlowThrottle; resend: FlowThrottle; forgot: FlowThrottle }>
}

const defaultThrottles = (clock: Clock): Readonly<{ register: FlowThrottle; resend: FlowThrottle; forgot: FlowThrottle }> => ({
  register: new FlowThrottle(clock, 15 * 60 * 1000, [{ prefix: 'ip:', limit: 10 }, { prefix: 'email:', limit: 3 }, { prefix: 'global', limit: 120 }]),
  resend: new FlowThrottle(clock, 15 * 60 * 1000, [{ prefix: 'ip:', limit: 5 }, { prefix: 'email:', limit: 3 }, { prefix: 'global', limit: 60 }]),
  forgot: new FlowThrottle(clock, 15 * 60 * 1000, [{ prefix: 'ip:', limit: 10 }, { prefix: 'email:', limit: 3 }, { prefix: 'global', limit: 60 }]),
})

const timestamp = (date: Date): Timestamp => date.toISOString() as Timestamp

/**
 * 显示名称转唯一登录名：User 记录目前只有 `username` 一个可展示字段，
 * 因此显示名称在这里被规范化为句柄，并在冲突时追加序号（不静默合并两个账号）。
 */
export function deriveUsername(candidate: string, taken: (name: string) => boolean): string {
  const base = candidate.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-._]+/, '').replace(/[-._]+$/, '')
  const stem = (base.length >= 3 ? base : `user-${base}`).slice(0, 32)
  if (!taken(stem)) return stem
  for (let index = 2; index <= 9; index += 1) {
    const next = `${stem}-${index}`
    if (!taken(next)) return next
  }
  return `${stem.slice(0, 27)}-${randomBytes(2).toString('hex')}`
}

const emailBodyLines = (title: string, lines: readonly string[]): string => [`${title}`, '', ...lines, '', '如果不是你本人操作，忽略这封邮件即可；在你完成操作前，该链接无法用于其他账号。'].join('\n')

export class EmailRegistrationService {
  private readonly clock: Clock
  private readonly verification: EmailVerificationPolicy
  private readonly throttles: Readonly<{ register: FlowThrottle; resend: FlowThrottle; forgot: FlowThrottle }>

  constructor(private readonly input: EmailRegistrationServiceInput) {
    this.clock = input.clock ?? systemClock
    this.verification = input.policy ?? defaultEmailVerificationPolicy
    this.throttles = input.throttles ?? defaultThrottles(this.clock)
  }

  /** 公开安全配置：策略与邮件可用性必须让前端如实呈现，不能靠隐藏表单限制。 */
  async capabilities(): Promise<RegistrationCapabilities> {
    return {
      registrationPolicy: await this.input.settings.policy(),
      emailDelivery: this.input.mail !== null,
      emailDeliveryReason: this.input.mail === null ? (this.input.mailReason ?? '未配置邮件投递') : null,
      passwordMinimumLength: passwordPolicy.minimumLength,
      passwordMaximumLength: passwordPolicy.maximumLength,
      verificationTtlMs: this.verification.verificationMs,
      resetTtlMs: this.verification.resetMs,
    }
  }

  /**
   * 提交注册：创建待验证注册并发送验证邮件。
   * 账号已存在时改发“账号已存在”通知，响应与新建注册完全一致。
   */
  async register(request: { readonly email: unknown; readonly displayName: unknown; readonly password: unknown; readonly throttleKeys: readonly string[] }): Promise<AcceptedOutcome> {
    const email = this.normalize(request.email)
    await this.assertFlowAllowed(email.normalized)
    const mail = this.requireMail()
    const displayName = typeof request.displayName === 'string' ? request.displayName.trim() : ''
    if (displayName.length === 0) throw new AppError(400, '请提供显示名称', 'invalid_display_name')
    if (displayName.length > 64) throw new AppError(400, '显示名称过长', 'invalid_display_name')
    this.assertPassword(request.password)
    this.throttles.register.consume(request.throttleKeys)
    const existing = await this.input.store.identity.getUserByEmail(email.normalized)
    if (existing) {
      await this.deliver(mail, accountExistsMail(mail, email))
      await this.note('identity.registration_duplicate', { email: maskEmail(email.normalized) })
      return { status: 'accepted', email: maskEmail(email.normalized) }
    }
    const passwordHash = await hashPassword(request.password)
    const now = this.clock.now()
    const expiresAt = timestamp(new Date(now.getTime() + this.verification.verificationMs))
    const taken = new Set((await this.input.store.identity.listUsers()).map(user => user.username))
    const attempt: RegistrationAttempt = {
      id: randomUUID(),
      emailNormalized: email.normalized,
      emailDisplay: email.display,
      username: deriveUsername(displayName, name => taken.has(name)),
      passwordHash,
      status: 'pending',
      createdAt: timestamp(now),
      expiresAt,
      consumedAt: null,
      userId: null,
    }
    const token = this.newToken()
    const challenge: VerificationChallenge = {
      id: randomUUID(), tokenHash: hashSecret(token), purpose: 'verify_email', targetEmail: email.normalized,
      registrationId: attempt.id, userId: null, createdAt: timestamp(now), expiresAt, consumedAt: null,
    }
    await this.input.store.transaction(async tx => {
      const previous = await tx.identity.findPendingRegistration(email.normalized)
      if (previous) {
        // 最新一次提交获胜：旧待验证注册与其验证链接一起失效，避免两个密码都能激活同一邮箱。
        await tx.identity.updateRegistrationAttempt({ ...previous, status: 'superseded', consumedAt: timestamp(now) })
        await invalidateChallenges(tx, email.normalized, 'verify_email', now)
      }
      await tx.identity.saveRegistrationAttempt(attempt)
      await tx.identity.saveVerificationChallenge(challenge)
      await tx.audit.append({
        id: randomUUID() as AuditEntryId, actorId: null, action: 'identity.registration_started',
        resource: { kind: 'user', id: 'registration-pending' as UserId }, result: 'succeeded', occurredAt: timestamp(now),
        metadata: { registrationId: attempt.id, email: maskEmail(email.normalized), expiresAt },
      })
    })
    await this.deliver(mail, verificationMail(mail, email, token, expiresAt))
    return { status: 'accepted', email: maskEmail(email.normalized) }
  }

  /** 重发验证邮件：只有存在未过期待验证注册时才真的发信，响应形状保持不变。 */
  async resend(request: { readonly email: unknown; readonly throttleKeys: readonly string[] }): Promise<AcceptedOutcome> {
    const email = this.normalize(request.email)
    await this.assertFlowAllowed(email.normalized)
    const mail = this.requireMail()
    this.throttles.resend.consume(request.throttleKeys)
    const now = this.clock.now()
    const pending = await this.input.store.identity.findPendingRegistration(email.normalized)
    if (!pending || Date.parse(pending.expiresAt) <= now.getTime()) {
      const existing = await this.input.store.identity.getUserByEmail(email.normalized)
      if (existing) await this.deliver(mail, accountExistsMail(mail, email))
      return { status: 'accepted', email: maskEmail(email.normalized) }
    }
    const token = this.newToken()
    // 新链接的有效期不超过待验证注册本身，过期注册不能用重发续命。
    const challenge: VerificationChallenge = {
      id: randomUUID(), tokenHash: hashSecret(token), purpose: 'verify_email', targetEmail: email.normalized,
      registrationId: pending.id, userId: null, createdAt: timestamp(now), expiresAt: pending.expiresAt, consumedAt: null,
    }
    await this.input.store.transaction(async tx => {
      await invalidateChallenges(tx, email.normalized, 'verify_email', now)
      await tx.identity.saveVerificationChallenge(challenge)
      await tx.audit.append({
        id: randomUUID() as AuditEntryId, actorId: null, action: 'identity.verification_resent',
        resource: { kind: 'user', id: 'registration-pending' as UserId }, result: 'succeeded', occurredAt: timestamp(now),
        metadata: { registrationId: pending.id, email: maskEmail(email.normalized), expiresAt: pending.expiresAt },
      })
    })
    await this.deliver(mail, verificationMail(mail, email, token, pending.expiresAt))
    return { status: 'accepted', email: maskEmail(email.normalized) }
  }

  /** 消费验证链接：原子创建可登录账号并直接签发登录会话。 */
  async verify(request: { readonly token: unknown; readonly client?: string }): Promise<VerifiedOutcome | AccountExistsOutcome> {
    const challenge = await this.loadChallenge(request.token, 'verify_email')
    if (!challenge.registrationId) throw new AppError(400, '验证链接无效', 'invalid_token')
    const attempt = await this.input.store.identity.getRegistrationAttempt(challenge.registrationId)
    if (!attempt) throw new AppError(400, '验证链接无效', 'invalid_token')
    const now = this.clock.now()
    if (attempt.status !== 'pending') {
      await this.consume(challenge, now)
      throw new AppError(409, '该注册已被更新的提交取代，请重新注册或直接登录', 'registration_superseded')
    }
    if (Date.parse(attempt.expiresAt) <= now.getTime()) {
      await this.input.store.transaction(async tx => {
        await tx.identity.updateRegistrationAttempt({ ...attempt, status: 'expired' })
        await tx.identity.consumeVerificationChallenge({ tokenHash: challenge.tokenHash, consumedAt: timestamp(now) })
      })
      throw new AppError(410, '验证链接已过期，请重新发送验证邮件', 'token_expired')
    }
    const masked = maskEmail(attempt.emailNormalized)
    const existing = await this.input.store.identity.getUserByEmail(attempt.emailNormalized)
    if (existing) {
      // 邮箱已有账号（并发注册的败者）：绝不覆盖既有密码，引导走登录/找回。
      await this.consume(challenge, now)
      return { status: 'account_exists', email: masked }
    }
    const at = timestamp(now)
    let user: User | null = null
    try {
      await this.input.store.transaction(async tx => {
        const taken = new Set((await tx.identity.listUsers()).map(candidate => candidate.username))
        const created: User = { id: randomUUID() as UserId, username: deriveUsername(attempt.username, name => taken.has(name)), email: attempt.emailDisplay, createdAt: at }
        const credential: LocalAccountCredential = { userId: created.id, passwordHash: attempt.passwordHash, updatedAt: at }
        const email: UserEmail = { emailNormalized: attempt.emailNormalized, userId: created.id, emailDisplay: attempt.emailDisplay, createdAt: at }
        await tx.identity.saveUser(created)
        await tx.identity.saveLocalAccountCredential(credential)
        await tx.identity.saveUserEmail(email)
        await tx.identity.updateRegistrationAttempt({ ...attempt, status: 'verified', consumedAt: at, userId: created.id })
        await tx.identity.consumeVerificationChallenge({ tokenHash: challenge.tokenHash, consumedAt: at })
        await tx.audit.append({
          id: randomUUID() as AuditEntryId, actorId: created.id, action: 'identity.registered',
          resource: { kind: 'user', id: created.id }, result: 'succeeded', occurredAt: at,
          metadata: { email: masked, registrationId: attempt.id, authenticationMethod: 'password' },
        })
        user = created
      })
    } catch (error) {
      if (error instanceof AppError && error.code === 'email_taken') return { status: 'account_exists', email: masked }
      throw error
    }
    const issued = await this.input.identity.issue(user as unknown as User, request.client, 'password')
    return { status: 'verified', issued }
  }

  /** 发起找回：只有存在本地密码凭据的账号才收到重置链接；Google-only 账号不被隐式加密码。 */
  async forgotPassword(request: { readonly email: unknown; readonly throttleKeys: readonly string[] }): Promise<AcceptedOutcome> {
    const mail = this.requireMail()
    const email = this.normalize(request.email)
    this.throttles.forgot.consume(request.throttleKeys)
    const now = this.clock.now()
    const masked = maskEmail(email.normalized)
    const user = await this.input.store.identity.getUserByEmail(email.normalized)
    if (!user) return { status: 'accepted', email: masked }
    const credential = await this.input.store.identity.getLocalAccountCredential(user.id)
    if (!credential) {
      await this.deliver(mail, googleAccountMail(mail, email))
      await this.note('identity.recovery_without_local_credential', { email: masked, userId: user.id })
      return { status: 'accepted', email: masked }
    }
    const token = this.newToken()
    const expiresAt = timestamp(new Date(now.getTime() + this.verification.resetMs))
    const challenge: VerificationChallenge = {
      id: randomUUID(), tokenHash: hashSecret(token), purpose: 'reset_password', targetEmail: email.normalized,
      registrationId: null, userId: user.id, createdAt: timestamp(now), expiresAt, consumedAt: null,
    }
    await this.input.store.transaction(async tx => {
      await invalidateChallenges(tx, email.normalized, 'reset_password', now)
      await tx.identity.saveVerificationChallenge(challenge)
      await tx.audit.append({
        id: randomUUID() as AuditEntryId, actorId: user.id, action: 'credentials.reset_requested',
        resource: { kind: 'user', id: user.id }, result: 'succeeded', occurredAt: timestamp(now),
        metadata: { email: masked, expiresAt },
      })
    })
    await this.deliver(mail, resetMail(mail, email, token, expiresAt))
    return { status: 'accepted', email: masked }
  }

  /** 消费重置链接：更新密码并撤销全部登录会话与 PAT，使用者必须重新登录。 */
  async resetPassword(request: { readonly token: unknown; readonly password: unknown }): Promise<ResetOutcome> {
    const challenge = await this.loadChallenge(request.token, 'reset_password')
    if (!challenge.userId) throw new AppError(400, '重置链接无效', 'invalid_token')
    this.assertPassword(request.password)
    const passwordHash = await hashPassword(request.password)
    const at = timestamp(this.clock.now())
    let revokedSessions = 0
    let revokedTokens = 0
    await this.input.store.transaction(async tx => {
      const user = await tx.identity.getUser(challenge.userId!)
      if (!user) throw new AppError(400, '重置链接无效', 'invalid_token')
      await tx.identity.saveLocalAccountCredential({ userId: user.id, passwordHash, updatedAt: at })
      await tx.identity.consumeVerificationChallenge({ tokenHash: challenge.tokenHash, consumedAt: at })
      revokedSessions = await tx.identity.revokeLoginSessions(user.id, at)
      revokedTokens = await tx.identity.revokePersonalAccessTokens(user.id, at)
      await tx.audit.append({
        id: randomUUID() as AuditEntryId, actorId: user.id, action: 'credentials.reset',
        resource: { kind: 'user', id: user.id }, result: 'succeeded', occurredAt: at,
        metadata: { channel: 'email_reset', revokedSessions, revokedTokens },
      })
    })
    return { status: 'reset', revokedSessions, revokedTokens }
  }

  private async assertFlowAllowed(email?: string | null): Promise<void> {
    // 部署声明里写了这个邮箱：注册策略约束其他所有人，不约束实例管理员自己。
    if (this.input.identity.declaresAdministrator(email)) {
      if ((await this.input.settings.policy()) !== 'open') {
        await this.note('identity.registration_allowed', { email: maskEmail(email ?? ''), reason: 'declared_administrator' })
      }
      return
    }
    const policy = await this.input.settings.policy()
    if (policy === 'closed') throw new AppError(403, '本实例已关闭邮箱注册', 'registration_closed')
    if (policy === 'invite_only') throw new AppError(403, '本实例仅限邀请注册：请通过有效的团队邀请链接创建账号', 'invitation_required')
  }

  private requireMail(): MailSettings {
    if (!this.input.mail) throw new AppError(503, `本实例未配置邮件投递（${this.input.mailReason ?? '未配置'}），邮箱自助注册与找回不可用；请联系实例管理员`, 'mail_unconfigured')
    return this.input.mail
  }

  private normalize(value: unknown): NormalizedEmail {
    const reason = invalidEmailReason(value)
    if (reason) throw new AppError(400, reason, 'invalid_email')
    const normalized = normalizeEmail(value)
    if (!normalized) throw new AppError(400, '邮箱地址格式不正确', 'invalid_email')
    return normalized
  }

  private assertPassword(password: unknown): asserts password is string {
    if (typeof password !== 'string') throw new AppError(400, '密码必须是字符串', 'invalid_request')
    try { assertPasswordPolicy(password) } catch (error) {
      if (error instanceof PasswordPolicyError) throw new AppError(400, error.message, 'invalid_password')
      throw error
    }
  }

  private newToken(): string { return randomBytes(32).toString('base64url') }

  private async loadChallenge(token: unknown, purpose: VerificationChallenge['purpose']): Promise<VerificationChallenge> {
    if (typeof token !== 'string' || token.length === 0 || token.length > 200) throw new AppError(400, '链接无效', 'invalid_token')
    const challenge = await this.input.store.identity.findVerificationChallengeByTokenHash(hashSecret(token))
    if (!challenge) throw new AppError(400, '链接无效：可能已被使用，或从未签发', 'invalid_token')
    if (challenge.purpose !== purpose) throw new AppError(400, purpose === 'verify_email' ? '该链接不能用于验证邮箱' : '该链接不能用于重置密码', 'wrong_purpose')
    if (challenge.consumedAt !== null) throw new AppError(409, '该链接已被使用；如需继续，请重新发起', 'token_consumed')
    if (Date.parse(challenge.expiresAt) <= this.clock.now().getTime()) {
      // 过期链接被点击时顺手把待验证注册标为过期，不让数据库里留下永远不会再成功的 pending 行。
      if (purpose === 'verify_email' && challenge.registrationId) await this.expireRegistration(challenge.registrationId, challenge.tokenHash)
      throw new AppError(410, purpose === 'verify_email' ? '验证链接已过期，请重新发送验证邮件' : '重置链接已过期，请重新发起找回', 'token_expired')
    }
    return challenge
  }

  private async expireRegistration(registrationId: string, tokenHash: string): Promise<void> {
    try {
      const attempt = await this.input.store.identity.getRegistrationAttempt(registrationId)
      if (!attempt || attempt.status !== 'pending') return
      const at = timestamp(this.clock.now())
      await this.input.store.transaction(async tx => {
        await tx.identity.updateRegistrationAttempt({ ...attempt, status: 'expired' })
        await tx.identity.consumeVerificationChallenge({ tokenHash, consumedAt: at })
      })
    } catch { /* 过期登记是清理动作：失败不能把 410 变成 500 */ }
  }

  private async consume(challenge: VerificationChallenge, now: Date): Promise<void> {
    await this.input.store.transaction(async tx => { await tx.identity.consumeVerificationChallenge({ tokenHash: challenge.tokenHash, consumedAt: timestamp(now) }) })
  }

  private async deliver(mail: MailSettings, message: OutgoingMail): Promise<void> {
    try {
      await mail.delivery.deliver(message)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await this.note('identity.email_delivery_failed', { reason: reason.slice(0, 200) })
      throw new AppError(502, `验证邮件发送失败：${reason.slice(0, 200)}。流程尚未完成，请稍后重试或联系实例管理员`, 'delivery_failed')
    }
  }

  /** 失败路径也要留痕，但审计绝不写入令牌、链接或邮件正文。 */
  private async note(action: string, metadata: Readonly<Record<string, string | number | boolean | null>>): Promise<void> {
    try {
      await this.input.store.transaction(async tx => {
        await tx.audit.append({
          id: randomUUID() as AuditEntryId, actorId: null, action,
          resource: { kind: 'user', id: 'registration-pending' as UserId }, result: 'succeeded',
          occurredAt: timestamp(this.clock.now()), metadata,
        })
      })
    } catch { /* 审计失败不能改变对外语义 */ }
  }
}

/** 同用途的历史挑战在签发新链接时全部作废：同一时刻只有一个有效链接。 */
async function invalidateChallenges(tx: ServerStoreTx, targetEmail: string, purpose: VerificationChallenge['purpose'], now: Date): Promise<void> {
  const since = new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000).toISOString() as Timestamp
  for (const challenge of await tx.identity.listVerificationChallenges(targetEmail, purpose, since)) {
    if (challenge.consumedAt === null) await tx.identity.consumeVerificationChallenge({ tokenHash: challenge.tokenHash, consumedAt: timestamp(now) })
  }
}

function verificationMail(mail: MailSettings, email: NormalizedEmail, token: string, expiresAt: Timestamp): OutgoingMail {
  const hours = Math.max(1, Math.round((Date.parse(expiresAt) - Date.now()) / (60 * 60 * 1000)))
  return {
    to: email.display,
    subject: '验证你的 Wemux 邮箱',
    text: emailBodyLines('请验证你的邮箱以完成 Wemux 账号注册', [
      '点击下面的链接完成验证（先打开确认页，再点击确认按钮）：',
      verificationLink(mail.publicUrl, token),
      '',
      `链接在 ${hours} 小时内有效，且只能使用一次。`,
    ]),
  }
}

function resetMail(mail: MailSettings, email: NormalizedEmail, token: string, expiresAt: Timestamp): OutgoingMail {
  const minutes = Math.max(1, Math.round((Date.parse(expiresAt) - Date.now()) / (60 * 1000)))
  return {
    to: email.display,
    subject: '重置你的 Wemux 密码',
    text: emailBodyLines('重置 Wemux 密码', [
      '点击下面的链接设置新密码：',
      passwordResetLink(mail.publicUrl, token),
      '',
      `链接在 ${minutes} 分钟内有效，且只能使用一次。重置成功后所有登录会话与访问令牌都会被撤销。`,
    ]),
  }
}

function accountExistsMail(mail: MailSettings, email: NormalizedEmail): OutgoingMail {
  return {
    to: email.display,
    subject: '你的 Wemux 账号已存在',
    text: emailBodyLines('该邮箱已经注册过 Wemux', [
      '如果你刚才尝试注册，请注意：这个邮箱已经有账号了，本次注册没有创建新账号，也没有修改原密码。',
      `直接登录：${mail.publicUrl}/`,
      `忘记密码：${mail.publicUrl}/forgot-password`,
    ]),
  }
}

function googleAccountMail(mail: MailSettings, email: NormalizedEmail): OutgoingMail {
  return {
    to: email.display,
    subject: '你的 Wemux 账号使用 Google 登录',
    text: emailBodyLines('该账号目前通过 Google 登录', [
      '为避免在你不知情时创建本地密码，我们没有签发重置链接。',
      `请用 Google 继续登录：${mail.publicUrl}/`,
      '登录后可在“账号安全”页重新认证并设置本地密码。',
    ]),
  }
}