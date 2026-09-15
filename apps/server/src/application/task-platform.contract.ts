import type { BoardColumn, LaunchRequest, LaunchResponse, TaskSummary } from '@wemux/web-contract/task-platform'

/** Compile-only M1 producer fixture; not an endpoint or a persistence mapper. */
export function taskPlatformProducerContract(request: LaunchRequest, response: LaunchResponse): BoardColumn {
  const failure: { readonly code: string; readonly message: string } | null = response.run.failure
  const lastProjectedSeq: number = response.run.lastProjectedSeq
  void failure
  void lastProjectedSeq
  const task: TaskSummary = {
    id: response.run.taskId, projectId: response.run.projectId, title: request.prompt,
    priority: 'none', status: 'todo', version: 1, assignee: request.assignment,
    origin: 'manual', activeRun: response.run, linkCount: 0,
    createdAt: response.run.createdAt, updatedAt: response.run.createdAt,
    lastActivityAt: response.run.createdAt,
  }
  return { status: 'todo', tasks: [task] }
}
