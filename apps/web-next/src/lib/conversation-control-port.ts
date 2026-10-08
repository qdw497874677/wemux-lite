import type { ConversationControlIntent, ConversationControlPort, ConversationControlScope, ConversationController, ConversationSnapshot } from '@wemux/web-client'
import type { ProjectClient } from '../components/ProjectManagement.tsx'

const fields = ['teamId', 'projectId', 'taskId', 'sessionId'] as const
const keyOf = (scope: ConversationControlScope) => JSON.stringify([new URL(scope.host).origin, scope.accountId, ...fields.map(key => scope[key])])
const bindingOf = (snapshot: ConversationSnapshot | null) => {
  const session = snapshot?.session
  return session ? JSON.stringify([session.workspaceId, session.binding.workspaceId, session.binding.agent.workerId, session.binding.agent.agentKey]) : null
}
/** Current metadata authorizes the UI only; Server rechecks every original/replayed POST.
 * Reader partition remains username for compatibility; control ownership/storage use server ID.
 */
export function conversationControlDenial(api: ProjectClient, scope: ConversationControlScope, snapshot: ConversationSnapshot | null, intent: ConversationControlIntent, requireTarget: boolean): string | null {
  const identity = api.controlIdentity, partition = api.taskSessionScope
  if (!identity?.accountId || identity.signal.aborted || identity.accountId !== scope.accountId || partition.host !== scope.host || partition.teamId !== scope.teamId) return '当前已验证账号或团队身份失效，不能操作。'
  if (!snapshot || snapshot.status !== 'ready' || snapshot.needsRefresh || snapshot.error || snapshot.subscriptionError || snapshot.subscription !== 'watching') return '会话元数据尚未就绪或需要刷新，暂不能控制或重试。'
  if (snapshot.scope.accountId !== partition.account || fields.some(key => snapshot.scope[key] !== scope[key])) return '会话范围已变化，请重新打开当前会话。'
  const session = snapshot.session
  if (!session || session.id !== scope.sessionId || session.taskId !== scope.taskId || session.projectId !== scope.projectId || session.binding.workspaceId !== session.workspaceId) return '会话归属或执行绑定不一致，不能操作。'
  if (!session.access.canRead || !session.access.canWrite) return '当前会话为只读权限，不能控制或重试。'
  if (session.archivedAt || session.deletedAt) return '会话已归档或删除，不能控制或重试。'
  // A replay checks current write authority, not a newly reported model list.
  // The immutable original target is revalidated/deduplicated by the Server.
  if (intent.operation === 'select-model') return null
  if (intent.operation === 'resolve-approval') {
    const approval = snapshot.projection.pendingApprovals.find(item => item.turnId === intent.body.turnId && item.approvalId === intent.approvalId)
    if (requireTarget && (!approval || session.activeTurnId !== intent.body.turnId)) return '审批已结束或不属于当前 Turn，不能发起新决定。'
    return null
  }
  const queued = intent.operation === 'cancel-queued' ? session.queuedMessages.find(message => message.commandId === intent.submissionCommandId) : undefined
  const observed = intent.operation === 'cancel-queued' ? !!queued : session.activeTurnId === intent.body.turnId
  if (requireTarget && !observed) return '所选目标已不在当前权威元数据中，不会改为其他目标。'
  const owner = intent.operation === 'cancel-queued' ? queued?.sentByAccountId : observed ? session.activeTurnOwnerId : null
  if (!session.access.canControl && owner !== identity.accountId) return observed ? '仅能控制自己提交的消息或 Turn；控制他人执行需要控制权限。' : '原目标已不可观察，无法核验自己的目标权限；保留原请求，不能改为新目标。'
  return null
}
type Binding = { port: ConversationControlPort; attach(read: ConversationController | null): () => void }
// No credentials/global account cache. Keys are actual authenticated clients; scopes own stable ports.
const clients = new WeakMap<ProjectClient, Map<string, Binding>>()
export function conversationControlBinding(api: ProjectClient, input: ConversationControlScope): Binding {
  const scope = Object.freeze({ ...input, host: new URL(input.host).origin }), key = keyOf(scope)
  let ports = clients.get(api)
  if (!ports) { ports = new Map(); clients.set(api, ports) }
  const existing = ports.get(key)
  if (existing) return existing
  let current: { token: object; read: ConversationController | null } | null = null
  let executionBinding: string | null = null
  const port: ConversationControlPort = Object.freeze({
    scope, signal: api.controlIdentity.signal,
    assertCurrent(candidate: ConversationControlScope, intent: ConversationControlIntent) {
      const snapshot = current?.read?.getSnapshot() ?? null
      const denial = keyOf(candidate) !== key ? '控制范围已变化。' : conversationControlDenial(api, scope, snapshot, intent, false)
      if (denial || (executionBinding !== null && bindingOf(snapshot) !== executionBinding)) throw Error(denial ?? '执行绑定已变化。')
      if (executionBinding === null) executionBinding = bindingOf(snapshot)
    },
    cancelQueuedMessage: api.cancelQueuedMessage.bind(api), stopTurn: api.stopTurn.bind(api), resolveApproval: api.resolveApproval.bind(api), selectModel: api.selectModel.bind(api),
  })
  const binding: Binding = { port, attach(read) {
    const token = {}
    current = { token, read }
    const snapshot = read?.getSnapshot() ?? null
    if (snapshot?.status === 'ready' && executionBinding === null) executionBinding = bindingOf(snapshot)
    return () => { if (current?.token === token) current = null }
  } }
  port.signal.addEventListener('abort', () => { current = null; ports!.clear() }, { once: true })
  ports.set(key, binding)
  return binding
}
