import { createHash } from 'node:crypto'
import type { CommandId, Timestamp } from '@wemux/domain'
import type { InboundDelivery } from '@wemux/server-domain'
import type { ChannelRepository } from './ports/channel-repository.ts'
import type { ProjectAccessService } from './project-access-service.ts'
import type { SessionAccessService } from './session-access-service.ts'
import type { WorkerAccessService } from './worker-access-service.ts'
import type { ServerService } from './server-service.ts'

export class ChannelRouter {
  private readonly repository: ChannelRepository
  private readonly sessions: SessionAccessService
  private readonly projects: ProjectAccessService
  private readonly workers: WorkerAccessService
  private readonly server: ServerService
  constructor(
    repository: ChannelRepository,
    sessions: SessionAccessService,
    projects: ProjectAccessService,
    workers: WorkerAccessService,
    server: ServerService,
  ) {
    this.repository = repository
    this.sessions = sessions
    this.projects = projects
    this.workers = workers
    this.server = server
  }

  async drain(limit = 20): Promise<number> {
    const deliveries = await this.repository.claimAcceptedInbound(limit)
    for (const delivery of deliveries) await this.route(delivery)
    return deliveries.length
  }

  async route(delivery: InboundDelivery): Promise<void> {
    const at = now()
    const channel = await this.repository.getChannel(delivery.channelId)
    if (!channel || !channel.enabled) return this.fail(delivery, 'Channel 已停用', at)
    const record = await this.repository.findBinding(delivery.channelId, delivery.externalConversationKey)
    if (!record) return this.repository.updateInbound({ ...delivery, status: 'unbound', diagnostic: '没有匹配的 Channel binding', updatedAt: at })
    const binding = record.binding
    if (!binding.enabled) return this.fail(delivery, 'Channel binding 已停用', at, binding.id)
    if (binding.senderAllowlist.length && !binding.senderAllowlist.includes(delivery.senderId)) return this.fail(delivery, '发送者不在 allowlist', at, binding.id)
    try {
      await this.projects.require(record.createdBy, binding.projectId, 'manager')
      const session = await this.sessions.require(record.createdBy, binding.sessionId, 'control')
      await this.workers.require(record.createdBy, binding.workerId, 'use')
      if (session.projectId !== binding.projectId || session.binding.agent.workerId !== binding.workerId) throw new Error('Session binding changed')
      const commandId = stableCommandId(delivery.sessionEnqueueRequestId)
      await this.server.enqueue(binding.sessionId, { commandId, messageId: commandId, content: delivery.content }, record.createdBy)
      await this.repository.updateInbound({ ...delivery, status: 'enqueued', bindingId: binding.id, sessionId: binding.sessionId, diagnostic: null, updatedAt: now() })
    } catch (error) {
      await this.fail(delivery, error instanceof Error ? error.message : '权限检查失败', now(), binding.id, binding.sessionId)
    }
  }

  private fail(delivery: InboundDelivery, diagnostic: string, updatedAt: Timestamp, bindingId: InboundDelivery['bindingId'] = null, sessionId: InboundDelivery['sessionId'] = null): Promise<void> {
    return this.repository.updateInbound({ ...delivery, status: 'failed_closed', bindingId, sessionId, diagnostic: diagnostic.slice(0, 500), updatedAt })
  }
}

function stableCommandId(value: string): CommandId {
  const hex = createHash('sha256').update(value).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}` as CommandId
}
const now = (): Timestamp => new Date().toISOString() as Timestamp
