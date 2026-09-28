import type { AttentionGroup, AttentionItemKind, AttentionQuery, AttentionResult, AttentionView, ApprovalView } from '@wemux/server-domain'
import type { ProjectId, Timestamp, UserId } from '@wemux/domain'
import type { AttentionSourcePort } from './ports/attention-source.ts'
import type { ProjectionService } from './projection-service.ts'

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
  private readonly clock: () => Date

  constructor(projections: ProjectionService, source: AttentionSourcePort, clock: () => Date = () => new Date()) {
    this.projections = projections
    this.source = source
    this.clock = clock
  }

  async query(actorId: UserId, isAdministrator: boolean, query: AttentionQuery): Promise<AttentionResult> {
    const [approvals, tasks, runs, deadLetters] = await Promise.all([
      this.projections.approvals(actorId, { status: 'pending', ...(query.projectId ? { projectId: query.projectId } : {}), limit: 200 }),
      this.source.listTasks(),
      this.source.listRuns(),
      isAdministrator ? this.source.listDeadLetters() : Promise.resolve([]),
    ])
    const allowedProjects = new Set(await this.projections.allowedProjectIds(actorId))
    const projectAllowed = (projectId: ProjectId) => allowedProjects.has(projectId) && (!query.projectId || query.projectId === projectId)
    const items: AttentionView[] = [
      ...approvals.items.filter(item => projectAllowed(item.projectId)).map(item => this.approvalItem(item)),
      ...tasks.filter(item => projectAllowed(item.projectId) && item.assigneeUserIds.includes(actorId)).map(item => ({
        projectionKey: `task_assignment:${item.taskId}`,
        kind: 'task_assignment' as const,
        projectId: item.projectId,
        title: item.title,
        detail: item.status === 'in_review' ? '任务等待审查' : '任务正在进行',
        href: `/projects/${encodeURIComponent(item.projectId)}/tasks/${encodeURIComponent(item.taskId)}?tab=details`,
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
        href: `/projects/${encodeURIComponent(item.projectId)}/tasks/${encodeURIComponent(item.taskId)}?tab=runs&run=${encodeURIComponent(item.runId)}`,
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
