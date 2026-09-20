import { useSyncExternalStore } from 'react'
import { MarkdownMessage } from '../../components/markdown-message.ts'
import { SubmissionController } from './submission'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bot, Check, ChevronDown, ChevronRight, CircleCheck, CircleX, FolderGit2, LoaderCircle, Menu, MessageSquarePlus, MoreHorizontal, Network, Plus, RefreshCw, Search, Send, Server, ServerCog, Settings2, Wrench, WifiOff } from 'lucide-react'
import type { ProjectDTO, SendMessageDTO, SessionDTO, WorkerDTO, WorkspaceDTO } from '../../api/dto'
import { useSession } from '../../api/use-session'
import type { ChatMessage, ChatTimelineItem, TimelineTool } from '../../api/journal'
import { Button } from '../../components/ui/button'
import { Badge } from '../../components/ui/badge'
import { Input } from '../../components/ui/input'
import { AiPromptInput } from '../../components/ui/ai-prompt-input.tsx'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '../../components/ui/sheet'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../../components/ui/dropdown-menu'
import { ConnectionDialog } from '../../components/connection-dialog'
import { CreateDialog, type CreateKind } from '../../components/create-dialog'
import { WorkerEnrollmentDialog } from '../../components/worker-enrollment-dialog'
import { ClusterPage } from '../../components/cluster-page'
import { cn } from '../../lib/utils'
import { formatChineseTime, runtimeStateLabel, workerStateLabel, workspaceStateLabel } from '../../lib/display'

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : '请求失败'
const freshnessLabels = { unknown: '历史完整性尚未确认', syncing: '正在补传历史', synced: '历史已同步', gap: '历史存在事件缺口', offline: '工作节点离线，仅展示缓存', orphaned: '工作节点已丢失，仅可读取缓存' }
const toolStatusLabels: Record<TimelineTool['status'], string> = { running: '正在执行', completed: '执行完成', failed: '执行失败', cancelled: '已取消' }
const formatUsageNumber = (value: number | undefined) => value === undefined ? null : new Intl.NumberFormat('zh-CN').format(value)
const formatToolValue = (value: unknown) => {
  if (value == null || value === '') return ''
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

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
    return <div className="ml-12 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground/70 animate-fade-up" aria-label="运行用量">{parts.length > 0 ? parts.map(part => <span key={part} className="rounded-lg bg-white/5 px-2.5 py-1">{part}</span>) : <span>暂无用量数据</span>}</div>
  }
  if (entry.kind === 'notice') return <div role={entry.tone === 'error' ? 'alert' : 'status'} className={cn('ml-12 rounded-2xl px-4 py-3 text-sm shadow-md animate-fade-up', entry.tone === 'error' ? 'border border-red-500/30 bg-red-500/15 text-red-200' : 'surface-glass text-muted-foreground')}><p className="whitespace-pre-wrap break-words leading-6">{entry.text}</p></div>
  if (entry.kind === 'tool') {
    const input = formatToolValue(entry.input)
    const statusIcon = entry.status === 'running' ? <LoaderCircle className="size-3.5 animate-spin" /> : entry.status === 'completed' ? <CircleCheck className="size-3.5" /> : <CircleX className="size-3.5" />
    return <article className="ml-12 overflow-hidden rounded-2xl surface-glass text-xs shadow-md animate-fade-up"><header className="flex min-h-11 items-center gap-2.5 border-b border-white/5 px-4"><Wrench className="size-4 text-violet-300" /><strong className="min-w-0 flex-1 truncate font-mono text-sm text-foreground">{entry.toolName}</strong><span className={cn('flex items-center gap-1.5 text-xs', entry.status === 'failed' ? 'text-red-300' : entry.status === 'running' ? 'text-amber-300' : 'text-emerald-300')}>{statusIcon}{toolStatusLabels[entry.status]}{entry.exitCode != null ? ` · ${entry.exitCode}` : ''}</span></header>{input && <details className="border-b border-white/5" open={entry.status === 'running'}><summary className="cursor-pointer px-4 py-2.5 text-muted-foreground transition-colors hover:text-foreground">调用参数</summary><pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words border-t border-white/5 bg-background/40 px-4 py-3 font-mono text-xs leading-5 text-foreground">{input}</pre></details>}{entry.output && <details open><summary className="cursor-pointer px-4 py-2.5 text-muted-foreground transition-colors hover:text-foreground">工具输出</summary><pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words border-t border-white/5 bg-background/40 px-4 py-3 font-mono text-xs leading-5 text-foreground">{entry.output}</pre></details>}{!input && !entry.output && <p className="px-4 py-3 text-muted-foreground">等待工具输出…</p>}</article>
  }
  return <article className={cn('flex gap-3 animate-fade-up', entry.role === 'user' && 'justify-end')}>{entry.role === 'assistant' && <span className="grid size-9 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-indigo-500/15 to-purple-500/10 text-violet-300 shadow-sm"><Bot className="size-4" /></span>}<div className={cn('max-w-[85%] min-w-0 text-sm leading-6', entry.role === 'user' ? 'rounded-3xl rounded-br-lg bg-gradient-to-br from-indigo-500/25 to-purple-500/20 px-5 py-3.5 shadow-md ring-1 ring-indigo-400/20' : 'rounded-3xl rounded-bl-lg surface-glass px-5 py-4')}>{entry.text ? <MarkdownMessage text={entry.text} /> : <p className="text-muted-foreground">等待输出…</p>}{entry.role === 'user' ? <div className="mt-1.5 flex items-center justify-end gap-1.5"><MessageStatus status={entry.status} />{onOpenContext && <button type="button" onClick={onOpenContext} className="rounded-lg p-1 text-muted-foreground/50 transition-all hover:bg-white/10 hover:text-foreground" aria-label="查看会话信息"><ChevronRight className="size-3.5" /></button>}</div> : entry.status === 'running' || entry.status === 'started' ? <TypingDots /> : <MessageStatus status={entry.status} />}</div></article>
}

const messageStatusLabels: Record<string, string> = { queued: '排队中', started: '正在处理', running: '正在回复', completed: '已完成', cancelled: '已取消', rejected: '已拒绝', failed: '执行失败' }
function MessageStatus({ status }: { status: string }) {
  return <small role="status" className={cn('text-[10px]', status === 'failed' || status === 'rejected' ? 'text-red-300' : 'text-muted-foreground')}>{messageStatusLabels[status] ?? '等待确认'}</small>
}

function TypingDots() {
  return <span className="mt-1.5 inline-flex items-center gap-1" role="status" aria-label="正在回复">{[0, 1, 2].map(index => <span key={index} className={cn('size-1.5 animate-bounce rounded-full bg-violet-300/80', index === 1 && '[animation-delay:150ms]', index === 2 && '[animation-delay:300ms]')} />)}</span>
}
export function Composer({ controller, session, canSend, blockedReason, confirmedIds }: { controller: SubmissionController; session: SessionDTO; canSend: boolean; blockedReason: string; confirmedIds: string[] }) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot)
  useEffect(() => { controller.confirm(confirmedIds) }, [controller, confirmedIds.join(',')])
  canSend = canSend && session.access?.canWrite !== false && session.sendCapability?.allowed === true
  blockedReason = session.access?.canWrite === false ? '当前账号只有查看权限' : session.sendCapability?.allowed === false ? session.sendCapability.reason : !session.sendCapability ? '暂时无法确认发送权限' : blockedReason
  const retry = state.attempt?.content === state.draft.trim()
  const hint = state.pending ? '正在发送…' : state.receipt ? '消息已送达，等待 Agent 回复' : canSend ? session.runtimeState === 'running' ? 'Agent 正在运行，新消息将进入队列' : 'Enter 发送，Shift+Enter 换行' : `${blockedReason}，草稿仍会保留`
  return <div className="conversation-composer shrink-0 px-3 py-3 sm:px-6 sm:py-4"><div className="conversation-content mx-auto max-w-4xl"><AiPromptInput
    value={state.draft}
    onChange={controller.edit}
    onSubmit={() => { if (canSend) void controller.send() }}
    modelLabel={session.modelId || 'Agent 默认模型'}
    agentLabel={session.agentKey}
    status={state.pending ? 'loading' : 'idle'}
    submitDisabled={!canSend || state.pending}
    retry={retry}
    placeholder={canSend ? '给 Agent 发送消息…' : `${blockedReason}，可以先编辑草稿`}
    hint={hint}
    error={state.error}
  /></div></div>
}

export function OptimisticMessages({ controller, confirmedIds }: { controller: SubmissionController; confirmedIds: string[] }) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot)
  return <>{state.echoes.filter(item => !confirmedIds.includes(item.messageId)).map(item => <article key={item.messageId} data-message-id={item.messageId} className="border-l-2 border-primary pl-4"><MarkdownMessage text={item.content} /><small role="status">{state.pending && state.attempt?.messageId === item.messageId ? '正在提交…' : '等待会话历史确认'}</small></article>)}</>
}
