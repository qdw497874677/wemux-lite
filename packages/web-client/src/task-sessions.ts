import type { CreateTaskSessionRequest, CreateTaskSessionResponse, TaskSession, TaskSessionFilters, TaskSessionView } from '@wemux/web-contract/task-platform'
import type { createClusterTransport } from './cluster-transport.ts'
import { ApiError } from './errors.ts'

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const contractError = () => new ApiError('任务会话响应格式异常；创建结果可能已保存，请保留原请求重试。', undefined, 'contract')
function isSession(value: unknown, projectId: string, taskId: string): value is TaskSession {
  return record(value) && ['id', 'ownerId', 'workspaceId', 'title'].every(key => text(value[key]))
    && value.projectId === projectId && value.taskId === taskId && (value.runId === null || text(value.runId))
    && record(value.binding) && text(value.binding.workspaceId) && record(value.binding.agent) && text(value.binding.agent.workerId) && text(value.binding.agent.agentKey)
    && value.binding.workspaceId === value.workspaceId && (value.binding.modelId === null || text(value.binding.modelId))
    && ['owner-only', 'selected-members', 'project'].includes(String(value.shareScope))
    && ['idle', 'queued', 'running', 'stopping', 'unavailable', 'failed'].includes(String(value.runtimeState)) && (value.deletedAt === null || text(value.deletedAt))
}
export function taskSessionOperations({ request }: ReturnType<typeof createClusterTransport>) {
  const path = (p: string, t: string) => `/api/projects/${encodeURIComponent(p)}/tasks/${encodeURIComponent(t)}/sessions`
  return {
    async createDedicatedSession(p: string, scenario: 'quick-chat' | 'agent-test', body: CreateTaskSessionRequest, signal?: AbortSignal): Promise<CreateTaskSessionResponse> {
      if (!['quick-chat', 'agent-test'].includes(scenario) || ![body.workspaceId, body.workerId, body.agentKey, body.modelId, body.requestId, body.title].every(text)) throw contractError()
      const value = await request<unknown>('/api/sessions', { ...body, scenario }, signal)
      if (!record(value) || !record(value.session) || !text(value.session.taskId) || !isSession(value.session, p, value.session.taskId)
        || !text(value.commandId) || typeof value.created !== 'boolean' || value.session.runId !== null || value.session.shareScope !== 'owner-only'
        || value.session.workspaceId !== body.workspaceId || value.session.binding.agent.workerId !== body.workerId || value.session.binding.agent.agentKey !== body.agentKey
        || (value.created && (value.session.title !== body.title || value.session.binding.modelId !== body.modelId))
        || value.session.creation?.requestId !== body.requestId || value.session.creation.commandId !== value.commandId || !text(value.session.creation.fingerprint)) throw contractError()
      return value as unknown as CreateTaskSessionResponse
    },
    async createTaskSession(p: string, t: string, body: CreateTaskSessionRequest, signal?: AbortSignal): Promise<CreateTaskSessionResponse> {
      const value = await request<unknown>(path(p, t), body, signal)
      if (!record(value) || !isSession(value.session, p, t) || !text(value.commandId) || typeof value.created !== 'boolean'
        || value.session.runId !== null || (value.created && value.session.title !== body.title)
        || (body.workspaceId !== undefined && (value.session.workspaceId !== body.workspaceId || value.session.binding.agent.workerId !== body.workerId || value.session.binding.agent.agentKey !== body.agentKey || (value.created && body.modelId != null && value.session.binding.modelId !== body.modelId)))
        || value.session.creation?.requestId !== body.requestId || value.session.creation.commandId !== value.commandId || !text(value.session.creation.fingerprint)) throw contractError()
      return value as unknown as CreateTaskSessionResponse
    },
    async taskSessions(p: string, t: string, filters: TaskSessionFilters = {}, signal?: AbortSignal): Promise<TaskSessionView[]> {
      const query = new URLSearchParams()
      for (const key of ['projectId', 'workspaceId', 'taskId', 'archived'] as const) if (filters[key] !== undefined) query.set(key, String(filters[key]))
      const value = await request<unknown>(`${path(p, t)}${query.size ? `?${query}` : ''}`, undefined, signal)
      if (!record(value) || !Array.isArray(value.items) || !value.items.every(item => isSession(item, p, t)
        && record(item) && record(item.access) && typeof item.access.canRead === 'boolean' && typeof item.access.canWrite === 'boolean' && typeof item.access.canControl === 'boolean'
        && (item.activeTurnId === null || text(item.activeTurnId)) && (item.activeTurnOwnerId === null || text(item.activeTurnOwnerId))
        && Array.isArray(item.queuedMessages) && record(item.freshness) && item.freshness.sessionId === item.id
        && Number.isInteger(item.freshness.contiguousSeq) && (item.freshness.workerLastSeq === null || Number.isInteger(item.freshness.workerLastSeq))
        && ['unknown', 'syncing', 'synced', 'gap', 'offline', 'orphaned'].includes(String(item.freshness.status))
        && record(item.sendCapability) && typeof item.sendCapability.allowed === 'boolean' && typeof item.sendCapability.reason === 'string' && text(item.sendCapability.reasonCode))) throw contractError()
      return value.items as TaskSessionView[]
    },
  }
}
