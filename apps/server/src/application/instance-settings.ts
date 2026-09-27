import { randomUUID } from 'node:crypto'
import type { AuditEntryId, Timestamp, UserId } from '@wemux/domain'
import type { InstanceSettings, RegistrationPolicy } from '@wemux/server-domain'
import type { ServerStore } from './ports/server-store.ts'
import { AppError } from './errors.ts'
import type { Clock } from './identity-service.ts'

/**
 * 实例级注册策略的唯一读写入口。
 *
 * 设计（`docs/design/account-identity-system.md` 第 2.2 节）：
 * - 策略决定允许哪些账号创建流程，前后端同时执行，隐藏按钮不算限制；
 * - `invite_only` 是建议默认值；初始化完成前所有公开注册关闭（由认领状态另行判定）；
 * - 策略变更可发生，因此这里记录“谁在何时把策略从什么改成什么”。
 */
export const defaultRegistrationPolicy: RegistrationPolicy = 'invite_only'

export interface InstanceSettingsView {
  readonly policy: RegistrationPolicy
  /** false 表示仍在用代码内默认值，数据库里没有显式设置。 */
  readonly explicit: boolean
  readonly updatedAt: Timestamp | null
  readonly updatedBy: UserId | null
}

export const registrationPolicies: readonly RegistrationPolicy[] = ['open', 'invite_only', 'closed']

export function requireRegistrationPolicy(value: unknown): RegistrationPolicy {
  if (typeof value !== 'string' || !registrationPolicies.includes(value as RegistrationPolicy)) {
    throw new AppError(400, '注册策略必须是 open、invite_only 或 closed', 'invalid_registration_policy')
  }
  return value as RegistrationPolicy
}

export class InstanceSettingsService {
  private readonly store: ServerStore
  private readonly clock: Clock
  private readonly fallback: RegistrationPolicy
  constructor(
    store: ServerStore,
    clock: Clock,
    fallback: RegistrationPolicy = defaultRegistrationPolicy,
  ) { this.store = store; this.clock = clock; this.fallback = fallback;}

  /** 已落盘的设置；没有记录时返回 null（调用方使用默认值，不写库）。 */
  stored(): Promise<InstanceSettings | null> { return this.store.identity.getInstanceSettings() }

  async view(): Promise<InstanceSettingsView> {
    const stored = await this.stored()
    if (!stored) return { policy: this.fallback, explicit: false, updatedAt: null, updatedBy: null }
    return { policy: stored.registrationPolicy, explicit: true, updatedAt: stored.updatedAt, updatedBy: stored.updatedBy }
  }

  async policy(): Promise<RegistrationPolicy> { return (await this.view()).policy }

  /** 仅实例管理员可调用；路由层负责鉴权与 CSRF，这里只落策略与审计。 */
  async setPolicy(policy: RegistrationPolicy, actor: UserId): Promise<InstanceSettingsView> {
    const next = requireRegistrationPolicy(policy)
    const current = await this.view()
    const at = this.clock.now().toISOString() as Timestamp
    const settings: InstanceSettings = { id: 'instance', registrationPolicy: next, updatedAt: at, updatedBy: actor }
    await this.store.transaction(async tx => {
      await tx.identity.saveInstanceSettings(settings)
      await tx.audit.append({
        id: randomUUID() as AuditEntryId, actorId: actor, action: 'settings.registration_policy',
        resource: { kind: 'user', id: actor }, result: 'succeeded', occurredAt: at,
        metadata: { from: current.policy, to: next },
      })
    })
    return { policy: next, explicit: true, updatedAt: at, updatedBy: actor }
  }
}