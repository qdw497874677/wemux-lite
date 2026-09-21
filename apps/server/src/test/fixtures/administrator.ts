import { randomUUID } from 'node:crypto'
import type { CredentialId, ProjectId, TeamId, Timestamp, UserId } from '@wemux/domain'
import type { InstanceAdministrator, Project, Team, User } from '@wemux/server-domain'
import { AdministratorDirectory } from '../../application/administrator-directory.js'
import { hashSecret } from '../../application/auth.js'
import { normalizeEmail } from '../../application/email-address.js'
import { hashPassword } from '../../application/password.js'
import type { ServerStore } from '../../application/ports/server-store.js'
import type { ServerService } from '../../application/server-service.js'
import { createWemuxServer, type WemuxServerOptions } from '../../server.js'

/**
 * 测试里的部署者：声明邮箱的账号 + 真实 PAT + 管理员归属记录。
 * 三者与生产「部署声明的邮箱注册或登录后被提升」的结果一致，因此测试走的是同一条授权判定路径，
 * 不再有 `bootstrap-admin` 之类的合成用户或引导令牌。
 */
export const administratorEmail = 'deployer@wemux.test'

/** 测试里的部署者账号 id：所有服务端写操作的归属用户，取代旧的 `bootstrap-admin` 合成用户。 */
export const instanceOperatorId = 'deployer-user' as UserId

/** 夹具默认签发的 PAT：测试里 `Authorization: Bearer <administratorToken>` 就是部署者本人。 */
export const administratorToken = 'test-administrator-pat'

/** PAT 必须带有效期（`AuthenticationService.bearerUser` 拒绝 `expiresAt === null`），测试用远期时间。 */
const farFuture = '2099-01-01T00:00:00.000Z' as Timestamp

export interface TestAdministrator {
  readonly userId: UserId
  readonly user: User
  readonly email: string
  readonly token: string
  readonly administrators: AdministratorDirectory
}

export interface SeedAdministratorOptions {
  readonly userId?: UserId
  readonly email?: string
  readonly username?: string
  readonly token?: string
  readonly assignedAt?: Timestamp
  readonly expiresAt?: Timestamp | null
}

export async function seedAdministrator(store: ServerStore, overrides: SeedAdministratorOptions = {}): Promise<TestAdministrator> {
  const userId = overrides.userId ?? instanceOperatorId
  const email = overrides.email ?? administratorEmail
  const token = overrides.token ?? administratorToken
  const assignedAt = overrides.assignedAt ?? new Date().toISOString() as Timestamp
  const user: User = { id: userId, username: overrides.username ?? 'deployer', email, createdAt: assignedAt, status: 'active', authVersion: 0, statusChangedAt: assignedAt, deletedAt: null }
  const record: InstanceAdministrator = { userId, email, assignedAt, source: 'declared' }
  await store.transaction(async tx => {
    await tx.identity.saveUser(user)
    // 邮箱索引（`user_emails`）是登录、注册占用检查与恢复的真实查找路径，夹具必须一并落盘，
    // 否则「账号已存在」在测试里会看起来不存在。
    if (email && !await tx.identity.getUserEmail(userId)) {
      await tx.identity.saveUserEmail({ emailNormalized: normalizeEmail(email)!.normalized, userId, emailDisplay: email, createdAt: assignedAt })
    }
    await tx.identity.savePersonalAccessToken({ id: randomUUID() as CredentialId, userId, name: '测试管理员', scopes: ['read', 'write', 'execute', 'admin'], tokenHash: hashSecret(token), authVersion: user.authVersion ?? 0, createdAt: assignedAt, expiresAt: overrides.expiresAt ?? farFuture, lastUsedAt: null, revokedAt: null })
    // 幂等：同一用户重复播种（多个夹具共用同一个 store）不写第二条归属，也不触发唯一约束。
    if (!await tx.identity.findInstanceAdministrator(userId)) await tx.identity.saveInstanceAdministrator(record)
  })
  return { userId, user, email, token, administrators: administratorDirectory(store, email) }
}

export interface LocalAccountOptions {
  readonly userId?: UserId
  readonly username: string
  readonly email: string | null
  readonly password: string
  /** 同时写入实例管理员归属；不传则由登录时的懒提升决定（默认声明命中即提升）。 */
  readonly administrator?: boolean
}

/**
 * 账号 + 本机密码的直接落盘：生产路径是「注册 + 验证邮件」，
 * 测试里跳过邮件环节但保留真实的密码哈希与登录校验。
 */
export async function seedLocalAccount(store: ServerStore, options: LocalAccountOptions): Promise<User> {
  const userId = options.userId ?? randomUUID() as UserId
  const at = new Date().toISOString() as Timestamp
  const user: User = { id: userId, username: options.username, email: options.email, createdAt: at, status: 'active', authVersion: 0, statusChangedAt: at, deletedAt: null }
  const passwordHash = await hashPassword(options.password)
  await store.transaction(async tx => {
    await tx.identity.saveUser(user)
    await tx.identity.saveLocalAccountCredential({ userId, passwordHash, updatedAt: at })
    const email = options.email ? normalizeEmail(options.email)?.normalized ?? null : null
    if (email && !await tx.identity.getUserEmail(userId)) {
      await tx.identity.saveUserEmail({ emailNormalized: email, userId, emailDisplay: options.email!, createdAt: at })
    }
    if (options.administrator) {
      if (!email) throw new Error('写入管理员归属需要邮箱')
      await tx.identity.saveInstanceAdministrator({ userId, email, assignedAt: at, source: 'declared' })
    }
  })
  return user
}

export function administratorDirectory(store: ServerStore, email = administratorEmail): AdministratorDirectory {
  return new AdministratorDirectory(store.identity, [email])
}

export interface TestOperator extends TestAdministrator {
  readonly team: Team
  readonly project: Project
}

/**
 * 声明管理员 + 默认环境（Team/Project 及 owner 归属）就绪的最小服务端状态。
 * 取代已删除的 `ServerService.bootstrap()`：不再创建合成管理员，owner 指向真实部署者。
 */
export async function seedOperator(store: ServerStore, service: ServerService, overrides: SeedAdministratorOptions = {}): Promise<TestOperator> {
  const administrator = await seedAdministrator(store, overrides)
  const environment = await service.ensureDefaultEnvironment(administrator.userId)
  return { ...administrator, team: environment.team!, project: environment.project }
}

export interface SeedOperatorOptions extends SeedAdministratorOptions {
  /** 稳定 ID（单 Team/单 Project 部署）可用常量断言，测试里通常直接使用返回值。 */
  readonly teamId?: TeamId
  readonly projectId?: ProjectId
}

export interface AdministratorApp {
  readonly app: ReturnType<typeof createWemuxServer>
  readonly base: string
  readonly admin: TestAdministrator
  readonly token: string
  readonly userId: UserId
  close(): Promise<void>
}

/**
 * 声明管理员 + 已登录凭据 + 默认环境的最小在线实例：PAT 就是管理员身份，
 * 让既有的 `Authorization: Bearer <token>` 调用继续表达「部署者在操作」。
 */
export async function administratorApp(options: { databasePath?: string } & Partial<WemuxServerOptions> = {}): Promise<AdministratorApp> {
  const app = createWemuxServer({ databasePath: ':memory:', ...options, administratorEmails: [administratorEmail] })
  const admin = await seedAdministrator(app.store)
  await app.service.ensureDefaultEnvironment(admin.userId)
  const base = await app.listen(0)
  return { app, base, admin, token: admin.token, userId: admin.userId, close: () => app.close() }
}