import type {
  ApprovalPage,
  ApprovalQuery,
  ApprovalView,
  AttentionPage,
  AttentionQuery,
  CrossEntityProjectionPort,
  ProjectionFreshness,
  TimelineEvent,
  TimelinePage,
  TimelineQuery,
  TimelineSourceKind,
} from '@wemux/server-domain'
import type { JournalEvent, ProjectId, Timestamp, UserId } from '@wemux/domain'
import type { Session } from '@wemux/server-domain'
import type { ServerStore } from './ports/server-store.ts'
import type { ProjectAccessService } from './project-access-service.ts'
import type { SessionAccessService } from './session-access-service.ts'
import type { ApprovalDecisionRepository } from './ports/approval-decision-repository.ts'
import { canDecideHumanReview } from './human-review-authority.ts'
import { isActiveRun } from './run-projection.ts'
import { AppError } from './errors.ts'

interface ProjectionCursor { readonly occurredAt: string; readonly sourceKind: string; readonly sourceId: string }
interface OrderedProjection { readonly occurredAt: Timestamp; readonly sourceKind: string; readonly sourceId: string }

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100

export function encodeProjectionCursor(value: ProjectionCursor): string {
  return Buffer.from(JSON.stringify([value.occurredAt, value.sourceKind, value.sourceId]), 'utf8').toString('base64url')
}
export function decodeProjectionCursor(value: string | undefined): ProjectionCursor | null {
  if (!value) return null
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (!Array.isArray(parsed) || parsed.length !== 3 || parsed.some(item => typeof item !== 'string')) throw new Error()
    return { occurredAt: parsed[0], sourceKind: parsed[1], sourceId: parsed[2] }
  } catch { throw new AppError(400, 'Invalid projection cursor', 'invalid_cursor') }
}
function limit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIMIT) throw new AppError(400, 'limit must be between 1 and 100', 'invalid_limit')
  return value
}
function compare(a: OrderedProjection, b: OrderedProjection): number {
  return b.occurredAt.localeCompare(a.occurredAt) || a.sourceKind.localeCompare(b.sourceKind) || a.sourceId.localeCompare(b.sourceId)
}
function afterCursor(item: OrderedProjection, cursor: ProjectionCursor | null): boolean {
  return cursor === null || compare(item, cursor as OrderedProjection) > 0
}
function page<T extends OrderedProjection>(items: readonly T[], cursorValue: string | undefined, requestedLimit: number | undefined): { items: readonly T[]; nextCursor: string | null } {
  const cursor = decodeProjectionCursor(cursorValue), size = limit(requestedLimit)
  const ordered = [...items].sort(compare).filter(item => afterCursor(item, cursor))
  const selected = ordered.slice(0, size)
  const last = selected.at(-1)
  return { items: selected, nextCursor: ordered.length > size && last ? encodeProjectionCursor(last) : null }
}
function freshness(status: string | undefined, observedAt: Timestamp): ProjectionFreshness {
  if (status === 'synced') return { status: 'current', observedAt }
  if (status === 'syncing') return { status: 'syncing', observedAt, detail: 'Worker Journal 正在同步' }
  if (status === 'offline') return { status: 'offline', observedAt, detail: 'Worker 已离线，决定会由权威来源再次校验' }
  if (status === 'gap' || status === 'orphaned') return { status: 'stale', observedAt, detail: 'Worker Journal 存在同步缺口' }
  return { status: 'unavailable', observedAt, detail: '尚无可靠的新鲜度信息' }
}
function approvalKey(kind: string, ...parts: readonly string[]): string { return [kind, ...parts].map(encodeURIComponent).join(':') }
function currentSessionApprovals(session: Session, events: readonly JournalEvent[], status: string | undefined): ApprovalView[] {
  const ordered = events.filter(event => event.sessionId === session.id).sort((a, b) => a.seq - b.seq)
  const approvals = new Map<string, ApprovalView>()
  const finishedTurns = new Set<string>()
  const observedAt = ordered.at(-1)?.occurredAt
  for (const event of ordered) {
    const payload = event.payload
    if (payload.kind === 'turn.finished') {
      finishedTurns.add(payload.turnId)
      for (const [key, approval] of approvals) {
        if (approval.source.kind === 'session_tool' && approval.source.turnId === payload.turnId && approval.status === 'pending') {
          approvals.set(key, { ...approval, status: 'expired', decisionCapabilities: [] })
        }
      }
    } else if (payload.kind === 'approval.requested') {
      const key = approvalKey('session_tool', session.id, payload.turnId, payload.approvalId)
      // The first request fixes identity, revision and cursor position. Reobservations
      // cannot reopen a resolved/expired identity or replace its request content.
      if (approvals.has(key)) continue
      const projectionStatus = finishedTurns.has(payload.turnId) ? 'expired' : 'pending'
      approvals.set(key, {
        projectionKey: key, projectId: session.projectId,
        source: { kind: 'session_tool', sessionId: session.id, turnId: payload.turnId, approvalId: payload.approvalId },
        status: projectionStatus, title: `Session「${session.title}」工具审批`, reason: payload.reason ?? null,
        requestedBy: { kind: 'agent', id: session.binding.agent.agentKey }, requestedAt: event.occurredAt,
        decidedAt: null, decisionCapabilities: projectionStatus === 'pending' && status !== 'offline' ? ['approve', 'deny'] : [],
        sourceRevision: String(event.seq), freshness: freshness(status, observedAt ?? event.occurredAt),
      })
    } else if (payload.kind === 'approval.expired') {
      const key = approvalKey('session_tool', session.id, payload.turnId, payload.approvalId)
      const approval = approvals.get(key)
      if (approval?.status === 'pending') approvals.set(key, { ...approval, status: 'expired', decisionCapabilities: [] })
    } else if (payload.kind === 'approval.resolved') {
      const key = approvalKey('session_tool', session.id, payload.turnId, payload.approvalId)
      const approval = approvals.get(key)
      // Only an already requested, still-pending identity can be resolved. In
      // particular a late resolution after turn.finished cannot undo expiration.
      if (approval?.status === 'pending') approvals.set(key, { ...approval,
        status: payload.decision === 'approve' ? 'approved' : 'denied', decidedAt: event.occurredAt, decisionCapabilities: [],
      })
    }
  }
  return [...approvals.values()]
}

function applicableSessionOverlay(current: ApprovalView | undefined, overlay: ApprovalView): boolean {
  return current?.status === 'pending' && current.source.kind === 'session_tool' && overlay.source.kind === 'session_tool' &&
    current.projectionKey === overlay.projectionKey && current.projectId === overlay.projectId && current.sourceRevision === overlay.sourceRevision &&
    current.source.sessionId === overlay.source.sessionId && current.source.turnId === overlay.source.turnId && current.source.approvalId === overlay.source.approvalId
}

export class ProjectionService implements CrossEntityProjectionPort {
  private readonly store: ServerStore
  private readonly projects: ProjectAccessService
  private readonly sessions: SessionAccessService
  private readonly approvalDecisions: ApprovalDecisionRepository
  constructor(store: ServerStore, projects: ProjectAccessService, sessions: SessionAccessService, approvalDecisions: ApprovalDecisionRepository) {
    this.store = store
    this.projects = projects
    this.sessions = sessions
    this.approvalDecisions = approvalDecisions
  }

  async approvals(actorId: UserId, query: ApprovalQuery): Promise<ApprovalPage> {
    const projectList = await this.projects.list(actorId)
    const visibleIds = new Set(projectList.map(project => project.id))
    if (query.projectId && !visibleIds.has(query.projectId)) return { items: [], nextCursor: null }
    const approvals: ApprovalView[] = []
    for (const project of projectList) {
      if (query.projectId && project.id !== query.projectId) continue
      const reviews = await this.store.tasks.pendingReviews(project.id)
      for (const review of reviews) {
        const task = await this.store.tasks.get(review.taskId)
        if (!task || task.currentReviewId !== review.id) continue
        const decisionCapabilities = await this.store.transaction(async tx => {
          const denied: ('approve' | 'changes_requested')[] = []
          const currentProject = await tx.resources.getProject(project.id)
          if (!currentProject || currentProject.deletedAt) return denied
          const records = currentProject.ownerId === actorId ? null : await tx.identity.getIdentityRecords({ userId: actorId, teamId: currentProject.teamId, projectId: currentProject.id })
          if (!canDecideHumanReview(actorId, review.actor, currentProject.ownerId, !!records?.membership, records?.projectGrant?.role)) return denied
          // Human decisions have a dedicated workflow; generic Run review capabilities
          // describe the legacy no-policy workflow, not decideHumanReview.
          if (task.projectId !== project.id || task.deletedAt || review.projectId !== project.id ||
            (task.metadataJson.values.reviewPolicy !== 'human' && task.metadataJson.values.reviewPolicy !== 'multi-stage') || task.metadataJson.values.reviewPolicyFrozen !== true || task.status !== 'in_review' ||
            review.status !== 'requested' || review.closedAt !== null || review.decidedAt !== null || review.reviewer !== null) return denied
          // Staged chains need an independent decider per stage: someone who
          // already decided an earlier stage of this Run sees no capabilities.
          if (task.metadataJson.values.reviewPolicy === 'multi-stage' &&
            (await tx.tasks.reviews(task.id)).some(item => item.taskRunId === review.taskRunId && item.id !== review.id && item.reviewer === actorId)) return denied
          const run = await tx.tasks.run(review.taskRunId)
          if (!run || run.taskId !== task.id || run.projectId !== project.id) return denied
          const runs = await tx.tasks.runs(task.id)
          const latest = runs.reduce<typeof run | undefined>((last, next) => !last || next.attempt > last.attempt ? next : last, undefined)
          if (!latest || latest.id !== run.id || latest.status !== 'succeeded' || runs.some(isActiveRun)) return denied
          return ['approve' as const, 'changes_requested' as const]
        })
        approvals.push({ projectionKey: approvalKey('task_review', review.taskId, review.taskRunId, review.id), projectId: project.id,
          source: { kind: 'task_review', taskId: review.taskId, runId: review.taskRunId, reviewId: review.id }, status: 'pending', title: task.title,
          reason: null, requestedBy: { kind: 'user', id: review.actor }, requestedAt: review.requestedAt as Timestamp, decidedAt: null,
          decisionCapabilities, sourceRevision: `${task.version}:${review.status}`,
          freshness: { status: 'current', observedAt: review.requestedAt as Timestamp } })
      }
    }
    approvals.push(...await this.sessionApprovals(actorId, query.projectId))
    const remembered = await this.decisionOverlays()
    const deduped = [...new Map(approvals.map(item => {
      const overlay = remembered.get(item.projectionKey)
      return [item.projectionKey, overlay && (item.source.kind !== 'session_tool' || applicableSessionOverlay(item, overlay)) ? overlay : item]
    })).values()]
      .filter(item => (!query.sourceKind || item.source.kind === query.sourceKind) && (!query.status || item.status === query.status))
      .map(item => ({ ...item, occurredAt: item.requestedAt, sourceKind: item.source.kind, sourceId: item.projectionKey }))
    const result = page(deduped, query.cursor, query.limit)
    return { items: result.items.map(({ occurredAt: _occurredAt, sourceKind: _sourceKind, sourceId: _sourceId, ...item }) => item), nextCursor: result.nextCursor }
  }

  /** Receipt visibility must not depend on the pending-review projection. */
  async requireApprovalProject(actorId: UserId, projectId: ProjectId): Promise<void> {
    await this.projects.require(actorId, projectId)
  }

  async approval(actorId: UserId, projectionKey: string): Promise<ApprovalView | null> {
    let cursor: string | undefined
    do {
      const result = await this.approvals(actorId, { cursor, limit: MAX_LIMIT })
      const found = result.items.find(item => item.projectionKey === projectionKey)
      if (found) return found
      cursor = result.nextCursor ?? undefined
    } while (cursor)
    return null
  }

  async attention(_actorId: UserId, _query: AttentionQuery): Promise<AttentionPage> { return { items: [], nextCursor: null } }

  async allowedProjectIds(actorId: UserId): Promise<ReadonlySet<ProjectId>> { return new Set((await this.projects.list(actorId)).map(project => project.id)) }

  async listAccessibleProjectIds(actorId: UserId, scopedProjectId?: ProjectId): Promise<readonly ProjectId[]> {
    return this.store.resources.listAccessibleProjectIds(actorId, scopedProjectId)
  }

  async timeline(actorId: UserId, query: TimelineQuery): Promise<TimelinePage> {
    const projects = await this.projects.list(actorId)
    const visible = new Map(projects.map(project => [project.id, project]))
    if (query.projectId && !visible.has(query.projectId)) return { items: [], nextCursor: null }
    const events: TimelineEvent[] = []
    for (const project of projects) {
      if (query.projectId && project.id !== query.projectId) continue
      for (const item of await this.store.tasks.projectActivity(project.id, 0)) {
        const activity = item.activity
        const task = await this.store.tasks.get(activity.taskId)
        const sourceId = `${activity.taskId}:${activity.seq}`
        events.push({ cursor: '', sourceKind: 'task_activity', sourceId, sourceKey: `${activity.type}:${activity.requestId}`, occurredAt: activity.occurredAt as Timestamp,
          projectId: project.id, actor: { kind: 'user', id: activity.actor, label: activity.actor }, action: activity.type,
          subject: { kind: 'task', id: activity.taskId, label: task?.title ?? 'Task' }, summary: task ? `${task.title}：${activity.type}` : activity.type,
          result: 'informational', href: `/projects/${project.id}/tasks/${activity.taskId}`, freshness: { status: 'current', observedAt: activity.occurredAt as Timestamp } })
      }
    }
    const auditPage = await this.store.identity.queryAudit({ limit: MAX_LIMIT })
    for (const audit of auditPage.items) {
      const projectId = audit.resource.kind === 'project' ? audit.resource.id : typeof audit.metadata.projectId === 'string' ? audit.metadata.projectId as ProjectId : null
      if (!projectId || !visible.has(projectId) || (query.projectId && projectId !== query.projectId)) continue
      const sourceKey = `${audit.action}:${String(audit.metadata.requestId ?? audit.metadata.reviewId ?? audit.id)}`
      events.push({ cursor: '', sourceKind: 'audit', sourceId: audit.id, sourceKey, occurredAt: audit.occurredAt, projectId,
        actor: { kind: audit.actorId ? 'user' : 'system', id: audit.actorId, label: audit.actorId ?? '系统' }, action: audit.action,
        subject: { kind: audit.resource.kind, id: audit.resource.id, label: visible.get(projectId)?.name ?? audit.resource.kind }, summary: audit.action,
        result: audit.result, href: `/projects/${projectId}`, freshness: { status: 'current', observedAt: audit.occurredAt } })
    }
    const sessionApprovals = new Map((await this.sessionApprovals(actorId, query.projectId)).map(item => [item.projectionKey, item]))
    for (const overlay of (await this.decisionOverlays()).values()) {
      // Do not expose a private Session or let an optimistic admission contradict
      // terminal Journal history. Authoritative timeline events are a separate seam.
      if (overlay.source.kind === 'session_tool' && !applicableSessionOverlay(sessionApprovals.get(overlay.projectionKey), overlay)) continue
      if (!visible.has(overlay.projectId) || (query.projectId && query.projectId !== overlay.projectId) || !overlay.decidedAt) continue
      events.push({ cursor: '', sourceKind: overlay.source.kind === 'task_review' ? 'task_activity' : 'session', sourceId: `approval:${overlay.projectionKey}:${overlay.sourceRevision}`, sourceKey: `approval.decided:${overlay.projectionKey}:${overlay.sourceRevision}`, occurredAt: overlay.decidedAt, projectId: overlay.projectId,
        actor: { kind: 'system', id: null, label: '审批服务' }, action: 'approval.decided', subject: { kind: 'approval', id: overlay.projectionKey, label: overlay.title }, summary: `${overlay.title}：${overlay.status === 'approved' ? '已批准' : overlay.status === 'denied' ? '已拒绝' : '要求修改'}`,
        result: overlay.status === 'approved' ? 'succeeded' : 'failed', href: '/approvals', freshness: overlay.freshness })
    }
    const preferred = new Map<string, TimelineEvent>()
    for (const event of events.sort(compare)) {
      const existing = preferred.get(event.sourceKey)
      if (!existing || (existing.sourceKind === 'audit' && event.sourceKind === 'task_activity')) preferred.set(event.sourceKey, event)
    }
    const filtered = [...preferred.values()].filter(event => (!query.sourceKind || event.sourceKind === query.sourceKind) && (!query.actorKind || event.actor.kind === query.actorKind) && (!query.actorId || event.actor.id === query.actorId) && (!query.subjectKind || event.subject.kind === query.subjectKind) && (!query.from || event.occurredAt >= query.from) && (!query.to || event.occurredAt <= query.to))
      .map(event => ({ ...event, cursor: encodeProjectionCursor(event) }))
    return page(filtered, query.cursor, query.limit)
  }

  private async sessionApprovals(actorId: UserId, projectId?: ProjectId): Promise<ApprovalView[]> {
    const approvals: ApprovalView[] = []
    for (const session of await this.sessions.list(actorId)) {
      if (projectId && session.projectId !== projectId) continue
      const state = await this.store.cache.getFreshness(session.id)
      if (!state || state.contiguousSeq < 1) continue
      const events = (await this.store.cache.readEvents(session.id, 1 as never, state.contiguousSeq)).events
      approvals.push(...currentSessionApprovals(session, events, state.status))
    }
    return approvals
  }

  private async decisionOverlays(): Promise<ReadonlyMap<string, ApprovalView>> {
    const persisted = await this.approvalDecisions.listOverlays(new Date().toISOString() as Timestamp)
    return new Map(persisted.map(item => [item.projectionKey, item] as const))
  }
}
