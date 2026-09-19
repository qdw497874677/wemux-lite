import { createHash } from 'node:crypto'
import type { UserId, WorkerId } from '@wemux/domain'
import type { LoginSession } from '@wemux/server-domain'
import type { ServerStore } from './ports/server-store.js'
import type { AdministratorDirectory } from './administrator-directory.js'
import { AppError } from './errors.js'

export const hashSecret = (secret: string): string => createHash('sha256').update(secret).digest('hex')

/** 一次请求的凭据组合：HttpOnly Cookie 登录会话与 Bearer 凭证互不冒充。 */
export interface RequestCredential {
  readonly bearer?: string
  readonly loginSession?: LoginSession | null
}

/** 已退役的浏览器会话令牌前缀：升级后即使残留在客户端也不再具备任何权限。 */
export const retiredSessionPrefix = 'wemux-session-'

/**
 * 集群控制面的凭证校验：PAT、Worker 凭据、Cookie 登录会话。
 * 浏览器登录会话由 `IdentityService` 校验并滑动，这里只做权威判定，不重复存储逻辑。
 * 实例管理员由 `AdministratorDirectory` 依据部署声明判定，本服务只转达结论。
 */
export class AuthenticationService {
  constructor(private readonly store: ServerStore, private readonly administrators: AdministratorDirectory) {}
  private async bearerUser(token: string): Promise<UserId> {
    if (token.startsWith(retiredSessionPrefix)) throw new AppError(401, '旧会话凭证已退役，请重新登录', 'retired_credential')
    const record = await this.store.identity.findPersonalAccessToken(hashSecret(token))
    if (!record || record.revokedAt || record.expiresAt === null || Date.parse(record.expiresAt) <= Date.now()) throw new AppError(401, 'Unauthorized')
    const user = await this.store.identity.getUser(record.userId)
    if (!user) throw new AppError(401, 'Unauthorized')
    return record.userId
  }
  /**
   * 实例管理员校验：授权根是部署声明的邮箱（`WEMUX_ADMIN_EMAILS`）。持登录会话不再等于管理员，
   * 且实例没有任何可自助完成的提权入口。Team 级 owner/admin 与实例级管理员互不提升。
   */
  async authenticateAdmin(credential: RequestCredential): Promise<void> {
    if (!credential.loginSession && !credential.bearer) throw new AppError(401, 'Unauthorized')
    const userId = credential.loginSession ? credential.loginSession.userId : await this.bearerUser(credential.bearer!)
    if (!this.administrators.configured) {
      throw new AppError(403, '实例尚未声明管理员；请在 Server 启动配置的 WEMUX_ADMIN_EMAILS 中声明部署者邮箱后重启', 'administrator_not_configured')
    }
    if (!await this.administrators.isAdministrator(this.store.identity, userId)) throw new AppError(403, '需要实例管理员权限', 'admin_required')
  }
  async taskActor(credential: RequestCredential): Promise<UserId> {
    if (credential.loginSession) return credential.loginSession.userId
    if (!credential.bearer) throw new AppError(401, 'Unauthorized')
    return this.bearerUser(credential.bearer)
  }
  async authenticateWorker(token: string | undefined): Promise<WorkerId> {
    if (!token) throw new AppError(401, 'Unauthorized')
    const record = await this.store.identity.findWorkerCredential(hashSecret(token))
    const worker = record && await this.store.resources.getWorker(record.workerId)
    if (!record || record.revokedAt || !worker || worker.connectionState === 'revoked') throw new AppError(401, 'Unauthorized')
    return worker.id
  }
  /** CLI/自动化 PAT 的归属用户；用于审计与后续票据的 worker 授权。 */
  async bearerUserId(bearer: string | undefined): Promise<UserId | null> {
    if (!bearer) return null
    const record = await this.store.identity.findPersonalAccessToken(hashSecret(bearer))
    return record && !record.revokedAt ? record.userId : null
  }
}