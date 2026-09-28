import { createHmac, timingSafeEqual } from 'node:crypto'
import type { CapabilityGrantClaims, IssuedCapabilityGrant, Timestamp } from '@wemux/domain'

export interface CapabilityGrantRequest extends Omit<CapabilityGrantClaims, 'id' | 'issuedAt' | 'expiresAt'> {
  readonly grantId: string
  readonly ttlMs?: number
}

export class CapabilityTokenError extends Error {
    readonly code: 'invalid-token' | 'expired-token'
  constructor(code: 'invalid-token' | 'expired-token') {
    super(code); this.code = code;
  }
}

const encode = (value: string): string => Buffer.from(value, 'utf8').toString('base64url')
const decode = (value: string): string => Buffer.from(value, 'base64url').toString('utf8')

export class CapabilityTokenService {
  private readonly secret: string
  private readonly now: () => Timestamp
  private readonly defaultTtlMs: number
  constructor(
    secret: string,
    now: () => Timestamp,
    defaultTtlMs = 15 * 60 * 1_000,
  ) { this.secret = secret; this.now = now; this.defaultTtlMs = defaultTtlMs;
    if (secret.length < 32) {
      throw new Error('Capability token secret must contain at least 32 characters')
    }
  }

  issue(request: CapabilityGrantRequest): IssuedCapabilityGrant {
    const issuedAt = this.now()
    const claims: CapabilityGrantClaims = {
      id: request.grantId,
      sessionId: request.sessionId,
      turnId: request.turnId,
      actorAgentId: request.actorAgentId,
      projectId: request.projectId,
      workspaceId: request.workspaceId,
      allowedTools: request.allowedTools,
      allowedConnectorIds: request.allowedConnectorIds,
      issuedAt,
      expiresAt: new Date(Date.parse(issuedAt) + (request.ttlMs ?? this.defaultTtlMs)).toISOString(),
    }
    const payload = encode(JSON.stringify(claims))
    const signature = this.sign(payload)
    return { token: `${payload}.${signature}`, claims }
  }

  verify(token: string): CapabilityGrantClaims {
    const [payload, signature, extra] = token.split('.')
    if (!payload || !signature || extra) throw new CapabilityTokenError('invalid-token')
    const expected = this.sign(payload)
    const actualBytes = Buffer.from(signature, 'utf8')
    const expectedBytes = Buffer.from(expected, 'utf8')
    if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
      throw new CapabilityTokenError('invalid-token')
    }
    let claims: CapabilityGrantClaims
    try {
      claims = JSON.parse(decode(payload)) as CapabilityGrantClaims
    } catch {
      throw new CapabilityTokenError('invalid-token')
    }
    if (Date.parse(claims.expiresAt) <= Date.parse(this.now())) {
      throw new CapabilityTokenError('expired-token')
    }
    return claims
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url')
  }
}
