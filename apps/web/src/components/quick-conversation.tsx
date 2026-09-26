import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Bot, Boxes, Check, ChevronDown, CircleCheck, Server, TriangleAlert } from 'lucide-react'
import type { WorkerDTO, WorkspaceDTO } from '../api/dto'
import { QuickStartController, fillQuickChoices, quickConfigReason } from '../features/sessions/quick-start.ts'
import { workspaceStateLabel, workerStateLabel } from '../lib/display.ts'
import { isExecutable } from '../lib/capability.ts'
import { cn } from '../lib/utils.ts'
import { PromptInput, PromptInputFooter, PromptInputSubmit, PromptInputTextarea, PromptInputTools } from './ai-elements/prompt-input.tsx'
import { Button } from './ui/button.tsx'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog.tsx'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.tsx'

/** Keep first-message recovery visible in the destination Session, also after reload. */
export function QuickStartRecovery({ controller, sessionId }: { controller: QuickStartController; sessionId: string }) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot)
  useEffect(() => { void controller.checkReceipt() }, [controller])
  if (state.attempt?.sessionId !== sessionId || state.completed) return null
  return <aside role="status" className="shrink-0 space-y-2 border-b border-border px-4 py-3 text-sm">
    <p>{state.error || '首条消息尚未确认，内容已保留。'}</p>
    <details><summary className="cursor-pointer text-xs">查看保留的首条消息</summary><p className="max-h-32 overflow-auto whitespace-pre-wrap break-words">{state.draft}</p></details>
    <Button type="button" size="sm" variant="outline" disabled={state.pending} onClick={() => { void controller.start() }}>{state.pending ? '正在重试…' : '重试首条消息'}</Button>
  </aside>
}

type Choice = { id: string; label: string; description?: string; disabled?: boolean }

function ConfigChip({ label, value, selectedId, icon, choices, disabled, onSelect }: {
  label: string; value: string; selectedId: string; icon: ReactNode; choices: Choice[]; disabled: boolean; onSelect: (id: string) => void
}) {
  return <Popover><PopoverTrigger asChild><button type="button" disabled={disabled} className="flex min-w-0 max-w-full items-center gap-1.5 rounded-full border border-border bg-card/80 px-3 py-1.5 text-xs text-muted-foreground transition hover:border-primary/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60">
    {icon}<span className="shrink-0 text-muted-foreground/70">{label}</span><span className="truncate font-medium text-foreground">{value}</span><ChevronDown className="size-3 shrink-0" />
  </button></PopoverTrigger><PopoverContent aria-label={`选择${label}`} className="w-80">
    <p className="px-2 pb-1.5 pt-1 text-xs font-medium text-muted-foreground">选择{label}</p>
    {choices.length ? choices.map(choice => <button key={choice.id || 'default'} type="button" disabled={choice.disabled} className="flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50" onClick={() => onSelect(choice.id)}>
      <Check className={cn('mt-0.5 size-4 shrink-0', choice.id === selectedId ? 'opacity-100' : 'opacity-0')} /><span className="min-w-0"><span className="block truncate text-foreground">{choice.label}</span>{choice.description && <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">{choice.description}</span>}</span>
    </button>) : <p className="px-2 py-3 text-sm text-muted-foreground">暂无可选项</p>}
  </PopoverContent></Popover>
}

export function QuickConversation({ controller, projectId, workers, workspaces, connected, onSetup, onOpen }: {
  controller: QuickStartController; projectId: string; workers: WorkerDTO[]; workspaces: WorkspaceDTO[]; connected: boolean
  onSetup: () => void; onOpen: (id: string) => void
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot)
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  const viewGeneration = useRef(0)
  useEffect(() => {
    viewGeneration.current++
    void controller.checkReceipt()
    return () => { viewGeneration.current++ }
  }, [controller, projectId])
  const { config } = state
  const ws = workspaces.find(w => w.id === config.workspaceId)
  const worker = workers.find(w => w.id === config.workerId)
  const agent = worker?.capabilities.find(a => a.agentKey === config.agentKey)
  const reason = quickConfigReason(config, projectId, workspaces, workers)
  const locked = state.pending || Boolean(state.attempt) || Boolean(state.completed)
  const start = () => { if (connected) { const generation = viewGeneration.current; void controller.start().then(id => { if (id && generation === viewGeneration.current) onOpen(id) }) } }
  const projectWorkspaces = workspaces.filter(w => w.projectId === projectId)
  const workerChoices = ws?.placements.map(placement => {
    const node = workers.find(item => item.id === placement.workerId)
    return { id: placement.workerId, label: node?.name ?? placement.workerId, description: `${workspaceStateLabel[placement.status]} · ${node ? workerStateLabel[node.connectionState] : '节点不可访问'}` }
  }) ?? []
  const agentChoices = worker?.capabilities.map(item => ({ id: item.agentKey, label: item.displayName, description: !isExecutable(item) ? item.availability.reason || '不可执行或尚未认证' : !item.models.length ? '未报告可用模型' : undefined, disabled: !isExecutable(item) })) ?? []
  const modelChoices = [{ id: '', label: '智能体默认模型' }, ...(agent?.models.map(item => ({ id: item.modelId, label: item.displayName })) ?? [])]
  const runtimeIssues = worker?.capabilities.filter(item => !isExecutable(item) || !item.models.length) ?? []
  const placementIssues = ws?.placements.filter(item => item.status !== 'ready' || item.failureReason) ?? []
  const hasDiagnostics = runtimeIssues.length > 0 || placementIssues.length > 0

  return <section className="mx-auto flex w-full max-w-3xl flex-col justify-center py-8 sm:min-h-[calc(100vh-16rem)] sm:py-12" aria-label="快速新对话">
    <header className="mb-8 text-center"><h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">新对话</h1><p className="mt-2 text-sm text-muted-foreground sm:text-base">直接说说你想做什么，无需创建任务。</p></header>

    <div className="mb-3 flex flex-wrap items-center justify-center gap-2" aria-label="对话配置">
      <ConfigChip label="工作区" value={ws?.name ?? (config.workspaceId || '请选择')} selectedId={config.workspaceId} icon={<Boxes className="size-3.5" />} disabled={locked} choices={projectWorkspaces.map(item => ({ id: item.id, label: item.name, description: `${item.placements.length} 个工作节点` }))} onSelect={id => { const next = workspaces.find(item => item.id === id); controller.configure(fillQuickChoices({ workspaceId: next?.id ?? '', workerId: '', agentKey: '', modelId: '' }, projectId, workspaces, workers)) }} />
      <ConfigChip label="节点" value={worker?.name ?? (config.workerId || '请选择')} selectedId={config.workerId} icon={<Server className="size-3.5" />} disabled={locked || !ws} choices={workerChoices} onSelect={id => controller.configure(fillQuickChoices({ ...config, workerId: id, agentKey: '', modelId: '' }, projectId, workspaces, workers))} />
      <ConfigChip label="智能体" value={agent?.displayName ?? (config.agentKey || '请选择')} selectedId={config.agentKey} icon={<Bot className="size-3.5" />} disabled={locked || !worker} choices={agentChoices} onSelect={id => controller.configure(fillQuickChoices({ ...config, agentKey: id, modelId: '' }, projectId, workspaces, workers))} />
      <ConfigChip label="模型" value={agent?.models.find(item => item.modelId === config.modelId)?.displayName ?? (config.modelId || '默认')} selectedId={config.modelId} icon={<Bot className="size-3.5" />} disabled={locked || !agent} choices={modelChoices} onSelect={id => controller.configure({ ...config, modelId: id })} />
    </div>

    <PromptInput className="shadow-lg shadow-black/5" onSubmit={() => start()}>
      <PromptInputTextarea autoFocus aria-label="首条消息" placeholder="输入你的需求…" className="min-h-36 px-5 py-4 text-base leading-7" value={state.draft} readOnly={locked} onChange={event => controller.edit(event.target.value)} />
      <PromptInputFooter className="px-3"><PromptInputTools>
        {reason ? <span role="status" className="truncate text-xs text-amber-300">{reason}</span> : <span className="text-xs text-muted-foreground">Enter 发送，Shift + Enter 换行</span>}
      </PromptInputTools><PromptInputSubmit status={state.pending ? 'submitted' : state.error ? 'error' : 'ready'} disabled={!connected || Boolean(reason) || state.pending || !state.draft.trim()} title={state.attempt ? '重试首条消息' : '发送并开始对话'} />
      </PromptInputFooter>
    </PromptInput>

    <div className="mt-3 flex min-h-8 flex-wrap items-center justify-center gap-2 text-xs">
      {worker && (hasDiagnostics ? <button type="button" className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-amber-300 hover:bg-amber-500/10" onClick={() => setDiagnosticsOpen(true)}><TriangleAlert className="size-3.5" />{runtimeIssues.length ? `${runtimeIssues.length} 个运行时未安装或不可用` : '工作区运行异常'} · 查看详情</button> : <span role="status" className="inline-flex items-center gap-1.5 text-emerald-300"><CircleCheck className="size-3.5" />运行时已就绪</span>)}
      {!projectWorkspaces.some(item => item.placements.some(placement => placement.status === 'ready')) && <Button type="button" size="xs" variant="outline" disabled={!connected || locked} onClick={onSetup}>准备工作区</Button>}
    </div>

    {state.error && <p role="alert" className="mt-2 text-center text-sm text-red-300">{state.error}</p>}
    {state.attempt && !state.completed && <p className="mt-2 text-center text-xs text-muted-foreground">草稿和请求身份已保留。{state.attempt.sessionId ? state.attempt.rejected ? '首条消息已被拒绝，重试将在同一会话发送新请求。' : '重试将复用原消息身份，避免重复发送。' : '重试将复用原 requestId，避免重复创建会话。'}</p>}
    {state.attempt?.sessionId && <div className="mt-3 text-center"><Button type="button" size="sm" variant="outline" onClick={() => onOpen(state.attempt!.sessionId!)}>查看已创建会话</Button></div>}
    {state.completed && <div className="mt-3 text-center"><Button type="button" size="sm" onClick={() => controller.resetCompleted()}>再开新对话</Button></div>}

    <Dialog open={diagnosticsOpen} onOpenChange={setDiagnosticsOpen}><DialogContent><DialogHeader><DialogTitle>运行时诊断</DialogTitle><DialogDescription>这些信息不会阻止你选择其他可用的智能体或工作节点。</DialogDescription></DialogHeader><DialogBody className="max-h-[60vh] space-y-5 overflow-auto">
      {ws && <section><h2 className="mb-2 text-sm font-medium text-foreground">工作区节点</h2><ul className="space-y-2">{ws.placements.map(placement => { const node = workers.find(item => item.id === placement.workerId); return <li key={placement.workerId} className="rounded-lg border border-border p-3"><p className="font-medium text-foreground">{node?.name ?? placement.workerId} · {workspaceStateLabel[placement.status]}</p>{placement.location?.rootPath && <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{placement.location.rootPath}</p>}{placement.failureReason && <p className="mt-1 text-xs text-red-300">{placement.failureReason}</p>}</li> })}</ul></section>}
      {runtimeIssues.length > 0 && <section><h2 className="mb-2 text-sm font-medium text-foreground">运行时</h2><ul className="space-y-2">{runtimeIssues.map(item => <li key={item.agentKey} className="rounded-lg border border-border p-3"><p className="font-medium text-foreground">{item.displayName}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{item.availability.reason || (!isExecutable(item) ? '不可执行或尚未认证' : '未报告可用模型')}</p></li>)}</ul></section>}
    </DialogBody></DialogContent></Dialog>
  </section>
}
