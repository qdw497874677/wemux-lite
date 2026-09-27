import type { UIMessage } from 'ai'
import type { AbortReasonDTO, AgentFailureReasonDTO, JournalEventDTO, RuntimeState, RuntimeUsageDTO } from './dto'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  status: string
}

export interface TimelineMessage extends ChatMessage {
  kind: 'message'
  turnId?: string
}

export interface TimelineTool {
  kind: 'tool'
  id: string
  turnId: string
  toolCallId: string
  toolName: string
  input: unknown
  output: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  exitCode: number | null
  streamKind?: 'command_output' | 'file_change_output'
}

export interface TimelineNotice {
  kind: 'notice'
  id: string
  text: string
  tone: 'info' | 'error'
  failureReason?: AgentFailureReasonDTO
}

export interface TimelineUsage {
  kind: 'usage'
  id: string
  turnId: string
  usage: RuntimeUsageDTO
}

export interface TimelineReasoning {
  kind: 'reasoning'
  id: string
  turnId: string
  text: string
  duration: number
  running: boolean
}

export interface QueuedItem { commandId: string; messageId: string; content: string; position: number }
export interface PendingApproval { approvalId: string; turnId: string; action: unknown; reason?: string }
export interface ApprovalHistoryEntry extends PendingApproval { decision: 'approve' | 'deny' }

export type ChatTimelineItem = TimelineMessage | TimelineTool | TimelineNotice | TimelineUsage | TimelineReasoning

const abortReasonLabels: Record<AbortReasonDTO, string> = {
  user_stop: '用户已停止本轮',
  executor_disconnected: '执行节点连接已断开',
  control_plane_disconnect: '控制面连接已断开',
  timeout: '本轮执行超时',
  provider_error: '模型服务执行失败',
  cancelled: '本轮已取消',
  unknown: '本轮因未知原因中止',
}
const failureReasonLabels: Record<AgentFailureReasonDTO, string> = {
  'agent_error.context_overflow': '上下文窗口已超限',
  'agent_error.missing_config': '运行时缺少必要配置',
  'agent_error.provider_auth_or_access': '模型服务认证或访问被拒绝',
  'agent_error.provider_quota_limit': '模型服务额度不足',
  'agent_error.provider_capacity_or_rate_limit': '模型服务容量不足或触发限流',
  'agent_error.provider_server_error': '模型服务端发生错误',
  'agent_error.provider_network': '模型服务网络连接中断',
  'agent_error.model_not_found_or_unavailable': '模型不存在或当前不可用',
  'agent_error.empty_or_unparseable_output': '智能体未返回可解析结果',
  'agent_error.agent_timeout': '智能体进程执行超时',
  'agent_error.runtime_missing_executable': '智能体运行时未安装或不可执行',
  'agent_error.runtime_version_unsupported': '智能体运行时版本不受支持',
  'agent_error.process_failure': '智能体进程异常退出',
  'agent_error.unknown': '智能体发生未知错误',
}

/** AI Elements consumes the AI SDK UIMessage shape, while Wemux keeps its own durable AgentEvent journal. */
export function timelineMessageToUIMessage(message: TimelineMessage): UIMessage {
  return { id: message.id, role: message.role, parts: [{ type: 'text', text: message.text }] }
}

// Rebuild from the ordered, durable journal. The timeline keeps assistant text
// segments on either side of tool calls instead of flattening the whole turn.
export function projectJournal(events: readonly JournalEventDTO[]) {
  const messages: ChatMessage[] = []
  const timeline: ChatTimelineItem[] = []
  const notices: string[] = []
  let runtimeState: RuntimeState | undefined
  let activeTurnId: string | null = null
  const queued = new Map<string, QueuedItem>()
  const approvals = new Map<string, PendingApproval>()
  const approvalHistory: ApprovalHistoryEntry[] = []
  const turnMessages = new Map<string, string>()
  const turnStartedAt = new Map<string, number>()

  const assistantMessage = (turnId: string) => {
    let message = messages.find(item => item.id === `assistant:${turnId}`)
    if (!message) {
      message = { id: `assistant:${turnId}`, role: 'assistant', text: '', status: 'running' }
      messages.push(message)
    }
    return message
  }

  for (const event of events) {
    const payload = event.payload
    switch (payload.kind) {
      case 'message.queued': {
        queued.set(payload.messageId, { commandId: payload.commandId, messageId: payload.messageId, content: payload.content, position: payload.position })
        const message: ChatMessage = { id: payload.messageId, role: 'user', text: payload.content, status: 'queued' }
        messages.push(message)
        timeline.push({ kind: 'message', ...message })
        break
      }
      case 'message.cancelled': {
        queued.delete(payload.messageId)
        const message = messages.find(item => item.id === payload.messageId)
        if (message) message.status = 'cancelled'
        const entry = timeline.find(item => item.kind === 'message' && item.id === payload.messageId)
        if (entry?.kind === 'message') entry.status = 'cancelled'
        break
      }
      case 'message.rejected': {
        queued.delete(payload.messageId)
        const message = messages.find(item => item.id === payload.messageId)
        if (message) message.status = 'rejected'
        const entry = timeline.find(item => item.kind === 'message' && item.id === payload.messageId)
        if (entry?.kind === 'message') entry.status = 'rejected'
        notices.push(payload.reason)
        timeline.push({ kind: 'notice', id: `rejected:${payload.messageId}:${event.seq}`, text: payload.reason, tone: 'error' })
        break
      }
      case 'turn.started': {
        queued.delete(payload.messageId)
        activeTurnId = payload.turnId
        turnMessages.set(payload.turnId, payload.messageId)
        turnStartedAt.set(payload.turnId, Date.parse(event.occurredAt))
        const message = messages.find(item => item.id === payload.messageId)
        if (message) message.status = 'started'
        const entry = timeline.find(item => item.kind === 'message' && item.id === payload.messageId)
        if (entry?.kind === 'message') entry.status = 'started'
        assistantMessage(payload.turnId)
        runtimeState = 'running'
        break
      }
      case 'assistant.text.delta': {
        if (payload.streamKind === 'reasoning_text' || payload.streamKind === 'plan_text') {
          const previous = timeline.at(-1)
          if (previous?.kind === 'reasoning' && previous.turnId === payload.turnId && previous.running) previous.text += payload.text
          else timeline.push({ kind: 'reasoning', id: `reasoning:${payload.turnId}:${event.seq}`, turnId: payload.turnId, text: payload.text, duration: 1, running: true })
          break
        }
        assistantMessage(payload.turnId).text += payload.text
        const previous = timeline.at(-1)
        if (previous?.kind === 'message' && previous.role === 'assistant' && previous.turnId === payload.turnId && previous.status === 'running') {
          previous.text += payload.text
        } else {
          timeline.push({ kind: 'message', id: `assistant:${payload.turnId}:${event.seq}`, turnId: payload.turnId, role: 'assistant', text: payload.text, status: 'running' })
        }
        break
      }
      case 'turn.finished': {
        if (activeTurnId === payload.turnId) activeTurnId = null
        for (const [id, approval] of approvals) if (approval.turnId === payload.turnId) approvals.delete(id)
        const message = messages.find(item => item.id === `assistant:${payload.turnId}`)
        if (message) message.status = payload.outcome
        const completedUserMessage = messages.find(item => item.id === turnMessages.get(payload.turnId))
        if (completedUserMessage) completedUserMessage.status = payload.outcome
        for (const entry of timeline) {
          if (entry.kind === 'message' && entry.role === 'assistant' && entry.turnId === payload.turnId) entry.status = payload.outcome
          if (entry.kind === 'message' && entry.role === 'user' && entry.id === completedUserMessage?.id) entry.status = payload.outcome
          if (entry.kind === 'tool' && entry.turnId === payload.turnId && entry.status === 'running') entry.status = payload.outcome === 'cancelled' ? 'cancelled' : 'failed'
        }
        if (payload.failure) {
          const category = payload.failure.failureReason ? failureReasonLabels[payload.failure.failureReason] : payload.failure.abortReason ? abortReasonLabels[payload.failure.abortReason] : ''
          const failureText = category && !payload.failure.message.includes(category) ? `${category}：${payload.failure.message}` : payload.failure.message
          notices.push(failureText)
          timeline.push({ kind: 'notice', id: `failure:${payload.turnId}:${event.seq}`, text: failureText, tone: 'error', ...(payload.failure.failureReason ? { failureReason: payload.failure.failureReason } : {}) })
        }
        runtimeState = payload.outcome === 'failed' ? 'failed' : messages.some(item => item.role === 'user' && item.status === 'queued') ? 'queued' : 'idle'
        break
      }
      case 'session.runtime.changed':
        runtimeState = payload.state
        if (payload.reason) {
          notices.push(payload.reason)
          timeline.push({ kind: 'notice', id: `runtime:${event.seq}`, text: payload.reason, tone: payload.state === 'failed' || payload.state === 'unavailable' ? 'error' : 'info' })
        }
        break
      case 'tool.started': {
        // AgentEvent currently has no provider-neutral thinking payload. Keep the
        // adapter seam explicit and derive only an honest pre-tool status until it does.
        const occurredAt = Date.parse(event.occurredAt)
        const startedAt = turnStartedAt.get(payload.turnId)
        const elapsed = occurredAt - (startedAt ?? occurredAt)
        const duration = Number.isFinite(elapsed) ? Math.max(1, Math.round(elapsed / 1000)) : 1
        timeline.push({ kind: 'reasoning', id: `reasoning:${payload.toolCallId}`, turnId: payload.turnId, text: `准备调用工具：${payload.toolName}`, duration, running: false })
        timeline.push({ kind: 'tool', id: `tool:${payload.toolCallId}`, turnId: payload.turnId, toolCallId: payload.toolCallId, toolName: payload.toolName, input: payload.input, output: '', status: 'running', exitCode: null, ...(payload.streamKind ? { streamKind: payload.streamKind } : {}) })
        break
      }
      case 'tool.output.delta': {
        let tool = timeline.find(item => item.kind === 'tool' && item.toolCallId === payload.toolCallId)
        if (!tool || tool.kind !== 'tool') {
          tool = { kind: 'tool', id: `tool:${payload.toolCallId}`, turnId: payload.turnId, toolCallId: payload.toolCallId, toolName: '工具', input: null, output: '', status: 'running', exitCode: null, ...(payload.streamKind ? { streamKind: payload.streamKind } : {}) }
          timeline.push(tool)
        }
        if (payload.streamKind) tool.streamKind = payload.streamKind
        tool.output += payload.text
        break
      }
      case 'tool.finished': {
        let tool = timeline.find(item => item.kind === 'tool' && item.toolCallId === payload.toolCallId)
        if (!tool || tool.kind !== 'tool') {
          tool = { kind: 'tool', id: `tool:${payload.toolCallId}`, turnId: payload.turnId, toolCallId: payload.toolCallId, toolName: '工具', input: null, output: '', status: 'running', exitCode: null }
          timeline.push(tool)
        }
        tool.exitCode = payload.exitCode
        tool.status = payload.exitCode === null || payload.exitCode === 0 ? 'completed' : 'failed'
        break
      }
      case 'usage.updated': {
        const previous = timeline.find(item => item.kind === 'usage' && item.turnId === payload.turnId)
        if (previous?.kind === 'usage') previous.usage = payload.usage
        else timeline.push({ kind: 'usage', id: `usage:${payload.turnId}`, turnId: payload.turnId, usage: payload.usage })
        break
      }
      case 'approval.requested':
        approvals.set(payload.approvalId, { approvalId: payload.approvalId, turnId: payload.turnId, action: payload.action, reason: payload.reason })
        timeline.push({ kind: 'notice', id: `approval:${payload.approvalId}`, text: `等待审批${payload.reason ? `：${payload.reason}` : ''}`, tone: 'info' })
        break
      case 'approval.resolved': {
        const approval = approvals.get(payload.approvalId)
        approvals.delete(payload.approvalId)
        approvalHistory.push({ approvalId: payload.approvalId, turnId: payload.turnId, action: approval?.action ?? null, ...(approval?.reason ? { reason: approval.reason } : {}), decision: payload.decision })
        timeline.push({ kind: 'notice', id: `approval-resolved:${event.seq}`, text: payload.decision === 'approve' ? '审批已批准' : '审批已拒绝', tone: 'info' })
        break
      }
      case 'compaction.started':
        timeline.push({ kind: 'notice', id: `compaction:${payload.turnId}:${event.seq}`, text: `正在压缩上下文${payload.reason ? `：${payload.reason}` : ''}`, tone: 'info' })
        break
      case 'compaction.finished':
        timeline.push({ kind: 'notice', id: `compaction:${payload.turnId}:${event.seq}`, text: `上下文压缩完成${payload.summary ? `：${payload.summary}` : ''}`, tone: 'info' })
        break
      case 'model.changed':
        timeline.push({ kind: 'notice', id: `model-changed:${event.seq}`, text: `模型已切换为 ${payload.modelId}`, tone: 'info' })
        break
      case 'runtime.notice': {
        const retry = payload.retry
        const attempt = retry ? (retry.maxAttempts ? `第 ${retry.attempt}/${retry.maxAttempts} 次重试` : `第 ${retry.attempt} 次重试`) : ''
        const delay = retry?.delayMs ? `，约 ${Math.max(1, Math.round(retry.delayMs / 1000))} 秒后重试` : ''
        const detail = attempt ? `${attempt}${delay}` : ''
        timeline.push({ kind: 'notice', id: `runtime-notice:${event.seq}`, text: detail ? `${payload.message}（${detail}）` : payload.message, tone: payload.level === 'warning' ? 'error' : 'info' })
        notices.push(payload.message)
        break
      }
    }
  }
  return { messages, timeline, notices, runtimeState, activeTurnId, queuedItems: [...queued.values()].sort((a, b) => a.position - b.position), pendingApprovals: [...approvals.values()], approvalHistory }
}

export function appendPage(current: readonly JournalEventDTO[], incoming: readonly JournalEventDTO[], sessionId: string) {
  const bySeq = new Map(current.map(event => [event.seq, event]))
  for (const event of incoming) {
    if (event.sessionId !== sessionId || !Number.isInteger(event.seq) || event.seq < 1 || !event.payload || typeof event.payload.kind !== 'string') {
      throw new Error('事件契约错误：sessionId、seq 或 payload 无效。')
    }
    bySeq.set(event.seq, event)
  }
  const ordered = [...bySeq.values()].sort((a, b) => a.seq - b.seq)
  for (let index = 0; index < ordered.length; index++) {
    if (ordered[index].seq !== index + 1) throw new Error('历史存在 gap：事件序号不连续，不能展示为已同步。')
  }
  return ordered
}
