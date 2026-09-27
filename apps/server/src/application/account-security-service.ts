/**
 * 账号安全管理（Ticket 06 密码与邮箱恢复管理、Ticket 08 登录方式绑定与解绑）。
 *
 * 设计依据 `docs/design/account-identity-system.md` 第 2.4、3、5 节：
 * - 改密码、改邮箱、解绑登录方式都是“凭据面”操作：必须有旧密码或近期强认证之一；
 * - 新邮箱必须收到验证链接才算变更，旧邮箱同时收到通知（不是事后通知，而是进行中通知）；
 * - 邮箱冲突一律拒绝，绝不合并两个账号；旧邮箱上未消费的找回/变更链接在变更后立即失效；
 * - 登录身份以 `(issuer, subject)` 为唯一键，一个账号至少要保留一种可用登录方式。
 */
import { randomBytes, randomUUID } from 'node:crypto'
import type { AuditEntryId, Timestamp, UserId } from '@wemux/domain'
import type { ExternalLoginIdentity, LoginSession, User, UserEmail, VerificationChallenge } from '@wemux/server-domain'
import type { ServerStore, ServerStoreTx } from './ports/server-store.ts'
import { AppError } from './errors.ts'
import { hashSecret } from './auth.ts'
import { invalidEmailReason, maskEmail, normalizeEmail, type NormalizedEmail } from './email-address.ts'
import { PasswordPolicyError, assertPasswordPolicy, hashPassword, passwordPolicy, verifyPassword } from './password.ts'
import { changeEmailLink, type MailSettings, type OutgoingMail } from './mail/email-delivery.ts'
import { FlowThrottle } from './email-registration.ts'
import { systemClock, type Clock, type IdentityService, type LoginSessionPolicy } from './identity-service.ts'

export interface AccountSecurityPolicy {
  /** 无本地密码账号（Google-only）执行凭据面操作所需的近期强认证窗口。 */
  readonly reauthenticateMs: number
  /** 邮箱变更链接有效期：够用户去新邮箱点一下，又不会长期悬着。 */
  readonly emailChangeMs: number
}

export const defaultAccountSecurityPolicy: AccountSecurityPolicy = {
  reauthenticateMs: 5 * 60 * 1000,
  emailChangeMs: 60 * 60 * 1000,
}

/** 登录方式视图：只暴露可安全展示的字段，绝不返回 subject 之外的提供方内部标识或任何哈希。 */
export interface LoginMethodView {
  readonly kind: 'password' | 'google'
  /** 解绑接口使用的稳定标识：本地密码固定 `password`，外部身份用绑定行 id。 */
  readonly id: string
  readonly label: string
  readonly email: string | null
  readonly createdAt: Timestamp | null
  readonly lastSignInAt: Timestamp | null
  /** 只剩一种登录方式时 false：最后一种不可解绑。 */
  readonly removable: boolean
}

export interface AccountSecurityView {
  readonly methods: readonly LoginMethodView[]
  readonly passwordSet: boolean
  /** 当前主邮箱（展示用原文）；无主邮箱时为 null。 */
  readonly email: string | null
  readonly emailDelivery: boolean
  readonly emailDeliveryReason: string | null
  /** 当前会话是否处于近期强认证窗口内（Google-only 账号执行凭据面操作的依据）。 */
  readonly reauthenticated: boolean
  readonly reauthenticateWindowMs: number
}

export interface AccountSecurityInput {
  readonly store: ServerStore
  readonly identity: IdentityService
  readonly mail: MailSettings | null
  readonly mailReason?: string | null
  readonly clock?: Clock
  readonly policy?: AccountSecurityPolicy
  readonly sessionPolicy?: LoginSessionPolicy
  readonly throttles?: Readonly<{ password: FlowThrottle; emailChange: FlowThrottle }>
}

const timestamp = (date: Date): Timestamp => date.toISOString() as Timestamp

const defaultThrottles = (clock: Clock): Readonly<{ password: FlowThrottle; emailChange: FlowThrottle }> => ({
  password: new FlowThrottle(clock, 15 * 60 * 1000, [{ prefix: 'user:', limit: 10 }, { prefix: 'ip:', limit: 20 }, { prefix: 'global', limit: 120 }]),
  emailChange: new FlowThrottle(clock, 15 * 60 * 1000, [{ prefix: 'user:', limit: 5 }, { prefix: 'ip:', limit: 10 }, { prefix: 'global', limit: 60 }]),
})

export interface ChangePasswordOutcome {
  readonly status: 'changed'
  /** 本次是否为「从来没有本地密码」的账号首次设置密码。 */
  readonly created: boolean
  readonly revokedSessions: number
  readonly revokedTokens: number
}

export interface EmailChangeRequestOutcome {
  readonly status: 'accepted'
  readonly email: string
  readonly expiresAt: Timestamp
}

export interface EmailChangeOutcome {
  readonly status: 'changed'
  readonly email: string
  readonly previousEmail: string | null
}

export interface UnbindOutcome {
  readonly status: 'unbound'
  readonly kind: LoginMethodView['kind']
  readonly methods: readonly LoginMethodView[]
}

export class AccountSecurityService {
  private readonly clock: Clock
  private readonly policy: AccountSecurityPolicy
  private readonly sessionPolicy: LoginSessionPolicy
  private readonly throttles: Readonly<{ password: FlowThrottle; emailChange: FlowThrottle }>

  private readonly input: AccountSecurityInput

  constructor(input: AccountSecurityInput) { this.input = input;
    this.clock = input.clock ?? systemClock
    this.policy = input.policy ?? defaultAccountSecurityPolicy
    this.sessionPolicy = input.sessionPolicy ?? { idleMs: 0, absoluteMs: 0, touchIntervalMs: 0, reauthenticateMs: defaultAccountSecurityPolicy.reauthenticateMs }
    this.throttles = input.throttles ?? defaultThrottles(this.clock)
  }

  private requireMail(): MailSettings {
    if (!this.input.mail) throw new AppError(503, `本实例未配置邮件投递（${this.input.mailReason ?? '未配置'}），邮箱变更不可用；请联系实例管理员`, 'mail_unconfigured')
    return this.input.mail
  }

  /**
   * 强认证判定：有本地密码就必须重新提供旧密码，没有密码（Google-only）就必须处于近期强认证窗口内。
   * 只认服务端记录，不认前端传入的“我已认证”标记。
   *
   * 现密码输错一律 400：会话本身完全有效，错的是请求体里的那一个字段。
   * 用 401 会让 Web 的全局 401 拦截把用户登出（`api/client.ts` 见到 401 就调 `onUnauthorized`），
   * 变成“在设置里手一抖就被踢下线”。401 只留给“这次请求根本没有有效会话”。
   */
  private async assertStrongAuth(user: User, session: LoginSession, currentPassword: unknown): Promise<{ created: boolean }> {
    if (session.userId !== user.id) throw new AppError(401, 'Unauthorized')
    const credential = await this.input.store.identity.getLocalAccountCredential(user.id)
    if (credential) {
      if (typeof currentPassword !== 'string' || currentPassword.length === 0) throw new AppError(400, '请输入当前密码', 'current_password_required')
      if (currentPassword.length > passwordPolicy.maximumLength) throw new AppError(400, '当前密码不正确', 'current_password_invalid')
      const verified = await verifyPassword(currentPassword, credential.passwordHash)
      if (!verified.ok) throw new AppError(400, '当前密码不正确', 'current_password_invalid')
      return { created: false }
    }
    const age = this.clock.now().getTime() - Date.parse(session.authenticatedAt)
    if (age > this.reauthenticateMs()) {
      throw new AppError(403, '这是一次凭据操作，需要重新认证：请重新登录后再试', 'reauthentication_required')
    }
    return { created: true }
  }

  /** 无密码账号的强认证窗口取自会话策略，避免两处窗口各说各话。 */
  private reauthenticateMs(): number {
    return this.sessionPolicy.reauthenticateMs > 0 ? this.sessionPolicy.reauthenticateMs : this.policy.reauthenticateMs
  }

  private async methods(userId: UserId): Promise<readonly LoginMethodView[]> {
    const [credential, identities] = await Promise.all([
      this.input.store.identity.getLocalAccountCredential(userId),
      this.input.store.identity.listLoginIdentities(userId),
    ])
    const items: LoginMethodView[] = []
    if (credential) {
      items.push({ kind: 'password', id: 'password', label: '本地密码', email: null, createdAt: credential.updatedAt, lastSignInAt: null, removable: false })
    }
    for (const identity of identities) {
      items.push({
        kind: 'google', id: identity.id,
        label: identity.provider === 'google' ? 'Google' : identity.provider,
        email: identity.emailAtSignIn, createdAt: identity.createdAt, lastSignInAt: identity.lastSignInAt, removable: false,
      })
    }
    const removable = items.length > 1
    return items.map(item => ({ ...item, removable }))
  }

  /** 账号安全页所需的全部只读状态；不泄露哈希、subject 或令牌。 */
  async view(user: User, session: LoginSession): Promise<AccountSecurityView> {
    const [methods, primary] = await Promise.all([this.methods(user.id), this.input.store.identity.getUserEmail(user.id)])
    const window = this.reauthenticateMs()
    return {
      methods,
      passwordSet: methods.some(method => method.kind === 'password'),
      email: primary?.emailDisplay ?? user.email ?? null,
      emailDelivery: this.input.mail !== null,
      emailDeliveryReason: this.input.mail === null ? (this.input.mailReason ?? '未配置邮件投递') : null,
      reauthenticated: this.clock.now().getTime() - Date.parse(session.authenticatedAt) <= window,
      reauthenticateWindowMs: window,
    }
  }

  /**
   * 改密码（Ticket 06 ③ / Ticket 08 ①）：旧密码或近期强认证之后才接受新密码，
   * 新哈希一律按当前参数计算（等价于哈希升级）；其他会话与全部 PAT 立即撤销，当前会话保留。
   */
  async changePassword(request: { readonly user: User; readonly session: LoginSession; readonly currentPassword?: unknown; readonly newPassword?: unknown; readonly throttleKeys?: readonly string[] }): Promise<ChangePasswordOutcome> {
    const { user, session } = request
    this.throttles.password.consume(request.throttleKeys ?? [`user:${user.id}`])
    const { created } = await this.assertStrongAuth(user, session, request.currentPassword)
    this.assertPassword(request.newPassword)
    const passwordHash = await hashPassword(request.newPassword)
    const at = timestamp(this.clock.now())
    let revokedSessions = 0
    let revokedTokens = 0
    await this.input.store.transaction(async tx => {
      await tx.identity.saveLocalAccountCredential({ userId: user.id, passwordHash, updatedAt: at })
      // 密码换了，其他设备上的会话与所有 PAT 都不再代表账号持有者的最新意愿；当前会话保留以免操作者被踢出。
      revokedSessions = await revokeOtherSessions(tx, user.id, session.id, at)
      revokedTokens = await tx.identity.revokePersonalAccessTokens(user.id, at)
      await tx.audit.append({
        id: randomUUID() as AuditEntryId, actorId: user.id, action: created ? 'credentials.password_set' : 'credentials.password_changed',
        resource: { kind: 'user', id: user.id }, result: 'succeeded', occurredAt: at,
        metadata: { channel: created ? 'google_reauth' : 'current_password', revokedSessions, revokedTokens },
      })
    })
    await this.notify(user, passwordChangedMail, at)
    return { status: 'changed', created, revokedSessions, revokedTokens }
  }

  /**
   * 发起邮箱变更（Ticket 06 ④）：先验证新邮箱，同时通知旧邮箱；目标邮箱被占用直接拒绝，不合并账号。
   * 变更到生效之间账号主邮箱保持原样，所以任何一步失败都不会留下半改状态。
   */
  async requestEmailChange(request: { readonly user: User; readonly session: LoginSession; readonly newEmail?: unknown; readonly currentPassword?: unknown; readonly throttleKeys?: readonly string[] }): Promise<EmailChangeRequestOutcome> {
    const mail = this.requireMail()
    const { user, session } = request
    this.throttles.emailChange.consume(request.throttleKeys ?? [`user:${user.id}`])
    await this.assertStrongAuth(user, session, request.currentPassword)
    const target = this.normalize(request.newEmail)
    const current = await this.input.store.identity.getUserEmail(user.id)
    if (current && current.emailNormalized === target.normalized) throw new AppError(400, '新邮箱与当前邮箱相同', 'email_unchanged')
    const owner = await this.input.store.identity.getUserByEmail(target.normalized)
    if (owner && owner.id !== user.id) {
      await this.note('credentials.email_change_rejected', { email: maskEmail(target.normalized), reason: 'email_taken' }, user.id)
      throw new AppError(409, '该邮箱已被其他账号使用；请换一个邮箱，或先用那个账号登录后自行变更', 'email_taken')
    }
    const now = this.clock.now()
    const expiresAt = timestamp(new Date(now.getTime() + this.policy.emailChangeMs))
    const token = randomBytes(32).toString('base64url')
    const challenge: VerificationChallenge = {
      id: randomUUID(), tokenHash: hashSecret(token), purpose: 'change_email', targetEmail: target.normalized,
      registrationId: null, userId: user.id, previousEmail: current?.emailNormalized ?? null,
      createdAt: timestamp(now), expiresAt, consumedAt: null,
    }
    await this.input.store.transaction(async tx => {
      // 同一目标邮箱只保留一个有效链接；旧链接一律作废，避免一次操作产生多个可用凭据。
      await invalidateChallenges(tx, target.normalized, 'change_email', now)
      await tx.identity.saveVerificationChallenge(challenge)
      await tx.audit.append({
        id: randomUUID() as AuditEntryId, actorId: user.id, action: 'credentials.email_change_requested',
        resource: { kind: 'user', id: user.id }, result: 'succeeded', occurredAt: timestamp(now),
        metadata: { from: current ? maskEmail(current.emailNormalized) : null, to: maskEmail(target.normalized), expiresAt },
      })
    })
    await this.deliver(mail, changeEmailVerificationMail(mail, target, token, expiresAt))
    // 旧邮箱不是“事后通知”：变更没生效前就告诉持箱人有人在改，好让真正的持箱人来得及阻止。
    if (current) await this.deliver(mail, changeEmailRequestedMail(mail, current, target))
    return { status: 'accepted', email: maskEmail(target.normalized), expiresAt }
  }

  /** 消费邮箱变更链接：原子替换主邮箱占用并清理旧邮箱上的待用凭据。 */
  async confirmEmailChange(request: { readonly token?: unknown }): Promise<EmailChangeOutcome> {
    const mail = this.requireMail()
    const challenge = await this.loadChallenge(request.token, 'change_email')
    if (!challenge.userId) throw new AppError(400, '链接无效', 'invalid_token')
    const user = await this.input.store.identity.getUser(challenge.userId)
    if (!user) throw new AppError(400, '链接无效', 'invalid_token')
    const current = await this.input.store.identity.getUserEmail(user.id)
    const previousNormalized = challenge.previousEmail ?? null
    if ((current?.emailNormalized ?? null) !== previousNormalized) {
      // 期间已经发生过一次变更：旧链接绝不能覆盖更新的归属。
      await this.note('credentials.email_change_superseded', { email: maskEmail(challenge.targetEmail) }, user.id)
      throw new AppError(409, '该链接已失效：账号邮箱在此之后又变过，请重新发起邮箱变更', 'email_change_superseded')
    }
    const owner = await this.input.store.identity.getUserByEmail(challenge.targetEmail)
    if (owner && owner.id !== user.id) {
      await this.note('credentials.email_change_rejected', { email: maskEmail(challenge.targetEmail), reason: 'email_taken' }, user.id)
      throw new AppError(409, '该邮箱已被其他账号使用，本次变更已取消；请重新发起并换一个邮箱', 'email_taken')
    }
    const display = normalizeEmail(challenge.targetEmail)?.display ?? challenge.targetEmail
    const at = timestamp(this.clock.now())
    await this.input.store.transaction(async tx => {
      // user_emails 对 user_id 有 UNIQUE 约束（一个账号只有一行主邮箱），所以必须先撤掉旧行再写新行，
      // 否则新地址会被自己账号的旧行挡住，报成“邮箱已被占用”。
      if (previousNormalized) await tx.identity.deleteUserEmail(previousNormalized)
      await tx.identity.saveUserEmail({ emailNormalized: challenge.targetEmail, userId: user.id, emailDisplay: display, createdAt: at })
      await tx.identity.saveUser({ ...user, email: display })
      // 单次消费必须显式判定：并发重放的第二次确认要拿到明确的 409（并回滚），而不是写成两遍。
      if (!(await tx.identity.consumeVerificationChallenge({ tokenHash: challenge.tokenHash, consumedAt: at }))) {
        throw new AppError(409, '该链接刚刚已被使用；如需继续，请重新发起邮箱变更', 'token_consumed')
      }
      // 旧邮箱手上的找回链接从此不再指向这个账号：邮箱换了，恢复通道也必须跟着换。
      if (previousNormalized) {
        for (const purpose of ['reset_password', 'change_email', 'verify_email'] as const) {
          await invalidateChallenges(tx, previousNormalized, purpose, this.clock.now())
        }
      }
      await tx.audit.append({
        id: randomUUID() as AuditEntryId, actorId: user.id, action: 'credentials.email_changed',
        resource: { kind: 'user', id: user.id }, result: 'succeeded', occurredAt: at,
        metadata: { from: previousNormalized ? maskEmail(previousNormalized) : null, to: maskEmail(challenge.targetEmail) },
      })
    })
    await this.deliver(mail, changeEmailCompletedMail(mail, display, previousNormalized))
    if (previousNormalized) await this.deliver(mail, oldAddressMail(mail, previousNormalized, display))
    return { status: 'changed', email: display, previousEmail: previousNormalized }
  }

  /**
   * 解绑登录方式（Ticket 08 ③）：必须在强认证之后，且不允许把账号解到没有任何可用登录方式。
   * 解绑有本地密码、无外部身份的账号会直接失败（remaining 为 0）。
   */
  async unbind(request: { readonly user: User; readonly session: LoginSession; readonly methodId?: unknown; readonly currentPassword?: unknown; readonly throttleKeys?: readonly string[] }): Promise<UnbindOutcome> {
    const { user, session } = request
    this.throttles.password.consume(request.throttleKeys ?? [`user:${user.id}`])
    const methods = await this.methods(user.id)
    const methodId = typeof request.methodId === 'string' ? request.methodId : ''
    const target = methods.find(method => method.id === methodId)
    if (!target) throw new AppError(404, '该登录方式不存在或已解绑', 'login_method_not_found')
    if (methods.length <= 1) {
      await this.note('credentials.login_method_unbind_rejected', { method: target.kind, reason: 'last_login_method' }, user.id)
      throw new AppError(409, '这是账号目前唯一的登录方式，解绑后将无法登录；请先绑定另一种登录方式', 'last_login_method')
    }
    await this.assertStrongAuth(user, session, request.currentPassword)
    const at = timestamp(this.clock.now())
    await this.input.store.transaction(async tx => {
      if (target.kind === 'password') await tx.identity.deleteLocalAccountCredential(user.id)
      else await tx.identity.deleteLoginIdentity(target.id)
      await tx.audit.append({
        id: randomUUID() as AuditEntryId, actorId: user.id, action: 'credentials.login_method_unbound',
        resource: { kind: 'user', id: user.id }, result: 'succeeded', occurredAt: at,
        metadata: { method: target.kind },
      })
      if (target.kind === 'password') {
        // 去掉密码意味着账号不再有密码凭据：所有 PAT 随之失效，避免旧令牌继续代表账号。
        await tx.identity.revokePersonalAccessTokens(user.id, at)
      }
    })
    return { status: 'unbound', kind: target.kind, methods: await this.methods(user.id) }
  }

  /** 绑定完成后的只读回执：让 Web 能立刻重画登录方式列表。 */
  async afterBind(userId: UserId): Promise<readonly LoginMethodView[]> { return this.methods(userId) }

  private assertPassword(password: unknown): asserts password is string {
    if (typeof password !== 'string') throw new AppError(400, '密码必须是字符串', 'invalid_request')
    try { assertPasswordPolicy(password) } catch (error) {
      if (error instanceof PasswordPolicyError) throw new AppError(400, error.message, 'invalid_password')
      throw error
    }
  }

  private normalize(value: unknown): NormalizedEmail {
    const reason = invalidEmailReason(value)
    if (reason) throw new AppError(400, reason, 'invalid_email')
    const normalized = normalizeEmail(value)
    if (!normalized) throw new AppError(400, '邮箱地址格式不正确', 'invalid_email')
    return normalized
  }

  private async loadChallenge(token: unknown, purpose: VerificationChallenge['purpose']): Promise<VerificationChallenge> {
    if (typeof token !== 'string' || token.length === 0 || token.length > 200) throw new AppError(400, '链接无效', 'invalid_token')
    const challenge = await this.input.store.identity.findVerificationChallengeByTokenHash(hashSecret(token))
    if (!challenge) throw new AppError(400, '链接无效：可能已被使用，或从未签发', 'invalid_token')
    if (challenge.purpose !== purpose) throw new AppError(400, '该链接不能用于邮箱变更', 'wrong_purpose')
    if (challenge.consumedAt !== null) throw new AppError(409, '该链接已被使用；如需继续，请重新发起邮箱变更', 'token_consumed')
    if (Date.parse(challenge.expiresAt) <= this.clock.now().getTime()) throw new AppError(410, '链接已过期，请重新发起邮箱变更', 'token_expired')
    return challenge
  }

  private async deliver(mail: MailSettings, message: OutgoingMail): Promise<void> {
    try {
      await mail.delivery.deliver(message)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await this.note('identity.email_delivery_failed', { reason: reason.slice(0, 200) })
      throw new AppError(502, `邮件发送失败：${reason.slice(0, 200)}。流程尚未完成，请稍后重试或联系实例管理员`, 'delivery_failed')
    }
  }

  /** 通知邮件是尽力而为：投递失败不能把已经生效的凭据变更报成失败。 */
  private async notify(user: User, template: (mail: MailSettings, email: NormalizedEmail) => OutgoingMail, at: Timestamp): Promise<void> {
    const mail = this.input.mail
    if (!mail) return
    const primary = await this.input.store.identity.getUserEmail(user.id)
    // 主邮箱是 UserEmail 行（带展示原文）；没有行时退回 User.email，两者都统一成规范化地址再发给模板。
    const target = primary ? normalizeEmail(primary.emailNormalized) : (user.email ? normalizeEmail(user.email) : null)
    if (!target) return
    try {
      await mail.delivery.deliver(template(mail, target))
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await this.note('identity.email_delivery_failed', { reason: reason.slice(0, 200), template: template.name || 'notice', at })
    }
  }

  /** 失败与后台路径也要留痕；审计绝不写入密码、令牌或链接。 */
  private async note(action: string, metadata: Readonly<Record<string, string | number | boolean | null>>, actorId: UserId | null = null): Promise<void> {
    try {
      await this.input.store.transaction(async tx => {
        await tx.audit.append({
          id: randomUUID() as AuditEntryId, actorId, action,
          resource: { kind: 'user', id: actorId ?? ('account-security' as UserId) }, result: 'succeeded',
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

/** 撤销除当前会话以外的全部会话：改密码不该把操作者自己踢下线，但其他设备必须重新登录。 */
async function revokeOtherSessions(tx: ServerStoreTx, userId: UserId, keepSessionId: string, at: Timestamp): Promise<number> {
  let revoked = 0
  for (const session of await tx.identity.listLoginSessions(userId)) {
    if (session.revokedAt !== null || session.id === keepSessionId) continue
    await tx.identity.revokeLoginSession(session.id, at)
    revoked++
  }
  return revoked
}

const mailBody = (title: string, lines: readonly string[]): string => [title, '', ...lines, '', '如果不是你本人操作，请立即登录并修改密码，必要时联系实例管理员。'].join('\n')

function changeEmailVerificationMail(mail: MailSettings, target: NormalizedEmail, token: string, expiresAt: Timestamp): OutgoingMail {
  const minutes = Math.max(1, Math.round((Date.parse(expiresAt) - Date.now()) / 60000))
  return {
    to: target.display,
    subject: '确认把这个邮箱设为你的 Wemux 账号邮箱',
    text: mailBody('确认新增 Wemux 账号邮箱', [
      '点击下面的链接确认把这个邮箱设为你 Wemux 账号的主邮箱：',
      changeEmailLink(mail.publicUrl, token),
      '',
      `链接在 ${minutes} 分钟内有效，且只能使用一次。确认之前账号邮箱不会改变。`,
    ]),
  }
}

function changeEmailRequestedMail(mail: MailSettings, oldAddress: UserEmail, newAddress: NormalizedEmail): OutgoingMail {
  return {
    to: oldAddress.emailDisplay,
    subject: '你的 Wemux 账号收到一次邮箱变更请求',
    text: mailBody('有人请求把 Wemux 账号邮箱改为另一个地址', [
      `目标邮箱：${maskEmail(newAddress.normalized)}`,
      '变更尚未生效：需要目标邮箱收到确认链接并点击后才会完成。',
      `如果这不是你的操作，请立即登录并修改密码：${mail.publicUrl}/`,
    ]),
  }
}

function changeEmailCompletedMail(mail: MailSettings, newAddress: string, oldAddress: string | null): OutgoingMail {
  return {
    to: newAddress,
    subject: '你的 Wemux 账号邮箱已变更为这个邮箱',
    text: mailBody('Wemux 账号邮箱变更已完成', [
      oldAddress ? `原邮箱：${maskEmail(oldAddress)}` : '该账号此前没有已验证邮箱。',
      `此后登录、找回与安全通知都发到这里。如果不是你的操作，请立即通过本邮箱找回密码：${mail.publicUrl}/forgot-password`,
    ]),
  }
}

function oldAddressMail(mail: MailSettings, previousEmail: string, target: string): OutgoingMail {
  return {
    to: previousEmail,
    subject: '你的 Wemux 账号已改用新邮箱',
    text: mailBody('这个邮箱不再是 Wemux 账号邮箱', [
      `账号邮箱已改为：${maskEmail(target)}`,
      '此后本邮箱不再接收该账号的登录、找回或安全通知；如非本人操作，请立即联系实例管理员。',
    ]),
  }
}

function passwordChangedMail(mail: MailSettings, email: NormalizedEmail): OutgoingMail {
  return {
    to: email.display,
    subject: '你的 Wemux 账号密码已更新',
    text: mailBody('Wemux 账号密码已更新', [
      '密码刚刚被修改，其他设备上的登录会话与全部访问令牌已同步撤销。',
      `如果不是你本人操作，请立即通过邮箱找回并修改密码：${mail.publicUrl}/forgot-password`,
    ]),
  }
}