import { ApiError } from './errors.ts'
import type { SelectConversationModel, ResolveConversationApproval, CancelQueuedConversationMessage, ConversationControlReceipt, StopConversationTurn } from '@wemux/web-contract'

export interface ConversationControlScope {
  readonly host: string
  readonly accountId: string
  readonly teamId: string
  readonly projectId: string
  readonly taskId: string
  readonly sessionId: string
}
export type ConversationControlIntent =
  | { readonly operation: 'select-model'; readonly body: SelectConversationModel }
  | { readonly operation: 'cancel-queued'; readonly submissionCommandId: string; readonly body: CancelQueuedConversationMessage }
  | { readonly operation: 'stop-turn'; readonly body: StopConversationTurn }
  | { readonly operation: 'resolve-approval'; readonly approvalId: string; readonly body: ResolveConversationApproval }
export interface ConversationControlStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem?(key: string): void
}
/** Owned by the authenticated client, shared across same-client remounts. Never reuse this
 * object across identity lifetimes. Abort signal BEFORE replacing the client/account/team.
 * assertCurrent must synchronously throw on lost current authority (including target policy).
 * It must not return a Promise. Scope/storage are partitions, not authorization credentials.
 */
export interface ConversationControlPort {
  readonly scope: ConversationControlScope
  readonly signal: AbortSignal
  assertCurrent(scope: ConversationControlScope, intent: ConversationControlIntent): void
  cancelQueuedMessage(sessionId: string, submissionCommandId: string, body: CancelQueuedConversationMessage, signal?: AbortSignal): Promise<ConversationControlReceipt>
  stopTurn(sessionId: string, body: StopConversationTurn, signal?: AbortSignal): Promise<ConversationControlReceipt>
  selectModel?(sessionId: string, body: SelectConversationModel, signal?: AbortSignal): Promise<ConversationControlReceipt>
  resolveApproval?(sessionId: string, approvalId: string, body: ResolveConversationApproval, signal?: AbortSignal): Promise<ConversationControlReceipt>
}
export interface ConversationControlOptions {
  /** Lazily supply the same sessionStorage object. No module browser globals. */
  readonly storage: () => ConversationControlStorage
  readonly port: ConversationControlPort
}
export interface ConversationControlSnapshot {
  readonly scope: ConversationControlScope
  readonly status: 'unloaded' | 'ready' | 'sending' | 'uncertain' | 'admitted' | 'rejected' | 'blocked' | 'disposed'
  readonly intent: ConversationControlIntent | null
  /** Validated admission only; may be memory-only if settlement persistence failed. */
  readonly admission: ConversationControlReceipt | null
  readonly error: string | null
}
export interface ConversationControls {
  readonly key: string
  getSnapshot(): ConversationControlSnapshot
  subscribe(listener: () => void): () => void
  /** Read only. Durable receipts from an earlier client require explicit same-intent retry. */
  load(): void
  /** Caller owns IDs. One unresolved control serializes all operations in this scope. */
  submit(intent: ConversationControlIntent): Promise<void>
  retry(): Promise<void>
  /** Explicitly release only a verified not-admitted model intent in this client lifetime. */
  releaseRejected(): void
  /** Stops this observer only, never cancels the remote operation or another joiner. */
  dispose(): void
}

type Stored = { version: 1; scopeKey: string; intent: ConversationControlIntent; receipt: ConversationControlReceipt | null }
type Outcome = { intent: ConversationControlIntent; receipt: ConversationControlReceipt | null; persisted: boolean; error: string | null; rejected?: boolean }
type Flight = { port: ConversationControlPort; identity: string; result: Promise<Outcome> }
type Coordination = { busy: Set<string>; flights: Map<string, Flight>; settled: WeakMap<ConversationControlPort, Map<string, string>>; rejected: WeakMap<ConversationControlPort, Map<string, string>> }
const coordination = new WeakMap<ConversationControlStorage, Coordination>()
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k))
const id = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 200 && !v.includes('\0')
const errors = {
  storage: '无法读取或验证控制请求存储；不会自动发送。',
  save: '无法确认控制请求已持久保存；请保留原身份，恢复存储后重试。',
  stale: '持久控制请求已变化或消失；当前视图不能替换原请求。',
  pending: '上一控制请求尚未确认接收；请显式重试原请求。',
  authority: '当前客户端或操作权限已失效；未授权新的投递。',
  uncertain: '无法确认控制请求接收结果；可能已经提交，请保留原身份显式重试。',
  settlement: '已收到接收回执，但无法保存确认；不得替换未解决的持久请求。',
  invalid: '控制请求需要有效的显式目标和调用方 commandId。',
  busy: '同一范围的控制请求正在处理；不同客户端不能接管其回执。',
  rejected: '服务器明确未接收模型选择：模型已不可用或 Agent 不支持切换。可显式释放此请求，再刷新清单或使用其他控制。',
}
function freeze<T>(v: T): T {
  if (v && typeof v === 'object') { Object.freeze(v); for (const child of Object.values(v)) freeze(child) }
  return v
}
function scopeCopy(v: ConversationControlScope): ConversationControlScope {
  const { accountId, teamId, projectId, taskId, sessionId } = v
  const url = new URL(v.host)
  if (![accountId, teamId, projectId, taskId, sessionId].every(id) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin.length > 2048) throw Error(errors.invalid)
  return freeze({ host: url.origin, accountId, teamId, projectId, taskId, sessionId })
}
function intentCopy(v: unknown): ConversationControlIntent {
  if (!record(v) || !record(v.body) || !id(v.body.commandId)) throw Error(errors.invalid)
  if (v.operation === 'cancel-queued' && exact(v, ['operation', 'submissionCommandId', 'body']) && exact(v.body, ['commandId']) && id(v.submissionCommandId)) {
    return freeze({ operation: v.operation, submissionCommandId: v.submissionCommandId, body: { commandId: v.body.commandId } })
  }
  if (v.operation === 'select-model' && exact(v, ['operation', 'body']) && exact(v.body, ['commandId', 'modelId']) && id(v.body.modelId)) {
    return freeze({ operation: v.operation, body: { commandId: v.body.commandId, modelId: v.body.modelId } })
  }
  if (v.operation === 'stop-turn' && exact(v, ['operation', 'body']) && exact(v.body, ['commandId', 'turnId']) && id(v.body.turnId)) {
    return freeze({ operation: v.operation, body: { commandId: v.body.commandId, turnId: v.body.turnId } })
  }
  if (v.operation === 'resolve-approval' && exact(v, ['operation', 'approvalId', 'body']) && id(v.approvalId)
    && exact(v.body, ['commandId', 'turnId', 'decision']) && id(v.body.turnId) && (v.body.decision === 'approve' || v.body.decision === 'deny')) {
    return freeze({ operation: v.operation, approvalId: v.approvalId, body: { commandId: v.body.commandId, turnId: v.body.turnId, decision: v.body.decision } })
  }
  throw Error(errors.invalid)
}
const identity = (v: ConversationControlIntent) => JSON.stringify(v)
function receiptCopy(v: unknown, intent: ConversationControlIntent): ConversationControlReceipt {
  if (!record(v) || v.commandId !== intent.body.commandId) throw Error(errors.uncertain)
  return freeze({ commandId: intent.body.commandId })
}
function parse(raw: string | null, key: string): Stored | null {
  if (raw === null) return null
  if (raw.length > 20000) throw Error(errors.storage)
  const v: unknown = JSON.parse(raw)
  if (!record(v) || !exact(v, ['version', 'scopeKey', 'intent', 'receipt']) || v.version !== 1 || v.scopeKey !== key) throw Error(errors.storage)
  const intent = intentCopy(v.intent)
  if (v.receipt !== null && (!record(v.receipt) || !exact(v.receipt, ['commandId']))) throw Error(errors.storage)
  return freeze({ version: 1, scopeKey: key, intent, receipt: v.receipt === null ? null : receiptCopy(v.receipt, intent) })
}

/** A bounded durable control slot, not an execution outbox. Only a validated response through
 * this authenticated port settles admission. No Journal confirmation or command polling API.
 * Same-realm storage coordination is not cross-tab CAS or distributed exactly-once execution.
 */
export function createConversationControls(scopeInput: ConversationControlScope, options: ConversationControlOptions): ConversationControls {
  const scope = scopeCopy(scopeInput), { port, storage: getStorage } = options
  const scopeIdentity = JSON.stringify(scope)
  if (JSON.stringify(scopeCopy(port.scope)) !== scopeIdentity) throw Error(errors.authority)
  const signal = port.signal
  const key = `wemux.conversation-controls:${scopeIdentity}`
  const lifetime = new AbortController(), listeners = new Set<() => void>()
  let known: ConversationControlIntent | null = null, loaded = false, disposed = false, accessing = false
  let memory: { identity: string; receipt: ConversationControlReceipt } | null = null
  let snapshot: ConversationControlSnapshot = freeze({ scope, status: 'unloaded', intent: null, admission: null, error: null })
  function publish(patch: Partial<ConversationControlSnapshot>) {
    if (disposed) return
    const next = { ...snapshot, ...patch }
    if (!next.intent || next.admission?.commandId !== next.intent.body.commandId) next.admission = null
    snapshot = freeze(next)
    const current = snapshot
    for (const listener of [...listeners]) {
      if (disposed || snapshot !== current) break
      if (listeners.has(listener)) { try { listener() } catch { /* Observation cannot change admission. */ } }
    }
  }
  const fail = (e: unknown) => publish({ status: 'blocked', intent: known, error: e instanceof Error && Object.values(errors).includes(e.message) ? e.message : errors.storage })
  function authority(intent: ConversationControlIntent) {
    if (signal.aborted || port.signal !== signal || JSON.stringify(scopeCopy(port.scope)) !== scopeIdentity) throw Error(errors.authority)
    try {
      const result: unknown = port.assertCurrent(scope, intent)
      if (result !== undefined) throw Error(errors.authority)
    } catch { throw Error(errors.authority) }
  }
  function context() {
    if (accessing) throw Error(errors.busy)
    accessing = true
    try {
      const storage = getStorage()
      if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') throw Error(errors.storage)
      let c = coordination.get(storage)
      if (!c) { c = { busy: new Set(), flights: new Map(), settled: new WeakMap(), rejected: new WeakMap() }; coordination.set(storage, c) }
      return { storage, c }
    } finally { accessing = false }
  }
  function locked<T>(c: Coordination, action: () => T): T {
    if (c.busy.has(key)) throw Error(errors.busy)
    c.busy.add(key)
    try { return action() } finally { c.busy.delete(key) }
  }
  function read(storage: ConversationControlStorage) {
    let raw: string | null, value: Stored | null
    try { raw = storage.getItem(key); value = parse(raw, key) } catch { throw Error(errors.storage) }
    if ((known && (!value || identity(known) !== identity(value.intent))) || (loaded && !known && value)) throw Error(errors.stale)
    return { raw, value }
  }
  function write(storage: ConversationControlStorage, before: string | null, value: Stored) {
    const raw = JSON.stringify(value)
    try {
      if (storage.getItem(key) !== before) throw Error(errors.stale)
      storage.setItem(key, raw)
      if (storage.getItem(key) !== raw) throw Error(errors.save)
    } catch { throw Error(errors.save) }
  }
  const admitted = (c: Coordination, value: Stored) => !signal.aborted && !!value.receipt && c.settled.get(port)?.get(key) === identity(value.intent)
  const rejected = (c: Coordination, value: Stored) => !signal.aborted && !value.receipt && c.rejected.get(port)?.get(key) === identity(value.intent)
  function apply(c: Coordination, value: Stored | null) {
    loaded = true
    known = value?.intent ?? null
    if (!known || memory?.identity !== identity(known)) memory = null
    publish({ intent: known, admission: value?.receipt ?? memory?.receipt ?? null,
      status: value ? admitted(c, value) ? 'admitted' : rejected(c, value) ? 'rejected' : 'uncertain' : 'ready', error: value && rejected(c, value) ? errors.rejected : null })
  }
  function load() {
    if (disposed) return
    try { const { storage, c } = context(); apply(c, locked(c, () => read(storage).value)) } catch (e) { fail(e) }
  }
  async function execute(storage: ConversationControlStorage, c: Coordination, intent: ConversationControlIntent): Promise<Outcome> {
    let receipt: ConversationControlReceipt | null = null
    try {
      locked(c, () => { const current = read(storage).value; if (!current || identity(current.intent) !== identity(intent)) throw Error(errors.stale) })
      authority(intent)
      c.rejected.get(port)?.delete(key)
      const result = intent.operation === 'cancel-queued'
        ? await port.cancelQueuedMessage(scope.sessionId, intent.submissionCommandId, intent.body, signal)
        : intent.operation === 'stop-turn' ? await port.stopTurn(scope.sessionId, intent.body, signal)
        : intent.operation === 'select-model' ? await (port.selectModel ? port.selectModel(scope.sessionId, intent.body, signal) : Promise.reject(Error(errors.authority)))
        : await (port.resolveApproval ? port.resolveApproval(scope.sessionId, intent.approvalId, intent.body, signal) : Promise.reject(Error(errors.authority)))
      authority(intent)
      receipt = receiptCopy(result, intent)
      locked(c, () => {
        const current = read(storage)
        if (!current.value || identity(current.value.intent) !== identity(intent)) throw Error(errors.stale)
        write(storage, current.raw, { ...current.value, receipt })
        let settled = c.settled.get(port)
        if (!settled) { settled = new Map(); c.settled.set(port, settled) }
        settled.set(key, identity(intent))
      })
      return { intent, receipt, persisted: true, error: null }
    } catch (e) {
      // This code is emitted only inside admission's transaction, after the existing
      // command check and before creating a command. Generic HTTP errors are ambiguous.
      if (!receipt && intent.operation === 'select-model' && e instanceof ApiError && e.status === 409 && e.code === 'model_not_admitted') {
        try {
          authority(intent)
          locked(c, () => {
            const current = read(storage).value
            if (!current || current.receipt || identity(current.intent) !== identity(intent)) throw Error(errors.stale)
            let proofs = c.rejected.get(port)
            if (!proofs) { proofs = new Map(); c.rejected.set(port, proofs) }
            proofs.set(key, identity(intent))
          })
          return { intent, receipt: null, persisted: false, rejected: true, error: errors.rejected }
        } catch { return { intent, receipt: null, persisted: false, error: errors.authority } }
      }
      return { intent, receipt, persisted: false, error: receipt ? errors.settlement : e instanceof Error && Object.values(errors).includes(e.message) ? e.message : errors.uncertain }
    }
  }
  async function observe(storage: ConversationControlStorage, c: Coordination, result: Promise<Outcome>) {
    if (disposed) return
    let stop!: () => void
    const stopped = new Promise<null>(resolve => { stop = () => resolve(null); lifetime.signal.addEventListener('abort', stop, { once: true }) })
    try {
      const outcome = await Promise.race([result, stopped])
      if (!outcome || disposed) return
      if (known && identity(known) !== identity(outcome.intent)) { fail(Error(errors.stale)); return }
      known = outcome.intent
      if (outcome.receipt) memory = { identity: identity(known), receipt: outcome.receipt }
      try {
        authority(known)
        locked(c, () => {
          const current = read(storage).value
          if (!current || identity(current.intent) !== identity(outcome.intent)) throw Error(errors.stale)
          if (outcome.persisted && !admitted(c, current)) throw Error(errors.stale)
        })
      } catch (e) {
        publish({ intent: known, admission: outcome.receipt })
        fail(e)
        return
      }
      publish({ intent: known, admission: outcome.receipt, status: outcome.persisted ? 'admitted' : outcome.receipt ? 'blocked' : outcome.rejected ? 'rejected' : 'uncertain', error: outcome.error })
    } finally { lifetime.signal.removeEventListener('abort', stop) }
  }
  async function start(input: ConversationControlIntent | null, retry: boolean) {
    if (disposed) return
    try {
      // Copy before storage callbacks, authority checks, transport, or any await.
      const requested = input === null ? null : intentCopy(input)
      const expected = known
      const { storage, c } = context()
      const prepared = locked(c, () => {
        const current = read(storage), previous = current.value
        let intent: ConversationControlIntent
        if (retry) {
          if (!expected || !previous || identity(expected) !== identity(previous.intent)) throw Error(errors.stale)
          intent = previous.intent
        } else {
          if (!requested) throw Error(errors.invalid)
          intent = requested
          if (previous && identity(previous.intent) !== identity(intent)) {
            if (!admitted(c, previous)) throw Error(errors.pending)
            if (previous.intent.body.commandId === intent.body.commandId) throw Error(errors.invalid)
          }
        }
        const flight = c.flights.get(key)
        if (flight && (flight.port !== port || flight.identity !== identity(intent))) throw Error(errors.busy)
        if (previous && identity(previous.intent) === identity(intent) && admitted(c, previous)) return { value: previous, flight: null, settled: true }
        const value: Stored = { version: 1, scopeKey: key, intent, receipt: previous && identity(previous.intent) === identity(intent) ? previous.receipt : null }
        // A write may commit and then throw. Retain attempted identity even on save failure.
        known = intent
        if (!previous || identity(previous.intent) !== identity(intent)) write(storage, current.raw, value)
        // Joining is an explicit action and requires current authority too.
        if (flight) authority(intent)
        return { value, flight, settled: false }
      })
      if (prepared.settled) { apply(c, prepared.value); return }
      let flight = prepared.flight
      if (!flight) {
        const result = Promise.resolve().then(() => execute(storage, c, prepared.value.intent))
        flight = { port, identity: identity(prepared.value.intent), result }
        c.flights.set(key, flight)
        const owned = flight
        void result.finally(() => { if (c.flights.get(key) === owned) c.flights.delete(key) })
      }
      // Install the shared flight before publishing: listeners may synchronously retry.
      apply(c, prepared.value)
      publish({ status: 'sending' })
      await observe(storage, c, flight.result)
    } catch (e) { fail(e) }
  }
  function releaseRejected() {
    if (disposed) return
    try {
      const { storage, c } = context()
      locked(c, () => {
        const current = read(storage)
        if (!current.value || !rejected(c, current.value) || c.flights.has(key)) throw Error(errors.pending)
        authority(current.value.intent)
        if (!storage.removeItem || storage.getItem(key) !== current.raw) throw Error(errors.save)
        storage.removeItem(key)
        if (storage.getItem(key) !== null) throw Error(errors.save)
        c.rejected.get(port)?.delete(key)
        known = null; memory = null
      })
      apply(c, null)
    } catch (e) { fail(e) }
  }
  return {
    key, getSnapshot: () => snapshot, subscribe(listener) { if (disposed) return () => {}; listeners.add(listener); return () => { listeners.delete(listener) } },
    load, submit: intent => start(intent, false), retry: () => start(null, true), releaseRejected,
    dispose() { if (disposed) return; disposed = true; lifetime.abort(); listeners.clear(); snapshot = freeze({ ...snapshot, status: 'disposed' }) },
  }
}
