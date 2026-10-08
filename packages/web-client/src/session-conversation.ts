import type { SelectConversationModel, ResolveConversationApproval, CancelQueuedConversationMessage, StopConversationTurn, ConversationControlReceipt, ConversationCommandReceipt, ConversationFreshness, ConversationHistoryPage, ConversationSendReceipt, ConversationSession, SendConversationMessage } from '@wemux/web-contract'
import type { createClusterTransport } from './cluster-transport.ts'
import { ApiError } from './errors.ts'

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0
const controlId = (v: unknown): v is string => text(v) && v.length <= 200 && !v.includes('\0')
const nullableText = (v: unknown) => v === null || text(v)
const integer = (v: unknown, minimum = 0): v is number => Number.isSafeInteger(v) && (v as number) >= minimum && (v as number) < Number.MAX_SAFE_INTEGER
const member = (v: unknown, choices: readonly string[]) => typeof v === 'string' && choices.includes(v)
const statuses = ['pending', 'accepted', 'rejected', 'completed', 'failed', 'cancelled']
const contract = () => new ApiError('会话 API 契约错误；请保留原消息身份，勿假定执行已完成。', undefined, 'contract')
const timestamp = (v: unknown) => text(v) && Number.isFinite(Date.parse(v))
function freshness(v: unknown, id: string): v is ConversationFreshness {
  return record(v) && v.sessionId === id && integer(v.contiguousSeq) && (v.workerLastSeq === null || integer(v.workerLastSeq))
    && member(v.status, ['unknown', 'syncing', 'synced', 'gap', 'offline', 'orphaned'])
}
function session(v: unknown, id: string): v is ConversationSession {
  return record(v) && v.id === id && ['projectId', 'ownerId', 'workspaceId', 'title'].every(k => text(v[k]))
    && nullableText(v.taskId) && nullableText(v.runId) && nullableText(v.deletedAt)
    && member(v.shareScope, ['owner-only', 'selected-members', 'project'])
    && member(v.runtimeState, ['idle', 'queued', 'running', 'stopping', 'unavailable', 'failed'])
    && record(v.binding) && v.binding.workspaceId === v.workspaceId && nullableText(v.binding.modelId)
    && record(v.binding.agent) && text(v.binding.agent.workerId) && text(v.binding.agent.agentKey)
    && record(v.access) && ['canRead', 'canWrite', 'canControl'].every(k => typeof (v.access as Record<string, unknown>)[k] === 'boolean')
    && (v.access.projectRole === null || member(v.access.projectRole, ['owner', 'manager', 'contributor', 'viewer']))
    && nullableText(v.activeTurnId) && nullableText(v.activeTurnOwnerId)
    && Array.isArray(v.queuedMessages) && v.queuedMessages.every(q => record(q) && text(q.commandId) && text(q.messageId) && typeof q.content === 'string' && (q.position === null || integer(q.position)) && (q.sentByAccountId === undefined || text(q.sentByAccountId)))
    && freshness(v.freshness, id) && record(v.sendCapability) && typeof v.sendCapability.allowed === 'boolean'
    && member(v.sendCapability.reasonCode, ['task_deleted', 'allowed', 'invalid_metadata', 'invalid_transition', 'active_run', 'assignment_changed', 'workspace_not_ready', 'runtime_unavailable', 'reuse_ineligible', 'not_found']) && typeof v.sendCapability.reason === 'string'
    && (v.archivedAt === undefined || nullableText(v.archivedAt))
    && (v.storageMode === undefined || member(v.storageMode, ['local', 'replicated', 'central']))
    && (v.creation === undefined || (record(v.creation) && text(v.creation.requestId) && text(v.creation.commandId) && text(v.creation.fingerprint)))
}
export interface ConversationWatchOptions {
  /** Re-read on every connection. Only advance from validated HTTP history, never SSE IDs. */
  readonly fromSeq: () => number
  readonly onInvalidate: () => void
  readonly signal?: AbortSignal
  /** Total reconnect budget, not reset by a successful connection. Default 3, maximum 10. */
  readonly maxReconnects?: number
  readonly reconnectDelayMs?: number
}
export interface ConversationWatch { readonly done: Promise<void>; dispose(): void }
const wait = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
  const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
  const timer = setTimeout(finish, ms)
  signal.addEventListener('abort', finish, { once: true })
  if (signal.aborted) finish()
})

export function sessionConversationOperations(transport: ReturnType<typeof createClusterTransport>) {
  const { request } = transport
  const path = (id: string) => { if (!text(id)) throw contract(); return `/api/sessions/${encodeURIComponent(id)}` }
  return {
    async getSession(id: string, signal?: AbortSignal): Promise<ConversationSession> {
      const raw = await request<unknown>(path(id), undefined, signal)
      if (!record(raw)) throw contract()
      // Legacy read records omit creation provenance; Task-bound creation remains strict.
      const value = { ...raw, taskId: raw.taskId ?? null, runId: raw.runId ?? null }
      if (!session(value, id)) throw contract()
      return value
    },
    async sessionHistory(id: string, fromSeq = 1, limit = 500, signal?: AbortSignal): Promise<ConversationHistoryPage> {
      if (!integer(fromSeq, 1) || !integer(limit, 1) || limit > 1000) throw contract()
      const value = await request<unknown>(`${path(id)}/events?fromSeq=${fromSeq}&limit=${limit}`, undefined, signal)
      if (!record(value) || !Array.isArray(value.events) || value.events.length > limit || !freshness(value.freshness, id)) throw contract()
      for (const [index, event] of value.events.entries()) {
        if (!record(event) || event.sessionId !== id || !integer(event.seq, 1) || event.seq !== fromSeq + index || event.seq > value.freshness.contiguousSeq
          || !timestamp(event.occurredAt) || !record(event.payload) || !text(event.payload.kind)) throw contract()
      }
      const following = fromSeq + value.events.length
      if (value.nextSeq !== null && (!integer(value.nextSeq, 1) || value.events.length !== limit || value.nextSeq !== following || value.nextSeq > value.freshness.contiguousSeq)) throw contract()
      // Server reads events and freshness separately: a newer frontier can accompany an exhausted page.
      return value as unknown as ConversationHistoryPage
    },
    async sendMessage(id: string, body: SendConversationMessage, signal?: AbortSignal): Promise<ConversationSendReceipt> {
      if (!text(body.commandId) || body.commandId.length > 200 || !text(body.messageId) || body.messageId.length > 200 || !text(body.content) || body.content.length > 100000 || body.content.includes('\0')) throw contract()
      // Snapshot only the actual wire fields, before any await/CSRF refresh. Never mint IDs.
      const sent = { commandId: body.commandId, messageId: body.messageId, content: body.content }
      const value = await request<unknown>(`${path(id)}/messages`, sent, signal)
      if (!record(value) || value.commandId !== sent.commandId || value.messageId !== sent.messageId || !member(value.status, statuses)) throw contract()
      return value as unknown as ConversationSendReceipt
    },
    async cancelQueuedMessage(id: string, submissionCommandId: string, body: CancelQueuedConversationMessage, signal?: AbortSignal): Promise<ConversationControlReceipt> {
      if (!controlId(id) || !controlId(submissionCommandId) || !body || !controlId(body.commandId)) throw contract()
      const sent = { commandId: body.commandId }
      const value = await request<unknown>(`${path(id)}/messages/${encodeURIComponent(submissionCommandId)}/cancel`, sent, signal)
      if (!record(value) || value.commandId !== sent.commandId) throw contract()
      return Object.freeze({ commandId: sent.commandId })
    },
    async stopTurn(id: string, body: StopConversationTurn, signal?: AbortSignal): Promise<ConversationControlReceipt> {
      if (!controlId(id) || !body || !controlId(body.commandId) || !controlId(body.turnId)) throw contract()
      const sent = { commandId: body.commandId, turnId: body.turnId }
      const value = await request<unknown>(`${path(id)}/turn/stop`, sent, signal)
      if (!record(value) || value.commandId !== sent.commandId) throw contract()
      return Object.freeze({ commandId: sent.commandId })
    },
    async resolveApproval(id: string, approvalId: string, body: ResolveConversationApproval, signal?: AbortSignal): Promise<ConversationControlReceipt> {
      if (!controlId(id) || !controlId(approvalId) || !body || !controlId(body.commandId) || !controlId(body.turnId) || !['approve', 'deny'].includes(body.decision)) throw contract()
      const sent = { commandId: body.commandId, turnId: body.turnId, decision: body.decision }
      const value = await request<unknown>(`${path(id)}/runtime/approvals/${encodeURIComponent(approvalId)}`, sent, signal)
      if (!record(value) || value.commandId !== sent.commandId) throw contract()
      return Object.freeze({ commandId: sent.commandId })
    },
    async selectModel(id: string, body: SelectConversationModel, signal?: AbortSignal): Promise<ConversationControlReceipt> {
      if (!controlId(id) || !body || !controlId(body.commandId) || !controlId(body.modelId)) throw contract()
      const sent = { commandId: body.commandId, name: 'set_model', arguments: { modelId: body.modelId } }
      const value = await request<unknown>(`${path(id)}/runtime/commands`, sent, signal)
      if (!record(value) || value.commandId !== sent.commandId) throw contract()
      return Object.freeze({ commandId: sent.commandId })
    },
    async commandReceipt(commandId: string, signal?: AbortSignal): Promise<ConversationCommandReceipt> {
      if (!text(commandId)) throw contract()
      const value = await request<unknown>(`/api/commands/${encodeURIComponent(commandId)}`, undefined, signal)
      if (!record(value) || value.commandId !== commandId || !text(value.workerId) || !text(value.payloadFingerprint) || !member(value.status, statuses) || !timestamp(value.createdAt) || !timestamp(value.updatedAt)) throw contract()
      return value as unknown as ConversationCommandReceipt
    },
    /** Invalidation only. Subscribe before loading history; consume done to observe terminal failures. */
    watchSession(id: string, options: ConversationWatchOptions): ConversationWatch {
      const base = path(id), maxReconnects = options.maxReconnects ?? 3, delay = options.reconnectDelayMs ?? 1000
      if (!integer(maxReconnects) || maxReconnects > 10 || !integer(delay, 10) || delay > 30000) throw contract()
      const lifetime = new AbortController()
      const signal = AbortSignal.any([transport.signal, lifetime.signal, ...(options.signal ? [options.signal] : [])])
      const done = (async () => {
        for (let attempt = 0; !signal.aborted; attempt++) {
          try {
            const cursor = options.fromSeq()
            if (!integer(cursor, 1)) throw contract()
            await transport.stream(`${base}/stream?fromSeq=${cursor}`, event => {
              if (!signal.aborted && (event === 'session.event' || event === 'freshness')) options.onInvalidate()
            }, signal)
            if (!signal.aborted) throw new ApiError('事件流已关闭。', undefined, 'network')
          } catch (error) {
            // Report the originating 401 even though it invalidates the entire identity scope.
            if (error instanceof ApiError && error.status === 401) throw error
            if (signal.aborted) return
            if (!(error instanceof ApiError) || error.kind !== 'network' || attempt >= maxReconnects) throw error
          }
          if (!signal.aborted) await wait(delay, signal)
        }
      })()
      return { done, dispose: () => lifetime.abort() }
    },
  }
}
