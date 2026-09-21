import { randomUUID } from 'node:crypto'
import type { AuditEntryId, Timestamp, UserId } from '@wemux/domain'
import type { InstanceAdministrator, User } from '@wemux/server-domain'
import type { ServerIdentityReader, ServerIdentityWriter } from './ports/server-store-types.js'
import type { ServerAuditWriter } from './ports/server-store-types.js'
import { AppError } from './errors.js'
import { normalizeEmail } from './email-address.js'
import { systemClock, type Clock } from './identity-service.js'

/**
 * 实例管理员的唯一权威：部署者声明的邮箱，而不是任何可自助完成的状态。
 *
 * 设计（`docs/design/account-identity-system.md` 第 2 节）：
 * - 授权根是启动配置 `WEMUX_ADMIN_EMAILS`。没有引导令牌、没有首次认领表单，
 *   也没有“先到先得”的提权窗口：谁写进配置，谁就是管理员。
 * - 声明邮箱的账号在登录/注册成功时懒提升为管理员，归属与理由写进审计；
 *   同一声明不重复写记录，也不重复产生审计噪音。
 * - Team 内 owner/admin 与实例级管理员是两件事，互不提升。
 */
export type AdministratorReader = ServerIdentityReader

/** 归属写入必须与审计同事务，因此要求调用方传事务端口。 */
export interface AdministratorWriter {
  readonly identity: ServerIdentityReader & ServerIdentityWriter
  readonly audit: ServerAuditWriter
}

const recordKind = 'instance-administrator'

/** 解析并校验声明邮箱：任何一个写错的条目都在启动时失败，而不是等到登录时才发现。 */
export function parseAdministratorEmails(raw: string | undefined | readonly string[]): string[] {
  const entries = typeof raw === 'string' ? raw.split(',') : (raw ?? [])
  const normalized = new Set<string>()
  for (const entry of entries) {
    const trimmed = entry.trim()
    if (!trimmed) continue
    const email = normalizeEmail(trimmed)
    if (!email) throw new Error(`WEMUX_ADMIN_EMAILS 含无效邮箱：${trimmed}`)
    normalized.add(email.normalized)
  }
  return [...normalized]
}

export class AdministratorDirectory {
  private readonly declared: readonly string[]
  constructor(private readonly store: AdministratorReader, declared: readonly string[] = [], private readonly clock: Clock = systemClock) {
    // 构造时再规范化一次：调用方可以传原始配置串，判定语义只在这里定义。
    this.declared = parseAdministratorEmails(declared)
  }

  static fromEnvironment(store: AdministratorReader, environment: NodeJS.ProcessEnv = process.env, clock: Clock = systemClock): AdministratorDirectory {
    return new AdministratorDirectory(store, parseAdministratorEmails(environment.WEMUX_ADMIN_EMAILS), clock)
  }

  /** 是否声明了任何管理员邮箱；false 时实例没有任何实例级权限入口，`/auth/options` 如实公开。 */
  get configured(): boolean { return this.declared.length > 0 }

  /** 声明命中：大小写与首尾空白不敏感；未声明的邮箱永远不是管理员。 */
  declares(email: string | null | undefined): boolean {
    const normalized = email ? normalizeEmail(email)?.normalized ?? null : null
    return normalized !== null && this.declared.includes(normalized)
  }

  /** 记录过的归属优先，其次看当前邮箱是否命中声明；两者都不命中才是普通成员。 */
  async isAdministrator(port: AdministratorReader, userId: UserId): Promise<boolean> {
    const user = await port.getUser(userId)
    if (!user || (user.status ?? 'active') !== 'active') return false
    if (await port.findInstanceAdministrator(userId)) return true
    return this.declares(user.email)
  }

  /** 已落盘的管理员归属，按用户 id 索引；用于诊断、恢复与后续团队级授权。 */
  async roster(): Promise<readonly InstanceAdministrator[]> { return this.store.listInstanceAdministrators() }

  /**
   * 懒提升：声明邮箱命中且尚未记录时写入归属与审计，返回本次是否发生变化。
   * 幂等——重复登录不会重复写记录，也不会产生第二条审计。
   */
  async ensure(tx: AdministratorWriter, user: User, source: InstanceAdministrator['source'] = 'declared'): Promise<boolean> {
    if (source === 'declared' && !this.declares(user.email)) return false
    const email = user.email ? normalizeEmail(user.email)?.normalized : null
    if (!email) return false
    if (await tx.identity.findInstanceAdministrator(user.id)) return false
    const assignedAt = this.clock.now().toISOString() as Timestamp
    const record: InstanceAdministrator = { userId: user.id, email, assignedAt, source }
    await tx.identity.saveInstanceAdministrator(record)
    await tx.audit.append({
      id: randomUUID() as AuditEntryId, actorId: user.id,
      action: source === 'declared' ? 'instance.administrator_assigned' : 'instance.administrator_recovered',
      resource: { kind: 'user', id: user.id }, result: 'succeeded', occurredAt: assignedAt,
      metadata: { channel: source, email },
    })
    return true
  }

  /** 已声明但还没注册/登录的管理员邮箱，用于把“实例还没有管理员”说清楚。 */
  private async accountExists(email: string): Promise<boolean> { return await this.store.getUserByEmail(email) !== null }

  /**
   * 实例当前是否已经有可用的管理员账号。声明了邮箱但账号还没建出来时仍是 false：
   * 落地页据此提示部署者先完成管理员注册，而不是假装权限已经就绪。
   */
  async active(): Promise<boolean> {
    for (const administrator of await this.store.listInstanceAdministrators()) {
      const user = await this.store.getUser(administrator.userId)
      if (user && (user.status ?? 'active') === 'active') return true
    }
    for (const email of this.declared) if (await this.accountExists(email)) return true
    return false
  }

  /** 记录里的邮箱与当前声明不一致时的诊断信息（声明邮箱变更后仍保留管理员身份）。 */
  async drift(): Promise<readonly { readonly userId: UserId; readonly recorded: string; readonly current: string | null }[]> {
    const roster = await this.roster()
    const rows: { userId: UserId; recorded: string; current: string | null }[] = []
    for (const administrator of roster) {
      const user = await this.store.getUser(administrator.userId)
      const current = user?.email ? normalizeEmail(user.email)?.normalized ?? null : null
      if (current !== administrator.email) rows.push({ userId: administrator.userId, recorded: administrator.email, current })
    }
    return rows
  }
}

export { recordKind as instanceAdministratorRecordKind }