import type { SessionId } from '@wemux/domain'

/** Process-lifetime fence shared by every Runtime using one Worker home.
 * An abort, resolved stop/return, or bounded shutdown is not proof of child exit.
 * Unknown ownership stays quarantined until process exit; no timer unlocks it.
 */
export class SessionOwnership {
  private readonly owners = new Map<SessionId, symbol>()

  occupied(sessionId: SessionId): boolean { return this.owners.has(sessionId) }

  acquire(sessionId: SessionId): symbol | null {
    if (this.owners.has(sessionId)) return null
    const token = Symbol('agent invocation')
    this.owners.set(sessionId, token)
    return token
  }

  release(sessionId: SessionId, token: symbol): void {
    if (this.owners.get(sessionId) === token) this.owners.delete(sessionId)
  }
}

const homes = new Map<string, SessionOwnership>()
export function ownershipForHome(home: string): SessionOwnership {
  let ownership = homes.get(home)
  if (!ownership) { ownership = new SessionOwnership(); homes.set(home, ownership) }
  return ownership
}
