import { taskListView, type TaskListSort } from '../lib/task-list-view.ts'
import { TaskCreateForm } from './TaskCreateForm.tsx'
import { navigate } from '../lib/navigation.ts'
import { useState } from 'react'
import type { ProjectDTO } from '@wemux/web-contract/browser-host'
import type { TaskSummary, TaskStatus } from '@wemux/web-contract/task-platform'
import { type ProjectClient } from './ProjectManagement.tsx'
import { AccountSection, useAccountData } from './AccountForms.tsx'
import { Button, Input } from './primitives.tsx'
import { TaskDetailPanel } from './TaskDetailPanel.tsx'
export const taskLabels: Record<TaskStatus, string> = { backlog: '待规划', todo: '待处理', in_progress: '进行中', in_review: '待审查', blocked: '已阻塞', done: '已完成', cancelled: '已取消' }
export function ProjectTasks({ api, project, search }: { api: ProjectClient; project: ProjectDTO; search: string }) {
  const state = useAccountData(() => api.tasks(project.id), [api, project.id, project.accessRole])
  const selected = new URLSearchParams(search).get('task') ?? ''
  const sessionId = new URLSearchParams(search).get('session') ?? ''
  const runId = new URLSearchParams(search).get('run') ?? ''
  const select = (taskId: string, session: string) => {
    const params = new URLSearchParams(search)
    if (!taskId || taskId !== selected) params.delete('run')
    if (taskId) params.set('task', taskId); else params.delete('task')
    if (session && taskId) params.set('session', session); else params.delete('session')
    navigate(`/next/projects/${encodeURIComponent(project.id)}${params.size ? `?${params}` : ''}${window.location.hash}`)
  }
  const setSelected = (id: string) => select(id, '')
  const [mode, setMode] = useState('list'), [sort, setSort] = useState<TaskListSort>('updated')
  // Like the current view/sort controls, filters are memory-only and retire with Project/identity.
  const [query, setQuery] = useState(''), [status, setStatus] = useState('')
  const tasks = taskListView(state.data ?? [], query, status, sort)
  const row = (task: TaskSummary) => <li className="account-row" data-task-id={task.id} key={task.id}><Button variant="ghost" onClick={() => setSelected(task.id)}>{task.title}</Button><span>{taskLabels[task.status]} · {task.priority}</span></li>
  return <><AccountSection title="项目任务"><div className="account-actions"><label>搜索任务标题<Input type="search" aria-label="搜索任务标题" placeholder="搜索任务标题" value={query} onChange={event => setQuery(event.target.value)} /></label><label>状态筛选<select aria-label="状态筛选" value={status} onChange={event => setStatus(event.target.value)}><option value="">所有状态</option>{Object.entries(taskLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><Button variant="outline" disabled={!query && !status} onClick={() => { setQuery(''); setStatus('') }}>清除任务筛选</Button><Button variant="outline" onClick={state.reload}>刷新任务</Button><label>任务视图<select aria-label="任务视图" value={mode} onChange={event => setMode(event.target.value)}><option value="list">列表</option><option value="board">看板</option></select></label><label>任务排序<select aria-label="任务排序" value={sort} onChange={event => setSort(event.target.value as TaskListSort)}><option value="updated">最近更新</option><option value="title">名称</option><option value="priority">优先级</option></select></label></div>{state.feedback}{state.data && <p role="status" aria-live="polite">显示 {tasks.length} / {state.data.length} 个任务</p>}
    {project.accessRole !== 'viewer' && <TaskCreateForm key={selected} api={api} projectId={project.id} created={id => { setSelected(id); state.reload() }} />}
    {mode === 'list' ? <ul>{tasks.map(row)}</ul> : <div className="task-board">{Object.entries(taskLabels).map(([status, label]) => <section key={status} aria-label={`${label}任务`}><h3>{label}</h3><ul>{tasks.filter(task => task.status === status).map(row)}</ul></section>)}</div>}
    {state.data && !tasks.length && <p>{state.data.length ? '没有匹配的任务。' : '还没有任务。'}</p>}<p className="muted">排序仅影响当前视图，不改变任务归属。手工拖动持久排序尚未实现。永久删除的任务仅保留获权只读历史。运行成功不会自动完成任务。</p></AccountSection>
    {selected && <TaskDetailPanel key={JSON.stringify([api.taskSessionScope, project.id, selected, project.accessRole])} api={api} project={project} taskId={selected} sessionId={sessionId} runId={runId} selectSession={id => select(selected, id)} changed={state.reload} close={() => setSelected('')} />}
  </>
}
