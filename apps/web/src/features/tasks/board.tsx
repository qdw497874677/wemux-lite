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
import { Textarea } from '../../components/ui/textarea'

export const statusLabels: Record<TaskStatus, string> = { backlog: 'Backlog', todo: 'Ready', in_progress: 'In Progress', in_review: 'Review', done: 'Done', blocked: 'Blocked', cancelled: 'Cancelled' }
const message = (error: unknown) => error instanceof Error ? error.message : '请求失败'
export function TaskBoard({ api, projectId, taskId, search, go }: { api: Api; projectId: string; taskId: string; search: string; go: (path: string) => void }) {
  const client = useQueryClient(), key = projectKeys.tasks(projectId)
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
    if (task.status === 'in_review' && ['done', 'in_progress'].includes(status) && !window.confirm(`确认将 ${task.title} 从 Review 迁移至 ${statusLabels[status]}？这将结束当前审查周期。`)) return
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
  const card = (task: TaskSummary) => <article key={task.id} className="task-card" draggable={!busy && online} onDragStart={event => { drag.current = task.id; event.dataTransfer.setData('text/plain', task.id); event.dataTransfer.effectAllowed = 'move' }} onDragEnd={() => { drag.current = null }}>
    <a href={`${base}/tasks/${encodeURIComponent(task.id)}${search}`} onClick={event => { event.preventDefault(); open(task.id) }} className="block font-medium break-words">{task.title}</a>
    <p className="text-xs text-muted-foreground">{task.assignee ? `${task.assignee.agentKey} / ${task.assignee.modelId} · ` : ''}{task.priority} · {task.linkCount ? `${task.linkCount} 个关联` : '无关联'}</p>
    <label className="block text-xs">迁移状态<select id={`task-state-${task.id}`} aria-label={`${task.title} 状态`} value={task.status} disabled={busy || !online} onChange={event => void move(task, event.target.value as TaskStatus)}>{taskStatuses.map(status => <option key={status} value={status} disabled={!(task.capabilities?.transitions[status] ?? unavailableCapability).allowed}>{statusLabels[status]}{task.capabilities?.transitions[status]?.allowed ? '' : ` · ${(task.capabilities?.transitions[status] ?? unavailableCapability).reason}`}</option>)}</select></label>
  </article>
  return <div className="task-workbench">
    <section className="task-canvas" aria-label="任务看板">
      <header className="flex flex-wrap items-center gap-3"><h1 className="mr-auto text-lg font-semibold">任务看板</h1><Button data-inspector-trigger onClick={() => setCreating(true)}>创建任务</Button></header>
      <div className="flex flex-wrap gap-2 py-4"><Input aria-label="搜索任务" value={query} onChange={event => updateSearch('q', event.target.value)} placeholder="搜索任务标题" className="max-w-64" /><label>视图<select aria-label="任务视图" value={view} onChange={event => updateSearch('view', event.target.value)}><option value="board">看板</option><option value="list">列表</option></select></label><label>筛选<select aria-label="状态筛选" value={filter} onChange={event => updateSearch('filter', event.target.value)}><option value="">所有状态</option>{taskStatuses.map(status => <option value={status} key={status}>{statusLabels[status]}</option>)}</select></label></div>
      <p className="text-xs text-muted-foreground mb-3">六列工作流：Ready = todo；Cancelled 从列表或筛选打开。拖动卡片到列标题下的接收区，或使用每张卡片的状态菜单（支持键盘与触屏）。</p>
      <p className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</p>
      {!online && <p role="alert">当前离线。显示最近读取的任务；恢复连接后再保存或迁移。</p>}
      {(error || tasks.error) && <div role="alert">{error || message(tasks.error)}<Button variant="outline" onClick={refresh}>重新加载</Button></div>}
      {intent && <Button variant="outline" disabled={busy || tasks.isFetching} onClick={() => { const task = tasks.data?.find(item => item.id === intent.id); if (task) void move(task, intent.status) }}>已核对最新状态，重新确认迁移至 {statusLabels[intent.status]}</Button>}
      {tasks.isPending ? <p role="status">正在加载任务…</p> : <>{!tasks.data?.length && <p className="py-5">尚无任务。创建第一个任务，记录目标和验收标准。</p>}{view === 'list' || filter === 'cancelled' ? <div className="task-list">{visible.map(card)}{!visible.length && <p>没有符合条件的任务。</p>}</div> : <div className="task-board" role="region" aria-label="任务看板" tabIndex={0}>{boardStatuses.map(status => <section key={status} aria-label={`${statusLabels[status]} 列`} className="task-column"><h2>{statusLabels[status]} <span aria-label="任务数量">{visible.filter(task => task.status === status).length}</span></h2><div className="task-drop" onDragOver={event => { if (drag.current) { event.preventDefault(); event.dataTransfer.dropEffect = 'move' } }} onDrop={event => { event.preventDefault(); const task = tasks.data?.find(item => item.id === drag.current); drag.current = null; if (task) void move(task, status) }}>拖放到 {statusLabels[status]}</div>{visible.filter(task => task.status === status).map(card)}{!visible.some(task => task.status === status) && <p className="p-3 text-sm text-muted-foreground">暂无任务</p>}</section>)}</div>}</>}
      {creating && <section className="my-4 border border-border p-4" aria-label="创建任务"><h2>创建任务</h2><TaskForm onDirty={() => {}} onSave={async fields => { const task = await api.createTask(projectId, { ...fields, title: fields.title ?? '' }); setCreating(false); refresh(); open(task.id) }} /><Button variant="ghost" onClick={() => setCreating(false)}>取消创建</Button></section>}
    </section>
    <InspectorHost open={Boolean(taskId)} onOpenChange={open => { if (!open) close() }}>
      {detail.isPending ? <p role="status">正在加载任务详情…</p> : detail.error ? <p role="alert">{message(detail.error)}</p> : detail.data && <><h2 className="text-lg font-semibold">{detail.data.title}</h2><p>{statusLabels[detail.data.status]} · {detail.data.priority} · v{detail.data.version}</p><nav className="flex flex-wrap gap-2 py-4" aria-label="任务详情页签">{[['details', '详情'], ['activity', '活动'], ['workspaces', '工作区'], ['runs', '运行']].map(([value, label]) => <Button key={value} variant="outline" aria-pressed={tab === value} onClick={() => updateSearch('tab', value)}>{label}</Button>)}</nav><div hidden={tab !== 'details'}><TaskForm key={taskId} task={detail.data} onDirty={value => markDirty('content', value)} onReload={() => api.task(projectId, taskId)} onSave={async fields => { await client.cancelQueries({ queryKey: projectKeys.task(projectId, taskId) }); const saved = await api.patchTask(projectId, taskId, fields); await client.cancelQueries({ queryKey: projectKeys.task(projectId, taskId) }); client.setQueryData(projectKeys.task(projectId, taskId), saved); refresh(); return saved }} /><dl className="my-4 text-sm"><dt>创建时间</dt><dd>{detail.data.createdAt}</dd><dt>更新时间</dt><dd>{detail.data.updatedAt}</dd><dt>最近活动</dt><dd>{detail.data.lastActivityAt}</dd></dl><TaskLinks task={detail.data} api={api} refresh={refresh} /><p className="mt-4 text-sm text-muted-foreground">当前指派：{detail.data.assignee ? `${detail.data.assignee.agentKey} / ${detail.data.assignee.modelId}` : '未指派'}。只影响后续运行。</p></div>{tab === 'activity' && <TaskActivityPanel api={api} projectId={projectId} taskId={taskId} />}<div hidden={tab !== 'workspaces'}><TaskWorkspaces key={taskId} task={detail.data} api={api} refresh={refresh} onDirty={value => markDirty('workspace', value)} /></div>{tab === 'runs' && <TaskRuns key={taskId} onDirty={value => markDirty('run', value)} task={detail.data} api={api} refresh={refresh} search={search} selectRun={id => updateSearch('run', id)} />}</>}
    </InspectorHost>
  </div>
}
function TaskForm({ task, onSave, onDirty, onReload }: { task?: TaskDetail; onDirty: (value: boolean) => void; onSave: (fields: TaskContentPatch) => Promise<TaskDetail | void>; onReload?: () => Promise<TaskDetail> }) {
  const [draft] = useState(() => new TaskDraft(task)), [, render] = useState(0)
  const [error, setError] = useState(''), [saving, setSaving] = useState(false), [reloading, setReloading] = useState(false)
  const pending = useRef(false), dirtyCallback = useRef(onDirty)
  dirtyCallback.current = onDirty
  const update = () => { dirtyCallback.current(draft.dirty); render(value => value + 1) }
  useEffect(() => { if (task && !pending.current) { draft.receive(task); dirtyCallback.current(draft.dirty); render(value => value + 1) } }, [task, draft])
  const edit = (key: keyof typeof draft.values, value: string) => { draft.edit(key, value); update() }
  const values = draft.values
  return <form className="space-y-3" onSubmit={event => { event.preventDefault(); if (pending.current) return; pending.current = true; setSaving(true); setError(''); void (async () => { try { const { snapshot, patch } = draft.submission(!task); const saved = Object.keys(patch).length ? await onSave(patch) : undefined; draft.saved(snapshot, patch, saved || undefined); update() } catch (cause) { setError(message(cause)) } finally { pending.current = false; setSaving(false) } })() }}>
    <label className="block">标题<Input aria-label="标题" required maxLength={200} value={values.title} onChange={event => edit('title', event.target.value)} /></label><label className="block">描述<Textarea aria-label="描述" value={values.description} onChange={event => edit('description', event.target.value)} /></label><label className="block">验收标准<Textarea aria-label="验收标准" value={values.acceptanceCriteria} onChange={event => edit('acceptanceCriteria', event.target.value)} /></label><label className="block">优先级<select value={values.priority} onChange={event => edit('priority', event.target.value)}>{['none', 'low', 'medium', 'high'].map(value => <option key={value}>{value}</option>)}</select></label><label className="block">Metadata JSON（schemaVersion 1）<Textarea aria-label="Metadata JSON（schemaVersion 1）" value={values.metadataJson} onChange={event => edit('metadataJson', event.target.value)} /></label>
    {draft.remoteChanged && <p role="alert">远端内容已变化；保留了本地草稿，请核对后保存或重新加载。</p>}
    {onReload && <Button type="button" variant="outline" disabled={saving || reloading} onClick={() => {
      if (pending.current || (draft.dirty && !window.confirm('放弃未保存的修改并重新加载？'))) return
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
    }}>{reloading ? '重新加载中…' : '重新加载'}</Button>}
    {error && <p role="alert">{error}</p>}<p role="status">{draft.dirty ? '有未保存的修改' : '无未保存的修改'}</p><Button disabled={saving || reloading}>{saving ? '保存中…' : task ? '保存任务' : '提交创建'}</Button>
  </form>
}
function TaskLinks({ task, api, refresh }: { task: TaskDetail; api: Api; refresh: () => void }) {
  const [url, setUrl] = useState(''), [error, setError] = useState('')
  return <section><h3>GitHub 关联（不自动同步）</h3>{!task.links.length && <p>暂无关联</p>}{task.links.map(link => <div key={link.id}><a className="underline" href={link.url} target="_blank" rel="noreferrer">{link.externalId} · {link.type}</a><Button variant="ghost" onClick={() => { void api.removeTaskLink(task.projectId, task.id, link.id).then(refresh).catch(cause => setError(message(cause))) }}>移除关联</Button></div>)}<form onSubmit={event => { event.preventDefault(); setError(''); void api.addTaskLink(task.projectId, task.id, url).then(() => { setUrl(''); refresh() }).catch(cause => setError(message(cause))) }}><Input aria-label="GitHub URL" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://github.com/owner/repo/issues/1" /><Button variant="outline">添加关联</Button></form>{error && <p role="alert">{error}</p>}</section>
}
function TaskActivityPanel({ api, projectId, taskId }: { api: Api; projectId: string; taskId: string }) {
  const client = useQueryClient()
  const activity = useQuery({ ...projectActivityOptions(api, projectId, client), select: items => items.filter(item => item.activity.taskId === taskId).map(item => item.activity) })
  return <section aria-label="任务活动">{activity.isPending ? <p role="status">正在读取活动…</p> : activity.error ? <p role="alert">{message(activity.error)}</p> : <ol>{activity.data?.map(event => <li key={event.seq} className="border-b border-border py-3"><strong>#{event.seq} {event.type}</strong><p>{event.actor} · {event.occurredAt}</p><pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(event.payload)}</pre><p className="break-all text-xs">requestId: {event.requestId}</p></li>)}</ol>}</section>
}
