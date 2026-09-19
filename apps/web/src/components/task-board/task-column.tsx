import type { DragEvent, ReactNode } from 'react'
import type { TaskStatus } from '@wemux/web-contract/task-platform'
import { Plus } from 'lucide-react'
import { cn } from '../../lib/utils.ts'
import { TaskStatusBadge, taskStatusLabels } from './task-status.tsx'

export function TaskColumn({ status, count, children, empty, canCreate = false, onCreate, onDragOver, onDrop, className }: {
  status: TaskStatus
  count: number
  children: ReactNode
  empty?: boolean
  canCreate?: boolean
  onCreate?: () => void
  onDragOver?: (event: DragEvent<HTMLDivElement>) => void
  onDrop?: (event: DragEvent<HTMLDivElement>) => void
  className?: string
}) {
  return <section className={cn('task-column', className)} aria-label={`${taskStatusLabels[status]} 列`}>
    <header className="task-column-header">
      <TaskStatusBadge status={status} />
      <span className="task-column-count" aria-label={`${count} 个任务`}>{count}</span>
      {canCreate && <button type="button" className="task-column-add" onClick={onCreate} aria-label={`在${taskStatusLabels[status]}中新建任务`}><Plus aria-hidden /></button>}
    </header>
    <div className="task-column-scroll" onDragOver={onDragOver} onDrop={onDrop}>
      <div className="task-drop" aria-hidden>放到这里</div>
      {children}
      {empty && <div className="task-column-empty"><span>暂无任务</span><small>拖动任务到此阶段</small></div>}
    </div>
  </section>
}
