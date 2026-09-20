import type { TeamId, Timestamp, UserId } from '@wemux/domain'

export type TeamRole = 'owner' | 'admin' | 'member'

export interface User {
  readonly id: UserId
  readonly username: string
  readonly email: string | null
  readonly createdAt: Timestamp
}

/** Password hashes are stored separately from the public User record. */
export interface LocalAccountCredential {
  readonly userId: UserId
  readonly passwordHash: string
  readonly updatedAt: Timestamp
}

/** 会话的认证方式：本地密码或外部 OIDC 身份；仅用于展示与审计，不参与鉴权判定。 */
export type LoginSessionAuthenticationMethod = 'password' | 'google'

/**
 * Browser login sessions are not PATs and never expose their stored token hash.
 * 32 字节随机不透明登录令牌，服务端只保存哈希；明文仅在签发响应中出现一次。
 */
export interface LoginSession {
  readonly id: string
  readonly userId: UserId
  readonly tokenHash: string
  readonly csrfTokenHash: string
  readonly authenticationMethod: LoginSessionAuthenticationMethod
  /** 设备列表展示用的客户端标签（User-Agent 截断），不含任何秘密。 */
  readonly client: string | null
  readonly authenticatedAt: Timestamp
  readonly createdAt: Timestamp
  readonly lastSeenAt: Timestamp
  readonly idleExpiresAt: Timestamp
  readonly absoluteExpiresAt: Timestamp
  readonly revokedAt: Timestamp | null
}

/**
 * 实例管理员归属。权威来源是 Server 启动配置里声明的邮箱（`WEMUX_ADMIN_EMAILS`），
 * 这条记录只承担两件事：把“谁在何时、按哪种来源成为管理员”落成可审计事实，
 * 以及在声明邮箱之后账号改邮箱时不静默丢掉管理员身份。它不是可自助申请的状态。
 */
export interface InstanceAdministrator {
  readonly userId: UserId
  /** 判定时使用的规范化邮箱（trim + 小写）；只用于比对与展示。 */
  readonly email: string
  readonly assignedAt: Timestamp
  /** declared = 命中部署声明的邮箱；recovery = 主机本地恢复流程显式提升。 */
  readonly source: 'declared' | 'recovery'
}

/**
 * 实例级注册策略：决定允许哪些账号创建流程，客户端隐藏按钮不构成限制。
 * `invite_only` 要求持有有效邀请；初始化完成前所有公开注册关闭。
 */
export type RegistrationPolicy = 'open' | 'invite_only' | 'closed'

/** 实例设置是单例记录；未落盘时使用代码内默认值，不把默认值写进数据库。 */
export interface InstanceSettings {
  readonly id: 'instance'
  readonly registrationPolicy: RegistrationPolicy
  readonly updatedAt: Timestamp
  readonly updatedBy: UserId | null
}

/**
 * 主邮箱占用记录：一个 User 一个已规范化主邮箱。
 * `emailDisplay` 保留用户原始书写形式，唯一性与登录匹配只用 `emailNormalized`。
 */
export interface UserEmail {
  readonly emailNormalized: string
  readonly userId: UserId
  readonly emailDisplay: string
  readonly createdAt: Timestamp
}

/**
 * 待验证注册：验证成功前不产生 User、不授予任何资源权限。
 * 密码在提交时就以带盐哈希保存，验证成功时连同 User 原子落盘。
 */
export type RegistrationStatus = 'pending' | 'verified' | 'expired' | 'superseded'

export interface RegistrationAttempt {
  readonly id: string
  readonly emailNormalized: string
  readonly emailDisplay: string
  readonly username: string
  readonly passwordHash: string
  /** 团队邀请注册的令牌哈希；旧记录没有该字段，读取时等同 null。 */
  readonly invitationTokenHash?: string | null
  readonly status: RegistrationStatus
  readonly createdAt: Timestamp
  readonly expiresAt: Timestamp
  readonly consumedAt: Timestamp | null
  /** 验证成功后才出现的账号归属；pending 阶段必须为 null。 */
  readonly userId: UserId | null
}

/** 用途不可互换：验证邮件挑战不能当成密码重置或邮箱变更凭据使用。 */
export type VerificationPurpose = 'verify_email' | 'reset_password' | 'change_email'

/** 只保存令牌哈希；明文只在邮件链接中出现一次。 */
export interface VerificationChallenge {
  readonly id: string
  readonly tokenHash: string
  readonly purpose: VerificationPurpose
  readonly targetEmail: string
  /** 待验证注册挑战的归属；与 `userId` 互斥。 */
  readonly registrationId: string | null
  /** 已有账号挑战（找回、邮箱变更）的归属；与 `registrationId` 互斥。 */
  readonly userId: UserId | null
  /**
   * 邮箱变更挑战发起时的主邮箱。消费时若账号主邮箱已不是它，说明期间又发生了变更，
   * 该链接必须作废重发，绝不用一个旧链接覆盖更新的归属（Ticket 06）。
   */
  readonly previousEmail?: string | null
  readonly createdAt: Timestamp
  readonly expiresAt: Timestamp
  readonly consumedAt: Timestamp | null
}

/**
 * 外部登录身份（Ticket 07）：以规范化的 `(issuer, subject)` 唯一识别账号。
 * 邮箱只是身份提供方的声明，不是身份主键，也不参与唯一性判定。
 */
export type LoginIdentityProvider = 'google'

export interface ExternalLoginIdentity {
  readonly id: string
  readonly provider: LoginIdentityProvider
  /** 规范化后的 issuer；Google 的 `accounts.google.com` 与 `https://accounts.google.com` 归一到同一写法。 */
  readonly issuer: string
  readonly subject: string
  readonly userId: UserId
  /** 绑定时提供方声明的邮箱（原样保留用于展示与排查），绝不作为已验证主邮箱使用。 */
  readonly emailAtSignIn: string | null
  /** 提供方对上述邮箱的证明状态；未声明时一律按 false 记录。 */
  readonly emailVerified: boolean
  readonly createdAt: Timestamp
  readonly lastSignInAt: Timestamp
}

/**
 * OIDC 登录事务（Ticket 07）。state 只保存哈希；nonce 与 PKCE verifier 是短期待验证材料，
 * 只存在于服务端存储，绝不写进 URL 后续跳转、日志或浏览器存储。
 * `link` 意图预留给“已登录账号显式绑定”（Ticket 08），本票只创建 `login`。
 */
export type OAuthIntent = 'login' | 'link'

export interface OAuthTransaction {
  readonly id: string
  readonly provider: LoginIdentityProvider
  readonly issuer: string
  readonly stateHash: string
  readonly nonce: string
  readonly codeVerifier: string
  readonly intent: OAuthIntent
  /** `link` 意图的发起账号与会话；`login` 意图必须为 null。 */
  readonly userId: UserId | null
  readonly sessionId: string | null
  /** 登录成功后的站内跳转路径（相对路径，登录时校验），不构成开放重定向。 */
  readonly returnTo: string | null
  readonly createdAt: Timestamp
  readonly expiresAt: Timestamp
  readonly consumedAt: Timestamp | null
}

export interface Team {
  readonly id: TeamId
  readonly name: string
  readonly createdAt: Timestamp
}

export interface Membership {
  readonly teamId: TeamId
  readonly userId: UserId
  readonly role: TeamRole
  readonly joinedAt: Timestamp
}

export type TeamInvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired'

/**
 * Team invitation is email-directed and single-use. Only the token hash is durable;
 * the plaintext token exists solely in the creation response and delivery channel.
 */
export interface TeamInvitation {
  readonly id: string
  readonly teamId: TeamId
  readonly emailNormalized: string
  readonly emailDisplay: string
  readonly role: Exclude<TeamRole, 'owner'>
  readonly tokenHash: string
  readonly invitedBy: UserId
  readonly createdAt: Timestamp
  readonly expiresAt: Timestamp
  readonly consumedAt: Timestamp | null
  readonly revokedAt: Timestamp | null
}
