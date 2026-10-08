import type { ConversationSnapshot, ConversationScope } from '@wemux/web-client'

/** UI admission guard only; the Server rechecks authorization and capability on every POST.
 * Offline Journal freshness alone is not a denial: send capability permits durable offline enqueue.
 */
export function conversationSendDenial(snapshot: ConversationSnapshot | null, scope: ConversationScope): string | null {
  if (!snapshot || snapshot.status !== 'ready' || snapshot.needsRefresh || snapshot.error || snapshot.subscriptionError || snapshot.subscription !== 'watching') return '会话元数据尚未就绪或需要刷新，暂不能发送或重试。'
  if ((['accountId', 'teamId', 'projectId', 'taskId', 'sessionId'] as const).some(key => snapshot.scope[key] !== scope[key])) return '会话身份已变化，请重新打开当前会话。'
  const session = snapshot.session
  if (!session || session.id !== scope.sessionId || session.projectId !== scope.projectId || session.taskId !== scope.taskId) return '会话不属于当前任务或项目，不能发送或重试。'
  if (!session.access.canRead || !session.access.canWrite) return '当前会话为只读权限，不能发送或重试。'
  if (session.deletedAt || session.archivedAt) return '会话已删除或归档，不能发送或重试。'
  if (!session.sendCapability?.allowed) return `当前不允许发送：${session.sendCapability?.reason || '权威发送能力不可用'}（${session.sendCapability?.reasonCode ?? 'invalid_metadata'}）。`
  return null
}
