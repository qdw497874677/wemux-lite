import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { unavailableCapability, boardStatuses, taskStatuses, type TaskContentPatch, type TaskDetail, type TaskStatus, type TaskSummary } from '@wemux/web-contract/task-platform'
import { projectActivityOptions, projectKeys } from '../../app/project-query'
import { TaskDraft } from './draft'
import { TaskRuns } from './runs'
import { TaskWorkspaces } from './workspaces'
import { useTaskNavigationGuard } from '../../app/router'
import type { Api } from '../../api/client'
import { InspectorHost } from '../../app/shell'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { CreationDialog } from '../../components/creation-dialog'
import { DialogFooter } from '../../components/ui/dialog'
import { Textarea } from '../../components/ui/textarea'
import { TaskCard } from '../../components/task-board/task-card.tsx'
import { TaskColumn } from '../../components/task-board/task-column.tsx'
import { TaskStatusBadge, taskStatusLabels as statusLabels } from '../../components/task-board/task-status.tsx'
import { Columns3, List, Plus, Search, SlidersHorizontal } from 'lucide-react'
import { useConfirmDialog } from '../../components/ui/confirm-dialog.tsx'
import { Skeleton } from '../../components/ui/skeleton.tsx'

export { taskStatusLabels as statusLabels } from '../../components/task-board/task-status.tsx'
const message = (error: unknown) => error instanceof Error ? error.message : '请求失败'
export function TaskBoard({ api, projectId, taskId, search, go }: { api: Api; projectId: string; taskId: string; search: string; go: (path: string) => void }) {
  const client = useQueryClient(), key = projectKeys.tasks(projectId)
  const confirm = useConfirmDialog()
  const tasks = useQuery({ queryKey: key, queryFn: ({ signal }) => api.tasks(projectId, signal) })
  const detail = useQuery({ queryKey: projectKeys.task(projectId, taskId), queryFn: ({ signal }) => api.task(projectId, taskId, signal), enabled: Boolean(taskId) })
  const params = new URLSearchParams(search), filter = params.get('filter') ?? '', query = params.get('q') ?? '', view = params.get('view') ?? 'board', tab = params.get('tab') ?? 'details'
  const base = `/projects/${encodeURIComponent(projectId)}`
  const [online, setOnline] = useState(navigator.onLine)
  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update); window.addEventListener('offline', update)
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update) }
  }, [])
  const [createBusy, setCreateBusy] = useState(false)
  const createDirty = useRef(false)
  const closeCreate = () => { if (createBusy) return; if (!createDirty.current) { setCreating(false); return } void confirm({ title: '放弃未保存的任务', description: '确认关闭并放弃当前任务草稿？', confirmLabel: '放弃', danger: true }).then(ok => { if (ok) { setCreating(false); createDirty.current = false } }) }
  const [creating, setCreating] = useState(false), [error, setError] = useState(''), [announcement, setAnnouncement] = useState(''), [busy, setBusy] = useState(false)
  const [intent, setIntent] = useState<{ id: string; status: TaskStatus } | null>(null)
  const drag = useRef<string | null>(null), dirty = useRef(false), focusTask = useRef<string | null>(null)
  const contentDirty = useRef(false), workspaceDirty = useRef(false), runDirty = useRef(false)
  const markDirty = (kind: 'content' | 'workspace' | 'run', value: boolean) => { (kind === 'content' ? contentDirty : kind === 'workspace' ? workspaceDirty : runDirty).current = value; dirty.current = contentDirty.current || workspaceDirty.current || runDirty.current }
  useTaskNavigationGuard(dirty)
  useEffect(() => { dirty.current = contentDirty.current || workspaceDirty.current || runDirty.current }, [taskId])
  useEffect(() => {
    if (!busy && !tasks.isFetching && focusTask.current) {
      document.getElementById(`task-state-${focusTask.current}`)?.focus()
      focusTask.current = null
    }
  }, [busy, tasks.isFetching, tasks.data])
  const updateSearch = (name: string, value: string) => { const next = new URLSearchParams(search); value ? next.set(name, value) : next.delete(name); go(`${base}/${taskId ? `tasks/${encodeURIComponent(taskId)}` : 'board'}?${next}`) }
  const refresh = () => { void client.invalidateQueries({ queryKey: projectKeys.root(projectId) }) }
  const open = (id: string) => go(`${base}/tasks/${encodeURIComponent(id)}${search}`)
  const close = () => go(`${base}/board${search}`)
  async function move(task: TaskSummary, status: TaskStatus) {
    if (busy || !online) return
    const capability = task.capabilities?.transitions[status] ?? unavailableCapability
    if (!capability.allowed) { setError(capability.reason); return }
    if (task.status === 'in_review' && ['done', 'in_progress'].includes(status) && !await confirm({ title: '结束当前审查周期', description: `确认将 ${task.title} 从待审查迁移至 ${statusLabels[status]}？这将结束当前审查周期。`, confirmLabel: '确认迁移', danger: true })) return
    focusTask.current = task.id
    setBusy(true); setError(''); setIntent(null)
    await client.cancelQueries({ queryKey: key })
    const previous = client.getQueryData<readonly TaskSummary[]>(key)
    client.setQueryData<readonly TaskSummary[]>(key, old => old?.map(item => item.id === task.id ? { ...item, status } : item))
    try {
      await api.patchTask(projectId, task.id, { status, version: task.version })
      setAnnouncement(`${task.title} 已移至 ${statusLabels[status]}`)
    } catch (cause) {
      client.setQueryData(key, previous); setError(message(cause)); setIntent({ id: task.id, status }); setAnnouncement('迁移失败，已回滚；可核对最新状态后重新确认。')
    } finally {
      setBusy(false); refresh()
    }
  }
  const visible = (tasks.data ?? []).filter(task => (!filter || task.status === filter) && task.title.toLowerCase().includes(query.toLowerCase()))
  const card = (task: TaskSummary, compact = false) => <TaskCard key={task.id} task={task} compact={compact} href={`${base}/tasks/${encodeURIComponent(task.id)}${search}`} onOpen={() => open(task.id)} draggable={!busy && online} onDragStart={event => { drag.current = task.id; event.dataTransfer.setData('text/plain', task.id); event.dataTransfer.effectAllowed = 'move' }} onDragEnd={() => { drag.current = null }} footer={<label className="task-state-control"><span className="sr-only">迁移状态</span><select id={`task-state-${task.id}`} aria-label={`${task.title} 状态`} value={task.status} disabled={busy || !online} onChange={event => void move(task, event.target.value as TaskStatus)}>{taskStatuses.map(status => <option key={status} value={status} disabled={!(task.capabilities?.transitions[status] ?? unavailableCapability).allowed}>{statusLabels[status]}{task.capabilities?.transitions[status]?.allowed ? '' : ` · ${(task.capabilities?.transitions[status] ?? unavailableCapability).reason}`}</option>)}</select></label>} />
  return <div className="task-workbench">
    <section className="task-canvas" aria-label="任务看板">
      <header className="task-board-header"><div><p className="task-board-eyebrow">TEAM EXECUTION</p><h1>任务看板</h1><p>规划、指派、运行与人工审查都汇聚在同一个工作流。</p></div><Button data-inspector-trigger onClick={() => setCreating(true)}><Plus className="size-4" />新建任务</Button></header>
      <div className="task-board-toolbar">
        <label className="task-search"><Search aria-hidden /><Input aria-label="搜索任务" value={query} onChange={event => updateSearch('q', event.target.value)} placeholder="搜索任务标题" /></label>
        <div className="task-view-switch" aria-label="任务视图"><button type="button" aria-pressed={view === 'board'} onClick={() => updateSearch('view', 'board')}><Columns3 aria-hidden />看板</button><button type="button" aria-pressed={view === 'list'} onClick={() => updateSearch('view', 'list')}><List aria-hidden />列表</button></div>
        <label className="task-filter"><SlidersHorizontal aria-hidden /><span className="sr-only">状态筛选</span><select aria-label="状态筛选" value={filter} onChange={event => updateSearch('filter', event.target.value)}><option value="">所有状态</option>{taskStatuses.map(status => <option value={status} key={status}>{statusLabels[status]}</option>)}</select></label>
        <span className="task-result-count">{visible.length} / {tasks.data?.length ?? 0} 个任务</span>
      </div>
      <p className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</p>
      {!online && <p role="alert">当前离线。显示最近读取的任务；恢复连接后再保存或迁移。</p>}
      {(error || tasks.error) && <div role="alert">{error || message(tasks.error)}<Button variant="outline" onClick={refresh}>重新加载</Button></div>}
      {intent && <Button variant="outline" disabled={busy || tasks.isFetching} onClick={() => { const task = tasks.data?.find(item => item.id === intent.id); if (task) void move(task, intent.status) }}>已核对最新状态，重新确认迁移至 {statusLabels[intent.status]}</Button>}
      {tasks.isPending ? <div className="task-board grid gap-3 md:grid-cols-2 xl:grid-cols-4" role="status" aria-label="正在加载任务">{boardStatuses.map(status => <div key={status} className="space-y-3 rounded-xl border border-border p-3"><Skeleton className="h-5 w-24" /><Skeleton className="h-28 w-full" /><Skeleton className="h-24 w-full" /></div>)}</div> : <>{!tasks.data?.length && <div className="task-board-empty"><h2>开始规划团队工作</h2><p>创建第一个任务，定义目标、验收标准和执行环境。</p><Button onClick={() => setCreating(true)}>新建任务</Button></div>}{view === 'list' || filter === 'cancelled' ? <div className="task-list">{visible.map(task => card(task, true))}{!visible.length && <p className="task-no-results">没有符合条件的任务。</p>}</div> : <div className="task-board" role="region" aria-label="任务看板" tabIndex={0}>{boardStatuses.map(status => { const columnTasks = visible.filter(task => task.status === status); return <TaskColumn key={status} status={status} count={columnTasks.length} empty={!columnTasks.length} canCreate={status === 'backlog'} onCreate={() => setCreating(true)} onDragOver={event => { if (drag.current) { event.preventDefault(); event.dataTransfer.dropEffect = 'move' } }} onDrop={event => { event.preventDefault(); const task = tasks.data?.find(item => item.id === drag.current); drag.current = null; if (task) void move(task, status) }}>{columnTasks.map(task => card(task))}</TaskColumn> })}</div>}</>}
      {creating && <CreationDialog title="新建任务" description="先定义目标和验收标准。创建后，在任务中准备工作区，再选择智能体和模型启动运行；任务不会自动执行。" busy={createBusy} onClose={closeCreate} footer={<><Button type="button" variant="outline" disabled={createBusy} onClick={closeCreate}>取消</Button><Button type="submit" form="create-task-form" disabled={createBusy}>{createBusy ? '正在创建…' : '创建'}</Button></>}><TaskForm formId="create-task-form" onDirty={value => { createDirty.current = value }} onBusy={setCreateBusy} onCancel={closeCreate} onSave={async fields => { const task = await api.createTask(projectId, { ...fields, title: fields.title ?? '' }); createDirty.current = false; setCreating(false); refresh(); open(task.id) }} /></CreationDialog>}
    </section>
    <InspectorHost open={Boolean(taskId)} onOpenChange={open => { if (!open) close() }}>
      {detail.isPending ? <div className="space-y-4" role="status" aria-label="正在加载任务详情"><Skeleton className="h-7 w-2/3" /><Skeleton className="h-5 w-32" /><Skeleton className="h-28 w-full" /><Skeleton className="h-10 w-full" /></div> : detail.error ? <p role="alert">{message(detail.error)}</p> : detail.data && <><h2 className="text-lg font-semibold">{detail.data.title}</h2><div className="mt-2 flex items-center gap-2"><TaskStatusBadge status={detail.data.status} /><span className="text-xs text-muted-foreground">v{detail.data.version}</span></div><details className="my-3 border-y border-border py-2 text-xs"><summary className="cursor-pointer py-1 font-medium">任务怎么执行？</summary><ol className="list-decimal space-y-2 py-3 pl-5 text-muted-foreground"><li>详情：定义目标和验收标准，将任务从待规划移到待开始。</li><li>工作区：绑定执行环境，选择工作节点、智能体和模型，保存指派。</li><li>运行：确认指令并启动，每次执行保留当时的指派快照；会话记录对话和工具输出。</li><li>审查：核对产出后提交审查，通过才完成；需要修改则阻塞，调整后继续。</li></ol><p className="pb-2 text-muted-foreground">一个任务可有多次运行，同一时刻最多一个活跃运行。修改指派只影响后续运行；运行成功不会自动完成任务。</p></details><nav className="flex flex-wrap gap-2 py-4" aria-label="任务详情页签">{[['details', '详情'], ['activity', '活动'], ['workspaces', '工作区'], ['runs', '运行']].map(([value, label]) => <Button key={value} variant="outline" aria-pressed={tab === value} onClick={() => updateSearch('tab', value)}>{label}</Button>)}</nav><div hidden={tab !== 'details'}><TaskForm key={taskId} task={detail.data} onDirty={value => markDirty('content', value)} onReload={() => api.task(projectId, taskId)} onSave={async fields => { await client.cancelQueries({ queryKey: projectKeys.task(projectId, taskId) }); const saved = await api.patchTask(projectId, taskId, fields); await client.cancelQueries({ queryKey: projectKeys.task(projectId, taskId) }); client.setQueryData(projectKeys.task(projectId, taskId), saved); refresh(); return saved }} /><dl className="my-4 text-sm"><dt>创建时间</dt><dd>{detail.data.createdAt}</dd><dt>更新时间</dt><dd>{detail.data.updatedAt}</dd><dt>最近活动</dt><dd>{detail.data.lastActivityAt}</dd></dl><TaskLinks task={detail.data} api={api} refresh={refresh} /><p className="mt-4 text-sm text-muted-foreground">当前指派：{detail.data.assignee ? `${detail.data.assignee.agentKey} / ${detail.data.assignee.modelId}` : '未指派'}。只影响后续运行。</p></div>{tab === 'activity' && <TaskActivityPanel api={api} projectId={projectId} taskId={taskId} />}<div hidden={tab !== 'workspaces'}><TaskWorkspaces key={taskId} task={detail.data} api={api} refresh={refresh} onDirty={value => markDirty('workspace', value)} /></div>{tab === 'runs' && <TaskRuns key={taskId} onDirty={value => markDirty('run', value)} task={detail.data} api={api} refresh={refresh} search={search} selectRun={id => updateSearch('run', id)} />}</>}
    </InspectorHost>
  </div>
}
function TaskForm({ task, onSave, onDirty, onReload, onCancel, onBusy, formId }: { onCancel?: () => void; onBusy?: (busy: boolean) => void; task?: TaskDetail; onDirty: (value: boolean) => void; onSave: (fields: TaskContentPatch) => Promise<TaskDetail | void>; onReload?: () => Promise<TaskDetail>; formId?: string }) {
  const confirm = useConfirmDialog()
  const [draft] = useState(() => new TaskDraft(task)), [, render] = useState(0)
  const [error, setError] = useState(''), [saving, setSaving] = useState(false), [reloading, setReloading] = useState(false)
  const pending = useRef(false), dirtyCallback = useRef(onDirty)
  dirtyCallback.current = onDirty
  const update = () => { dirtyCallback.current(draft.dirty); render(value => value + 1) }
  useEffect(() => { if (task && !pending.current) { draft.receive(task); dirtyCallback.current(draft.dirty); render(value => value + 1) } }, [task, draft])
  const edit = (key: keyof typeof draft.values, value: string) => { draft.edit(key, value); update() }
  const values = draft.values
  return <form id={formId} className="space-y-3" onSubmit={event => { event.preventDefault(); if (pending.current) return; pending.current = true; setSaving(true); onBusy?.(true); setError(''); void (async () => { try { const { snapshot, patch } = draft.submission(!task); const saved = Object.keys(patch).length ? await onSave(patch) : undefined; draft.saved(snapshot, patch, saved || undefined); update() } catch (cause) { setError(message(cause)) } finally { pending.current = false; setSaving(false); onBusy?.(false) } })() }}>
    <label className="grid gap-2 text-xs">标题<Input autoFocus={!task} aria-label="标题" required maxLength={200} value={values.title} onChange={event => edit('title', event.target.value)} /></label><label className="grid gap-2 text-xs">描述<Textarea aria-label="描述" value={values.description} onChange={event => edit('description', event.target.value)} /></label><label className="grid gap-2 text-xs">验收标准<Textarea aria-label="验收标准" value={values.acceptanceCriteria} onChange={event => edit('acceptanceCriteria', event.target.value)} /></label><label className="grid gap-2 text-xs">优先级<select className="h-10 rounded-md border border-border bg-background px-3 text-sm" value={values.priority} onChange={event => edit('priority', event.target.value)}>{[['none', '无'], ['low', '低'], ['medium', '中'], ['high', '高']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><details><summary className="cursor-pointer py-2 text-xs text-muted-foreground">高级设置</summary><label className="grid gap-2 text-xs">Metadata JSON（schemaVersion 1）<Textarea aria-label="Metadata JSON（schemaVersion 1）" value={values.metadataJson} onChange={event => edit('metadataJson', event.target.value)} /></label></details>
    {draft.remoteChanged && <p role="alert">远端内容已变化；保留了本地草稿，请核对后保存或重新加载。</p>}
    {onReload && <Button type="button" variant="outline" disabled={saving || reloading} onClick={() => {
      if (pending.current) return
      void (async () => {
      if (draft.dirty && !await confirm({ title: '重新加载任务', description: '放弃未保存的修改并重新加载最新内容？', confirmLabel: '重新加载', danger: true })) return
      const revision = draft.revision
      pending.current = true; setReloading(true); setError('')
      void (async () => {
        try {
          const latest = await onReload()
          const applied = draft.reload(latest, revision)
          update(); setError(applied ? '' : '重新加载期间有新输入，已保留草稿；可再次重新加载。')
        } catch (cause) { setError(message(cause)) }
        finally { pending.current = false; setReloading(false) }
      })()
      })()
    }}>{reloading ? '重新加载中…' : '重新加载'}</Button>}
    {error && <p role="alert">{error}</p>}<p role="status">{draft.dirty ? '有未保存的修改' : '无未保存的修改'}</p>{!formId && <DialogFooter className="shrink-0 border-t border-white/10 bg-card px-6 py-4">{onCancel && <Button type="button" variant="outline" disabled={saving} onClick={onCancel}>取消</Button>}<Button disabled={saving || reloading}>{saving ? task ? '保存中…' : '正在创建…' : task ? '保存任务' : '创建'}</Button></DialogFooter>}
  </form>
}
function TaskLinks({ task, api, refresh }: { task: TaskDetail; api: Api; refresh: () => void }) {
  const [url, setUrl] = useState(''), [error, setError] = useState('')
  return <section><h3>GitHub 关联（不自动同步）</h3>{!task.links.length && <p>暂无关联</p>}{task.links.map(link => <div key={link.id}><a className="underline" href={link.url} target="_blank" rel="noreferrer">{link.externalId} · {link.type}</a><Button variant="ghost" onClick={() => { void api.removeTaskLink(task.projectId, task.id, link.id).then(refresh).catch(cause => setError(message(cause))) }}>移除关联</Button></div>)}<form onSubmit={event => { event.preventDefault(); setError(''); void api.addTaskLink(task.projectId, task.id, url).then(() => { setUrl(''); refresh() }).catch(cause => setError(message(cause))) }}><Input aria-label="GitHub URL" className="w-full" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://github.com/owner/repo/issues/1" /><Button variant="outline">添加关联</Button></form>{error && <p role="alert">{error}</p>}</section>
}
function TaskActivityPanel({ api, projectId, taskId }: { api: Api; projectId: string; taskId: string }) {
  const client = useQueryClient()
  const activity = useQuery({ ...projectActivityOptions(api, projectId, client), select: items => items.filter(item => item.activity.taskId === taskId).map(item => item.activity) })
  return <section aria-label="任务活动">{activity.isPending ? <p role="status">正在读取活动…</p> : activity.error ? <p role="alert">{message(activity.error)}</p> : <ol>{activity.data?.map(event => <li key={event.seq} className="border-b border-border py-3"><strong>#{event.seq} {event.type}</strong><p>{event.actor} · {event.occurredAt}</p><pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(event.payload)}</pre><p className="break-all text-xs">requestId: {event.requestId}</p></li>)}</ol>}</section>
}
