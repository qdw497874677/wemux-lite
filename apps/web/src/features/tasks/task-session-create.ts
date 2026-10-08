import type { PendingTaskSession } from '@wemux/web-client'
import type { TaskDetail } from '@wemux/web-contract/task-platform'
import type { Api } from '../../api/client.ts'

/** Freeze assignment before any capability fetch; retries never consult the current Task or model order. */
export function createIndependentTaskSession(pending: PendingTaskSession, api: Pick<Api, 'createTaskSession' | 'workers'>, task: Pick<TaskDetail, 'id' | 'projectId' | 'title' | 'assignee'>) {
  const { projectId, id, title } = task
  const assignment = task.assignee ? { ...task.assignee } : null
  return pending.run(async () => {
    if (!assignment) throw Error('请先为任务选择执行环境与 Agent。')
    const modelId = assignment.modelId ?? (await api.workers()).find(w => w.id === assignment.workerId)?.capabilities.find(a => a.agentKey === assignment.agentKey)?.models[0]?.modelId
    if (!modelId) throw Error('无法确定具体模型，请检查 Worker 能力并选择模型后重试。')
    return { title, ...assignment, modelId }
  }, body => api.createTaskSession(projectId, id, body))
}
