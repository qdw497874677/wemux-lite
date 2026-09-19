import type { HTMLAttributes } from 'react'
import type { TaskPriority, TaskStatus } from '@wemux/web-contract/task-platform'
import { AlertTriangle, Check, CircleDashed, CircleDot, CirclePause, Eye, ListTodo, X } from 'lucide-react'
import { cn } from '../../lib/utils.ts'

export const taskStatusLabels: Record<TaskStatus, string> = {
  backlog: '待规划',
  todo: '待开始',
  in_progress: '进行中',
  in_review: '待审查',
  done: '已完成',
  blocked: '已阻塞',
  cancelled: '已取消',
}

export const taskPriorityLabels: Record<TaskPriority, string> = {
  none: '无优先级',
  low: '低',
  medium: '中',
  high: '高',
}

const statusIcons = {
  backlog: CircleDashed,
  todo: ListTodo,
  in_progress: CircleDot,
  in_review: Eye,
  done: Check,
  blocked: CirclePause,
  cancelled: X,
} satisfies Record<TaskStatus, typeof CircleDot>

export function TaskStatusBadge({ status, className, ...props }: HTMLAttributes<HTMLSpanElement> & { status: TaskStatus }) {
  const Icon = statusIcons[status]
  return <span className={cn('task-status-badge', `task-status-${status}`, className)} {...props}>
    <Icon aria-hidden />
    {taskStatusLabels[status]}
  </span>
}

export function TaskPriorityBadge({ priority, className, ...props }: HTMLAttributes<HTMLSpanElement> & { priority: TaskPriority }) {
  if (priority === 'none') return null
  return <span className={cn('task-priority-badge', `task-priority-${priority}`, className)} {...props}>
    <AlertTriangle aria-hidden />
    {taskPriorityLabels[priority]}
  </span>
}
