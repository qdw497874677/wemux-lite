import { createHash } from 'node:crypto'
import type { TaskDetail } from '@wemux/web-contract/task-platform'
import type { ServerStoreTx } from './ports/server-store.ts'
import { AppError } from './errors.ts'

type Identity = NonNullable<TaskDetail['dedicatedConversation']>
/** Called only after current Project/Workspace/Worker/Agent authorization in the
 * Session creation transaction. Model and Session requestId are deliberately absent.
 * Project test Tasks use the ordinary Project workflow; this is not Team coordination.
 */
export async function dedicatedConversationTask(tx: ServerStoreTx, projectId: string, identity: Identity, requestId: string): Promise<string> {
  const key = JSON.stringify([identity.ownerId, projectId, identity.workspaceId, identity.workerId, identity.agentKey, identity.scenario])
  const id = `conversation:${createHash('sha256').update(key).digest('hex')}`
  const previous = await tx.tasks.get(id)
  if (previous) {
    const stored = previous.dedicatedConversation
    if (previous.projectId !== projectId || !stored || JSON.stringify([stored.ownerId, projectId, stored.workspaceId, stored.workerId, stored.agentKey, stored.scenario]) !== key) throw new AppError(409, 'Dedicated Task identity conflict', 'request_id_conflict')
    if (previous.deletedAt) throw new AppError(410, 'Dedicated Task is deleted', 'task_deleted')
    return id
  }
  const at = new Date().toISOString()
  const task: TaskDetail = {
    id, projectId, title: identity.scenario === 'agent-test' ? 'Agent 测试' : '快速试聊',
    description: '由项目内会话入口自动提供。不是 Team 协调对话，不授予额外权限。',
    acceptanceCriteria: null, priority: 'none', status: 'backlog', version: 1,
    assignee: null, origin: 'manual', dedicatedConversation: identity,
    activeRun: null, currentReviewId: null, linkCount: 0, createdAt: at, updatedAt: at,
    lastActivityAt: at, blockedFrom: null, cancelledFrom: null, workspaces: [], links: [],
    metadataJson: { schemaVersion: 1, values: {} },
  }
  await tx.tasks.save(task)
  await tx.tasks.append({ taskId: id, projectId, type: 'task.created', actor: identity.ownerId, requestId, occurredAt: at, payload: { title: task.title, action: 'conversation.created', scenario: identity.scenario } })
  return id
}
