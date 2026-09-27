import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionId, TurnId, Timestamp } from '@wemux/domain'
import { CapabilityTokenService } from '../application/capability-token-service.js'

test('capability tokens use a short TTL and reject malformed or expired tokens', () => {
  let clock = Date.now()
  const now = () => new Date(clock).toISOString() as Timestamp
  const service = new CapabilityTokenService('a'.repeat(32), now, 5_000)
  const issued = service.issue({
    grantId: 'grant', sessionId: 'session' as SessionId, turnId: 'turn' as TurnId,
    actorAgentId: 'session' as SessionId, projectId: 'project' as any,
    workspaceId: 'workspace' as any, allowedTools: ['session.info'], allowedConnectorIds: [],
  })
  assert.equal(Date.parse(issued.claims.expiresAt) - clock, 5_000)
  assert.throws(() => service.verify('missing'), /invalid-token/)
  clock += 5_001
  assert.throws(() => service.verify(issued.token), /expired-token/)
})
