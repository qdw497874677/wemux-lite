import type { CredentialId, TeamId, Timestamp, UserId, WorkerId } from '@wemux/domain'

export type PersonalAccessTokenScope = 'read' | 'write' | 'execute' | 'admin'

export interface PersonalAccessTokenRecord {
  readonly id: CredentialId
  readonly userId: UserId
  /** 可辨识、不可冒充权限的展示名。旧记录缺失时由服务层显示为“历史访问令牌”。 */
  readonly name?: string
  /** 旧无 scope 记录必须按无效处理，绝不能推断成管理员令牌。 */
  readonly scopes?: readonly PersonalAccessTokenScope[]
  readonly tokenHash: string
  readonly createdAt?: Timestamp
  readonly expiresAt: Timestamp | null
  readonly lastUsedAt?: Timestamp | null
  readonly revokedAt: Timestamp | null
}

export interface EnrollmentTokenRecord {
  readonly id: CredentialId
  readonly teamId: TeamId
  readonly createdBy: UserId
  readonly tokenHash: string
  readonly expiresAt: Timestamp
  readonly consumedByWorkerId: WorkerId | null
  readonly consumedAt: Timestamp | null
}

export interface WorkerCredentialRecord {
  readonly id: CredentialId
  readonly workerId: WorkerId
  readonly credentialHash: string
  readonly createdAt: Timestamp
  readonly revokedAt: Timestamp | null
}
