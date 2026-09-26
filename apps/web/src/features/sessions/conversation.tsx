import { useEffect, useSyncExternalStore } from 'react'
import { Bot, ChevronRight } from 'lucide-react'
import type { SessionDTO } from '../../api/dto.ts'
import type { ChatTimelineItem, TimelineTool } from '../../api/journal.ts'
import { timelineMessageToUIMessage } from '../../api/journal.ts'
import { MarkdownMessage } from '../../components/markdown-message.ts'
import { Message, MessageContent } from '../../components/ai-elements/message.tsx'
import { PromptInput, PromptInputFooter, PromptInputSubmit, PromptInputTextarea, PromptInputTools } from '../../components/ai-elements/prompt-input.tsx'
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput, type ToolState } from '../../components/ai-elements/tool.tsx'
import { cn } from '../../lib/utils.ts'
import { SubmissionController } from './submission.ts'

const formatUsageNumber = (value: number | undefined) => value === undefined ? null : new Intl.NumberFormat('zh-CN').format(value)
const formatToolValue = (value: unknown) => {
  if (value == null || value === '') return ''
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}
const toolState = (tool: TimelineTool): ToolState => tool.status === 'running' ? 'input-available' : tool.status === 'completed' ? 'output-available' : tool.status === 'cancelled' ? 'output-denied' : 'output-error'

export function TimelineEntry({ entry, onOpenContext }: { entry: ChatTimelineItem; onOpenContext?: () => void }) {
  if (entry.kind === 'usage') {
    const parts = [
      entry.usage.completeness === 'partial' ? '部分统计' : null,
      formatUsageNumber(entry.usage.inputTokens) && `输入 ${formatUsageNumber(entry.usage.inputTokens)}`,
      formatUsageNumber(entry.usage.outputTokens) && `输出 ${formatUsageNumber(entry.usage.outputTokens)}`,
      formatUsageNumber(entry.usage.cacheReadTokens) && `缓存读取 ${formatUsageNumber(entry.usage.cacheReadTokens)}`,
      formatUsageNumber(entry.usage.cacheWriteTokens) && `缓存写入 ${formatUsageNumber(entry.usage.cacheWriteTokens)}`,
      formatUsageNumber(entry.usage.totalTokens) && `总计 ${formatUsageNumber(entry.usage.totalTokens)}`,
      entry.usage.costUsd === undefined ? null : `费用 ${entry.usage.currency ?? 'USD'} $${entry.usage.costUsd.toFixed(4)}`,
    ].filter(Boolean)
    return <div className="ml-12 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground/70" aria-label="运行用量">{parts.length ? parts.map(part => <span key={part} className="rounded-lg bg-white/5 px-2.5 py-1">{part}</span>) : <span>暂无用量数据</span>}</div>
  }
  if (entry.kind === 'notice') return <div role={entry.tone === 'error' ? 'alert' : 'status'} className={cn('ml-12 rounded-2xl px-4 py-3 text-sm shadow-sm', entry.tone === 'error' ? 'border border-red-500/30 bg-red-500/15 text-red-200' : 'border border-border bg-card/70 text-muted-foreground')}><p className="whitespace-pre-wrap break-words leading-6">{entry.text}</p></div>
  if (entry.kind === 'tool') {
    const input = formatToolValue(entry.input)
    const output = entry.output || (!input ? '等待工具输出…' : '')
    return <div className="ml-12"><Tool defaultOpen={entry.status === 'running'}><ToolHeader title={entry.exitCode == null ? entry.toolName : `${entry.toolName} · exit ${entry.exitCode}`} state={toolState(entry)} />
      <ToolContent>{input && <ToolInput input={entry.input} />}<ToolOutput output={output} errorText={entry.status === 'failed' ? output || '工具执行失败' : undefined} /></ToolContent>
    </Tool></div>
  }
  return <TimelineMessage entry={entry} onOpenContext={onOpenContext} />
}

function TimelineMessage({ entry, onOpenContext }: { entry: Extract<ChatTimelineItem, { kind: 'message' }>; onOpenContext?: () => void }) {
  const message = timelineMessageToUIMessage(entry)
  const text = message.parts.filter(part => part.type === 'text').map(part => part.text).join('')
  return <Message from={message.role} data-message-id={message.id} className="animate-fade-up">
    {message.role === 'assistant' && <span className="grid size-9 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-indigo-500/15 to-purple-500/10 text-violet-300 shadow-sm"><Bot className="size-4" /></span>}
    <MessageContent>{text ? <MarkdownMessage text={text} /> : <p className="text-muted-foreground">等待输出…</p>}
      <div className={cn('mt-1.5 flex items-center gap-1.5', message.role === 'user' && 'justify-end')}><MessageStatus status={entry.status} />{message.role === 'user' && onOpenContext && <button type="button" onClick={onOpenContext} className="rounded-lg p-1 text-muted-foreground/50 transition-all hover:bg-white/10 hover:text-foreground" aria-label="查看会话信息"><ChevronRight className="size-3.5" /></button>}</div>
    </MessageContent>
  </Message>
}

const messageStatusLabels: Record<string, string> = { queued: '排队中', started: '正在处理', running: '正在回复', completed: '已完成', cancelled: '已取消', rejected: '已拒绝', failed: '执行失败' }
function MessageStatus({ status }: { status: string }) {
  if (status === 'running' || status === 'started') return <span className="inline-flex items-center gap-1" role="status" aria-label="正在回复">{[0, 1, 2].map(index => <span key={index} className={cn('size-1.5 animate-bounce rounded-full bg-violet-300/80', index === 1 && '[animation-delay:150ms]', index === 2 && '[animation-delay:300ms]')} />)}</span>
  return <small role="status" className={cn('text-[10px]', status === 'failed' || status === 'rejected' ? 'text-red-300' : 'text-muted-foreground')}>{messageStatusLabels[status] ?? '等待确认'}</small>
}

export function Composer({ controller, session, canSend, blockedReason, confirmedIds }: { controller: SubmissionController; session: SessionDTO; canSend: boolean; blockedReason: string; confirmedIds: string[] }) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot)
  useEffect(() => { controller.confirm(confirmedIds) }, [controller, confirmedIds.join(',')])
  canSend = canSend && session.access?.canWrite !== false && session.sendCapability?.allowed === true
  blockedReason = session.access?.canWrite === false ? '当前账号只有查看权限' : session.sendCapability?.allowed === false ? session.sendCapability.reason : !session.sendCapability ? '暂时无法确认发送权限' : blockedReason
  const retry = state.attempt?.content === state.draft.trim()
  const hint = state.pending ? '正在发送…' : state.receipt ? '消息已送达，等待 Agent 回复' : canSend ? session.runtimeState === 'running' ? 'Agent 正在运行，新消息将进入队列' : 'Enter 发送，Shift+Enter 换行' : `${blockedReason}，草稿仍会保留`
  return <div className="conversation-composer shrink-0 px-3 py-3 sm:px-6 sm:py-4"><div className="conversation-content mx-auto max-w-4xl"><PromptInput onSubmit={() => { if (canSend && !state.pending && state.draft.trim()) void controller.send() }}>
    <label className="sr-only" htmlFor={`session-prompt-${session.id}`}>消息内容</label>
    <PromptInputTextarea id={`session-prompt-${session.id}`} value={state.draft} onChange={event => controller.edit(event.target.value)} maxLength={16_000} aria-invalid={Boolean(state.error) || undefined} placeholder={canSend ? '给 Agent 发送消息…' : `${blockedReason}，可以先编辑草稿`} />
    <PromptInputFooter><PromptInputTools><span className="truncate rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground" title="会话创建后，智能体与模型保持固定">{session.agentKey} · {session.modelId || 'Agent 默认模型'}</span><span role={state.error ? 'alert' : 'status'} className={cn('min-w-0 truncate text-xs text-muted-foreground', state.error && 'text-red-300')}>{state.error || hint}</span></PromptInputTools>
      <PromptInputSubmit status={state.pending ? 'submitted' : state.error ? 'error' : 'ready'} disabled={!canSend || state.pending || !state.draft.trim()} title={retry ? '重试发送' : '发送消息'} />
    </PromptInputFooter>
  </PromptInput></div></div>
}

export function OptimisticMessages({ controller, confirmedIds }: { controller: SubmissionController; confirmedIds: string[] }) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot)
  return <>{state.echoes.filter(item => !confirmedIds.includes(item.messageId)).map(item => <Message key={item.messageId} from="user" data-message-id={item.messageId}><MessageContent><MarkdownMessage text={item.content} /><small role="status">{state.pending && state.attempt?.messageId === item.messageId ? '正在提交…' : '等待会话历史确认'}</small></MessageContent></Message>)}</>
}
