import { TaskSessions } from './TaskSessions.tsx'
import { TaskRuns } from './TaskRuns.tsx'
import { TaskDeletion } from './TaskDeletion.tsx'
import { TaskWorkspaces } from './TaskWorkspaces.tsx'
import { TaskContentEditor } from './TaskContentEditor.tsx'
import type { ProjectDTO } from '@wemux/web-contract/browser-host'
import type { TaskStatus } from '@wemux/web-contract/task-platform'
import type { ProjectClient } from './ProjectManagement.tsx'
import { AccountSection, ActionForm, ConfirmButton, useAccountData } from './AccountForms.tsx'
import { Button } from './primitives.tsx'
import { useState } from 'react'
import { taskLabels } from './ProjectTasks.tsx'
export function TaskDetailPanel({ api, project, taskId, sessionId, runId, selectSession, changed, close }: { api: ProjectClient; project: ProjectDTO; taskId: string; sessionId: string; runId: string; selectSession: (id: string) => void; changed: () => void; close: () => void }) {
  const [pendingRefresh, setPendingRefresh] = useState<{ version: number; id: string } | null>(null)
  const state = useAccountData(() => Promise.all([api.task(project.id, taskId), api.workspaces(project.id, 'all'), api.workers(), api.taskActivity(project.id, taskId)]), [api, project.id, taskId])
  const reload = () => { state.reload(); changed() }
  const reconcile = (version: number) => { setPendingRefresh({ version, id: taskId }); reload() }
  const task = state.data?.[0]
  const ready = pendingRefresh === null || (pendingRefresh.id === taskId && !!task && task.version > pendingRefresh.version && state.ready), writable = project.accessRole !== 'viewer' && !task?.deletedAt
  return <AccountSection title="任务详情"><div className="account-actions"><Button variant="outline" onClick={close}>关闭详情</Button><Button variant="outline" onClick={reload}>加载最新版本</Button></div>{state.feedback}{task && <><h3>{task.title}</h3><p>版本 {task.version}，{taskLabels[task.status]}</p><p className="muted">并发冲突时保留表单内容。点击“加载最新版本”核实状态，再决定是否重新提交；状态修改由服务端版本校验；内容修改的限制见下方。</p>
    {task.deletedAt ? <div role="status"><h3>任务已永久删除</h3><p>删除时间：{task.deletedAt}。只读历史，不能恢复；工作区和文件独立保留。</p><p>{task.description}</p><pre>{task.acceptanceCriteria}</pre></div> : <TaskContentEditor api={api} task={task} writable={writable} changed={reload} />}
    <ActionForm label="更新任务状态" disabled={!writable} submit={async ({ status }) => { await api.patchTask(project.id, taskId, { status: status as TaskStatus, version: task.version }); reload(); return '任务状态已更新。' }}><label>任务状态<select name="status" defaultValue={task.status}>{Object.entries(taskLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label></ActionForm>
    <TaskRuns key={JSON.stringify([api.taskSessionScope, project.id, task.id])} api={api} project={project} task={task} runId={runId} selectSession={selectSession} changed={reload} reconcile={reconcile} reconciliationReady={ready} />
    <TaskSessions api={api} project={project} task={task} sessionId={sessionId} selectSession={selectSession} />
    <h3>外部关联</h3><ul>{task.links.map(link => <li className="account-row" key={link.id}><a href={link.url} target="_blank" rel="noreferrer">{link.title ?? link.url}</a>{writable && <ConfirmButton confirm="移除此外部关联？" act={async () => { await api.removeTaskLink(project.id, taskId, link.id); reload() }}>移除关联</ConfirmButton>}</li>)}</ul>{writable && <ActionForm label="添加外部关联" fields={[{ name: 'url', label: 'GitHub Issue 或 Pull Request URL', type: 'url' }]} submit={async ({ url }) => { await api.addTaskLink(project.id, taskId, url); reload() }} />}
    <h3>任务工作区</h3>{task.workspaces.map(binding => <div className="account-row" key={binding.workspaceId}>{state.data![1].find(workspace => workspace.id === binding.workspaceId)?.name ?? binding.workspaceId}{writable && <ConfirmButton confirm="解绑工作区？关联指派将按当前版本校验，目录与文件不会删除。" act={async () => { await api.unbindTaskWorkspace(project.id, taskId, binding.workspaceId, task.version); reload(); return '已解绑，工作区独立保留。' }}>解绑工作区</ConfirmButton>}</div>)}
    {writable && <ActionForm label="绑定工作区" submit={async ({ workspaceId }) => { await api.bindTaskWorkspace(project.id, taskId, workspaceId); reload() }}><label>项目工作区<select name="workspaceId" required><option value="">选择工作区</option>{state.data![1].filter(workspace => !task.workspaces.some(binding => binding.workspaceId === workspace.id)).map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></label></ActionForm>}
    {writable && <TaskWorkspaces api={api} task={task} workspaces={state.data![1]} workers={state.data![2]} teamId={project.teamId} changed={reload} />}
    <h3>执行指派</h3><p>{task.assignee ? `${task.assignee.agentKey} / ${task.assignee.modelId ?? '默认模型'}` : '未指派'}</p>
    {writable && <><ActionForm label="保存执行指派" submit={async ({ target }) => { const [workspaceId, workerId, agentKey, modelId] = JSON.parse(target) as string[]; await api.assignTask(project.id, taskId, { workspaceId, workerId, agentKey, modelId: modelId || null }, task.version); reload() }}><label>可用执行环境<select name="target" required><option value="">选择已绑定工作区的执行环境</option>{state.data![1].filter(workspace => task.workspaces.some(binding => binding.workspaceId === workspace.id)).flatMap(workspace => workspace.placements.filter(placement => placement.status === 'ready').flatMap(placement => state.data![2].filter(worker => worker.id === placement.workerId && worker.connectionState === 'online').flatMap(worker => worker.capabilities.filter(agent => agent.mode === 'execution' && agent.availability.status === 'available').flatMap(agent => agent.models.map(model => <option key={JSON.stringify([workspace.id, worker.id, agent.agentKey, model.modelId])} value={JSON.stringify([workspace.id, worker.id, agent.agentKey, model.modelId])}>{workspace.name} / {worker.name} / {agent.displayName} / {model.displayName}</option>)))))}</select></label></ActionForm>{task.assignee && <ConfirmButton confirm="清除执行指派？运行中可能被拒绝。" act={async () => { await api.assignTask(project.id, taskId, null, task.version); reload() }}>清除指派</ConfirmButton>}</>}
    {!task.deletedAt && ['owner', 'manager'].includes(project.accessRole) && <TaskDeletion api={api} task={task} changed={reload} />}
    <h3>活动</h3><ol>{state.data![3].map(activity => <li className="account-row" key={activity.seq}><time>{activity.occurredAt}</time> {activity.type}<pre>{JSON.stringify(activity.payload, null, 2)}</pre></li>)}</ol>
  </>}</AccountSection>
}
