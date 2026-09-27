import { createHash } from 'node:crypto'
import type { JournalEvent, SessionId, Timestamp, TurnId } from '@wemux/domain'
import { createGuardedFetch } from '@wemux/connector'
import type { OutboundDelivery } from '@wemux/server-domain'
import type { ChannelRepository } from './ports/channel-repository.ts'
import type { ProjectAccessService } from './project-access-service.ts'
import type { SessionAccessService } from './session-access-service.ts'
import type { WorkerAccessService } from './worker-access-service.ts'
import type { ServerStore } from './ports/server-store.ts'

const retrySeconds = [1, 2, 4, 8, 16, 32] as const

export class ChannelOutbox {
  private readonly guardedFetch: typeof fetch
    private readonly repository: ChannelRepository
  private readonly projects: ProjectAccessService
  private readonly sessions: SessionAccessService
  private readonly workers: WorkerAccessService
  private readonly store: ServerStore
constructor(
    repository: ChannelRepository,
    projects: ProjectAccessService,
    sessions: SessionAccessService,
    workers: WorkerAccessService,
    store: ServerStore,
    fetchOptions: Parameters<typeof createGuardedFetch>[0] = {},
    guardedFetch?: typeof fetch
  ) {
    this.repository = repository; this.projects = projects; this.sessions = sessions; this.workers = workers; this.store = store; this.guardedFetch = guardedFetch ?? createGuardedFetch(fetchOptions) }

  async projectJournal(sessionId: SessionId, events: readonly JournalEvent[]): Promise<number> {
    const bindings = (await this.bindingsForSession(sessionId)).filter(value => value.binding.enabled)
    if (!bindings.length) return 0
    let created = 0
    for (const event of events) {
      const payload = event.payload
      if (payload.kind !== 'turn.finished' || payload.outcome !== 'completed') continue
      const content = await this.assistantText(sessionId, payload.turnId, event.seq)
      if (!content) continue
      for (const record of bindings) {
        const identity = `${sessionId}:${event.seq}:${payload.turnId}`
        const id = `${record.binding.channelId}:${record.binding.id}:${identity}`
        const at = event.occurredAt
        const delivery: OutboundDelivery = { id, channelId: record.binding.channelId, bindingId: record.binding.id, projectId: record.binding.projectId, sessionId, journalEventIdentity: identity, callbackUrl: record.callbackUrl, content, status: 'pending', attempt: 0, nextAttemptAt: at, leaseExpiresAt: null, responseStatus: null, diagnostic: null, createdAt: at, updatedAt: at, deliveredAt: null }
        if (await this.repository.saveOutbound(delivery)) created++
      }
    }
    return created
  }

  private async assistantText(sessionId: SessionId, turnId: TurnId, through: number): Promise<string> {
    let from = 1 as import('@wemux/domain').EventSeq
    let content = ''
    while (from <= through) {
      const page = await this.store.cache.readEvents(sessionId, from, 500)
      for (const event of page.events) {
        if (event.seq > through) return content.trim()
        const payload = event.payload
        if (payload.kind === 'assistant.text.delta' && payload.turnId === turnId && (payload.streamKind === undefined || payload.streamKind === 'assistant_text')) content += payload.text
      }
      if (!page.nextSeq || page.nextSeq <= from) break
      from = page.nextSeq
    }
    return content.trim()
  }

  async drain(limit = 20, current = new Date()): Promise<number> {
    const at = current.toISOString() as Timestamp, lease = new Date(current.getTime() + 60_000).toISOString() as Timestamp
    const deliveries = await this.repository.claimOutbound(at, lease, limit)
    for (const delivery of deliveries) await this.send(delivery)
    return deliveries.length
  }

  async send(delivery: OutboundDelivery): Promise<void> {
    const at = now(), binding = await this.repository.getBinding(delivery.bindingId), channel = await this.repository.getChannel(delivery.channelId)
    if (!binding || !binding.binding.enabled || !channel?.enabled) return this.dead(delivery, 'Channel 或 binding 已停用', null, at)
    try {
      await this.projects.require(binding.createdBy, binding.binding.projectId, 'manager')
      const session = await this.sessions.require(binding.createdBy, binding.binding.sessionId, 'control')
      await this.workers.require(binding.createdBy, binding.binding.workerId, 'use')
      if (session.binding.agent.workerId !== binding.binding.workerId) return this.dead(delivery, 'Session Worker 绑定已变化', null, at)
    } catch (error) { return this.dead(delivery, error instanceof Error ? error.message : '授权已撤销', null, at) }
    let response: Response
    try {
      response = await this.guardedFetch(delivery.callbackUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': providerId(delivery.id) }, body: JSON.stringify({ deliveryId: delivery.id, channelId: delivery.channelId, bindingId: delivery.bindingId, sessionId: delivery.sessionId, text: delivery.content }) })
    } catch (error) { return this.retry(delivery, error instanceof Error ? error.message : '网络错误', null, at) }
    await response.body?.cancel().catch(() => undefined)
    if (response.ok) { await this.repository.updateOutbound({ ...delivery, status: 'delivered', leaseExpiresAt: null, responseStatus: response.status, diagnostic: null, deliveredAt: at, updatedAt: at }); return }
    if (response.status === 429 || response.status >= 500) return this.retry(delivery, `回调返回 HTTP ${response.status}`, response.status, at, retryAfter(response))
    return this.dead(delivery, `回调返回永久错误 HTTP ${response.status}`, response.status, at)
  }

  private async retry(delivery: OutboundDelivery, diagnostic: string, responseStatus: number | null, at: Timestamp, retryAfterMs = 0): Promise<void> {
    if (delivery.attempt >= 6) return this.dead(delivery, `${diagnostic}，已达到 6 次尝试`, responseStatus, at)
    const base = retrySeconds[Math.min(delivery.attempt - 1, retrySeconds.length - 1)] * 1000
    const delay = Math.max(retryAfterMs, Math.round(base * (1 + Math.random() * 0.2)))
    await this.repository.updateOutbound({ ...delivery, status: 'retry_wait', leaseExpiresAt: null, nextAttemptAt: new Date(Date.parse(at) + delay).toISOString() as Timestamp, responseStatus, diagnostic: diagnostic.slice(0, 500), updatedAt: at })
  }
  private async dead(delivery: OutboundDelivery, diagnostic: string, responseStatus: number | null, at: Timestamp): Promise<void> { await this.repository.updateOutbound({ ...delivery, status: 'dead_letter', leaseExpiresAt: null, nextAttemptAt: null, responseStatus, diagnostic: diagnostic.slice(0, 500), updatedAt: at }) }
  private async bindingsForSession(sessionId: SessionId) { const session = await this.store.resources.getSession(sessionId); return session ? (await this.repository.listBindings(session.projectId)).filter(value => value.binding.sessionId === sessionId) : [] }
}
function providerId(value: string): string { return createHash('sha256').update(value).digest('hex').slice(0, 32) }
function retryAfter(response: Response): number { const raw = response.headers.get('retry-after'); if (!raw) return 0; const seconds = Number(raw); if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000); return Math.max(0, Date.parse(raw) - Date.now()) }
const now = (): Timestamp => new Date().toISOString() as Timestamp
