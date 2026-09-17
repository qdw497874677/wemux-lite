import type { JournalEventDTO, RuntimeState, RuntimeUsageDTO } from './dto'

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
}

export interface TimelineNotice {
  kind: 'notice'
  id: string
  text: string
  tone: 'info' | 'error'
}

export interface TimelineUsage {
  kind: 'usage'
  id: string
  turnId: string
  usage: RuntimeUsageDTO
}

export interface QueuedItem { commandId: string; messageId: string; content: string; position: number }
export interface PendingApproval { approvalId: string; turnId: string; action: unknown; reason?: string }

export type ChatTimelineItem = TimelineMessage | TimelineTool | TimelineNotice | TimelineUsage

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
  const turnMessages = new Map<string, string>()

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
        const message = messages.find(item => item.id === payload.messageId)
        if (message) message.status = 'started'
        const entry = timeline.find(item => item.kind === 'message' && item.id === payload.messageId)
        if (entry?.kind === 'message') entry.status = 'started'
        assistantMessage(payload.turnId)
        runtimeState = 'running'
        break
      }
      case 'assistant.text.delta': {
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
          notices.push(payload.failure.message)
          timeline.push({ kind: 'notice', id: `failure:${payload.turnId}:${event.seq}`, text: payload.failure.message, tone: 'error' })
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
      case 'tool.started':
        timeline.push({ kind: 'tool', id: `tool:${payload.toolCallId}`, turnId: payload.turnId, toolCallId: payload.toolCallId, toolName: payload.toolName, input: payload.input, output: '', status: 'running', exitCode: null })
        break
      case 'tool.output.delta': {
        let tool = timeline.find(item => item.kind === 'tool' && item.toolCallId === payload.toolCallId)
        if (!tool || tool.kind !== 'tool') {
          tool = { kind: 'tool', id: `tool:${payload.toolCallId}`, turnId: payload.turnId, toolCallId: payload.toolCallId, toolName: '工具', input: null, output: '', status: 'running', exitCode: null }
          timeline.push(tool)
        }
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
      case 'approval.resolved':
        approvals.delete(payload.approvalId)
        timeline.push({ kind: 'notice', id: `approval-resolved:${event.seq}`, text: payload.decision === 'approve' ? '审批已批准' : '审批已拒绝', tone: 'info' })
        break
      case 'compaction.started':
        timeline.push({ kind: 'notice', id: `compaction:${payload.turnId}:${event.seq}`, text: `正在压缩上下文${payload.reason ? `：${payload.reason}` : ''}`, tone: 'info' })
        break
      case 'compaction.finished':
        timeline.push({ kind: 'notice', id: `compaction:${payload.turnId}:${event.seq}`, text: `上下文压缩完成${payload.summary ? `：${payload.summary}` : ''}`, tone: 'info' })
        break
    }
  }
  return { messages, timeline, notices, runtimeState, activeTurnId, queuedItems: [...queued.values()].sort((a, b) => a.position - b.position), pendingApprovals: [...approvals.values()] }
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
