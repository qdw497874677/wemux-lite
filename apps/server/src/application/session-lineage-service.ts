import { assertSessionTaskMutable } from './task-lifecycle.ts'
import { createHash } from 'node:crypto'
import type {
  AgentKey,
  EventSeq,
  ForkSessionCommand,
  ForkSessionResult,
  ModelId,
  ProjectId,
  SessionForkContextPolicy,
  SessionForkId,
  SessionForkPoint,
  SessionGraphEdge,
  SessionGraphNode,
  SessionGraphNodeSummary,
  SessionGraphQuery,
  SessionGraphSnapshot,
  SessionId,
  TeamId,
  Timestamp,
  UserId,
  WorkerId,
  WorkspaceId,
} from '@wemux/domain'
import {
  assertForkCursorIsDurable,
  assertForkTargetsAnotherSession,
  isSessionForkContextPolicy,
} from '@wemux/domain'
import { type Session, type SessionForkRecord, type SessionLineageNodeDecision } from '@wemux/server-domain'
import type { ServerStore, ServerStoreTx } from './ports/server-store.ts'
import type { AdministratorDirectory } from './administrator-directory.ts'
import { AppError, requireValue } from './errors.ts'
import { Notifications } from './notifications.ts'
import { canonicalCommand, newId, now, type ForkTargetSessionInput } from './server-service.ts'
import { integer, object, text } from './validation.ts'
import { ProjectAccessService } from './project-access-service.ts'
import { SessionAccessService } from './session-access-service.ts'

/**
 * Ticket 17 (C1): Session Fork 与血缘权威。Fork 是后端持久事实：目标 Session 创建、
 * 绑定快照、血缘写入与审计在同一个应用事务内完成，画布连线不参与领域写入。
 * 依赖方向按 `docs/design/session-canvas-module-contracts.md`：本模块不引用渲染器、
 * HTTP 细节与 transport frame；查询端点只读本模块，不自行拼装边。
 */

/** 同一 Project 内的血缘边查询结果。祖先按由近及远排列，children 只含直接分支。 */
export interface SessionLineageView {
  readonly sessionId: SessionId
  readonly ancestors: readonly SessionForkPoint[]
  readonly children: readonly SessionForkPoint[]
  readonly graphRevision: string
}

/** 授权 seam 委托现有内容 gate，不复制 Grant 或管理员策略。 */
export interface SessionLineageAccess {
  decideNode(input: { tx: ServerStoreTx; viewer: UserId; teamId: TeamId; session: Session }): Promise<SessionLineageNodeDecision>
}

/** 目标 Session 的唯一创建 seam，绑定校验仍留在 ServerService。 */
export interface ForkTargetSessionCreator {
  createForkTargetInTx(tx: ServerStoreTx, input: ForkTargetSessionInput): Promise<Session>
}

/** 不可读与已删除的 Session 完全省略，不提供存在性信号。 */
export function grantLineageAccess(sessions: SessionAccessService): SessionLineageAccess {
  return {
    async decideNode({ tx, viewer, session }) {
      try {
        await sessions.requireInTx(tx, viewer, session.id)
        return 'visible'
      } catch (error) {
        if (error instanceof AppError && error.status === 404) return 'omitted'
        throw error
      }
    },
  }
}

const forkPoint = (fork: SessionForkRecord): SessionForkPoint => ({
  forkId: fork.id,
  sourceSessionId: fork.sourceSessionId,
  sourceEventCursor: fork.sourceEventCursor,
  targetSessionId: fork.targetSessionId,
})

/**
 * 图 revision：viewer 当前可读的 Project 节点与血缘集合的稳定指纹。只在真实变化时改变，客户端据此判断快照
 * 是否过期；它是服务端事实，不由客户端合并。哈希避免通过 revision 值反推分支数量。
 */
function graphRevision(projectId: ProjectId, sessionIds: readonly SessionId[], edgeKeys: readonly string[]): string {
  const material = [projectId, ...[...sessionIds].sort(), ...[...edgeKeys].sort()].join('|')
  return `g${createHash('sha256').update(material).digest('hex').slice(0, 16)}`
}

/** 唯一支持完全兑现的上下文策略：固定 cursor 边界。其余策略需要选择载荷或摘要装配。 */
const supportedContextPolicies: readonly SessionForkContextPolicy[] = ['through_cursor']

const defaultDepth = 2
const maxDepth = 6
const defaultNodeLimit = 200
const maxNodeLimit = 1000

export class SessionLineageService {
  private readonly store: ServerStore
  private readonly targets: ForkTargetSessionCreator
  private readonly projects: ProjectAccessService
  private readonly access: SessionLineageAccess
  private readonly notifications?: Notifications
  constructor(
    store: ServerStore,
    targets: ForkTargetSessionCreator,
    _administrators: AdministratorDirectory,
    access?: SessionLineageAccess,
    notifications?: Notifications,
  ) {
    this.store = store
    this.targets = targets
    this.projects = new ProjectAccessService(store)
    this.access = access ?? grantLineageAccess(new SessionAccessService(store, this.projects))
    this.notifications = notifications
  }

  /**
   * 创建 Fork：校验来源可读与 cursor 已持久化，原子创建目标 Session 与血缘记录。
   * 失败不留下孤立 Session 或悬空边；同 requestId 重试返回原目标，指纹变化则拒绝。
   */
  async fork(input: { operator: UserId; projectId: ProjectId; command: unknown }): Promise<ForkSessionResult> {
    const command = parseForkCommand(input.projectId, input.command)
    const fingerprint = createHash('sha256').update(canonicalCommand({
      sourceSessionId: command.sourceSessionId,
      sourceEventCursor: command.sourceEventCursor ?? null,
      contextPolicy: command.contextPolicy ?? 'through_cursor',
      targetWorkspaceId: command.targetWorkspaceId,
      targetWorkerId: command.targetWorkerId,
      targetAgentKey: command.targetAgentKey,
      targetModelId: command.targetModelId,
    })).digest('hex')
    const outcome = await this.store.transaction(async (tx): Promise<{ fork: SessionForkPoint; targetSessionId: SessionId; graphRevision: string; workerId: WorkerId | null; replayed: boolean }> => {
      const project = await this.projects.requireInTx(tx, input.operator, input.projectId)
      const teamId = project.teamId
      const checkedSource = await tx.resources.getSession(command.sourceSessionId)
      if (!checkedSource || checkedSource.projectId !== input.projectId) throw new AppError(404, 'Source Session not found in this Project')
      const visible = await this.access.decideNode({ tx, viewer: input.operator, teamId, session: checkedSource })
      if (visible !== 'visible') throw new AppError(404, 'Source Session not found in this Project')
      await assertSessionTaskMutable(tx, checkedSource)
      // actor-scoped key; legacy unscoped rows remain replayable only by their creator.
      const requestKey = forkRequestKey(input.operator, command.requestId)
      const previous = await tx.resources.getSessionForkByRequest(input.projectId, requestKey)
        ?? (await tx.resources.listSessionForks(input.projectId)).find(fork =>
          fork.creation.requestId === command.requestId || fork.creation.requestId === forkRequestKey(fork.createdBy, command.requestId))
      if (previous) {
        const replayActorId = previous.createdBy
        if (replayActorId !== input.operator) throw new AppError(404, 'Fork not found')
        await this.requireReadable(tx, { operator: input.operator, teamId, sessionId: previous.sourceSessionId })
        const target = await this.requireReadable(tx, { operator: input.operator, teamId, sessionId: previous.targetSessionId })
        if (target.projectId !== input.projectId) throw new AppError(404, 'Fork not found')
        // 幂等重放：只有载荷完全一致才回到同一目标，否则冲突而不是静默复用。
        if (previous.creation.fingerprint !== fingerprint) throw new AppError(409, 'requestId already belongs to a different Session Fork', 'request_id_conflict')
        return { fork: forkPoint(previous), targetSessionId: previous.targetSessionId, graphRevision: await this.revision(tx, input.operator, input.projectId), workerId: null, replayed: true }
      }
      const source = await tx.resources.getSession(command.sourceSessionId)
      if (!source || source.projectId !== input.projectId) throw new AppError(404, 'Source Session not found in this Project')
      const decision = await this.access.decideNode({ tx, viewer: input.operator, teamId, session: source })
      // 无内容读取权时既不能读取来源，也不能把它当作上下文种子。
      if (decision !== 'visible') throw new AppError(404, 'Source Session not found in this Project')
      const durable = await this.durableSeq(tx, source.id)
      const cursor = command.sourceEventCursor ?? durable
      // 客户端可见的校验：cursor 超前于已持久序列是冲突，不是服务器内部错误。
      // 领域断言仍然执行，作为拒绝未来调用方绕过本层的不变量。
      if (cursor > durable) throw new AppError(409, `Session Fork cursor ${cursor} is ahead of durable sequence ${durable}`, 'cursor_not_durable')
      assertForkCursorIsDurable(cursor, durable)
      const target = await this.targets.createForkTargetInTx(tx, {
        taskId: source.taskId,
        projectId: input.projectId,
        workspaceId: command.targetWorkspaceId,
        workerId: command.targetWorkerId,
        agentKey: command.targetAgentKey,
        modelId: command.targetModelId,
        title: forkTitle(source.title),
        ownerId: input.operator,
        storageMode: source.storageMode ?? 'local',
        requestId: requestKey,
      })
      const record: SessionForkRecord = {
        id: newId<'SessionForkId'>(),
        projectId: input.projectId,
        sourceSessionId: source.id,
        sourceEventCursor: cursor,
        targetSessionId: target.id,
        createdBy: input.operator,
        createdAt: now(),
        contextPolicy: command.contextPolicy ?? 'through_cursor',
        creation: { requestId: requestKey, fingerprint },
      }
      assertForkTargetsAnotherSession(record)
      await tx.resources.saveSessionFork(record)
      await tx.audit.append({
        id: newId<'AuditEntryId'>(), actorId: input.operator, action: 'session.fork', resource: { kind: 'session', id: target.id },
        result: 'succeeded', occurredAt: record.createdAt,
        metadata: { forkId: record.id, sourceSessionId: source.id, sourceEventCursor: cursor, contextPolicy: record.contextPolicy },
      })
      return { fork: forkPoint(record), targetSessionId: target.id, graphRevision: await this.revision(tx, input.operator, input.projectId), workerId: target.binding.agent.workerId, replayed: false }
    })
    if (!outcome.replayed) {
      this.notifications?.session(outcome.targetSessionId)
      if (outcome.workerId) this.notifications?.commands(outcome.workerId)
    }
    const { workerId: _workerId, ...result } = outcome
    return result
  }

  /** 祖先、直接子分支与 Fork point：只返回两端都未被隐藏的边，标题与摘要不侧漏。 */
  async lineage(input: { operator: UserId; sessionId: SessionId }): Promise<SessionLineageView> {
    return await this.store.transaction(async tx => {
      const session = await this.requireReadable(tx, { operator: input.operator, sessionId: input.sessionId })
      const projection = await this.visibleProjection(tx, input.operator, session.projectId)
      const exposed = projection.forks
      const byTarget = new Map<SessionId, SessionForkRecord[]>()
      for (const fork of exposed) byTarget.set(fork.targetSessionId, [...(byTarget.get(fork.targetSessionId) ?? []), fork])
      const ancestors: SessionForkPoint[] = []
      const visited = new Set<SessionId>([session.id])
      for (let current = session.id; ;) {
        const parents = byTarget.get(current) ?? []
        const parent = parents[0]
        if (!parent || visited.has(parent.sourceSessionId)) break
        visited.add(parent.sourceSessionId)
        ancestors.push(forkPoint(parent))
        current = parent.sourceSessionId
      }
      const children = exposed.filter(fork => fork.sourceSessionId === session.id).map(forkPoint)
      return {
        sessionId: session.id,
        ancestors,
        children,
        graphRevision: projection.revision,
      }
    })
  }

  /** 单条血缘边只在两端当前都可读且属于同一个 Project 时返回。 */
  async getForkPoint(input: { operator: UserId; forkId: SessionForkId }): Promise<{ fork: SessionForkPoint; graphRevision: string }> {
    return await this.store.transaction(async tx => {
      const fork = requireValue(await tx.resources.getSessionFork(input.forkId))
      const projection = await this.visibleProjection(tx, input.operator, fork.projectId)
      if (!projection.forks.some(candidate => candidate.id === fork.id)) throw new AppError(404, 'Fork not found')
      return { fork: forkPoint(fork), graphRevision: projection.revision }
    })
  }

  /** 图只遍历可读节点；局部查询与完整可见图使用同一个 revision。 */
  async getGraph(input: { operator: UserId; query: SessionGraphQuery }): Promise<SessionGraphSnapshot> {
    const query = parseGraphQuery(input.query)
    return await this.store.transaction(async tx => {
      const projection = await this.visibleProjection(tx, input.operator, query.projectId)
      const live = projection.sessions
      const decisions = new Map<SessionId, SessionLineageNodeDecision>(live.map(session => [session.id, 'visible']))
      const exposed = projection.forks
      const adjacency = new Map<SessionId, SessionId[]>()
      for (const fork of exposed) {
        adjacency.set(fork.sourceSessionId, [...(adjacency.get(fork.sourceSessionId) ?? []), fork.targetSessionId])
        adjacency.set(fork.targetSessionId, [...(adjacency.get(fork.targetSessionId) ?? []), fork.sourceSessionId])
      }
      const selected = this.selectNodes(query, live, decisions, adjacency)
      const selectedIds = selected.map(session => session.id), selectedSet = new Set(selectedIds)
      const edges: SessionGraphEdge[] = exposed
        .filter(fork => selectedSet.has(fork.sourceSessionId) && selectedSet.has(fork.targetSessionId))
        .map(fork => ({ key: edgeKey(fork.id), relation: { type: 'fork', forkId: fork.id }, sourceSessionId: fork.sourceSessionId, targetSessionId: fork.targetSessionId }))
      const nodes: SessionGraphNode[] = []
      for (const session of selected) {
        nodes.push({ sessionId: session.id, visibility: 'visible', summary: await this.summary(tx, session, exposed, selectedSet) })
      }
      return { revision: projection.revision, nodes, edges, hiddenRelationCount: null }
    })
  }

  private async summary(tx: ServerStoreTx, session: Session, forks: readonly SessionForkRecord[], snapshot: ReadonlySet<SessionId>): Promise<SessionGraphNodeSummary> {
    return {
      title: session.title,
      projectId: session.projectId,
      workspaceId: session.workspaceId,
      workerId: session.binding.agent.workerId,
      agentKey: session.binding.agent.agentKey,
      modelId: session.binding.modelId,
      runtimeState: session.runtimeState,
      lastActivityAt: await this.lastActivityAt(tx, session.id),
      branchCount: forks.filter(fork => fork.sourceSessionId === session.id && snapshot.has(fork.targetSessionId)).length,
    }
  }

  /** 最近活动取最新已持久事件的 occurredAt；没有事件就是 null，绝不编造时间。 */
  private async lastActivityAt(tx: ServerStoreTx, sessionId: SessionId): Promise<Timestamp | null> {
    const durable = await this.durableSeq(tx, sessionId)
    if (durable === 0) return null
    const page = await tx.cache.readEvents(sessionId, durable as EventSeq, 1)
    return page.events[0]?.occurredAt ?? null
  }

  private async durableSeq(tx: ServerStoreTx, sessionId: SessionId): Promise<number> {
    return (await tx.cache.getFreshness(sessionId))?.contiguousSeq ?? 0
  }

  private async requireReadable(tx: ServerStoreTx, input: { operator: UserId; teamId?: TeamId; sessionId: SessionId }): Promise<Session> {
    const session = await tx.resources.getSession(input.sessionId)
    if (!session || session.deletedAt !== null) throw new AppError(404, 'Session not found')
    const project = await this.projects.requireInTx(tx, input.operator, session.projectId)
    if (input.teamId !== undefined && project.teamId !== input.teamId) throw new AppError(404, 'Session not found')
    if (await this.access.decideNode({ tx, viewer: input.operator, teamId: project.teamId, session }) !== 'visible') throw new AppError(404, 'Session not found')
    return session
  }

  /** 每次现查内容权限，不缓存授权结论；同一投影用于图、血缘、边、revision 和布局。 */
  private async visibleProjection(tx: ServerStoreTx, operator: UserId, projectId: ProjectId) {
    const project = await this.projects.requireInTx(tx, operator, projectId)
    const sessions: Session[] = []
    for (const session of await tx.resources.listSessions()) {
      if (session.projectId !== projectId || session.deletedAt !== null) continue
      if (await this.access.decideNode({ tx, viewer: operator, teamId: project.teamId, session }) === 'visible') sessions.push(session)
    }
    const ids = new Set(sessions.map(session => session.id))
    const forks = (await tx.resources.listSessionForks(projectId)).filter(fork => ids.has(fork.sourceSessionId) && ids.has(fork.targetSessionId))
    return { sessions, forks, revision: graphRevision(projectId, [...ids], forks.map(fork => edgeKey(fork.id))) }
  }

  /** 只沿可见边遍历到 depth，不补不可读节点或占位。 */
  private selectNodes(query: SessionGraphQuery, live: readonly Session[], decisions: ReadonlyMap<SessionId, SessionLineageNodeDecision>, adjacency: ReadonlyMap<SessionId, readonly SessionId[]>): readonly Session[] {
    const byId = new Map(live.map(session => [session.id, session]))
    const roots: SessionId[] = []
    if (query.rootSessionId !== undefined) {
      const root = byId.get(query.rootSessionId)
      if (!root || decisions.get(root.id) !== 'visible') throw new AppError(404, 'Session not found')
      roots.push(root.id)
    } else {
      for (const session of live) if (decisions.get(session.id) === 'visible') roots.push(session.id)
    }
    // 稳定顺序：先按 id 排序，nodeLimit 截断结果可复现；摘要与事件读取发生在截断之后。
    const depth = query.depth ?? defaultDepth, limit = query.nodeLimit ?? defaultNodeLimit
    const seen = new Set<SessionId>(), queue = roots.sort().map(id => ({ id, distance: 0 }))
    while (queue.length > 0) {
      const { id, distance } = queue.shift()!
      if (seen.has(id)) continue
      seen.add(id)
      if (seen.size >= limit) break
      if (distance >= depth) continue
      for (const neighbour of [...(adjacency.get(id) ?? [])].sort()) if (!seen.has(neighbour) && decisions.get(neighbour) === 'visible') queue.push({ id: neighbour, distance: distance + 1 })
    }
    return [...seen].sort().map(id => requireValue(byId.get(id)))
  }

  /** 不受图分页上限影响的布局授权投影，与 revision 在同一事务读取。 */
  async layoutProjectionFor(operator: UserId, projectId: ProjectId) {
    return this.store.transaction(async tx => {
      const projection = await this.visibleProjection(tx, operator, projectId)
      return {
        revision: projection.revision,
        sessionIds: new Set(projection.sessions.map(session => session.id as string)),
        workspaceGroups: new Set(projection.sessions.map(session => `workspace:${session.workspaceId}`)),
      }
    })
  }

  async graphRevisionFor(operator: UserId, projectId: ProjectId): Promise<string> {
    return this.store.transaction(tx => this.revision(tx, operator, projectId))
  }

  private async revision(tx: ServerStoreTx, operator: UserId, projectId: ProjectId): Promise<string> {
    return (await this.visibleProjection(tx, operator, projectId)).revision
  }
}

const forkRequestKey = (actor: UserId, requestId: string): string => `fork-actor:${createHash('sha256').update(JSON.stringify([actor, requestId])).digest('hex')}`

const edgeKey = (forkId: SessionForkId): string => `fork:${forkId}`

/** 目标 Session 的标题由来源派生：画布上的分支要能一眼看出出处，且不需要额外的 HTTP 字段。 */
const forkTitle = (sourceTitle: string): string => `${sourceTitle}（分支）`.slice(0, 200)

function parseForkCommand(projectId: ProjectId, value: unknown): ForkSessionCommand & { projectId: ProjectId } {
  const b = object(value)
  const allowed = ['sourceSessionId', 'sourceEventCursor', 'contextPolicy', 'targetWorkspaceId', 'targetWorkerId', 'targetAgentKey', 'targetModelId', 'requestId']
  const unknownKey = Object.keys(b).find(key => !allowed.includes(key))
  if (unknownKey) throw new AppError(400, `Invalid Session Fork request: unexpected field ${unknownKey}`)
  const policy = b.contextPolicy === undefined ? undefined : b.contextPolicy
  if (policy !== undefined && (typeof policy !== 'string' || !isSessionForkContextPolicy(policy))) throw new AppError(400, 'Invalid contextPolicy')
  if (policy !== undefined && !supportedContextPolicies.includes(policy)) throw new AppError(400, `contextPolicy ${policy} is not supported yet`, 'unsupported_context_policy')
  const modelId = b.targetModelId === undefined || b.targetModelId === null ? null : text(b.targetModelId, 'targetModelId', 200) as ModelId
  return {
    projectId,
    sourceSessionId: text(b.sourceSessionId, 'sourceSessionId', 200) as SessionId,
    ...(b.sourceEventCursor === undefined ? {} : { sourceEventCursor: integer(b.sourceEventCursor, 'sourceEventCursor', 0) }),
    ...(policy === undefined ? {} : { contextPolicy: policy }),
    targetWorkspaceId: text(b.targetWorkspaceId, 'targetWorkspaceId', 200) as WorkspaceId,
    targetWorkerId: text(b.targetWorkerId, 'targetWorkerId', 200) as WorkerId,
    targetAgentKey: text(b.targetAgentKey, 'targetAgentKey', 200) as AgentKey,
    targetModelId: modelId,
    requestId: text(b.requestId, 'requestId', 200),
  }
}

function parseGraphQuery(value: SessionGraphQuery): SessionGraphQuery {
  const b = object(value)
  const allowed = ['projectId', 'rootSessionId', 'depth', 'nodeLimit']
  const unknownKey = Object.keys(b).find(key => !allowed.includes(key))
  if (unknownKey) throw new AppError(400, `Invalid Session graph query: unexpected field ${unknownKey}`)
  const depth = b.depth === undefined ? undefined : integer(b.depth, 'depth', 0, maxDepth)
  const nodeLimit = b.nodeLimit === undefined ? undefined : integer(b.nodeLimit, 'nodeLimit', 1, maxNodeLimit)
  if (b.rootSessionId !== undefined && (typeof b.rootSessionId !== 'string' || !b.rootSessionId.trim())) throw new AppError(400, 'Invalid rootSessionId')
  return {
    projectId: text(b.projectId, 'projectId', 200) as ProjectId,
    ...(b.rootSessionId === undefined ? {} : { rootSessionId: b.rootSessionId as SessionId }),
    ...(depth === undefined ? {} : { depth }),
    ...(nodeLimit === undefined ? {} : { nodeLimit }),
  }
}