/**
 * Human task workflow: the transition rule is a domain invariant, so it lives here
 * and `@wemux/web-contract` re-exports it. Keeping this file free of web-contract
 * imports is what makes `@wemux/domain` a leaf for lineage and canvas contracts.
 */

export const taskStatuses = ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled'] as const

/** Run failure/retry is not a Task status and never completes a Task automatically. */
export type TaskStatus = (typeof taskStatuses)[number]

export type BlockedFrom = Exclude<TaskStatus, 'blocked'>
export type CancelledFrom = Exclude<TaskStatus, 'cancelled'>

/** The subset of a Task every workflow decision depends on. Wire DTOs extend it structurally. */
export interface TaskWorkflowState {
  readonly status: TaskStatus
  readonly version: number
  readonly blockedFrom: BlockedFrom | null
  readonly cancelledFrom: CancelledFrom | null
  readonly activeRun?: { readonly id: string } | null
}

const isStatus = (value: unknown): value is TaskStatus => taskStatuses.includes(value as TaskStatus)

/** Human workflow only. Terminal states stay reversible so a reviewer can reopen work. */
export function workflowTargets(task: { readonly status: TaskStatus; readonly blockedFrom: unknown; readonly cancelledFrom: unknown }): readonly TaskStatus[] {
  switch (task.status) {
    case 'backlog': return ['todo', 'blocked', 'cancelled']
    case 'todo': return ['in_progress', 'blocked', 'cancelled']
    case 'in_progress': return ['in_review', 'done', 'blocked', 'cancelled']
    case 'in_review': return ['done', 'in_progress', 'blocked', 'cancelled']
    case 'done': return ['in_progress', 'blocked', 'cancelled']
    case 'blocked': return [...(isStatus(task.blockedFrom) && task.blockedFrom !== 'blocked' ? [task.blockedFrom] : []), 'cancelled']
    case 'cancelled': return [...(isStatus(task.cancelledFrom) && task.cancelledFrom !== 'cancelled' ? [task.cancelledFrom] : []), 'blocked']
  }
}

export function taskTargets(task: Pick<TaskWorkflowState, 'status' | 'blockedFrom' | 'cancelledFrom'>): readonly TaskStatus[] {
  return workflowTargets(task)
}

export function transitionTask<S extends TaskWorkflowState>(task: S, status: TaskStatus, hasActiveRun: boolean = (task.activeRun ?? null) !== null): S {
  if (status === task.status) return task
  if (!taskTargets(task).includes(status)) throw new Error('invalid_transition')
  // Integration seam for the future durable Run projection; never fabricate a Run.
  if (hasActiveRun && (status === 'done' || status === 'cancelled')) throw new Error('active_run')
  return {
    ...task,
    status,
    version: task.version + 1,
    blockedFrom: status === 'blocked' && !(task.status === 'cancelled' && task.cancelledFrom === 'blocked') ? task.status as BlockedFrom : task.blockedFrom,
    cancelledFrom: status === 'cancelled' && !(task.status === 'blocked' && task.blockedFrom === 'cancelled') ? task.status as CancelledFrom : task.cancelledFrom,
  }
}