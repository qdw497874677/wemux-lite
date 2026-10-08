import type { TaskDetail } from '@wemux/web-contract/task-platform'
import type { ProjectClient } from './ProjectManagement.tsx'
import { useCreateIntent } from './ProjectManagement.tsx'
import { useOperationLifetime } from '../lib/operation-lifetime.ts'
import { ConfirmButton } from './AccountForms.tsx'

export function TaskDeletion({ api, task, changed }: { api: ProjectClient; task: TaskDetail; changed: () => void }) {
  const intent = useCreateIntent(), begin = useOperationLifetime([api, task.id])
  return <section className="account-row"><h3>永久删除任务</h3><p>删除后从任务列表移除，保留只读历史，不能恢复。解除工作区绑定，不删除工作区、落点或文件。当前有关联 Session（包括已归档或已删除记录）、Run 或开放审查的任务可能被拒绝；不会自动取消执行，也不要通过删除 Session 绕过限制。</p>
    <ConfirmButton confirm="确认永久删除此任务？任务历史保留只读，不能恢复；工作区和文件不会删除。" act={async () => {
      const active = begin(), body = { version: task.version }
      await api.deleteTask(task.projectId, task.id, task.version, intent.id(body))
      if (!active()) return
      intent.complete(); changed()
      return '任务已永久删除，工作区和文件保留。'
    }}>永久删除任务</ConfirmButton>
  </section>
}
