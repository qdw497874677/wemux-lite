import type { SessionId } from '@wemux/domain'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

/** Process-lifetime fence shared by every Runtime using one Worker home.
 * An abort, resolved stop/return, or bounded shutdown is not proof of child exit.
 * Unknown ownership stays quarantined until process exit; no timer unlocks it.
 * Release signals are process-local, not cross-process coordination.
 */
export class SessionOwnership {
  private readonly owners = new Map<SessionId, symbol>()
  private readonly listeners = new Map<SessionId, Set<() => void>>()

  /** In-process, one-shot release signal; never implies a child has exited. */
  onRelease(sessionId: SessionId, notify: () => void): () => void {
    let listeners = this.listeners.get(sessionId)
    if (!listeners) { listeners = new Set(); this.listeners.set(sessionId, listeners) }
    listeners.add(notify)
    return () => {
      listeners!.delete(notify)
      if (!listeners!.size) this.listeners.delete(sessionId)
    }
  }

  occupied(sessionId: SessionId): boolean { return this.owners.has(sessionId) }

  acquire(sessionId: SessionId): symbol | null {
    if (this.owners.has(sessionId)) return null
    const token = Symbol('agent invocation')
    this.owners.set(sessionId, token)
    return token
  }

  release(sessionId: SessionId, token: symbol): void {
    if (this.owners.get(sessionId) !== token) return
    this.owners.delete(sessionId)
    const listeners = this.listeners.get(sessionId)
    this.listeners.delete(sessionId)
    for (const notify of listeners ?? []) notify()
  }
}

const homes = new Map<string, SessionOwnership>()
export function ownershipForHome(home: string): SessionOwnership {
  // Resolve the existing home before looking up process ownership. Lexical paths
  // alone cannot fence symlink aliases of the same SQLite database. A missing
  // home fails closed rather than acquiring an identity that may change later.
  const canonicalHome = realpathSync(resolve(home))
  let ownership = homes.get(canonicalHome)
  if (!ownership) { ownership = new SessionOwnership(); homes.set(canonicalHome, ownership) }
  return ownership
}
