import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { CredentialId, Timestamp, UserId, WorkerId } from '@wemux/domain'
import type { ServerStore } from './ports/server-store.js'
import { AppError } from './errors.js'

export const hashSecret = (secret: string): string => createHash('sha256').update(secret).digest('hex')

/** MVP has one administrator, not implicit multi-user/team authorization. No HTTP types here. */
export class AuthenticationService {
  private readonly bootstrapHash: string
  constructor(private readonly store: ServerStore, bootstrapToken: string) {
    if (bootstrapToken.length < 16) throw new Error('Bootstrap token must contain at least 16 characters')
    this.bootstrapHash = hashSecret(bootstrapToken)
  }
  isBootstrapToken(token: string | undefined): boolean {
    if (!token) return false
    return timingSafeEqual(Buffer.from(hashSecret(token)), Buffer.from(this.bootstrapHash))
  }
  async authenticateAdmin(token: string | undefined): Promise<void> {
    if (this.isBootstrapToken(token)) return
    const record = token ? await this.store.identity.findPersonalAccessToken(hashSecret(token)) : null
    if (!record || record.revokedAt || record.expiresAt === null || Date.parse(record.expiresAt) <= Date.now()) throw new AppError(401, 'Unauthorized')
  }
  async taskActor(token: string | undefined): Promise<UserId> {
    if (this.isBootstrapToken(token)) return 'bootstrap-admin' as UserId
    await this.authenticateAdmin(token)
    const record = await this.store.identity.findPersonalAccessToken(hashSecret(token!))
    if (!record || !await this.store.identity.getUser(record.userId)) throw new AppError(401, 'Unauthorized')
    return record.userId
  }
  async issueAdminSession(userId: UserId, ttlMs: number): Promise<{ token: string; expiresAt: Timestamp }> {
    const token = `wemux-session-${randomBytes(32).toString('base64url')}`
    const expiresAt = new Date(Date.now() + ttlMs).toISOString() as Timestamp
    await this.store.transaction(tx => tx.identity.savePersonalAccessToken({ id: randomUUID() as CredentialId, userId, tokenHash: hashSecret(token), expiresAt, revokedAt: null }))
    return { token, expiresAt }
  }
  async authenticateWorker(token: string | undefined): Promise<WorkerId> {
    if (!token) throw new AppError(401, 'Unauthorized')
    const record = await this.store.identity.findWorkerCredential(hashSecret(token))
    const worker = record && await this.store.resources.getWorker(record.workerId)
    if (!record || record.revokedAt || !worker || worker.connectionState === 'revoked') throw new AppError(401, 'Unauthorized')
    return worker.id
  }
}
