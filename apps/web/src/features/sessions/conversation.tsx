import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Bot, Check, ChevronRight, Copy, ImagePlus, Paperclip } from 'lucide-react'
import type { Api } from '../../api/client.ts'
import type { SessionDTO } from '../../api/dto.ts'
import type { ChatTimelineItem, TimelineTool } from '../../api/journal.ts'
import { timelineMessageToUIMessage } from '../../api/journal.ts'
import { Action, ActionsBar } from '../../components/ai-elements/actions.tsx'
import { Loader } from '../../components/ai-elements/loader.tsx'
import { Message, MessageContent } from '../../components/ai-elements/message.tsx'
import { PromptInput, PromptInputFooter, PromptInputSubmit, PromptInputTextarea, PromptInputTools } from '../../components/ai-elements/prompt-input.tsx'
import { Response } from '../../components/ai-elements/response.tsx'
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput, type ToolState } from '../../components/ai-elements/tool.tsx'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../components/ui/tooltip.tsx'
import { cn, copyText, selectElementText } from '../../lib/utils.ts'
import { randomId } from '../../lib/random.ts'
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
  const contentRef = useRef<HTMLDivElement>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'manual'>('idle')
  const copy = async () => {
    if (await copyText(text)) {
      setCopyState('copied')
      window.setTimeout(() => setCopyState('idle'), 1600)
      return
    }
    if (contentRef.current) selectElementText(contentRef.current)
    setCopyState('manual')
  }
  return <Message from={message.role} data-message-id={message.id} className="animate-fade-up">
    <div className={cn('flex max-w-full items-start gap-3', message.role === 'user' && 'flex-row-reverse')}>
      {message.role === 'assistant' && <span className="grid size-9 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-indigo-500/15 to-purple-500/10 text-violet-300 shadow-sm"><Bot className="size-4" /></span>}
      <div className={cn('flex min-w-0 max-w-full flex-col gap-1', message.role === 'user' && 'items-end')}>
        <MessageContent><div ref={contentRef}>{text ? <Response>{text}</Response> : <span className="flex items-center gap-2 text-muted-foreground"><Loader />等待输出…</span>}</div>
          <div className={cn('mt-1.5 flex items-center gap-1.5', message.role === 'user' && 'justify-end')}><MessageStatus status={entry.status} />{message.role === 'user' && onOpenContext && <button type="button" onClick={onOpenContext} className="rounded-lg p-1 text-muted-foreground/50 transition-all hover:bg-white/10 hover:text-foreground" aria-label="查看会话信息"><ChevronRight className="size-3.5" /></button>}</div>
        </MessageContent>
        {text && <ActionsBar aria-label="消息操作"><Action onClick={() => void copy()} aria-label="复制消息内容" title={copyState === 'manual' ? '已全选，请 Ctrl+C / 长按复制' : copyState === 'copied' ? '已复制' : '复制消息内容'}>{copyState === 'copied' ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}</Action>{copyState === 'manual' && <span role="status" className="text-xs text-muted-foreground">已全选，请 Ctrl+C / 长按复制</span>}</ActionsBar>}
      </div>
    </div>
  </Message>
}

const messageStatusLabels: Record<string, string> = { queued: '排队中', started: '正在处理', running: '正在回复', completed: '已完成', cancelled: '已取消', rejected: '已拒绝', failed: '执行失败' }
function MessageStatus({ status }: { status: string }) {
  if (status === 'running' || status === 'started') return <span className="inline-flex items-center gap-2 text-xs text-muted-foreground" role="status" aria-label="正在回复"><Loader className="size-3.5" />正在回复</span>
  return <small role="status" className={cn('text-[10px]', status === 'failed' || status === 'rejected' ? 'text-red-300' : 'text-muted-foreground')}>{messageStatusLabels[status] ?? '等待确认'}</small>
}

type ComposerNotice = { tone: 'info' | 'error'; text: string } | null
const slashCommands = [
  { name: '/compact', label: '压缩上下文', description: '请求 Agent 压缩当前会话上下文' },
  { name: '/stop', label: '停止回合', description: '停止当前正在运行的回合' },
  { name: '/help', label: '命令帮助', description: '查看输入区支持的命令' },
] as const

export function Composer({ api, controller, session, activeTurnId = null, canSend, blockedReason, confirmedIds }: { api?: Api; controller: SubmissionController; session: SessionDTO; activeTurnId?: string | null; canSend: boolean; blockedReason: string; confirmedIds: string[] }) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot)
  const [notice, setNotice] = useState<ComposerNotice>(null)
  const [unsupportedNotice, setUnsupportedNotice] = useState<string | null>(null)
  const [commandPending, setCommandPending] = useState<'compact' | 'stop' | null>(null)
  useEffect(() => { controller.confirm(confirmedIds) }, [controller, confirmedIds.join(',')])
  canSend = canSend && session.access?.canWrite !== false && session.sendCapability?.allowed === true
  blockedReason = session.access?.canWrite === false ? '当前账号只有查看权限' : session.sendCapability?.allowed === false ? session.sendCapability.reason : !session.sendCapability ? '暂时无法确认发送权限' : blockedReason
  const running = session.runtimeState === 'running' || Boolean(activeTurnId)
  const canControl = session.access?.canControl ?? session.canManage
  const retry = state.attempt?.content === state.draft.trim()
  const hint = state.pending ? '正在发送…' : state.receipt ? '消息已送达，等待 Agent 回复' : canSend ? running ? 'Agent 正在运行，新消息将进入队列' : 'Enter 发送，Shift+Enter 换行' : `${blockedReason}，草稿仍会保留`
  const commandQuery = state.draft.startsWith('/') ? state.draft.trim().toLowerCase() : ''
  const visibleCommands = commandQuery ? slashCommands.filter(command => command.name.startsWith(commandQuery)) : []
  const showUnsupported = (kind: '文件' | '图片') => {
    const text = `即将支持：${kind}将上传到工作区`
    setUnsupportedNotice(text)
    setNotice({ tone: 'info', text })
  }
  const stop = async () => {
    const turnId = activeTurnId || session.activeTurnId
    if (!api || !turnId || !canControl || commandPending) {
      setNotice({ tone: 'error', text: turnId ? '当前无法停止回合，请检查连接或权限。' : '当前没有可停止的回合。' })
      return
    }
    setCommandPending('stop'); setNotice({ tone: 'info', text: '正在提交停止请求…' })
    try {
      await api.stopTurn(session.id, turnId, randomId())
      setNotice({ tone: 'info', text: '停止请求已提交，等待 Worker 回执。' })
    } catch (error) { setNotice({ tone: 'error', text: error instanceof Error ? error.message : '停止请求失败，请重试。' }) }
    finally { setCommandPending(null) }
  }
  const compact = async () => {
    if (!api || !canControl || running || commandPending) {
      setNotice({ tone: 'error', text: running ? '请先停止当前回合，再压缩上下文。' : '当前无法压缩上下文，请检查连接或权限。' })
      return
    }
    setCommandPending('compact'); setNotice({ tone: 'info', text: '正在提交上下文压缩请求…' })
    try {
      const commandId = randomId()
      await api.invokeRuntimeCommand(session.id, { commandId, operationId: randomId(), name: 'compact' })
      setNotice({ tone: 'info', text: '压缩请求已提交，等待 Worker 执行。' })
    } catch (error) { setNotice({ tone: 'error', text: error instanceof Error ? error.message : '压缩请求失败，请重试。' }) }
    finally { setCommandPending(null) }
  }
  const executeCommand = (name: typeof slashCommands[number]['name']) => {
    controller.edit('')
    if (name === '/compact') void compact()
    else if (name === '/stop') void stop()
    else setNotice({ tone: 'info', text: '可用命令：/compact 压缩上下文；/stop 停止当前回合；/help 显示本帮助。Enter 发送，Shift+Enter 换行。' })
  }
  return <div className="conversation-composer shrink-0 px-3 py-3 sm:px-6 sm:py-4"><div className="conversation-content mx-auto max-w-4xl"><PromptInput className="relative" onSubmit={() => { if (canSend && !state.pending && state.draft.trim() && !state.draft.startsWith('/')) void controller.send() }}>
    {visibleCommands.length > 0 && <div className="absolute inset-x-0 bottom-full z-20 mb-2 overflow-hidden rounded-xl border border-border bg-popover p-1.5 shadow-lg" role="listbox" aria-label="斜杠命令">{visibleCommands.map(command => <button key={command.name} type="button" role="option" className="flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left hover:bg-accent focus:bg-accent focus:outline-none" onClick={() => executeCommand(command.name)}><code className="text-sm text-violet-300">{command.name}</code><span><strong className="block text-sm font-medium">{command.label}</strong><small className="text-muted-foreground">{command.description}</small></span></button>)}</div>}
    {unsupportedNotice && <button type="button" role="status" onClick={() => setUnsupportedNotice(null)} className="absolute bottom-14 left-3 z-10 rounded-xl border border-border bg-popover px-3 py-2 text-left text-xs text-popover-foreground shadow-lg">{unsupportedNotice}<span className="ml-2 text-muted-foreground">点击关闭</span></button>}
    <label className="sr-only" htmlFor={`session-prompt-${session.id}`}>消息内容</label>
    <PromptInputTextarea id={`session-prompt-${session.id}`} value={state.draft} onChange={event => { controller.edit(event.target.value); setNotice(null); setUnsupportedNotice(null) }} maxLength={16_000} aria-invalid={Boolean(state.error) || undefined} placeholder={canSend ? '给 Agent 发送消息，输入 / 查看命令…' : `${blockedReason}，可以先编辑草稿`} />
    <PromptInputFooter><PromptInputTools className="flex-wrap">
      <TooltipProvider delayDuration={250}><Tooltip><TooltipTrigger asChild><button type="button" aria-disabled="true" onClick={() => showUnsupported('文件')} className="grid size-8 place-items-center rounded-lg text-muted-foreground opacity-60 hover:bg-accent hover:text-foreground" aria-label="添加附件（即将支持）"><Paperclip className="size-4" /></button></TooltipTrigger><TooltipContent>即将支持：文件将上传到工作区</TooltipContent></Tooltip><Tooltip><TooltipTrigger asChild><button type="button" aria-disabled="true" onClick={() => showUnsupported('图片')} className="grid size-8 place-items-center rounded-lg text-muted-foreground opacity-60 hover:bg-accent hover:text-foreground" aria-label="添加图片（即将支持）"><ImagePlus className="size-4" /></button></TooltipTrigger><TooltipContent>即将支持：图片将上传到工作区</TooltipContent></Tooltip></TooltipProvider>
      <span className="truncate rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground" title="会话创建后，智能体与模型保持固定">{session.agentKey} · {session.modelId || 'Agent 默认模型'}</span><span role={state.error || notice?.tone === 'error' ? 'alert' : 'status'} className={cn('min-w-0 flex-1 truncate text-xs text-muted-foreground', (state.error || notice?.tone === 'error') && 'text-red-300')}>{state.error || notice?.text || hint}</span></PromptInputTools>
      <PromptInputSubmit status={running || commandPending === 'stop' ? 'streaming' : state.pending ? 'submitted' : state.error ? 'error' : 'ready'} onStop={running ? () => void stop() : undefined} disabled={running ? !api || !canControl || commandPending === 'stop' : !canSend || state.pending || !state.draft.trim() || state.draft.startsWith('/')} title={running ? '停止当前回合' : retry ? '重试发送' : '发送消息'} />
    </PromptInputFooter>
  </PromptInput></div></div>
}

export function OptimisticMessages({ controller, confirmedIds }: { controller: SubmissionController; confirmedIds: string[] }) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot)
  return <>{state.echoes.filter(item => !confirmedIds.includes(item.messageId)).map(item => <Message key={item.messageId} from="user" data-message-id={item.messageId}><MessageContent><Response>{item.content}</Response><small role="status">{state.pending && state.attempt?.messageId === item.messageId ? '正在提交…' : '等待会话历史确认'}</small></MessageContent></Message>)}</>
}
