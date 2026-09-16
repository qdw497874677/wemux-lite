import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { WorkerDTO, WorkspaceDTO } from '../api/dto'
import { QuickStartController, fillQuickChoices, quickConfigReason } from '../features/sessions/quick-start.ts'
import { isExecutable } from '../lib/capability.ts'
import { Button } from './ui/button.tsx'
import { Textarea } from './ui/textarea.tsx'

/** Keep first-message recovery visible in the destination Session, also after reload. */
export function QuickStartRecovery({ controller, sessionId }: { controller: QuickStartController; sessionId: string }) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot)
  useEffect(() => { void controller.checkReceipt() }, [controller])
  if (state.attempt?.sessionId !== sessionId || state.completed) return null
  return <aside role="status" className="shrink-0 space-y-2 border-b border-border px-4 py-3 text-sm">
    <p>{state.error || '首条消息尚未确认，内容已保留。'}</p>
    <details><summary className="cursor-pointer text-xs">查看保留的首条消息</summary><p className="max-h-32 overflow-auto whitespace-pre-wrap break-words">{state.draft}</p></details>
    <Button type="button" size="sm" variant="outline" disabled={state.pending} onClick={() => { void controller.start() }}>{state.pending ? '…' : ''}</Button>
  </aside>
}

export function QuickConversation({ controller, projectId, workers, workspaces, connected, onSetup, onOpen }: {
  controller: QuickStartController; projectId: string; workers: WorkerDTO[]; workspaces: WorkspaceDTO[]; connected: boolean
  onSetup: () => void; onOpen: (id: string) => void
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot)
  const [expanded, setExpanded] = useState(false)
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
  const selectClass = 'h-10 min-w-0 w-full rounded-md border border-input bg-background px-2 text-sm'
  const missing = (value: string, exists: boolean) => value && !exists ? <option value={value}>{value}（已不可用）</option> : null
  const start = () => { if (connected) { const generation = viewGeneration.current; void controller.start().then(id => { if (id && generation === viewGeneration.current) onOpen(id) }) } }
  return <section className="conversation-content space-y-4" aria-label="快速新对话">
    <div><h1>新对话</h1><p className="mt-1 text-sm text-muted-foreground">直接说说你想做什么，无需创建任务。</p></div>
    <form className="space-y-3" onSubmit={event => { event.preventDefault(); start() }}>
      <Textarea autoFocus aria-label="首条消息" placeholder="输入你的需求…" className="min-h-32 text-base" value={state.draft} readOnly={locked} onChange={event => controller.edit(event.target.value)} onKeyDown={event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && (event.ctrlKey || event.metaKey || window.matchMedia('(pointer: fine)').matches)) { event.preventDefault(); start() }
      }} />
      <button type="button" aria-expanded={expanded || Boolean(reason)} className="w-full break-words text-left text-xs text-muted-foreground" onClick={() => setExpanded(!expanded)}>{ws?.name ?? (config.workspaceId || '选择工作区')} · {worker?.name ?? (config.workerId || '节点随工作区确定')} · {agent?.displayName ?? (config.agentKey || '选择智能体')} · {config.modelId || '选择模型'}　配置</button>
      {(expanded || reason) && <fieldset disabled={locked} className="grid gap-3 sm:grid-cols-3">
        <label className="grid min-w-0 gap-1 text-xs">工作区<select aria-label="工作区" className={selectClass} value={config.workspaceId} onChange={event => { const next = workspaces.find(w => w.id === event.target.value); controller.configure(fillQuickChoices({ workspaceId: next?.id ?? '', workerId: next?.workerId ?? '', agentKey: '', modelId: '' }, projectId, workspaces, workers)) }}><option value="">选择工作区</option>{missing(config.workspaceId, Boolean(ws))}{workspaces.map(w => <option key={w.id} value={w.id}>{w.name}{w.status !== 'ready' ? `（${w.status}）` : ''}</option>)}</select></label>
        <label className="grid min-w-0 gap-1 text-xs">智能体<select aria-label="智能体" className={selectClass} value={config.agentKey} onChange={event => controller.configure(fillQuickChoices({ ...config, agentKey: event.target.value, modelId: '' }, projectId, workspaces, workers))}><option value="">选择智能体</option>{missing(config.agentKey, Boolean(agent))}{worker?.capabilities.map(a => <option key={a.agentKey} value={a.agentKey} disabled={!isExecutable(a)}>{a.displayName}{!isExecutable(a) ? '（不可执行）' : ''}</option>)}</select></label>
        <label className="grid min-w-0 gap-1 text-xs">模型<select aria-label="模型" className={selectClass} value={config.modelId} onChange={event => controller.configure({ ...config, modelId: event.target.value })}><option value="">选择模型</option>{missing(config.modelId, Boolean(agent?.models.some(m => m.modelId === config.modelId)))}{agent?.models.map(m => <option key={m.modelId} value={m.modelId}>{m.displayName}</option>)}</select></label>
      </fieldset>}
      {reason && <p role="status" className="text-xs text-muted-foreground">{reason}</p>}
      {!workspaces.some(w => w.status === 'ready') && <Button type="button" variant="outline" disabled={!connected || locked} onClick={onSetup}>准备工作区</Button>}
      {state.error && <p role="alert" className="text-sm text-red-300">{state.error}</p>}
      {state.attempt && !state.completed && <p className="text-xs text-muted-foreground">。{state.attempt.sessionId ? state.attempt.rejected ? '，。' : '，。' : '， requestId ，。'}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        {state.attempt?.sessionId && <Button type="button" variant="outline" onClick={() => onOpen(state.attempt!.sessionId!)}>查看已创建会话</Button>}
        {state.completed ? <Button type="button" onClick={() => controller.resetCompleted()}>再开新对话</Button> : <Button type="submit" disabled={!connected || Boolean(reason) || state.pending || !state.draft.trim()}>{state.pending ? '正在启动…' : state.attempt ? '重试首条消息' : '发送并开始对话'}</Button>}
      </div>
    </form>
  </section>
}
