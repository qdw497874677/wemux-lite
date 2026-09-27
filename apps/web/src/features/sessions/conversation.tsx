import { useEffect, useRef, useState, useSyncExternalStore, type MutableRefObject } from 'react'
import { Bot, Check, ChevronDown, ChevronRight, Copy, FilePenLine, FileSearch, Globe, Pencil, RotateCcw, Search, Terminal, Trash2 } from 'lucide-react'
import type { Api } from '../../api/client.ts'
import type { AgentDTO, SessionDTO } from '../../api/dto.ts'
import type { ChatTimelineItem, TimelineTool } from '../../api/journal.ts'
import { timelineMessageToUIMessage } from '../../api/journal.ts'
import { Action, ActionsBar } from '../../components/ai-elements/actions.tsx'
import { Loader } from '../../components/ai-elements/loader.tsx'
import { Attachment, AttachmentInfo, AttachmentPreview, AttachmentRemove, Attachments } from '../../components/ai-elements/attachments.tsx'
import { Message, MessageContent } from '../../components/ai-elements/message.tsx'
import { PromptInput, PromptInputActionAddAttachments, PromptInputActionMenu, PromptInputActionMenuButton, PromptInputActionMenuContent, PromptInputActionMenuTrigger, PromptInputBody, PromptInputFooter, PromptInputHeader, PromptInputSubmit, PromptInputTextarea, PromptInputTools, usePromptInputAttachments, type PromptInputMessage } from '../../components/ai-elements/prompt-input.tsx'
import { Reasoning, ReasoningContent, ReasoningTrigger } from '../../components/ai-elements/reasoning.tsx'
import { Response } from '../../components/ai-elements/response.tsx'
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput, type ToolState } from '../../components/ai-elements/tool.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover.tsx'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../components/ui/tooltip.tsx'
import { ContextWindowMeter, type ContextWindowUsage } from '../../components/context-window-meter.tsx'
import { cn, copyText, selectElementText } from '../../lib/utils.ts'
import { formatTimelineTime, formatTimelineTimestampTitle } from '../../lib/conversation-timeline.ts'
import { randomId } from '../../lib/random.ts'
import { useCompactAction } from './cluster-controls.tsx'
import { SubmissionController } from './submission.ts'
import { normalizeWorkLogEntry, type WorkLogEntry } from './work-log.ts'
import { terminalContextText, useTerminalContext } from '../terminal/terminal-context.ts'
import { commandGroups, commandsForAgent, compactRoute, isAgentCommandInput, type SlashCommand } from './slash-commands.ts'

const formatUsageNumber = (value: number | undefined) => value === undefined ? null : new Intl.NumberFormat('zh-CN').format(value)
const formatToolValue = (value: unknown) => {
  if (value == null || value === '') return ''
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}
const toolState = (tool: TimelineTool): ToolState => tool.status === 'running' ? 'input-available' : tool.status === 'completed' ? 'output-available' : tool.status === 'cancelled' ? 'output-denied' : 'output-error'
const workLogIcons: Record<NonNullable<WorkLogEntry['action']>, typeof Terminal> = { command: Terminal, read: FileSearch, edit: FilePenLine, browser: Globe, search: Search }

export type MessageActions = { onEdit?: (text: string) => void; onRetry?: (text: string, messageId: string) => void; onHide?: (messageId: string) => void }

export function TimelineTimestamp({ timestamp, className }: { timestamp?: string; className?: string }) {
  const time = formatTimelineTime(timestamp)
  const title = formatTimelineTimestampTitle(timestamp)
  if (!time || !title) return null
  return <time dateTime={timestamp} title={title} className={cn('text-xs text-muted-foreground/60 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100', className)}>{time}</time>
}

export function useMessageActions(controller: SubmissionController, sessionId: string, enabled = true) {
  const [hiddenMessageIds, setHiddenMessageIds] = useState<Set<string>>(() => new Set())
  const [localNotice, setLocalNotice] = useState('')
  useEffect(() => { setHiddenMessageIds(new Set()); setLocalNotice('') }, [sessionId])
  const focusComposer = () => window.requestAnimationFrame(() => document.getElementById(`session-prompt-${sessionId}`)?.focus())
  const messageActions: MessageActions = {
    ...(enabled ? {
      onEdit: (text: string) => { controller.prefillForEdit(text); focusComposer() },
      onRetry: (text: string, messageId: string) => {
        if (controller.snapshot().attempt?.messageId === messageId) void controller.retryAttempt(messageId)
        else void controller.resendAsNew(text)
        focusComposer()
      },
    } : {}),
    onHide: (messageId: string) => {
      setHiddenMessageIds(current => new Set(current).add(messageId))
      setLocalNotice('，； Journal 。')
    },
  }
  return { hiddenMessageIds, localNotice, messageActions }
}

export function TimelineEntry({ entry, onOpenContext, messageActions }: { entry: ChatTimelineItem; onOpenContext?: () => void; messageActions?: MessageActions }) {
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
    return <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground/60" aria-label="运行用量">{parts.length ? parts.map(part => <span key={part} className="rounded-md bg-accent/45 px-2 py-0.5">{part}</span>) : <span>暂无用量数据</span>}</div>
  }
  if (entry.kind === 'notice') return <div role={entry.tone === 'error' ? 'alert' : 'status'} className={cn('rounded-xl px-3 py-2.5 text-sm', entry.tone === 'error' ? 'border border-red-500/30 bg-red-500/10 text-red-200' : 'border border-border/70 bg-card/55 text-muted-foreground')}><p className="whitespace-pre-wrap break-words leading-6">{entry.text}</p></div>
  if (entry.kind === 'reasoning') return <div><Reasoning duration={entry.duration}><ReasoningTrigger duration={entry.duration} running={entry.running} /><ReasoningContent>{entry.text}</ReasoningContent></Reasoning></div>
  if (entry.kind === 'tool') {
    const presentation = normalizeWorkLogEntry(entry)
    const Icon = presentation.action ? workLogIcons[presentation.action] : Terminal
    const input = formatToolValue(entry.input)
    const output = entry.output || (!input ? '等待工具输出…' : '')
    return <div className={cn('group rounded-xl', presentation.tone === 'error' && 'border border-red-500/30 bg-red-500/10')} tabIndex={entry.timestamp ? 0 : undefined}><Tool defaultOpen={entry.status === 'running'}><div className="flex items-center gap-2"><div className="min-w-0 flex-1"><ToolHeader title={presentation.toolTitle} state={toolState(entry)} icon={<Icon className={cn('size-4', presentation.tone === 'error' && 'text-red-300')} />} /></div><TimelineTimestamp timestamp={entry.timestamp} className="mr-3 shrink-0" /></div>
      <ToolContent>{presentation.detail && <p className={cn('mb-2 whitespace-pre-wrap break-all text-xs text-muted-foreground', presentation.tone === 'error' && 'text-red-200')}>{presentation.detail}</p>}{presentation.changedFiles?.length ? <ul className="mb-2 space-y-1 text-xs text-muted-foreground" aria-label="变更文件">{presentation.changedFiles.map(file => <li key={file} className="rounded-md bg-muted/60 px-2 py-1 font-mono">{file}</li>)}</ul> : null}{input && <ToolInput input={entry.input} />}<ToolOutput output={output} errorText={presentation.tone === 'error' ? output || '工具执行失败' : undefined} /></ToolContent>
    </Tool></div>
  }
  return <TimelineMessage entry={entry} onOpenContext={onOpenContext} messageActions={messageActions} />
}

function TimelineMessage({ entry, onOpenContext, messageActions }: { entry: Extract<ChatTimelineItem, { kind: 'message' }>; onOpenContext?: () => void; messageActions?: MessageActions }) {
  const message = timelineMessageToUIMessage(entry)
  const text = message.parts.filter(part => part.type === 'text').map(part => part.text).join('')
  const contentRef = useRef<HTMLDivElement>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'manual'>('idle')
  const retryable = message.role === 'user' && (entry.status === 'failed' || entry.status === 'rejected' || entry.status === 'cancelled')
  const copy = async () => {
    if (await copyText(text)) {
      setCopyState('copied')
      window.setTimeout(() => setCopyState('idle'), 1600)
      return
    }
    if (contentRef.current) selectElementText(contentRef.current)
    setCopyState('manual')
  }
  return <Message from={message.role} data-message-id={message.id} className="group animate-fade-up" tabIndex={entry.timestamp ? 0 : undefined}>
    <div className={cn('flex max-w-full items-start gap-2.5', message.role === 'user' && 'flex-row-reverse')}>
      {message.role === 'assistant' && <span className="mt-1 grid size-7 shrink-0 place-items-center rounded-lg bg-accent/70 text-muted-foreground"><Bot className="size-3.5" /></span>}
      <div className={cn('flex min-w-0 max-w-full flex-1 flex-col gap-1', message.role === 'user' && 'items-end')}>
        <MessageContent><div ref={contentRef}>{text ? <Response>{text}</Response> : <span className="flex items-center gap-2 text-muted-foreground"><Loader />等待输出…</span>}</div>
          <div className={cn('mt-1.5 flex items-center gap-1.5', message.role === 'user' && 'justify-end')}><MessageStatus status={entry.status} />{message.role === 'user' && onOpenContext && <button type="button" onClick={onOpenContext} className="rounded-lg p-1 text-muted-foreground/50 transition-all hover:bg-white/10 hover:text-foreground" aria-label="查看会话信息"><ChevronRight className="size-3.5" /></button>}</div>
        </MessageContent>
        <TimelineTimestamp timestamp={entry.timestamp} className={message.role === 'user' ? 'self-end' : 'self-start'} />
        {text && <ActionsBar aria-label="">
          {message.role === 'user' && !retryable && messageActions?.onEdit && <Action onClick={() => messageActions.onEdit?.(text)} aria-label="" title=""><Pencil className="size-3.5" /></Action>}
          {retryable && messageActions?.onRetry && <Action onClick={() => messageActions.onRetry?.(text, entry.id)} aria-label="" title=""><RotateCcw className="size-3.5" /></Action>}
          <Action onClick={() => void copy()} aria-label="" title={copyState === 'manual' ? ' Ctrl+C / ' : copyState === 'copied' ? '' : ''}>{copyState === 'copied' ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}</Action>
          {messageActions?.onHide && <Action onClick={() => messageActions.onHide?.(entry.id)} aria-label="" title="， Journal"><Trash2 className="size-3.5" /></Action>}
          {copyState === 'manual' && <span role="status" className="text-xs text-muted-foreground"> Ctrl+C / </span>}
        </ActionsBar>}
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
export function Composer({ api, controller, session, agent, activeTurnId = null, canSend, blockedReason, confirmedIds }: { api?: Api; controller: SubmissionController; session: SessionDTO; agent?: AgentDTO; activeTurnId?: string | null; canSend: boolean; blockedReason: string; confirmedIds: string[] }) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot)
  const submitRef = useRef<(message: PromptInputMessage) => void>(() => undefined)
  const sendWithAttachmentsRef = useRef(false)
  const [notice, setNotice] = useState<ComposerNotice>(null)
  const [commandPending, setCommandPending] = useState<'stop' | null>(null)
  const compactAction = useCompactAction(api, session.id)
  const terminalContext = useTerminalContext(session.id)
  useEffect(() => { controller.confirm(confirmedIds) }, [controller, confirmedIds.join(',')])
  canSend = canSend && session.access?.canWrite !== false && session.sendCapability?.allowed === true
  blockedReason = session.access?.canWrite === false ? '当前账号只有查看权限' : session.sendCapability?.allowed === false ? session.sendCapability.reason : !session.sendCapability ? '暂时无法确认发送权限' : blockedReason
  const running = session.runtimeState === 'running' || Boolean(activeTurnId)
  const canControl = session.access?.canControl ?? session.canManage
  const retry = state.attempt?.content === state.draft.trim()
  const defaultHint = state.pending ? '正在发送…' : state.receipt ? '消息已送达，等待 Agent 回复' : canSend ? running ? 'Agent 正在运行，新消息将进入队列' : 'Enter 发送，Shift+Enter 换行' : `${blockedReason}，草稿仍会保留`
  const hint = compactAction.action?.status === 'pending' ? '正在压缩上下文…' : compactAction.action?.status === 'error' ? '压缩失败，输入 /compact 重试' : defaultHint
  const commandQuery = state.draft.startsWith('/') ? state.draft.trim().toLowerCase() : ''
  const visibleCommandGroups = commandGroups(commandsForAgent(agent), commandQuery)
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
  const metadataUsage = session.customMetadata?.wemux?.usage
  const contextUsage: ContextWindowUsage | null = metadataUsage && (metadataUsage.usedTokens ?? metadataUsage.totalTokens) !== undefined && (metadataUsage.maxTokens ?? metadataUsage.contextWindow) !== undefined ? {
    usedTokens: metadataUsage.usedTokens ?? metadataUsage.totalTokens!,
    maxTokens: metadataUsage.maxTokens ?? metadataUsage.contextWindow!,
    ...(metadataUsage.compactThreshold !== undefined ? { compactThreshold: metadataUsage.compactThreshold } : {}),
  } : null
  const compact = async () => {
    if (!api || !canControl || running || commandPending) {
      setNotice({ tone: 'error', text: running ? '请先停止当前回合，再压缩上下文。' : '当前无法压缩上下文，请检查连接或权限。' })
      return
    }
    setNotice(null)
    await compactAction.compact()
  }
  const sendNativeCommand = (content: string) => {
    if (!canSend || state.pending) return
    controller.edit(content)
    void controller.send()
  }
  const executeCommand = (command: SlashCommand) => {
    if (command.group === 'agent') { sendNativeCommand(command.name); return }
    controller.edit('')
    if (command.name === '/compact') {
      if (compactRoute(agent) === 'slash-command') sendNativeCommand('/compact')
      else void compact()
    } else if (command.name === '/stop') void stop()
    else setNotice({ tone: 'info', text: '平台命令：/compact 压缩上下文；/stop 停止当前回合；/help 显示本帮助。Agent 原生命令会作为普通消息发送。Enter 发送，Shift+Enter 换行。' })
  }
  return <div className="conversation-composer shrink-0 px-3 py-3 sm:px-4 sm:py-4"><div className="conversation-content mx-auto max-w-[var(--chat-max-width)]"><PromptInput className="relative" onSubmit={message => submitRef.current(message)}>
    <ComposerContents api={api} session={session} agent={agent} controller={controller} state={state} canSend={canSend} blockedReason={blockedReason} running={running} canControl={canControl} retry={retry} hint={hint} notice={notice} setNotice={setNotice} commandPending={commandPending} stop={stop} visibleCommandGroups={visibleCommandGroups} executeCommand={executeCommand} submitRef={submitRef} sendWithAttachmentsRef={sendWithAttachmentsRef} terminalContext={terminalContext} contextUsage={contextUsage} compact={compact} compactDisabled={!api || !canControl || running || Boolean(commandPending)} />
  </PromptInput></div></div>
}

function ComposerContents({ api, session, agent, controller, state, canSend, blockedReason, running, canControl, retry, hint, notice, setNotice, commandPending, stop, visibleCommandGroups, executeCommand, submitRef, sendWithAttachmentsRef, terminalContext, contextUsage, compact, compactDisabled }: { api?: Api; session: SessionDTO; agent?: AgentDTO; controller: SubmissionController; state: ReturnType<SubmissionController['snapshot']>; canSend: boolean; blockedReason: string; running: boolean; canControl: boolean; retry: boolean; hint: string; notice: ComposerNotice; setNotice: (notice: ComposerNotice) => void; commandPending: 'stop' | null; stop: () => Promise<void>; visibleCommandGroups: ReturnType<typeof commandGroups>; executeCommand: (command: SlashCommand) => void; submitRef: MutableRefObject<(message: PromptInputMessage) => void>; sendWithAttachmentsRef: MutableRefObject<boolean>; terminalContext: ReturnType<typeof useTerminalContext>; contextUsage: ContextWindowUsage | null; compact: () => Promise<void>; compactDisabled: boolean }) {
  const attachments = usePromptInputAttachments()
  const submit = async (message: PromptInputMessage) => {
    if (!canSend || state.pending || (state.draft.startsWith('/') && !isAgentCommandInput(agent, state.draft))) return
    const textParts: string[] = []
    let skipped = 0
    for (const attachment of message.files ?? []) {
      if (isInlineTextAttachment(attachment.file) && attachment.size < 10 * 1024) {
        const content = await attachment.file.text()
        textParts.push(`附件：${attachment.name}\n\n\`\`\`${attachmentLanguage(attachment.name)}\n${content}\n\`\`\``)
      } else skipped++
    }
    const terminalText = terminalContext.active ? terminalContextText(terminalContext, 20) : ''
    const content = [message.text.trim(), ...textParts, terminalText].filter(Boolean).join('\n\n')
    if (skipped) setNotice({ tone: 'info', text: '附件将随后支持上传到工作区；本次仅发送文本和小于 10KB 的文本附件。' })
    if (!content) return
    controller.edit(content)
    sendWithAttachmentsRef.current = true
    try { await controller.send() }
    finally { sendWithAttachmentsRef.current = false }
    if (controller.snapshot().draft === '') attachments.clear()
  }
  submitRef.current = message => { void submit(message) }
  return <>
    {visibleCommandGroups.length > 0 && <div className="absolute inset-x-0 bottom-full z-20 mb-2 overflow-hidden rounded-xl border border-border bg-popover p-1.5 shadow-lg" role="listbox" aria-label="斜杠命令">{visibleCommandGroups.map(group => <section key={group.key} aria-label={group.label}><p className="px-3 pb-1 pt-2 text-xs font-medium text-muted-foreground">{group.label}</p>{group.commands.map(command => <button key={`${command.group}:${command.name}`} type="button" role="option" className="flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left hover:bg-accent focus:bg-accent focus:outline-none" onClick={() => executeCommand(command)}><code className="text-sm text-primary">{command.name}</code><span><strong className="block text-sm font-medium">{command.label}</strong><small className="text-muted-foreground">{command.description}</small></span></button>)}</section>)}</div>}
    {(attachments.files.length > 0 || terminalContext.active) && <PromptInputHeader>{terminalContext.active && <details className="rounded-lg border border-primary/20 bg-primary/10 px-3 py-2 text-xs"><summary className="cursor-pointer font-medium text-primary">终端上下文 · 最近 {Math.min(20, terminalContext.lines.length)} 行</summary><pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap text-[11px] text-muted-foreground">{terminalContext.lines.slice(-20).join('\n') || '等待终端输出…'}</pre></details>}{attachments.files.length > 0 && <Attachments variant="inline">{attachments.files.map(attachment => <Attachment key={attachment.id} data={attachment} onRemove={() => attachments.remove(attachment.id)}><AttachmentPreview /><AttachmentInfo /><AttachmentRemove /></Attachment>)}</Attachments>}</PromptInputHeader>}
    <PromptInputBody><label className="sr-only" htmlFor={`session-prompt-${session.id}`}>消息内容</label><PromptInputTextarea id={`session-prompt-${session.id}`} value={sendWithAttachmentsRef.current ? '' : state.draft} onChange={event => { controller.edit(event.target.value); setNotice(null) }} maxLength={16_000} aria-invalid={Boolean(state.error) || undefined} placeholder={canSend ? '给 Agent 发送消息，输入 / 查看命令…' : `${blockedReason}，可以先编辑草稿`} /></PromptInputBody>
    <PromptInputFooter><PromptInputTools className="flex-wrap">
      <PromptInputActionMenu><PromptInputActionMenuTrigger asChild><PromptInputActionMenuButton /></PromptInputActionMenuTrigger><PromptInputActionMenuContent align="start"><PromptInputActionAddAttachments kind="file" /><PromptInputActionAddAttachments kind="image" /></PromptInputActionMenuContent></PromptInputActionMenu>
      <SessionModelChip api={api} session={session} agent={agent} disabled={running || !canControl} onNotice={setNotice} /><ContextWindowMeter usage={contextUsage} onCompact={() => void compact()} compactDisabled={compactDisabled} /><span role={state.error || notice?.tone === 'error' ? 'alert' : 'status'} className={cn('min-w-0 flex-1 truncate text-xs text-muted-foreground/60', (state.error || notice?.tone === 'error') && 'text-red-300')}>{state.error || notice?.text || state.draftNotice || hint}</span></PromptInputTools>
      <PromptInputSubmit status={running || commandPending === 'stop' ? 'streaming' : state.pending ? 'submitted' : state.error ? 'error' : 'ready'} onStop={running ? () => void stop() : undefined} disabled={running ? !canControl || commandPending === 'stop' : !canSend || state.pending || (!state.draft.trim() && !attachments.files.length) || (state.draft.startsWith('/') && !isAgentCommandInput(agent, state.draft))} title={running ? '停止当前回合' : retry ? '重试发送' : '发送消息'} />
    </PromptInputFooter>
  </>
}

function SessionModelChip({ api, session, agent, disabled, onNotice }: { api?: Api; session: SessionDTO; agent?: AgentDTO; disabled: boolean; onNotice: (notice: ComposerNotice) => void }) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [modelId, setModelId] = useState(session.modelId)
  useEffect(() => setModelId(session.modelId), [session.modelId])
  const supported = agent?.modelSwap === true
  const label = `${session.agentKey} · ${modelId || 'Agent 默认模型'}`
  const select = async (nextModelId: string) => {
    if (!api || pending || nextModelId === modelId) { setOpen(false); return }
    const previous = modelId
    setModelId(nextModelId); setPending(true); setOpen(false); onNotice({ tone: 'info', text: `正在切换模型为 ${nextModelId}…` })
    try {
      const commandId = randomId()
      await api.invokeRuntimeCommand(session.id, { commandId, operationId: commandId, name: 'set_model', arguments: { modelId: nextModelId } })
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline) {
        const command = await api.command(commandId)
        if (command.status === 'accepted') { onNotice({ tone: 'info', text: `模型已切换为 ${nextModelId}` }); return }
        if (command.status === 'rejected') throw new Error(command.receipt?.error?.message || '智能体拒绝了模型切换请求。')
        await new Promise(resolve => setTimeout(resolve, 500))
      }
      throw new Error('模型切换确认超时，请重试。')
    } catch (error) {
      setModelId(previous)
      onNotice({ tone: 'error', text: error instanceof Error ? error.message : '模型切换失败，请重试。' })
    } finally { setPending(false) }
  }
  if (!supported) return <TooltipProvider><Tooltip><TooltipTrigger asChild><span className="middle-truncate rounded-md bg-muted/70 px-2 py-1 font-mono text-xs text-muted-foreground/60">{label}</span></TooltipTrigger><TooltipContent>该智能体不支持运行中切换</TooltipContent></Tooltip></TooltipProvider>
  return <Popover open={open} onOpenChange={setOpen}><PopoverTrigger asChild><button type="button" disabled={!api || disabled || pending} className="inline-flex min-w-0 items-center gap-1 rounded-full border border-border bg-card/80 px-2.5 py-1 font-mono text-xs text-muted-foreground transition hover:border-primary/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60" aria-label="选择会话模型"><span className="middle-truncate">{label}</span><ChevronDown className="size-3 shrink-0" /></button></PopoverTrigger><PopoverContent side="top" align="start" aria-label="选择会话模型" className="w-80"><p className="px-2 pb-1.5 pt-1 text-xs font-medium text-muted-foreground">选择 {session.agentKey} 模型</p>{agent.models.map(model => <button key={model.modelId} type="button" className="flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-accent" onClick={() => void select(model.modelId)}><Check className={cn('mt-0.5 size-4 shrink-0', model.modelId === modelId ? 'opacity-100' : 'opacity-0')} /><span className="min-w-0"><span className="block truncate text-foreground">{model.displayName}</span><span className="mt-0.5 block truncate text-xs text-muted-foreground">{model.modelId}</span></span></button>)}</PopoverContent></Popover>
}

const textAttachmentExtensions = new Set(['txt', 'md', 'markdown', 'json', 'js', 'jsx', 'ts', 'tsx', 'css', 'html', 'xml', 'yaml', 'yml', 'toml', 'ini', 'csv', 'sh', 'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'sql'])
function attachmentExtension(name: string) { return name.includes('.') ? name.split('.').pop()?.toLowerCase() ?? '' : '' }
function isInlineTextAttachment(file: File) { return file.type.startsWith('text/') || ['application/json', 'application/xml', 'application/javascript'].includes(file.type) || textAttachmentExtensions.has(attachmentExtension(file.name)) }
function attachmentLanguage(name: string) { const extension = attachmentExtension(name); return extension === 'markdown' ? 'md' : extension }

export function OptimisticMessages({ controller, confirmedIds, hiddenMessageIds = new Set(), messageActions }: { controller: SubmissionController; confirmedIds: string[]; hiddenMessageIds?: Set<string>; messageActions?: MessageActions }) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot)
  return <>{state.echoes.filter(item => !confirmedIds.includes(item.messageId) && !hiddenMessageIds.has(item.messageId)).map(item => {
    const failed = Boolean(state.error && state.attempt?.messageId === item.messageId)
    return <Message key={item.messageId} from="user" data-message-id={item.messageId}><MessageContent><Response>{item.content}</Response><small role={failed ? 'alert' : 'status'} className={failed ? 'text-red-300' : undefined}>{failed ? '' : state.pending && state.attempt?.messageId === item.messageId ? '…' : ''}</small></MessageContent><ActionsBar aria-label="">{failed && messageActions?.onRetry && <Action onClick={() => messageActions.onRetry?.(item.content, item.messageId)} aria-label="" title=""><RotateCcw className="size-3.5" /></Action>}<Action onClick={() => void copyText(item.content)} aria-label="" title=""><Copy className="size-3.5" /></Action>{messageActions?.onHide && <Action onClick={() => messageActions.onHide?.(item.messageId)} aria-label="" title="， Journal"><Trash2 className="size-3.5" /></Action>}</ActionsBar></Message>
  })}</>
}
