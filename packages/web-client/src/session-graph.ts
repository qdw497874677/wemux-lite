import type { SessionForkPoint, SessionForkPointResponse, SessionForkRequest, SessionForkResponse, SessionGraphQuery, SessionGraphSnapshot, SessionLineageResponse } from '@wemux/web-contract/session-graph'
import type { createClusterTransport } from './cluster-transport.ts'
import { ApiError } from './errors.ts'

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const count = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0
const contractError = () => new ApiError('画布与血缘响应格式异常；请刷新后重试，勿据此推断会话权限。', undefined, 'contract')

/** 节点摘要按可见性分级：可见节点必须带摘要，受限节点必须留空，否则等于泄露未获权会话的标题与成员。 */
function isSummary(value: unknown): boolean {
  return record(value) && text(value.title) && text(value.projectId) && text(value.workspaceId) && text(value.workerId) && text(value.agentKey)
    && (value.modelId === null || text(value.modelId)) && text(value.runtimeState) && (value.lastActivityAt === null || text(value.lastActivityAt)) && count(value.branchCount)
}
function isNode(value: unknown): value is SessionGraphSnapshot['nodes'][number] {
  if (!record(value) || !text(value.sessionId) || !['visible', 'placeholder'].includes(String(value.visibility))) return false
  return value.visibility === 'visible' ? isSummary(value.summary) : value.summary === null
}
function isEdge(value: unknown): boolean {
  // 第一版只有 Fork 边，但类型名保持通用：后续关系类型不得被当成 Fork 渲染。
  return record(value) && text(value.key) && text(value.sourceSessionId) && text(value.targetSessionId) && value.sourceSessionId !== value.targetSessionId
    && record(value.relation) && text(value.relation.type) && (value.relation.type !== 'fork' || text(value.relation.forkId))
}
function isGraph(value: unknown): value is SessionGraphSnapshot {
  if (!record(value) || !text(value.revision) || !Array.isArray(value.nodes) || !value.nodes.every(isNode) || !Array.isArray(value.edges) || !value.edges.every(isEdge)) return false
  if (!(value.hiddenRelationCount === null || count(value.hiddenRelationCount))) return false
  // 悬空边意味着服务端没有按两端权限过滤，客户端必须报错而不是把它画出来。
  const visible = new Set(value.nodes.map(node => node.sessionId))
  return value.edges.every(edge => visible.has(edge.sourceSessionId) && visible.has(edge.targetSessionId))
}
function isForkPoint(value: unknown): value is SessionForkPoint {
  return record(value) && text(value.forkId) && text(value.sourceSessionId) && text(value.targetSessionId)
    && count(value.sourceEventCursor) && value.sourceSessionId !== value.targetSessionId
}
function isForkBody(value: unknown): value is SessionForkRequest {
  if (!record(value)) return false
  const required = ['sourceSessionId', 'requestId', 'targetWorkspaceId', 'targetWorkerId', 'targetAgentKey'] as const
  if (!required.every(key => text(value[key]))) return false
  if (!(value.targetModelId === null || value.targetModelId === undefined || text(value.targetModelId))) return false
  return value.sourceEventCursor === undefined || count(value.sourceEventCursor)
}

export function sessionGraphOperations({ request }: ReturnType<typeof createClusterTransport>) {
  const projectPath = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/session-graph`
  return {
    /** 画布权威事实：服务端已按当前 viewer 的会话权限过滤节点与边。 */
    async sessionGraph(projectId: string, query: Omit<SessionGraphQuery, 'projectId'> = {}, signal?: AbortSignal): Promise<SessionGraphSnapshot> {
      if (!text(projectId)) throw contractError()
      const search = new URLSearchParams()
      for (const key of ['rootSessionId', 'depth', 'nodeLimit'] as const) if (query[key] !== undefined) search.set(key, String(query[key]))
      const value = await request<unknown>(`${projectPath(projectId)}${search.size ? `?${search}` : ''}`, undefined, signal)
      if (!record(value) || !isGraph(value.graph)) throw contractError()
      return value.graph
    },
    /** 祖先由近及远，子分支为直接子级；两者都只包含当前 viewer 可读的边。 */
    async sessionLineage(sessionId: string, signal?: AbortSignal): Promise<SessionLineageResponse> {
      if (!text(sessionId)) throw contractError()
      const value = await request<unknown>(`/api/sessions/${encodeURIComponent(sessionId)}/lineage`, undefined, signal)
      if (!record(value) || value.sessionId !== sessionId || !text(value.graphRevision)
        || !Array.isArray(value.ancestors) || !value.ancestors.every(isForkPoint) || !Array.isArray(value.children) || !value.children.every(isForkPoint)) throw contractError()
      return value as unknown as SessionLineageResponse
    },
    async sessionForkPoint(forkId: string, signal?: AbortSignal): Promise<SessionForkPointResponse> {
      if (!text(forkId)) throw contractError()
      const value = await request<unknown>(`/api/session-forks/${encodeURIComponent(forkId)}`, undefined, signal)
      if (!record(value) || !isForkPoint(value.fork) || !text(value.graphRevision)) throw contractError()
      return value as unknown as SessionForkPointResponse
    },
    /** 固定 cursor Fork：requestId 由调用方生成并跨重试保留，服务端据此幂等。 */
    async forkSession(projectId: string, body: SessionForkRequest, signal?: AbortSignal): Promise<SessionForkResponse> {
      if (!text(projectId) || !isForkBody(body)) throw contractError()
      const value = await request<unknown>(`/api/projects/${encodeURIComponent(projectId)}/session-forks`, body, signal)
      if (!record(value) || !isForkPoint(value.fork) || value.targetSessionId !== value.fork.targetSessionId
        || !text(value.graphRevision) || typeof value.replayed !== 'boolean') throw contractError()
      return value as unknown as SessionForkResponse
    },
  }
}
