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
