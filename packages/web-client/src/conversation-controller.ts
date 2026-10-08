import type { ConversationFreshness, ConversationHistoryPage, ConversationSession } from '@wemux/web-contract'
import type { ConversationWatch, ConversationWatchOptions } from './session-conversation.ts'
import type { ConversationProjection, ConversationProjectionErrorCode } from './conversation-projection.ts'
import { appendConversationEvents, createConversationProjection, ConversationProjectionError } from './conversation-projection.ts'

/** The authenticated port must belong to this account/team. Session reads cannot attest those two IDs. */
export interface ConversationScope {
  readonly accountId: string
  readonly teamId: string
  readonly projectId: string
  readonly taskId: string
  readonly sessionId: string
}
export interface ConversationReadPort {
  getSession(id: string, signal?: AbortSignal): Promise<ConversationSession>
  sessionHistory(id: string, fromSeq?: number, limit?: number, signal?: AbortSignal): Promise<ConversationHistoryPage>
  watchSession(id: string, options: ConversationWatchOptions): ConversationWatch
}
export interface ConversationControllerOptions {
  readonly pageSize?: number
  /** Total history requests per drain, including invalidation re-reads. No automatic polling at the limit. */
  readonly maxPagesPerRefresh?: number
}
export interface ConversationReadError {
  readonly source: 'session' | 'history' | 'subscription'
  readonly code: 'request-failed' | 'invalid-data' | 'scope-mismatch' | 'permission-denied' | 'session-unavailable' | 'history-regression' | 'session-regression' | ConversationProjectionErrorCode
}
export interface ConversationSnapshot {
  readonly scope: ConversationScope
  readonly status: 'loading' | 'refreshing' | 'ready' | 'error' | 'blocked' | 'disposed'
  /** watching means the watch is pending, not proof of a connected or fresh stream. */
  readonly subscription: 'starting' | 'watching' | 'closed' | 'error' | 'disposed'
  readonly projection: ConversationProjection
  /** Latest validated metadata; runtime/queue and its freshness are not rewritten from Journal guesses. */
  readonly session: ConversationSession | null
  /** Freshness of the last successfully applied HTTP page, independent of metadata freshness. */
  readonly freshness: ConversationFreshness | null
  /** More reads are needed, including bounded catch-up, a read race or an error. Not a sync guarantee. */
  readonly needsRefresh: boolean
  readonly error: ConversationReadError | null
  readonly subscriptionError: ConversationReadError | null
}
export interface ConversationController {
  getSnapshot(): ConversationSnapshot
  /** Change notification (no immediate call). Listener exceptions are isolated from synchronization. */
  subscribe(listener: () => void): () => void
  /** Re-read metadata/history; does not restart a terminal subscription. */
  refresh(): void
  /** Explicitly restart a terminal subscription and re-read. Blocked controllers require replacement. */
  retry(): void
  /** Scrubs retained data without notifying old-scope listeners. No later callback is delivered. */
  dispose(): void
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'
const integer = (value: unknown, minimum = 0): value is number => Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) < Number.MAX_SAFE_INTEGER
function validFreshness(value: unknown, sessionId: string): value is ConversationFreshness {
  return record(value) && value.sessionId === sessionId && integer(value.contiguousSeq)
    && (value.workerLastSeq === null || integer(value.workerLastSeq))
    && ['unknown', 'syncing', 'synced', 'gap', 'offline', 'orphaned'].includes(value.status as string)
}
function freezeTree<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) freezeTree(child)
  }
  return value
}
class ReadFailure extends Error {
  readonly code: ConversationReadError['code']
  constructor(code: ConversationReadError['code']) { super(code); this.code = code }
}
function readError(source: ConversationReadError['source'], error: unknown): ConversationReadError {
  // Do not publish raw server/transport errors, which may contain response bodies or unrelated data.
  const code = record(error) && (error.status === 401 || error.status === 403 || error.kind === 'unauthorized' || error.kind === 'forbidden') ? 'permission-denied'
    : record(error) && (error.status === 404 || error.kind === 'not-found') ? 'session-unavailable'
      : error instanceof ReadFailure || error instanceof ConversationProjectionError ? error.code
        : 'request-failed'
  return Object.freeze({ source, code })
}

/** One immutable scope per instance. Dispose before replacing account/team/project/task/session.
 * Subscribe before loading; coalesce invalidations with a dirty latch. A drain is serial and bounded.
 * Exhausted-page/newer-freshness races stop with needsRefresh rather than spinning; a future
 * invalidation or explicit refresh resumes. Errors likewise require a new trigger, never polling.
 */
export function createConversationController(scopeInput: ConversationScope, port: ConversationReadPort, options: ConversationControllerOptions = {}): ConversationController {
  for (const key of ['accountId', 'teamId', 'projectId', 'taskId', 'sessionId'] as const) {
    if (typeof scopeInput[key] !== 'string' || !scopeInput[key].trim()) throw new TypeError(`Invalid conversation scope: ${key}`)
  }
  const scope: ConversationScope = Object.freeze({ accountId: scopeInput.accountId, teamId: scopeInput.teamId, projectId: scopeInput.projectId, taskId: scopeInput.taskId, sessionId: scopeInput.sessionId })
  const pageSize = options.pageSize ?? 500, maxPages = options.maxPagesPerRefresh ?? 20
  if (!integer(pageSize, 1) || pageSize > 1000 || !integer(maxPages, 1) || maxPages > 100) throw new RangeError('Invalid conversation pagination budget')
  const lifetime = new AbortController(), listeners = new Set<() => void>()
  let snapshot: ConversationSnapshot = Object.freeze({ scope, status: 'loading', subscription: 'starting', projection: createConversationProjection(scope.sessionId), session: null, freshness: null, needsRefresh: true, error: null, subscriptionError: null })
  let stopped = false, scheduled = false, running = false, dirty = false
  let watch: ConversationWatch | null = null, watchGeneration = 0

  function publish(change: Partial<ConversationSnapshot>) {
    snapshot = Object.freeze({ ...snapshot, ...change })
    const published = snapshot
    for (const listener of [...listeners]) {
      // A listener can dispose, unsubscribe another listener, or synchronously change the snapshot.
      if (snapshot !== published) break
      if (listeners.has(listener)) {
        try { listener() } catch { /* Observer failures must not turn valid history into a read failure. */ }
      }
    }
  }
  function closeWatch() {
    watchGeneration++
    const previous = watch
    watch = null
    try { previous?.dispose() } catch { /* Lifetime abort remains the cleanup boundary for injected ports. */ }
  }
  function block(error: ConversationReadError) {
    stopped = true
    dirty = false
    lifetime.abort()
    closeWatch()
    publish({ status: 'blocked', subscription: 'disposed', session: null, freshness: null, projection: createConversationProjection(scope.sessionId), needsRefresh: false, error, subscriptionError: null })
    listeners.clear()
  }
  function fail(source: ConversationReadError['source'], cause: unknown) {
    if (stopped) return
    const error = readError(source, cause)
    if (['permission-denied', 'scope-mismatch', 'session-unavailable'].includes(error.code)) { block(error); return }
    if (source === 'subscription') publish({ subscription: 'error', subscriptionError: error })
    else publish({ status: 'error', needsRefresh: true, error })
  }
  function startWatch() {
    if (stopped || watch) return
    const generation = ++watchGeneration
    publish({ subscription: 'watching', subscriptionError: null })
    if (stopped) return
    try {
      const created = port.watchSession(scope.sessionId, {
        fromSeq: () => snapshot.projection.lastAppliedSeq + 1,
        onInvalidate: () => { if (!stopped && generation === watchGeneration) requestRefresh() },
        signal: lifetime.signal,
      })
      watch = created
      // Attach both branches in the same stack as creation: rejected done is never left unhandled.
      void created.done.then(() => {
        if (stopped || generation !== watchGeneration) return
        closeWatch()
        publish({ subscription: 'closed', subscriptionError: null })
      }, error => {
        if (stopped || generation !== watchGeneration) return
        closeWatch()
        fail('subscription', error)
      })
      if (stopped || generation !== watchGeneration) closeWatch()
    } catch (error) {
      closeWatch()
      fail('subscription', error)
    }
  }
  function validateSession(value: ConversationSession): ConversationSession {
    if (!record(value)) throw new ReadFailure('invalid-data')
    if (value.id !== scope.sessionId || value.projectId !== scope.projectId || value.taskId !== scope.taskId) throw new ReadFailure('scope-mismatch')
    if (!record(value.access) || typeof value.access.canRead !== 'boolean') throw new ReadFailure('invalid-data')
    if (!value.access.canRead) throw new ReadFailure('permission-denied')
    if (value.deletedAt !== null) throw new ReadFailure('session-unavailable')
    if (!validFreshness(value.freshness, scope.sessionId)) throw new ReadFailure('invalid-data')
    if (snapshot.session && value.freshness.contiguousSeq < snapshot.session.freshness.contiguousSeq) throw new ReadFailure('session-regression')
    // The injected operations validate the remaining metadata schema. Detach it from their objects.
    return freezeTree(structuredClone(value))
  }
  function applyPage(page: ConversationHistoryPage): ConversationProjection {
    if (!record(page) || !Array.isArray(page.events) || page.events.length > pageSize || !validFreshness(page.freshness, scope.sessionId)) throw new ReadFailure('invalid-data')
    const fromSeq = snapshot.projection.lastAppliedSeq + 1
    if (page.freshness.contiguousSeq < snapshot.projection.lastAppliedSeq || (snapshot.freshness && page.freshness.contiguousSeq < snapshot.freshness.contiguousSeq)) throw new ReadFailure('history-regression')
    for (const [index, event] of page.events.entries()) {
      if (!record(event) || event.seq !== fromSeq + index || event.seq > page.freshness.contiguousSeq) throw new ReadFailure('invalid-data')
    }
    const following = fromSeq + page.events.length
    if (page.nextSeq !== null && (!integer(page.nextSeq, 1) || page.events.length !== pageSize || page.nextSeq !== following || page.nextSeq > page.freshness.contiguousSeq)) throw new ReadFailure('invalid-data')
    return appendConversationEvents(snapshot.projection, page.events)
  }
  async function drain() {
    running = true
    let pages = 0, rounds = 0
    try {
      while (!stopped && dirty && pages < maxPages && rounds < maxPages) {
        dirty = false
        rounds++
        let source: ConversationReadError['source'] = 'session'
        try {
          publish({ status: snapshot.session ? 'refreshing' : 'loading', needsRefresh: true, error: null })
          if (stopped) return
          const value = await port.getSession(scope.sessionId, lifetime.signal)
          if (stopped) return
          const session = validateSession(value)
          publish({ session })
          if (stopped) return
          let hasNext: boolean
          do {
            source = 'history'
            pages++
            const page = await port.sessionHistory(scope.sessionId, snapshot.projection.lastAppliedSeq + 1, pageSize, lifetime.signal)
            if (stopped) return
            const projection = applyPage(page)
            hasNext = page.nextSeq !== null
            publish({ projection, freshness: freezeTree(structuredClone(page.freshness)) })
            if (stopped) return
          } while (hasNext && pages < maxPages)
          // No speculative fetch at an exhausted page, even if freshness was read later than events.
          const needsRefresh = dirty || hasNext || Math.max(session.freshness.contiguousSeq, snapshot.freshness!.contiguousSeq) > snapshot.projection.lastAppliedSeq
          publish({ status: 'ready', needsRefresh })
        } catch (error) {
          fail(source, error)
        }
        // Notifications may synchronously request another refresh. It consumes this same budget.
      }
      if (!stopped && dirty && !snapshot.needsRefresh) publish({ needsRefresh: true })
    } finally {
      running = false
    }
  }
  function requestRefresh() {
    if (stopped) return
    dirty = true
    if (running || scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      if (stopped) return
      if (snapshot.subscription === 'starting') startWatch()
      if (!stopped && !running) void drain()
    })
  }
  requestRefresh()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (stopped) return () => {}
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    refresh: requestRefresh,
    retry() {
      if (stopped) return
      if (snapshot.subscription === 'closed' || snapshot.subscription === 'error') startWatch()
      requestRefresh()
    },
    dispose() {
      if (stopped && snapshot.status === 'disposed') return
      stopped = true
      dirty = false
      listeners.clear()
      lifetime.abort()
      closeWatch()
      snapshot = Object.freeze({ scope, status: 'disposed', subscription: 'disposed', projection: createConversationProjection(scope.sessionId), session: null, freshness: null, needsRefresh: false, error: null, subscriptionError: null })
    },
  }
}
