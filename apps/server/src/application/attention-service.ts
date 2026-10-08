import type { AttentionGroup, AttentionPagesQuery, AttentionPagesResult, AttentionItemKind, AttentionQuery, AttentionResult, AttentionView, ApprovalView } from '@wemux/server-domain'
import type { ProjectId, Timestamp, UserId } from '@wemux/domain'
import type { AttentionSourcePort } from './ports/attention-source.ts'
import { AppError } from './errors.ts'
import { attentionPageInput } from './attention-page-input.ts'
import type { ProjectionService } from './projection-service.ts'
import type { ServerStore } from './ports/server-store.ts'

const order: readonly AttentionItemKind[] = ['approval', 'task_assignment', 'run_problem', 'channel_dead_letter']
const labels: Readonly<Record<AttentionItemKind, string>> = {
  approval: '待审批',
  task_assignment: '指派给我的任务',
  run_problem: '我创建的异常运行',
  channel_dead_letter: 'Channel 死信',
}

export class AttentionService {
  private readonly projections: ProjectionService
  private readonly source: AttentionSourcePort
  private readonly store: Pick<ServerStore, 'transaction'>
  private readonly clock: () => Date

  constructor(projections: ProjectionService, source: AttentionSourcePort, store: Pick<ServerStore, 'transaction'>, clock: () => Date = () => new Date()) {
    this.projections = projections
    this.source = source
    this.store = store
    this.clock = clock
  }

  async pages(actorId: UserId, isAdministrator: boolean, query: AttentionPagesQuery): Promise<AttentionPagesResult> {
    if (query.kind !== 'approval' && query.kind !== 'run_problem' && query.kind !== 'channel_dead_letter') {
      if (query.kind === 'task_assignment') throw new AppError(422, 'Attention kind does not support bounded pages', 'unsupported_attention_kind')
      throw new AppError(400, 'A valid attention kind is required', 'invalid_request')
    }
    // Validate even when the actor has no visible Projects, without invoking a source query.
    attentionPageInput({ ...query, authorizedProjectIds: [] }, query.kind)
    if (query.kind === 'channel_dead_letter' && !isAdministrator) throw new AppError(403, 'Administrator access required', 'forbidden')
    // Authorization and source rows must see one committed snapshot. A revocation
    // between separate reads could otherwise expose rows created after access ended.
    return this.store.transaction(async tx => {
      const authorizedProjectIds = await tx.resources.listAccessibleProjectIds(actorId, query.projectId)
      const generatedAt = this.clock().toISOString() as Timestamp
      if (authorizedProjectIds.length === 0) return { items: [], nextCursor: null, generatedAt }
      const sourceQuery = { authorizedProjectIds, cursor: query.cursor, limit: query.limit }
      const common = { occurredAt: null, freshness: { status: 'current' as const, observedAt: generatedAt } }
      if (query.kind === 'approval') {
        const page = await this.source.listApprovalsPage({ ...sourceQuery, actorId })
        return { generatedAt, nextCursor: page.nextCursor, items: page.items.map(item => {
          const sourceId = ['task_review', item.taskId, item.runId, item.reviewId].map(encodeURIComponent).join(':')
          return {
            ...common, projectionKey: `approval:${sourceId}`, kind: 'approval' as const,
            projectId: item.projectId, title: item.title, detail: '任务成果等待人工审查',
            // The Task surface reloads the current review/version and reauthorizes decisions.
            href: `/next/projects/${encodeURIComponent(item.projectId)}?task=${encodeURIComponent(item.taskId)}`,
            sourceId, occurredAt: item.requestedAt as Timestamp,
          }
        }) }
      }
      if (query.kind === 'run_problem') {
        const page = await this.source.listRunsPage({ ...sourceQuery, actorId })
        return { generatedAt, nextCursor: page.nextCursor, items: page.items.map(item => ({
          ...common, projectionKey: `run_problem:${item.runId}`, kind: 'run_problem' as const,
          projectId: item.projectId, title: item.title, detail: item.status === 'failed' ? '运行失败' : '运行受阻',
          href: `/next/projects/${encodeURIComponent(item.projectId)}?task=${encodeURIComponent(item.taskId)}&run=${encodeURIComponent(item.runId)}`,
          sourceId: item.runId,
        })) }
      }
      const page = await this.source.listDeadLettersPage({ ...sourceQuery, actorId })
      return { generatedAt, nextCursor: page.nextCursor, items: page.items.map(item => ({
        ...common, projectionKey: `channel_dead_letter:${item.id}`, kind: 'channel_dead_letter' as const,
        projectId: item.projectId, title: item.title, detail: item.detail,
        // Channel management has not migrated to /next; this is the reachable legacy page.
        href: `/projects/${encodeURIComponent(item.projectId)}/channels?delivery=${encodeURIComponent(item.id)}`, sourceId: item.id,
      })) }
    })
  }

  async query(actorId: UserId, isAdministrator: boolean, query: AttentionQuery): Promise<AttentionResult> {
    const [approvals, tasks, runs, deadLetters] = await Promise.all([
      this.pendingApprovals(actorId, query.projectId),
      this.source.listTasks(),
      this.source.listRuns(),
      isAdministrator ? this.store.transaction(async tx => {
        const authorizedProjectIds = await tx.resources.listAccessibleProjectIds(actorId, query.projectId)
        return this.source.listDeadLetters({ actorId, authorizedProjectIds })
      }) : Promise.resolve([]),
    ])
    const allowedProjects = new Set(await this.projections.allowedProjectIds(actorId))
    const projectAllowed = (projectId: ProjectId) => allowedProjects.has(projectId) && (!query.projectId || query.projectId === projectId)
    const items: AttentionView[] = [
      ...approvals.filter(item => projectAllowed(item.projectId) && item.decisionCapabilities.length > 0).map(item => this.approvalItem(item)),
      ...tasks.filter(item => projectAllowed(item.projectId) && item.assigneeUserIds.includes(actorId)).map(item => ({
        projectionKey: `task_assignment:${item.taskId}`,
        kind: 'task_assignment' as const,
        projectId: item.projectId,
        title: item.title,
        detail: item.status === 'in_review' ? '任务等待审查' : '任务正在进行',
        href: `/next/projects/${encodeURIComponent(item.projectId)}?task=${encodeURIComponent(item.taskId)}`,
        occurredAt: null,
        sourceId: item.taskId,
        freshness: { status: 'current' as const, observedAt: this.clock().toISOString() as Timestamp },
      })),
      ...runs.filter(item => projectAllowed(item.projectId) && item.createdBy === actorId).map(item => ({
        projectionKey: `run_problem:${item.runId}`,
        kind: 'run_problem' as const,
        projectId: item.projectId,
        title: item.title,
        detail: item.status === 'failed' ? '运行失败' : '运行受阻',
        href: `/next/projects/${encodeURIComponent(item.projectId)}?task=${encodeURIComponent(item.taskId)}&run=${encodeURIComponent(item.runId)}`,
        occurredAt: null,
        sourceId: item.runId,
        freshness: { status: 'current' as const, observedAt: this.clock().toISOString() as Timestamp },
      })),
      ...deadLetters.filter(item => projectAllowed(item.projectId)).map(item => ({
        projectionKey: `channel_dead_letter:${item.id}`,
        kind: 'channel_dead_letter' as const,
        projectId: item.projectId,
        title: item.title,
        detail: item.detail,
        href: `/projects/${encodeURIComponent(item.projectId)}/channels#dead-letter-${encodeURIComponent(item.id)}`,
        occurredAt: null,
        sourceId: item.id,
        freshness: { status: 'current' as const, observedAt: this.clock().toISOString() as Timestamp },
      })),
    ]
    const visibleItems = query.kind ? items.filter(item => item.kind === query.kind) : items
    const groups: AttentionGroup[] = order.map(kind => ({ kind, label: labels[kind], count: visibleItems.filter(item => item.kind === kind).length, items: visibleItems.filter(item => item.kind === kind) }))
    return { total: visibleItems.length, generatedAt: this.clock().toISOString() as Timestamp, groups }
  }

  private async pendingApprovals(actorId: UserId, projectId?: ProjectId): Promise<ApprovalView[]> {
    const items: ApprovalView[] = []
    let cursor: string | undefined
    do {
      const page = await this.projections.approvals(actorId, { status: 'pending', ...(projectId ? { projectId } : {}), limit: 100, cursor })
      items.push(...page.items)
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    return items
  }

  private approvalItem(item: ApprovalView): AttentionView {
    return {
      projectionKey: `approval:${item.projectionKey}`,
      kind: 'approval',
      projectId: item.projectId,
      title: item.title,
      detail: item.reason ?? '等待你的决定',
      href: `/approvals?projectId=${encodeURIComponent(item.projectId)}#${encodeURIComponent(item.projectionKey)}`,
      occurredAt: item.requestedAt,
      sourceId: item.projectionKey,
      freshness: item.freshness,
    }
  }
}
