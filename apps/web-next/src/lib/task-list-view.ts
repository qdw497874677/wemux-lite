import type { TaskSummary } from '@wemux/web-contract/task-platform'

export type TaskListSort = 'updated' | 'title' | 'priority'
type ListTask = Pick<TaskSummary, 'id' | 'title' | 'status' | 'priority' | 'updatedAt'>
const priorities = { none: 0, low: 1, medium: 2, high: 3 }
/** Operates only on the caller's authorized list; never mutates query data. */
export function taskListView<T extends ListTask>(tasks: readonly T[], query: string, status: string, sort: TaskListSort): T[] {
  const title = query.toLowerCase()
  return tasks.filter(task => (!status || task.status === status) && task.title.toLowerCase().includes(title))
    .sort((a, b) => (sort === 'title' ? a.title.localeCompare(b.title, 'zh') : sort === 'priority' ? priorities[b.priority] - priorities[a.priority] : b.updatedAt.localeCompare(a.updatedAt)) || a.id.localeCompare(b.id))
}
