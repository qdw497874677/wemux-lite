import { createHash, randomUUID } from 'node:crypto'
import type { AuditEntryId, Timestamp, UserId, WorkerId } from '@wemux/domain'
import type { LoginSession, PersonalAccessTokenRecord, PersonalAccessTokenScope } from '@wemux/server-domain'
import type { ServerStore } from './ports/server-store.ts'
import type { AdministratorDirectory } from './administrator-directory.ts'
import { AppError } from './errors.ts'

export const hashSecret = (secret: string): string => createHash('sha256').update(secret).digest('hex')

/** 一次请求的凭据组合：HttpOnly Cookie 登录会话与 Bearer 凭证互不冒充。 */
export interface RequestCredential {
  readonly bearer?: string
  readonly loginSession?: LoginSession | null
}

export type RequestAccess = 'read' | 'write' | 'execute' | 'admin'
export interface AuthenticatedActor {
  readonly userId: UserId
  readonly kind: 'session' | 'pat'
  readonly scopes: readonly PersonalAccessTokenScope[]
  readonly tokenId?: PersonalAccessTokenRecord['id']
}

/** 已退役的浏览器会话令牌前缀：升级后即使残留在客户端也不再具备任何权限。 */
export const retiredSessionPrefix = 'wemux-session-'

/**
 * 集群控制面的凭证校验：PAT、Worker 凭据、Cookie 登录会话。
 * 浏览器登录会话由 `IdentityService` 校验并滑动，这里只做权威判定，不重复存储逻辑。
 * 实例管理员由 `AdministratorDirectory` 依据部署声明判定，本服务只转达结论。
 */
export class AuthenticationService {
  private readonly store: ServerStore
  private readonly administrators: AdministratorDirectory
  constructor(store: ServerStore, administrators: AdministratorDirectory) { this.store = store; this.administrators = administrators;}
  private async bearerRecord(token: string): Promise<PersonalAccessTokenRecord> {
    if (token.startsWith(retiredSessionPrefix)) throw new AppError(401, '旧会话凭证已退役，请重新登录', 'retired_credential')
    const record = await this.store.identity.findPersonalAccessToken(hashSecret(token))
    if (!record || record.revokedAt || record.expiresAt === null || Date.parse(record.expiresAt) <= Date.now() || !record.scopes?.length) throw new AppError(401, 'Unauthorized')
    const user = await this.store.identity.getUser(record.userId)
    if (!user || (user.status ?? 'active') !== 'active' || (user.authVersion !== undefined && (record.authVersion ?? 0) !== user.authVersion)) throw new AppError(401, 'Unauthorized')
    return record
  }
  private assertScope(scopes: readonly PersonalAccessTokenScope[], required: RequestAccess): void {
    const allowed = required === 'read' ? scopes.some(scope => ['read', 'write', 'execute', 'admin'].includes(scope))
      : required === 'write' ? scopes.some(scope => ['write', 'admin'].includes(scope))
        : required === 'execute' ? scopes.some(scope => ['execute', 'admin'].includes(scope))
          : scopes.includes('admin')
    if (!allowed) throw new AppError(403, `访问令牌缺少 ${required} 范围`, 'pat_scope_required')
  }
  async actor(credential: RequestCredential, required: RequestAccess = 'read'): Promise<AuthenticatedActor> {
    if (credential.loginSession) {
      const user = await this.store.identity.getUser(credential.loginSession.userId)
      if (!user || (user.status ?? 'active') !== 'active' || (user.authVersion !== undefined && (credential.loginSession.authVersion ?? 0) !== user.authVersion)) throw new AppError(401, 'Unauthorized')
      return { userId: credential.loginSession.userId, kind: 'session', scopes: ['read', 'write', 'execute', 'admin'] }
    }
    if (!credential.bearer) throw new AppError(401, 'Unauthorized')
    const record = await this.bearerRecord(credential.bearer)
    this.assertScope(record.scopes!, required)
    return { userId: record.userId, kind: 'pat', scopes: record.scopes!, tokenId: record.id }
  }
  async recordPatUse(actor: AuthenticatedActor, required: RequestAccess): Promise<void> {
    if (actor.kind !== 'pat' || !actor.tokenId) return
    const record = (await this.store.identity.listPersonalAccessTokens()).find(value => value.id === actor.tokenId)
    const now = Date.now(), lastUsed = record?.lastUsedAt ? Date.parse(record.lastUsedAt) : 0
    if (record && Number.isFinite(lastUsed) && now - lastUsed < 60_000) return
    const at = new Date(now).toISOString() as Timestamp
    await this.store.transaction(async tx => {
      await tx.identity.touchPersonalAccessToken(actor.tokenId!, at)
      await tx.audit.append({ id: randomUUID() as AuditEntryId, actorId: actor.userId, action: 'pat.used', resource: { kind: 'user', id: actor.userId }, result: 'succeeded', occurredAt: at, metadata: { tokenId: actor.tokenId!, requiredScope: required } })
    })
  }
  /**
   * 实例管理员校验：授权根是部署声明的邮箱（`WEMUX_ADMIN_EMAILS`）。持登录会话不再等于管理员，
   * 且实例没有任何可自助完成的提权入口。Team 级 owner/admin 与实例级管理员互不提升。
   */
  async authenticateAdmin(credential: RequestCredential): Promise<void> {
    if (!credential.loginSession && !credential.bearer) throw new AppError(401, 'Unauthorized')
    const userId = (await this.actor(credential, 'admin')).userId
    if (!this.administrators.configured) {
      throw new AppError(403, '实例尚未声明管理员；请在 Server 启动配置的 WEMUX_ADMIN_EMAILS 中声明部署者邮箱后重启', 'administrator_not_configured')
    }
    if (!await this.administrators.isAdministrator(this.store.identity, userId)) throw new AppError(403, '需要实例管理员权限', 'admin_required')
  }
  async taskActor(credential: RequestCredential, required: RequestAccess = 'read'): Promise<UserId> {
    return (await this.actor(credential, required)).userId
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
    try { return (await this.bearerRecord(bearer)).userId } catch { return null }
  }
}