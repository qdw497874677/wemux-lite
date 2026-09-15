import { workflowTargets, type TaskDetail, type TaskStatus } from '@wemux/web-contract/task-platform'

/** Human workflow only. Run failure/retry is not a Task status or an automatic completion. */
export function taskTargets(task: Pick<TaskDetail, 'status' | 'blockedFrom' | 'cancelledFrom'>): readonly TaskStatus[] {
  return workflowTargets(task)
}
export function transitionTask(task: TaskDetail, status: TaskStatus, hasActiveRun = task.activeRun !== null): TaskDetail {
  if (status === task.status) return task
  if (!taskTargets(task).includes(status)) throw new Error('invalid_transition')
  // Integration seam for the future durable Run projection; never fabricate a Run.
  if (hasActiveRun && (status === 'done' || status === 'cancelled')) throw new Error('active_run')
  return { ...task, status, version: task.version + 1,
    blockedFrom: status === 'blocked' && !(task.status === 'cancelled' && task.cancelledFrom === 'blocked') ? task.status as Exclude<TaskStatus, 'blocked'> : task.blockedFrom,
    cancelledFrom: status === 'cancelled' && !(task.status === 'blocked' && task.blockedFrom === 'cancelled') ? task.status as Exclude<TaskStatus, 'cancelled'> : task.cancelledFrom }
}
