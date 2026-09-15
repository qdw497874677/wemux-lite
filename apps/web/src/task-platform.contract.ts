import type { BoardColumn, LaunchRequest, LaunchResponse, TaskSummary } from '@wemux/web-contract/task-platform'

/** Compile-only M1 consumer fixture; no UI, fetch, or application wiring. */
export function taskPlatformConsumerContract(column: BoardColumn, response: LaunchResponse): LaunchRequest | null {
  const task: TaskSummary | undefined = column.tasks[0]
  if (!task || !task.assignee) return null
  const linkCount: number = task.linkCount
  const attempt: number = response.run.attempt
  const failure: { readonly code: string; readonly message: string } | null = response.run.failure
  const lastProjectedSeq: number = response.run.lastProjectedSeq
  void failure
  void lastProjectedSeq
  void linkCount
  void attempt
  return {
    requestId: 'compile-fixture', mode: 'new', reuseSessionId: null,
    prompt: task.title, assignment: task.assignee,
  }
}
