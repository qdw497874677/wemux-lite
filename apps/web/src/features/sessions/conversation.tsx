import { useSyncExternalStore } from 'react'
import { MarkdownMessage } from '../../components/markdown-message.ts'
import { SubmissionController } from './submission'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bot, Check, ChevronDown, ChevronRight, CircleCheck, CircleX, FolderGit2, LoaderCircle, Menu, MessageSquarePlus, MoreHorizontal, Network, Plus, RefreshCw, Search, Send, Server, ServerCog, Settings2, Wrench, WifiOff } from 'lucide-react'
import { ApiError, createApi, type ConnectionConfig } from '../../api/client'
import { clearConnectionConfig, readConnectionConfig, saveConnectionConfig } from '../../lib/connection-storage'
import type { ProjectDTO, SendMessageDTO, SessionDTO, WorkerDTO, WorkspaceDTO } from '../../api/dto'
import { useSession } from '../../api/use-session'
import type { ChatMessage, ChatTimelineItem, TimelineTool } from '../../api/journal'
import { Button } from '../../components/ui/button'
import { Badge } from '../../components/ui/badge'
import { Input } from '../../components/ui/input'
import { Textarea } from '../../components/ui/textarea'
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

export function TimelineEntry({ entry }: { entry: ChatTimelineItem }) {
  if (entry.kind === 'usage') {
    const parts = [
      entry.usage.completeness === 'partial' ? '' : null,
      formatUsageNumber(entry.usage.inputTokens) && ` ${formatUsageNumber(entry.usage.inputTokens)}`,
      formatUsageNumber(entry.usage.outputTokens) && ` ${formatUsageNumber(entry.usage.outputTokens)}`,
      formatUsageNumber(entry.usage.cacheReadTokens) && ` ${formatUsageNumber(entry.usage.cacheReadTokens)}`,
      formatUsageNumber(entry.usage.cacheWriteTokens) && ` ${formatUsageNumber(entry.usage.cacheWriteTokens)}`,
      formatUsageNumber(entry.usage.totalTokens) && ` ${formatUsageNumber(entry.usage.totalTokens)}`,
      entry.usage.costUsd === undefined ? null : ` ${entry.usage.currency ?? 'USD'} $${entry.usage.costUsd.toFixed(4)}`,
    ].filter(Boolean)
    return <div className="ml-11 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground" aria-label="">{parts.length > 0 ? parts.map(part => <span key={part}>{part}</span>) : <span></span>}</div>
  }
  if (entry.kind === 'notice') return <div role={entry.tone === 'error' ? 'alert' : 'status'} className={cn('ml-11 rounded-lg border px-3 py-2 text-sm', entry.tone === 'error' ? 'border-red-500/25 bg-red-500/10 text-red-200' : 'border-border bg-card text-muted-foreground')}><p className="whitespace-pre-wrap break-words">{entry.text}</p></div>
  if (entry.kind === 'tool') {
    const input = formatToolValue(entry.input)
    const statusIcon = entry.status === 'running' ? <LoaderCircle className="size-3.5 animate-spin" /> : entry.status === 'completed' ? <CircleCheck className="size-3.5" /> : <CircleX className="size-3.5" />
    return <article className="ml-11 overflow-hidden rounded-xl border border-border bg-card/70 text-xs"><header className="flex min-h-10 items-center gap-2 border-b border-border px-3"><Wrench className="size-3.5 text-violet-300" /><strong className="min-w-0 flex-1 truncate font-mono text-foreground">{entry.toolName}</strong><span className={cn('flex items-center gap-1', entry.status === 'failed' ? 'text-red-300' : entry.status === 'running' ? 'text-amber-300' : 'text-emerald-300')}>{statusIcon}{toolStatusLabels[entry.status]}{entry.exitCode != null ? ` · ${entry.exitCode}` : ''}</span></header>{input && <details className="border-b border-border" open={entry.status === 'running'}><summary className="cursor-pointer px-3 py-2 text-muted-foreground">调用参数</summary><pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words border-t border-border bg-background/60 px-3 py-2 font-mono leading-5 text-foreground">{input}</pre></details>}{entry.output && <details open><summary className="cursor-pointer px-3 py-2 text-muted-foreground">工具输出</summary><pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words border-t border-border bg-background/60 px-3 py-2 font-mono leading-5 text-foreground">{entry.output}</pre></details>}{!input && !entry.output && <p className="px-3 py-2 text-muted-foreground">等待工具输出…</p>}</article>
  }
  return <article className={cn('flex gap-3', entry.role === 'user' && 'justify-end')}>{entry.role === 'assistant' && <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-violet-500/10 text-violet-300"><Bot className="size-4" /></span>}<div className={cn('max-w-[90%] min-w-0 text-sm leading-6', entry.role === 'user' && 'rounded-2xl rounded-br-sm bg-indigo-500/20 px-4 py-3 ring-1 ring-indigo-400/15')}>{entry.text ? <MarkdownMessage text={entry.text} /> : <p className="text-muted-foreground">等待输出…</p>}{entry.role === 'user' ? <div className="mt-1 flex justify-end"><MessageStatus status={entry.status} /></div> : entry.status === 'running' || entry.status === 'started' ? <TypingDots /> : (entry.status === 'failed' || entry.status === 'rejected') && <small className="mt-1 block text-xs text-red-300">回复失败</small>}</div></article>
}

// 业界通行的极简消息状态：发送中 spinner、送达一枚淡勾、失败红字；不再用文字步骤条
function MessageStatus({ status }: { status: string }) {
  if (status === 'failed' || status === 'cancelled' || status === 'rejected') return <small className="flex items-center gap-1 text-[10px] text-red-300"><CircleX className="size-3" />发送失败</small>
  if (status === 'completed') return <span title="已送达"><Check className="size-3 text-muted-foreground/60" /></span>
  return <LoaderCircle aria-label="发送中" className="size-3 animate-spin text-indigo-300/70" />
}

function TypingDots() {
  return <span className="mt-1.5 inline-flex items-center gap-1" role="status" aria-label="正在回复">{[0, 1, 2].map(index => <span key={index} className={cn('size-1.5 animate-bounce rounded-full bg-violet-300/80', index === 1 && '[animation-delay:150ms]', index === 2 && '[animation-delay:300ms]')} />)}</span>
}
export function Composer({ controller, session, canSend, blockedReason, confirmedIds }: { controller: SubmissionController; session: SessionDTO; canSend: boolean; blockedReason: string; confirmedIds: string[] }) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot)
  useEffect(() => { controller.confirm(confirmedIds) }, [controller, confirmedIds.join(',')])
  canSend = canSend && session.sendCapability?.allowed === true
  blockedReason = session.sendCapability?.allowed === false ? session.sendCapability.reason : !session.sendCapability ? 'Authoritative capability data unavailable' : blockedReason
  const submit = () => { if (canSend) void controller.send() }
  return <div className="conversation-composer shrink-0 border-t border-border px-3 py-2 sm:px-6 sm:py-3"><div className="conversation-content"><Textarea className="min-h-20 max-h-[28dvh] resize-y text-base sm:text-sm" rows={3} aria-label="消息内容" value={state.draft} onChange={event => controller.edit(event.target.value)} onKeyDown={event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && (event.ctrlKey || event.metaKey || window.matchMedia('(pointer: fine)').matches)) { event.preventDefault(); submit() }
  }} placeholder={canSend ? '输入消息…' : `${blockedReason}；仍可先编辑草稿`} /><div className="flex items-center gap-3 pt-2"><span role={state.error ? 'alert' : 'status'} className="min-w-0 flex-1 break-words text-xs text-muted-foreground">{state.error || (state.pending ? '正在发送…' : state.receipt ? '已送达，等待回复' : canSend ? '点击发送；电脑 Enter 发送，Shift+Enter 换行' : blockedReason)}</span><Button disabled={!canSend || state.pending || !state.draft.trim()} onClick={submit}>{state.pending ? '发送中' : state.attempt?.content === state.draft.trim() ? '重试' : session.runtimeState === 'running' ? '继续发送' : '发送'}</Button></div></div></div>
}

export function OptimisticMessages({ controller, confirmedIds }: { controller: SubmissionController; confirmedIds: string[] }) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot)
  return <>{state.echoes.filter(item => !confirmedIds.includes(item.messageId)).map(item => <article key={item.messageId} data-message-id={item.messageId} className="border-l-2 border-primary pl-4"><MarkdownMessage text={item.content} /><small role="status">{state.pending && state.attempt?.messageId === item.messageId ? '正在提交…' : '等待会话历史确认'}</small></article>)}</>
}
