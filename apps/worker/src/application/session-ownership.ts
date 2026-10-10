import type { SessionId } from '@wemux/domain'
import type { WorkerStore } from './ports/worker-store.js'
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
  private readonly finalizations = new Map<SessionId, { token: symbol; finish: (store: WorkerStore) => Promise<void>; safe: () => boolean; busy: boolean }>()

  retainFinalization(sessionId: SessionId, token: symbol, finish: (store: WorkerStore) => Promise<void>, safe: () => boolean): void {
    if (this.owners.get(sessionId) !== token) throw new Error('Finalization owner mismatch')
    this.finalizations.set(sessionId, { token, finish, safe, busy: false })
  }

  hasFinalization(sessionId: SessionId): boolean { return this.finalizations.has(sessionId) }

  /** Only the supplied open store is used. An old Runtime never owns retries on a closed store. */
  async finalize(sessionId: SessionId, store: WorkerStore): Promise<'busy' | 'failed' | 'finished' | 'unsafe' | 'absent'> {
    const pending = this.finalizations.get(sessionId)
    if (!pending) return 'absent'
    if (pending.busy) return 'busy'
    pending.busy = true
    try {
      await pending.finish(store)
      this.finalizations.delete(sessionId)
      if (!pending.safe()) return 'unsafe'
      this.release(sessionId, pending.token)
      return 'finished'
    } catch (error) {
      console.error('Claimed Turn finalization failed; retaining Session ownership:', error)
      return 'failed'
    } finally { pending.busy = false }
  }

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
    this.finalizations.delete(sessionId)
    const listeners = this.listeners.get(sessionId)
    this.listeners.delete(sessionId)
    for (const notify of listeners ?? []) {
      try { notify() }
      catch (error) { console.error('Session ownership release listener failed:', error) }
    }
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
