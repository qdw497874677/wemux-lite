import type { ProjectId, UserId } from '@wemux/domain'

export interface AttentionTaskSourceItem {
  readonly taskId: string
  readonly projectId: ProjectId
  readonly title: string
  readonly status: 'in_progress' | 'in_review'
  readonly assigneeUserIds: readonly UserId[]
}

export interface AttentionRunSourceItem {
  readonly runId: string
  readonly taskId: string
  readonly projectId: ProjectId
  readonly title: string
  readonly status: 'blocked' | 'failed'
  readonly createdBy: UserId | null
}

export interface AttentionDeadLetterSourceItem {
  readonly id: string
  readonly projectId: ProjectId
  readonly title: string
  readonly detail: string
}

export interface AttentionSourcePort {
  listTasks(): Promise<readonly AttentionTaskSourceItem[]>
  listRuns(): Promise<readonly AttentionRunSourceItem[]>
  listDeadLetters(): Promise<readonly AttentionDeadLetterSourceItem[]>
}
