import type { ServerStoreTx } from './ports/server-store.ts'
import type { Session } from '@wemux/server-domain'
import { AppError } from './errors.ts'

/** Caller must authorize the Session first. Includes legacy Run-bound Sessions. */
export async function assertSessionTaskMutable(tx: ServerStoreTx, session: Session) {
  const tasks = session.taskId ? [await tx.tasks.get(session.taskId)] : []
  for (const summary of await tx.tasks.list(session.projectId, true)) {
    if (summary.id !== session.taskId && (await tx.tasks.runs(summary.id)).some(run => run.sessionId === session.id)) tasks.push(await tx.tasks.get(summary.id))
  }
  if (tasks.some(task => task?.deletedAt)) throw new AppError(410, 'Task is permanently deleted; Session history is read-only', 'task_deleted')
}
