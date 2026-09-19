import { randomBytes, randomUUID } from 'node:crypto'
import type { AuditEntryId, Timestamp, UserId } from '@wemux/domain'
import type { ServerStore } from './ports/server-store.js'
import type { AdministratorDirectory } from './administrator-directory.js'
import { AppError } from './errors.js'
import { assertPasswordPolicy, hashPassword, passwordPolicy, PasswordPolicyError } from './password.js'
import { systemClock, type Clock } from './identity-service.js'

/** 恢复入口只在本机进程内使用；它不注册任何 HTTP 路由，也不提供任何在线提权。 */
export interface RecoveryAccountView {
  readonly userId: UserId
  readonly username: string
  readonly email: string | null
  readonly hasLocalPassword: boolean
  readonly activeSessions: number
  readonly activeTokens: number
}

export interface RecoveryReport {
  readonly login: string
  readonly userId: UserId
  /** 只有本次生成或显式传入的密码会返回；它必须被打印一次后丢弃，绝不写日志或审计。 */
  readonly password: string | null
  readonly revokedSessions: number
  readonly revokedTokens: number
}

export interface RevocationReport {
  readonly login: string
  readonly userId: UserId
  readonly revokedSessions: number
  readonly revokedTokens: number
}

/** 生成一次性强密码：主机本地恢复不能依赖交互，也不能要求安装者自己想密码。 */
export const generateRecoveryPassword = (): string => randomBytes(18).toString('base64url')

/**
 * 主机本地账号恢复（Ticket 04 验收项 6）。
 * 设计约束（`docs/design/account-identity-system.md` 第 2、4 节）：
 * 丢失管理员凭据的路径必须显式、可审计，且不能在公网重新开启任何提权入口。
 * 因此这里不隐藏提权：重置部署声明的管理员邮箱账号时，同时把归属写进
 * `instance_administrators`（`source='recovery'`）并留下审计，而不是让身份只在配置里隐式存在。
 */
export class AccountRecovery {
  constructor(private readonly store: ServerStore, private readonly administrators: AdministratorDirectory, private readonly clock: Clock = systemClock) {}

  private async target(login: string) {
    const trimmed = login.trim()
    if (!trimmed) throw new AppError(400, '必须显式指定账号（邮箱或用户名）', 'recovery_target_required')
    const user = await this.store.identity.getUserByLogin(trimmed)
    if (!user) throw new AppError(404, `找不到账号 ${trimmed}`, 'recovery_target_unknown')
    return user
  }

  /** 列出候选账号及凭据面，让安装者显式选择目标，而不是让命令去猜"应该恢复谁"。 */
  async accounts(): Promise<readonly RecoveryAccountView[]> {
    const users = await this.store.identity.listUsers()
    const tokens = await this.store.identity.listPersonalAccessTokens()
    return Promise.all(users.map(async user => {
      const [credential, sessions] = await Promise.all([
        this.store.identity.getLocalAccountCredential(user.id),
        this.store.identity.listLoginSessions(user.id),
      ])
      return {
        userId: user.id,
        username: user.username,
        email: user.email,
        hasLocalPassword: credential !== null,
        activeSessions: sessions.filter(session => session.revokedAt === null).length,
        activeTokens: tokens.filter(token => token.userId === user.id && token.revokedAt === null).length,
      }
    }))
  }

  private async requireAdministrator(): Promise<void> {
    // 没声明管理员邮箱就没有可恢复的实例管理员：正确做法是写配置，而不是在这里提权。
    if (!this.administrators.configured) {
      throw new AppError(409, '实例尚未声明管理员；请在 Server 启动配置的 WEMUX_ADMIN_EMAILS 中声明部署者邮箱后重启，恢复命令不会代为声明', 'administrator_not_configured')
    }
  }

  /** 重置本机密码并撤销该账号的全部浏览器会话与 PAT：旧凭据不能在恢复后继续有效。 */
  async resetPassword(input: { login: string; password?: string; keepTokens?: boolean }): Promise<RecoveryReport> {
    await this.requireAdministrator()
    const user = await this.target(input.login)
    const password = input.password ?? generateRecoveryPassword()
    try { assertPasswordPolicy(password) } catch (error) {
      if (error instanceof PasswordPolicyError) throw new AppError(400, error.message, 'password_policy')
      throw error
    }
    const at = this.clock.now().toISOString() as Timestamp
    const passwordHash = await hashPassword(password)
    const revokedSessions = await this.store.transaction(async tx => {
      const sessions = await tx.identity.revokeLoginSessions(user.id, at)
      const tokens = input.keepTokens ? 0 : await tx.identity.revokePersonalAccessTokens(user.id, at)
      await tx.identity.saveLocalAccountCredential({ userId: user.id, passwordHash, updatedAt: at })
      await tx.audit.append({
        id: randomUUID() as AuditEntryId, actorId: user.id, action: 'credentials.recovered',
        resource: { kind: 'user', id: user.id }, result: 'succeeded', occurredAt: at,
        metadata: { channel: 'host-local', revokedSessions: sessions, revokedTokens: tokens },
      })
      // 主机本地重置声明邮箱的账号 = 部署者本人回来：同时补上缺失的管理员归属，
      // 否则“声明了邮箱但归属还没落盘”的实例在恢复后会看起来没有任何管理员。
      await this.administrators.ensure(tx, user, 'recovery')
      return { sessions, tokens }
    })
    return { login: user.username, userId: user.id, password, revokedSessions: revokedSessions.sessions, revokedTokens: revokedSessions.tokens }
  }

  /** 只撤销凭据（泄露、丢失设备），不改密码：撤销范围显式可选。 */
  async revokeCredentials(input: { login: string; tokens?: boolean }): Promise<RevocationReport> {
    await this.requireAdministrator()
    const user = await this.target(input.login)
    const at = this.clock.now().toISOString() as Timestamp
    return await this.store.transaction(async tx => {
      const sessions = await tx.identity.revokeLoginSessions(user.id, at)
      const tokens = input.tokens ? await tx.identity.revokePersonalAccessTokens(user.id, at) : 0
      await tx.audit.append({
        id: randomUUID() as AuditEntryId, actorId: user.id, action: 'credentials.revoked',
        resource: { kind: 'user', id: user.id }, result: 'succeeded', occurredAt: at,
        metadata: { channel: 'host-local', revokedSessions: sessions, revokedTokens: tokens },
      })
      return { login: user.username, userId: user.id, revokedSessions: sessions, revokedTokens: tokens }
    })
  }
}

export { passwordPolicy }