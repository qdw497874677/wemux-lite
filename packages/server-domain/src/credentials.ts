import type { CredentialId, TeamId, Timestamp, UserId, WorkerId } from '@wemux/domain'

export interface PersonalAccessTokenRecord {
  readonly id: CredentialId
  readonly userId: UserId
  readonly tokenHash: string
  readonly expiresAt: Timestamp | null
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
