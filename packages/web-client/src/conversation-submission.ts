import type { ConversationSendReceipt, SendConversationMessage } from '@wemux/web-contract'
import type { ConversationScope } from './conversation-controller.ts'
import { randomId } from './random.ts'

export interface ConversationSubmissionScope extends ConversationScope { readonly host: string }
/** Supply the same sessionStorage object lazily. No browser globals are accessed by this module. */
export interface ConversationSubmissionStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}
export interface ConversationSubmissionOptions {
  readonly storage: () => ConversationSubmissionStorage
  /** Bind to the authenticated client for this immutable host/account/team. */
  readonly send: (sessionId: string, body: SendConversationMessage, signal: AbortSignal) => Promise<ConversationSendReceipt>
  readonly mint?: () => string
}
export interface ConversationSubmissionIntent {
  readonly body: SendConversationMessage
  readonly draftRevision: number
  /** Validated POST admission/command status, NOT Turn success. */
  readonly receipt: ConversationSendReceipt | null
}
export interface ConversationSubmissionSnapshot {
  readonly scope: ConversationSubmissionScope
  readonly status: 'unloaded' | 'ready' | 'sending' | 'uncertain' | 'admitted' | 'blocked' | 'disposed'
  readonly draft: string
  readonly intent: ConversationSubmissionIntent | null
  /** Retained even when persisting settlement fails. The intent then remains unresolved. */
  readonly admission: ConversationSendReceipt | null
  readonly error: string | null
}
export interface ConversationSubmissionController {
  readonly key: string
  getSnapshot(): ConversationSubmissionSnapshot
  subscribe(listener: () => void): () => void
  /** Read only; never sends, including on remount. */
  load(): void
  /** Persists immediately. Failure leaves the prior persisted draft/intent intact. */
  edit(content: string): boolean
  /** New intent only; an unresolved intent requires explicit retry(). */
  submit(): Promise<void>
  /** Replays only the exact intent observed by this instance; never mints. */
  retry(): Promise<void>
  /** Abort local observation, not server execution. Durable uncertainty is retained. */
  dispose(): void
}

type Stored = { version: 1; scopeKey: string; draft: { content: string; revision: number }; intent: ConversationSubmissionIntent | null }
type Outcome = { intent: ConversationSubmissionIntent | null; receipt: ConversationSendReceipt | null; error: string | null }
type Coordination = { busy: Set<string>; flights: Map<string, Promise<Outcome>> }
const coordination = new WeakMap<ConversationSubmissionStorage, Coordination>()
const statuses = ['pending', 'accepted', 'rejected', 'completed', 'failed', 'cancelled']
const messages = {
  storage: '无法读取或验证会话存储；请恢复同一标签页的存储后重试，原请求不会自动重发。',
  save: '无法确认会话内容已保存；本次不会继续发送。请恢复存储后核对原请求。',
  stale: '保存的原请求已消失或发生变化；已停止操作，不会创建新消息身份。请核对原请求。',
  busy: '会话存储正在更新，请稍后重试。',
  pending: '上一条消息的接收结果尚未确认；请显式重试原消息，新草稿已保留。',
  uncertain: '无法确认原消息的接收结果；它可能已经提交。请保留原身份并显式重试，勿作为新消息重发。',
  invalid: '消息不能为空，不能含 NUL 字符，最多 100000 字符且 JSON 编码不超过 200000 字节。',
  settled: '原消息已有接收回执；回执不代表 Turn 执行成功，无需重试提交。',
  settlement: '已收到消息接收回执，但无法保存确认状态；请恢复存储后核对原请求，勿作为新消息重发。',
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const keys = (v: Record<string, unknown>, expected: string[]) => Object.keys(v).length === expected.length && expected.every(k => Object.hasOwn(v, k))
const id = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 200 && !v.includes('\0')
const revision = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) < Number.MAX_SAFE_INTEGER - 1
const draftText = (v: unknown): v is string => typeof v === 'string' && v.length <= 100000 && !v.includes('\0') && new TextEncoder().encode(JSON.stringify(v)).length <= 200000
const bodyValid = (v: unknown): v is SendConversationMessage => record(v) && keys(v, ['commandId', 'messageId', 'content']) && id(v.commandId) && id(v.messageId) && draftText(v.content) && !!v.content.trim()
const sameBody = (a: SendConversationMessage, b: SendConversationMessage) => a.commandId === b.commandId && a.messageId === b.messageId && a.content === b.content
const sameIntent = (a: ConversationSubmissionIntent, b: ConversationSubmissionIntent) => sameBody(a.body, b.body) && a.draftRevision === b.draftRevision
function receiptValid(v: unknown, body: SendConversationMessage): v is ConversationSendReceipt {
  return record(v) && v.commandId === body.commandId && v.messageId === body.messageId && typeof v.status === 'string' && statuses.includes(v.status)
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child) }
  return value
}
function parse(raw: string | null, key: string): Stored {
  if (raw === null) return { version: 1, scopeKey: key, draft: { content: '', revision: 0 }, intent: null }
  // Bounded before JSON.parse, including worst-case JSON escapes for two bounded texts.
  if (raw.length > 1300000) throw Error(messages.storage)
  const v: unknown = JSON.parse(raw)
  if (!record(v) || !keys(v, ['version', 'scopeKey', 'draft', 'intent']) || v.version !== 1 || v.scopeKey !== key
    || !record(v.draft) || !keys(v.draft, ['content', 'revision']) || !draftText(v.draft.content) || !revision(v.draft.revision)) throw Error(messages.storage)
  if (v.intent !== null) {
    const i = v.intent
    if (!record(i) || !keys(i, ['body', 'draftRevision', 'receipt']) || !bodyValid(i.body) || !revision(i.draftRevision) || i.draftRevision > v.draft.revision
      || (i.receipt !== null && (!receiptValid(i.receipt, i.body) || !record(i.receipt) || !keys(i.receipt, ['commandId', 'messageId', 'status'])))) throw Error(messages.storage)
  }
  return freeze(v as unknown as Stored)
}

/** One durable intent per scope plus a separate draft, not an outbox. Only a matching, validated
 * POST response settles admission. All thrown HTTP errors remain uncertain: replay admission
 * checks precede deduplication on Server, and errors can also occur after commit. No admin receipt
 * polling or caller-supplied Journal confirmation. Same-realm coordination is not cross-tab CAS.
 */
export function createConversationSubmission(scopeInput: ConversationSubmissionScope, options: ConversationSubmissionOptions): ConversationSubmissionController {
  const { accountId, teamId, projectId, taskId, sessionId } = scopeInput
  if (![accountId, teamId, projectId, taskId, sessionId].every(id)) throw new TypeError('会话提交需要完整且有效的账号与任务范围。')
  const url = new URL(scopeInput.host)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin.length > 2048) throw new TypeError('会话提交需要有效的 HTTP 宿主。')
  const scope = freeze({ host: url.origin, accountId, teamId, projectId, taskId, sessionId })
  const key = `wemux.conversation-submission:${JSON.stringify([scope.host, accountId, teamId, projectId, taskId, sessionId])}`
  const { storage: getStorage, send, mint = randomId } = options
  const listeners = new Set<() => void>(), lifetime = new AbortController()
  let disposed = false, accessing = false
  let known: ConversationSubmissionIntent | null = null
  // Observation only: this must never authorize replacing a durably unresolved intent.
  let observedAdmission: { intent: ConversationSubmissionIntent; receipt: ConversationSendReceipt } | null = null
  let snapshot: ConversationSubmissionSnapshot = freeze({ scope, status: 'unloaded', draft: '', intent: null, admission: null, error: null })
  function publish(patch: Partial<ConversationSubmissionSnapshot>) {
    if (disposed) return
    const next = { ...snapshot, ...patch }
    if (observedAdmission && (!next.intent || !sameIntent(next.intent, observedAdmission.intent))) observedAdmission = null
    next.admission = next.intent?.receipt ?? null
    if (next.intent && !next.intent.receipt && observedAdmission && sameIntent(next.intent, observedAdmission.intent)) {
      next.admission = observedAdmission.receipt
      if (next.error === null || next.error === messages.uncertain || next.error === messages.pending) next.error = messages.settlement
    }
    snapshot = freeze(next)
    const current = snapshot
    for (const listener of [...listeners]) {
      if (disposed || snapshot !== current) break
      if (listeners.has(listener)) { try { listener() } catch { /* Observers do not control admission. */ } }
    }
  }
  function context() {
    if (accessing) throw Error(messages.busy)
    accessing = true
    try {
      const storage = getStorage()
      if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') throw Error(messages.storage)
      let c = coordination.get(storage)
      if (!c) { c = { busy: new Set(), flights: new Map() }; coordination.set(storage, c) }
      return { storage, c }
    } catch { throw Error(messages.storage) } finally { accessing = false }
  }
  function io<T>(storage: ConversationSubmissionStorage, c: Coordination, action: () => T): T {
    if (c.busy.has(key)) throw Error(messages.busy)
    c.busy.add(key)
    try { return action() } finally { c.busy.delete(key) }
  }
  function read(storage: ConversationSubmissionStorage) {
    let raw: string | null, value: Stored
    try { raw = storage.getItem(key); value = parse(raw, key) } catch { throw Error(messages.storage) }
    // A stale mounted view cannot authorize replacing/discarding its unresolved identity.
    if (known && !known.receipt && (!value.intent || !sameIntent(known, value.intent))) throw Error(messages.stale)
    return { raw, value }
  }
  function write(storage: ConversationSubmissionStorage, before: string | null, value: Stored) {
    try {
      if (storage.getItem(key) !== before) throw Error(messages.stale)
      const raw = JSON.stringify(value)
      parse(raw, key)
      storage.setItem(key, raw)
      if (storage.getItem(key) !== raw) throw Error(messages.save)
    } catch { throw Error(messages.save) }
  }
  function apply(value: Stored) {
    if (observedAdmission && (!value.intent || !sameIntent(value.intent, observedAdmission.intent) || value.intent.receipt)) observedAdmission = null
    known = value.intent
    publish({ draft: value.draft.content, intent: value.intent, admission: value.intent?.receipt ?? null,
      status: value.intent ? value.intent.receipt ? 'admitted' : 'uncertain' : 'ready', error: null })
  }
  const fail = (error: unknown) => publish({ status: 'blocked', intent: known ?? snapshot.intent, error: error instanceof Error && Object.values(messages).includes(error.message) ? error.message : messages.storage })
  function load() {
    if (disposed) return
    try { const { storage, c } = context(); apply(io(storage, c, () => read(storage).value)) } catch (e) { fail(e) }
  }
  function edit(content: string): boolean {
    if (disposed) return false
    if (!draftText(content)) { publish({ error: messages.invalid }); return false }
    try {
      const { storage, c } = context()
      const value = io(storage, c, () => {
        const prior = read(storage)
        if (!revision(prior.value.draft.revision + 1)) throw Error(messages.save)
        const next = { ...prior.value, draft: { content, revision: prior.value.draft.revision + 1 } }
        write(storage, prior.raw, next)
        return next
      })
      apply(value)
      if (c.flights.has(key)) publish({ status: 'sending' })
      return true
    } catch (e) { fail(e); return false }
  }
  async function execute(storage: ConversationSubmissionStorage, c: Coordination, retry: boolean, expected: ConversationSubmissionIntent | null): Promise<Outcome> {
    let body: SendConversationMessage | null = null, intent: ConversationSubmissionIntent | null = null, receipt: ConversationSendReceipt | null = null
    try {
      if (disposed) return { intent, receipt, error: null }
      const value = io(storage, c, () => {
        const prior = read(storage)
        if (retry) {
          if (!expected || !prior.value.intent || !sameIntent(expected, prior.value.intent)) throw Error(messages.stale)
          if (prior.value.intent.receipt) throw Error(messages.settled)
          return prior.value
        }
        if (prior.value.intent && !prior.value.intent.receipt) throw Error(messages.pending)
        if (!draftText(prior.value.draft.content) || !prior.value.draft.content.trim()) throw Error(messages.invalid)
        const intent = freeze({ body: { commandId: mint(), messageId: mint(), content: prior.value.draft.content }, draftRevision: prior.value.draft.revision, receipt: null })
        if (!bodyValid(intent.body)) throw Error(messages.invalid)
        // Keep the full identity in memory even if setItem or its read-back fails.
        known = intent
        const next = { ...prior.value, intent }
        write(storage, prior.raw, next)
        return next
      })
      intent = value.intent!
      body = intent.body
      apply(value)
      publish({ status: 'sending' })
      if (disposed) return { intent, receipt, error: messages.uncertain }
      // Recheck after observer callbacks; they may edit drafts or replace storage.
      io(storage, c, () => {
        const latest = read(storage).value
        if (!latest.intent || latest.intent.receipt || !sameIntent(value.intent!, latest.intent)) throw Error(messages.stale)
      })
      if (disposed) return { intent, receipt, error: messages.uncertain }
      // Abort releases local coordination even when an injected sender ignores its signal.
      let onAbort = () => {}
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(Error(messages.uncertain))
        lifetime.signal.addEventListener('abort', onAbort, { once: true })
      })
      let raw: unknown
      try { raw = await Promise.race([send(scope.sessionId, body, lifetime.signal), aborted]) }
      catch { return { intent, receipt, error: messages.uncertain } }
      finally { lifetime.signal.removeEventListener('abort', onAbort) }
      if (disposed) return { intent, receipt, error: messages.uncertain }
      if (!receiptValid(raw, body)) return { intent, receipt, error: messages.uncertain }
      receipt = freeze({ commandId: raw.commandId, messageId: raw.messageId, status: raw.status })
      try {
        io(storage, c, () => {
          const prior = read(storage)
          if (!prior.value.intent || prior.value.intent.receipt || !sameIntent(value.intent!, prior.value.intent)) throw Error(messages.stale)
          const untouched = prior.value.draft.revision === value.intent!.draftRevision && prior.value.draft.content === body!.content
          const next = { ...prior.value, intent: { ...prior.value.intent, receipt },
            draft: untouched ? { content: '', revision: prior.value.draft.revision + 1 } : prior.value.draft }
          write(storage, prior.raw, next)
        })
      } catch { return { intent, receipt, error: messages.settlement } }
      return { intent, receipt, error: null }
    } catch (e) { return { intent, receipt, error: e instanceof Error && Object.values(messages).includes(e.message) ? e.message : messages.storage } }
  }
  async function run(retry: boolean) {
    if (disposed) return
    try {
      const { storage, c } = context(), expected = known
      if (retry && (!expected || expected.receipt)) { publish({ error: expected?.receipt ? messages.settled : messages.stale }); return }
      let flight = c.flights.get(key)
      if (!flight) {
        // Register before any storage/mint/send callbacks can synchronously reenter.
        flight = Promise.resolve().then(() => execute(storage, c, retry, expected)).finally(() => { c.flights.delete(key) })
        c.flights.set(key, flight)
      }
      const result = await flight
      if (disposed) return
      if (retry && result.intent && expected && !sameIntent(expected, result.intent)) { fail(Error(messages.stale)); return }
      const retainAdmission = (intent: ConversationSubmissionIntent | null) => {
        if (result.intent && result.receipt && intent && sameIntent(intent, result.intent)) {
          observedAdmission = { intent: result.intent, receipt: result.receipt }
        }
      }
      try {
        // A joiner may still know the previous settled intent. Associate the outcome
        // with the exact intent being adopted, not that stale pre-read identity.
        const value = io(storage, c, () => read(storage).value)
        retainAdmission(value.intent)
        apply(value)
      } catch (error) {
        // A storage failure must not discard a receipt for our original intent or
        // replace the actionable storage error with the flight's generic outcome.
        retainAdmission(known)
        fail(error)
        if (result.error && snapshot.intent && !snapshot.intent.receipt) publish({ status: 'uncertain' })
        return
      }
      if (result.intent && (!snapshot.intent || !sameIntent(snapshot.intent, result.intent))) { fail(Error(messages.stale)); return }
      if (result.error) publish({ status: snapshot.intent && !snapshot.intent.receipt ? 'uncertain' : 'blocked', error: result.error })
    } catch (e) { fail(e) }
  }
  return {
    key, getSnapshot: () => snapshot,
    subscribe(listener) { if (!disposed) listeners.add(listener); return () => { listeners.delete(listener) } },
    load, edit, submit: () => run(false), retry: () => run(true),
    dispose() {
      if (disposed) return
      disposed = true; listeners.clear(); lifetime.abort(); known = null; observedAdmission = null
      snapshot = freeze({ scope, status: 'disposed', draft: '', intent: null, admission: null, error: null })
    },
  }
}
