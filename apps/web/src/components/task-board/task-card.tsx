import type { DragEvent, ReactNode } from 'react'
import type { TaskSummary } from '@wemux/web-contract/task-platform'
import { Bot, GitBranch, Link2, Play, Server } from 'lucide-react'
import { cn } from '../../lib/utils.ts'
import { TaskPriorityBadge } from './task-status.tsx'

function taskNumber(id: string) {
  const compact = id.replace(/[^a-zA-Z0-9]/g, '').slice(-6).toUpperCase()
  return `WMX-${compact || 'TASK'}`
}

function agentInitial(agentKey: string) {
  return agentKey.trim().slice(0, 1).toUpperCase() || 'A'
}

export interface TaskCardProps {
  task: TaskSummary
  href?: string
  onOpen?: () => void
  onDragStart?: (event: DragEvent<HTMLElement>) => void
  onDragEnd?: () => void
  draggable?: boolean
  footer?: ReactNode
  compact?: boolean
  className?: string
}

export function TaskCard({ task, href = '#', onOpen, onDragStart, onDragEnd, draggable = false, footer, compact = false, className }: TaskCardProps) {
  const active = task.activeRun
  return <article className={cn('task-card', compact && 'task-card-compact', className)} draggable={draggable} onDragStart={onDragStart} onDragEnd={onDragEnd}>
    <div className="task-card-heading">
      <span className="task-card-number">{taskNumber(task.id)}</span>
      {active && <span className="task-run-indicator"><Play aria-hidden />{active.status}</span>}
    </div>
    <a href={href} onClick={event => { if (onOpen) { event.preventDefault(); onOpen() } }} className="task-card-title">{task.title}</a>
    <div className="task-card-labels">
      <TaskPriorityBadge priority={task.priority} />
      {task.assignee && <span className="task-label"><Bot aria-hidden />{task.assignee.agentKey}</span>}
      {task.assignee?.modelId && <span className="task-label task-label-muted">{task.assignee.modelId}</span>}
    </div>
    <footer className="task-card-footer">
      <div className="task-card-meta">
        {task.linkCount > 0 && <span title={`${task.linkCount} 个外部关联`}><Link2 aria-hidden />{task.linkCount}</span>}
        {task.assignee && <span title="已绑定工作区与工作节点"><GitBranch aria-hidden /></span>}
        {active && <span title="存在活跃运行"><Server aria-hidden /></span>}
      </div>
      {task.assignee ? <span className="task-assignee-avatar" aria-label={`指派给 ${task.assignee.agentKey}`} title={task.assignee.agentKey}>{agentInitial(task.assignee.agentKey)}</span> : <span className="task-unassigned">未指派</span>}
    </footer>
    {footer && <div className="task-card-actions">{footer}</div>}
  </article>
}
