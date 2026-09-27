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
import { narrowForkAccess, type Project, type Session, type SessionForkRecord, type SessionLineageNodeDecision } from '@wemux/server-domain'
import type { ServerStore, ServerStoreTx } from './ports/server-store.ts'
import type { AdministratorDirectory } from './administrator-directory.ts'
import { AppError, requireValue } from './errors.ts'
import { Notifications } from './notifications.ts'
import { canonicalCommand, newId, now, type ForkTargetSessionInput } from './server-service.ts'
import { integer, object, text } from './validation.ts'

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

/**
 * 授权 seam：调用方提交操作者与目标，由实现决定可见性，调用方不复制 Grant 交集算法。
 * 当前实现是 A0 单管理员策略（见 `grantLineageAccess`），票据 09–13 落地团队授权后替换实现。
 */
export interface SessionLineageAccess {
  decideNode(input: { tx: ServerStoreTx; viewer: UserId; teamId: TeamId; session: Session }): Promise<SessionLineageNodeDecision>
}

/** 目标 Session 的唯一创建 seam，绑定校验仍留在 ServerService，不在此处复制。 */
export interface ForkTargetSessionCreator {
  createForkTargetInTx(tx: ServerStoreTx, input: ForkTargetSessionInput): Promise<Session>
}

/**
 * 当前的可见性策略：实例管理员与 Session 所有者可见；`shareScope` 为 project 且有 Project
 * Grant、或 selected-members 且有 Session Grant 时可见；其余返回无泄漏占位。
 * 占位者只说明“该 Session 存在”，不带标题、摘要、成员或分支数量。
 */
export function grantLineageAccess(administrators: AdministratorDirectory): SessionLineageAccess {
  return {
    async decideNode({ tx, viewer, teamId, session }) {
      if (session.deletedAt !== null) return 'omitted'
      if (session.ownerId === viewer) return 'visible'
      if (await administrators.isAdministrator(tx.identity, viewer)) return 'visible'
      const records = await tx.identity.getIdentityRecords({ userId: viewer, teamId, projectId: session.projectId, workerId: session.binding.agent.workerId, sessionId: session.id })
      if (session.shareScope === 'project' && records.projectGrant) return 'visible'
      if (session.shareScope === 'selected-members' && records.sessionGrant) return 'visible'
      return 'placeholder'
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
 * 图 revision：Project 内节点与血缘集合的稳定指纹。只在真实变化时改变，客户端据此判断快照
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
  private readonly administrators: AdministratorDirectory
  private readonly access: SessionLineageAccess
  private readonly notifications?: Notifications
  constructor(
    store: ServerStore,
    targets: ForkTargetSessionCreator,
    administrators: AdministratorDirectory,
    access: SessionLineageAccess = grantLineageAccess(administrators),
    notifications?: Notifications,
  ) { this.store = store; this.targets = targets; this.administrators = administrators; this.access = access; this.notifications = notifications;}

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
      const teamId = await this.effectiveTeamId(tx, input.operator)
      const project = await this.requireTeamProject(tx, input.projectId, teamId)
      const previous = await tx.resources.getSessionForkByRequest(input.projectId, command.requestId)
      if (previous) {
        // 幂等重放：只有载荷完全一致才回到同一目标，否则冲突而不是静默复用。
        if (previous.creation.fingerprint !== fingerprint) throw new AppError(409, 'requestId already belongs to a different Session Fork', 'request_id_conflict')
        return { fork: forkPoint(previous), targetSessionId: previous.targetSessionId, graphRevision: await this.revision(tx, input.projectId), workerId: null, replayed: true }
      }
      const source = await tx.resources.getSession(command.sourceSessionId)
      if (!source || source.projectId !== input.projectId) throw new AppError(404, 'Source Session not found in this Project')
      const decision = await this.access.decideNode({ tx, viewer: input.operator, teamId, session: source })
      // 无内容读取权时既不能读取来源，也不能把它当作上下文种子。
      if (decision === 'omitted') throw new AppError(404, 'Source Session not found in this Project')
      if (decision !== 'visible') throw new AppError(403, 'Source Session content is not readable', 'source_not_readable')
      const durable = await this.durableSeq(tx, source.id)
      const cursor = command.sourceEventCursor ?? durable
      // 客户端可见的校验：cursor 超前于已持久序列是冲突，不是服务器内部错误。
      // 领域断言仍然执行，作为拒绝未来调用方绕过本层的不变量。
      if (cursor > durable) throw new AppError(409, `Session Fork cursor ${cursor} is ahead of durable sequence ${durable}`, 'cursor_not_durable')
      assertForkCursorIsDurable(cursor, durable)
      const target = await this.targets.createForkTargetInTx(tx, {
        projectId: input.projectId,
        workspaceId: command.targetWorkspaceId,
        workerId: command.targetWorkerId,
        agentKey: command.targetAgentKey,
        modelId: command.targetModelId,
        title: forkTitle(source.title),
        ownerId: input.operator,
        requestId: command.requestId,
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
        creation: { requestId: command.requestId, fingerprint },
      }
      assertForkTargetsAnotherSession(record)
      await tx.resources.saveSessionFork(record)
      await tx.audit.append({
        id: newId<'AuditEntryId'>(), actorId: input.operator, action: 'session.fork', resource: { kind: 'session', id: target.id },
        result: 'succeeded', occurredAt: record.createdAt,
        metadata: { forkId: record.id, sourceSessionId: source.id, sourceEventCursor: cursor, contextPolicy: record.contextPolicy },
      })
      return { fork: forkPoint(record), targetSessionId: target.id, graphRevision: await this.revision(tx, input.projectId), workerId: target.binding.agent.workerId, replayed: false }
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
      const teamId = await this.effectiveTeamId(tx, input.operator)
      const session = await this.requireReadable(tx, { operator: input.operator, teamId, sessionId: input.sessionId })
      const forks = await tx.resources.listSessionForks(session.projectId)
      const sessionIds = new Set((await tx.resources.listSessions()).filter(candidate => candidate.projectId === session.projectId).map(candidate => candidate.id))
      const exposed = await this.exposedForks(tx, teamId, input.operator, forks, sessionIds)
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
        graphRevision: graphRevision(session.projectId, [...sessionIds], exposed.map(fork => edgeKey(fork.id))),
      }
    })
  }

  /** 单条血缘边。两端都不可见时返回 404，避免用 forkId 猜测他人分支。 */
  async getForkPoint(input: { operator: UserId; forkId: SessionForkId }): Promise<{ fork: SessionForkPoint; graphRevision: string }> {
    return await this.store.transaction(async tx => {
      const teamId = await this.effectiveTeamId(tx, input.operator)
      const fork = requireValue(await tx.resources.getSessionFork(input.forkId))
      const project = await tx.resources.getProject(fork.projectId)
      // Team 不一致按“不存在”处理：不能靠 forkId 探测别人 Team 的分支。
      if (!project || project.deletedAt !== null || project.teamId !== teamId) throw new AppError(404, 'Fork not found')
      const source = await tx.resources.getSession(fork.sourceSessionId), target = await tx.resources.getSession(fork.targetSessionId)
      if (!source || !target) throw new AppError(404, 'Fork not found')
      const [sourceDecision, targetDecision] = await Promise.all([
        this.access.decideNode({ tx, viewer: input.operator, teamId, session: source }),
        this.access.decideNode({ tx, viewer: input.operator, teamId, session: target }),
      ])
      const visible = narrowForkAccess(sourceDecision, targetDecision)
      if (visible === 'omitted' || (sourceDecision !== 'visible' && targetDecision !== 'visible')) throw new AppError(404, 'Fork not found')
      return { fork: forkPoint(fork), graphRevision: await this.revision(tx, fork.projectId) }
    })
  }

  /** 图读模型：默认返回 Project 内操作者可见的局部邻域，可指定根 Session 与深度。 */
  async getGraph(input: { operator: UserId; query: SessionGraphQuery }): Promise<SessionGraphSnapshot> {
    const query = parseGraphQuery(input.query)
    return await this.store.transaction(async tx => {
      const teamId = await this.effectiveTeamId(tx, input.operator)
      const project = await this.requireTeamProject(tx, query.projectId, teamId)
      const sessions = (await tx.resources.listSessions()).filter(candidate => candidate.projectId === query.projectId)
      const live = sessions.filter(candidate => candidate.deletedAt === null)
      const decisions = new Map<SessionId, SessionLineageNodeDecision>()
      for (const session of sessions) {
        decisions.set(session.id, session.deletedAt !== null ? 'omitted' : await this.access.decideNode({ tx, viewer: input.operator, teamId, session }))
      }
      // 一个可见根都没有时，先确认操作者能不能读这个 Project；不能读就当作不存在，
      // 而不是返回空图或占位图（那本身就是关系存在性的信号）。
      if (!live.some(session => decisions.get(session.id) === 'visible') && !await this.canReadProject(tx, input.operator, teamId, project)) throw new AppError(404, 'Project not found')
      const forks = await tx.resources.listSessionForks(query.projectId), liveIds = new Set(live.map(session => session.id))
      const exposed = forks.filter(fork => liveIds.has(fork.sourceSessionId) && liveIds.has(fork.targetSessionId) && narrowForkAccess(decisions.get(fork.sourceSessionId)!, decisions.get(fork.targetSessionId)!) !== 'omitted')
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
        const decision = decisions.get(session.id)!
        nodes.push(decision === 'visible'
          ? { sessionId: session.id, visibility: 'visible', summary: await this.summary(tx, session, exposed, selectedSet) }
          : { sessionId: session.id, visibility: 'placeholder', summary: null })
      }
      // 结构敏感：隐藏了多少条关系不对外计数，否则计数本身就是侧信道。
      return { revision: graphRevision(query.projectId, selectedIds, edges.map(edge => edge.key)), nodes, edges, hiddenRelationCount: null }
    })
  }

  /**
   * Project 级可读性：所有者、实例管理员或持有显式 Project Grant。
   * 与 Session 级策略共用同一个入口，票据 10 替换本实现而不改调用方。
   */
  private async canReadProject(tx: ServerStoreTx, viewer: UserId, teamId: TeamId, project: { id: ProjectId; ownerId: UserId }): Promise<boolean> {
    if (project.ownerId === viewer) return true
    if (await this.administrators.isAdministrator(tx.identity, viewer)) return true
    const records = await tx.identity.getIdentityRecords({ userId: viewer, teamId, projectId: project.id })
    return records.projectGrant !== null
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

  private async requireReadable(tx: ServerStoreTx, input: { operator: UserId; teamId: TeamId; sessionId: SessionId }): Promise<Session> {
    const session = await tx.resources.getSession(input.sessionId)
    if (!session) throw new AppError(404, 'Session not found')
    await this.requireTeamProject(tx, session.projectId, input.teamId)
    if (await this.access.decideNode({ tx, viewer: input.operator, teamId: input.teamId, session }) !== 'visible') throw new AppError(404, 'Session not found')
    return session
  }

  /**
   * 操作者的生效 Team：只取真实成员身份，A0 单 Team 部署回落到默认 Team。
   * 调用方不传 teamId，避免 HTTP 层自造授权范围；票据 09–13 替换此实现即可支持多 Team。
   */
  /**
   * Fork 与血缘不跨 Team：Project 的 Team 必须就是操作者的生效 Team，
   * 否则同一个管理员在两个 Team 里会看到一条本来不存在的通路。
   */
  private async requireTeamProject(tx: ServerStoreTx, projectId: ProjectId, teamId: TeamId): Promise<Project> {
    const project = await tx.resources.getProject(projectId)
    if (!project || project.deletedAt !== null || project.teamId !== teamId) throw new AppError(404, 'Project not found')
    return project
  }

  private async effectiveTeamId(tx: ServerStoreTx, operator: UserId): Promise<TeamId> {
    const memberships = await tx.identity.listMemberships(operator)
    return memberships[0]?.teamId ?? ('default-team' as TeamId)
  }

  /** 两端都未被隐藏、且收窄后仍可见的边；占位端点保留结构但不带内容。 */
  private async exposedForks(tx: ServerStoreTx, teamId: TeamId, viewer: UserId, forks: readonly SessionForkRecord[], liveIds: ReadonlySet<SessionId>): Promise<readonly SessionForkRecord[]> {
    const cache = new Map<SessionId, SessionLineageNodeDecision>()
    const decide = async (sessionId: SessionId): Promise<SessionLineageNodeDecision> => {
      const cached = cache.get(sessionId)
      if (cached) return cached
      if (!liveIds.has(sessionId)) { cache.set(sessionId, 'omitted'); return 'omitted' }
      const session = requireValue(await tx.resources.getSession(sessionId))
      const decision = await this.access.decideNode({ tx, viewer, teamId, session })
      cache.set(sessionId, decision)
      return decision
    }
    const exposed: SessionForkRecord[] = []
    for (const fork of forks) {
      const [source, target] = [await decide(fork.sourceSessionId), await decide(fork.targetSessionId)]
      if (narrowForkAccess(source, target) === 'omitted') continue
      exposed.push(fork)
    }
    return exposed
  }

  /** 以可见节点为种子沿血缘双向遍历到 depth；越界或不可见的邻居以占位节点进入快照。 */
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
      for (const neighbour of [...(adjacency.get(id) ?? [])].sort()) if (!seen.has(neighbour) && decisions.get(neighbour) !== 'omitted') queue.push({ id: neighbour, distance: distance + 1 })
    }
    return [...seen].sort().map(id => requireValue(byId.get(id)))
  }

  /** 操作者视角下的 Project revision：与图快照用同一指纹规则，客户端可比较新旧。 */
  private async revision(tx: ServerStoreTx, projectId: ProjectId): Promise<string> {
    const sessions = (await tx.resources.listSessions()).filter(session => session.projectId === projectId)
    const live = new Set(sessions.filter(session => session.deletedAt === null).map(session => session.id))
    const forks = (await tx.resources.listSessionForks(projectId)).filter(fork => live.has(fork.sourceSessionId) && live.has(fork.targetSessionId))
    return graphRevision(projectId, [...live], forks.map(fork => edgeKey(fork.id)))
  }
}

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