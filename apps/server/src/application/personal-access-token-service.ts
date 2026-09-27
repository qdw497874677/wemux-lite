import { randomBytes, randomUUID } from 'node:crypto'
import type { AuditEntryId, CredentialId, Timestamp, UserId } from '@wemux/domain'
import type { PersonalAccessTokenRecord, PersonalAccessTokenScope } from '@wemux/server-domain'
import { AppError } from './errors.ts'
import { hashSecret } from './auth.ts'
import type { Clock } from './identity-service.ts'
import { systemClock } from './identity-service.ts'
import type { ServerStore } from './ports/server-store.ts'

const allowedScopes = new Set<PersonalAccessTokenScope>(['read', 'write', 'execute', 'admin'])
const maximumLifetimeMs = 365 * 24 * 60 * 60 * 1000
const timestamp = (date: Date): Timestamp => date.toISOString() as Timestamp

export interface PersonalAccessTokenView {
  readonly id: CredentialId
  readonly name: string
  readonly scopes: readonly PersonalAccessTokenScope[]
  readonly createdAt: Timestamp
  readonly expiresAt: Timestamp
  readonly lastUsedAt: Timestamp | null
  readonly revokedAt: Timestamp | null
}

export interface IssuedPersonalAccessToken extends PersonalAccessTokenView {
  /** 明文只随创建/轮换响应出现一次，不进入列表与存储。 */
  readonly token: string
}

const view = (record: PersonalAccessTokenRecord): PersonalAccessTokenView => ({
  id: record.id,
  name: record.name ?? '历史访问令牌',
  scopes: record.scopes ?? [],
  createdAt: record.createdAt ?? record.expiresAt ?? '1970-01-01T00:00:00.000Z' as Timestamp,
  expiresAt: record.expiresAt ?? '1970-01-01T00:00:00.000Z' as Timestamp,
  lastUsedAt: record.lastUsedAt ?? null,
  revokedAt: record.revokedAt,
})

export class PersonalAccessTokenService {
  private readonly store: ServerStore
  private readonly clock: Clock
  constructor(store: ServerStore, clock: Clock = systemClock) { this.store = store; this.clock = clock;}

  async list(userId: UserId): Promise<readonly PersonalAccessTokenView[]> {
    return (await this.store.identity.listPersonalAccessTokens())
      .filter(record => record.userId === userId)
      .map(view)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  async create(userId: UserId, input: { readonly name?: unknown; readonly scopes?: unknown; readonly expiresAt?: unknown }): Promise<IssuedPersonalAccessToken> {
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    if (!name || name.length > 80) throw new AppError(400, '访问令牌名称需为 1–80 个字符', 'invalid_request')
    if (!Array.isArray(input.scopes) || input.scopes.length === 0) throw new AppError(400, '至少选择一个访问范围', 'invalid_request')
    const scopes = [...new Set(input.scopes)]
    if (scopes.some(scope => typeof scope !== 'string' || !allowedScopes.has(scope as PersonalAccessTokenScope))) throw new AppError(400, '访问范围不合法', 'invalid_request')
    if (typeof input.expiresAt !== 'string' || !Number.isFinite(Date.parse(input.expiresAt))) throw new AppError(400, '到期时间不合法', 'invalid_request')
    const now = this.clock.now(), expiry = new Date(input.expiresAt)
    if (expiry.getTime() <= now.getTime() || expiry.getTime() - now.getTime() > maximumLifetimeMs) throw new AppError(400, '到期时间必须在未来 365 天内', 'invalid_request')
    const token = `wmx_pat_${randomBytes(32).toString('base64url')}`
    const user = await this.store.identity.getUser(userId)
    if (!user || (user.status ?? 'active') !== 'active') throw new AppError(401, 'Unauthorized')
    const record: PersonalAccessTokenRecord = {
      id: randomUUID() as CredentialId, userId, name, scopes: scopes as PersonalAccessTokenScope[], tokenHash: hashSecret(token), authVersion: user.authVersion ?? 0,
      createdAt: timestamp(now), expiresAt: timestamp(expiry), lastUsedAt: null, revokedAt: null,
    }
    await this.store.transaction(async tx => {
      await tx.identity.savePersonalAccessToken(record)
      await tx.audit.append({ id: randomUUID() as AuditEntryId, actorId: userId, action: 'pat.created', resource: { kind: 'user', id: userId }, result: 'succeeded', occurredAt: record.createdAt!, metadata: { tokenId: record.id, name, scopes: scopes.join(','), expiresAt: record.expiresAt } })
    })
    return { ...view(record), token }
  }

  async revoke(userId: UserId, id: CredentialId): Promise<void> {
    const record = (await this.store.identity.listPersonalAccessTokens()).find(value => value.id === id && value.userId === userId)
    if (!record) throw new AppError(404, '访问令牌不存在', 'not_found')
    if (record.revokedAt !== null) return
    const at = timestamp(this.clock.now())
    await this.store.transaction(async tx => {
      await tx.identity.revokePersonalAccessToken(id, at)
      await tx.audit.append({ id: randomUUID() as AuditEntryId, actorId: userId, action: 'pat.revoked', resource: { kind: 'user', id: userId }, result: 'succeeded', occurredAt: at, metadata: { tokenId: id } })
    })
  }

  async rotate(userId: UserId, id: CredentialId, expiresAt?: unknown): Promise<IssuedPersonalAccessToken> {
    const record = (await this.store.identity.listPersonalAccessTokens()).find(value => value.id === id && value.userId === userId)
    if (!record || record.revokedAt !== null || !record.scopes?.length || !record.name) throw new AppError(404, '访问令牌不存在', 'not_found')
    const name = record.name
    const scopes = record.scopes
    const targetExpiry = expiresAt ?? record.expiresAt
    if (typeof targetExpiry !== 'string' || !Number.isFinite(Date.parse(targetExpiry))) throw new AppError(400, '到期时间不合法', 'invalid_request')
    const now = this.clock.now(), expiry = new Date(targetExpiry)
    if (expiry.getTime() <= now.getTime() || expiry.getTime() - now.getTime() > maximumLifetimeMs) throw new AppError(400, '到期时间必须在未来 365 天内', 'invalid_request')
    const token = `wmx_pat_${randomBytes(32).toString('base64url')}`
    const user = await this.store.identity.getUser(userId)
    if (!user || (user.status ?? 'active') !== 'active') throw new AppError(401, 'Unauthorized')
    const replacement: PersonalAccessTokenRecord = {
      id: randomUUID() as CredentialId, userId, name, scopes, tokenHash: hashSecret(token), authVersion: user.authVersion ?? 0, createdAt: timestamp(now),
      expiresAt: timestamp(expiry), lastUsedAt: null, revokedAt: null,
    }
    await this.store.transaction(async tx => {
      const current = (await tx.identity.listPersonalAccessTokens()).find(value => value.id === id && value.userId === userId)
      if (!current || current.revokedAt !== null) throw new AppError(409, '访问令牌已被轮换或撤销', 'pat_already_rotated')
      await tx.identity.savePersonalAccessToken(replacement)
      await tx.identity.revokePersonalAccessToken(id, replacement.createdAt!)
      await tx.audit.append({ id: randomUUID() as AuditEntryId, actorId: userId, action: 'pat.rotated', resource: { kind: 'user', id: userId }, result: 'succeeded', occurredAt: replacement.createdAt!, metadata: { oldTokenId: id, newTokenId: replacement.id, scopes: scopes.join(','), expiresAt: replacement.expiresAt } })
    })
    return { ...view(replacement), token }
  }

  async recordFailedAuthentication(input: { readonly bearer: string; readonly requiredScope: PersonalAccessTokenScope | 'admin'; readonly reason: string }): Promise<void> {
    const record = await this.store.identity.findPersonalAccessToken(hashSecret(input.bearer))
    if (!record) return
    const at = timestamp(this.clock.now())
    await this.store.transaction(tx => tx.audit.append({
      id: randomUUID() as AuditEntryId, actorId: record.userId, action: 'pat.authentication_failed', resource: { kind: 'user', id: record.userId },
      result: 'failed', occurredAt: at, metadata: { tokenId: record.id, requiredScope: input.requiredScope, reason: input.reason },
    }))
  }
}
