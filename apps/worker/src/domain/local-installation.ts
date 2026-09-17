import type { Timestamp } from '@wemux/domain'

export interface LocalInstallationIdentity {
  readonly installationId: string
  readonly name: string
  readonly createdAt: Timestamp
}

export interface LocalAdminRecord {
  readonly username: string
  readonly passwordSalt: string
  readonly passwordHash: string
  readonly createdAt: Timestamp
}
