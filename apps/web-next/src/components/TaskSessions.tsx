import { SessionConversation } from './SessionConversation.tsx'
import { useMemo, useRef, useState } from 'react'
import { PendingTaskSession, type TaskSessionIntent } from '@wemux/web-client'
import type { CreateTaskSessionRequest, TaskDetail, TaskSessionView } from '@wemux/web-contract/task-platform'
import type { ProjectDTO, WorkspaceDTO, WorkerDTO } from '@wemux/web-contract/browser-host'
import type { ProjectClient } from './ProjectManagement.tsx'
import { accountError, useAccountData } from './AccountForms.tsx'
import { Button, Input } from './primitives.tsx'
import { useOperationLifetime } from '../lib/operation-lifetime.ts'
import { taskSessionOptions } from '../lib/task-session-options.ts'

const runtimeLabels: Record<TaskSessionView['runtimeState'], string> = { idle: '空闲', queued: '排队中', running: '运行中', stopping: '停止中', unavailable: '不可用', failed: '失败' }
const freshnessLabels: Record<TaskSessionView['freshness']['status'], string> = { unknown: '尚未确认', syncing: '同步中', synced: '已同步', gap: '存在缺口', offline: 'Worker 离线', orphaned: '无法恢复' }
type Props = { api: ProjectClient; project: ProjectDTO; task: TaskDetail; sessionId: string; selectSession: (id: string) => void }
export function TaskSessions(props: Props) {
  const { api, project, task } = props
  return <TaskSessionsScope key={JSON.stringify([api.taskSessionScope, project.id, task.id, project.accessRole])} {...props} />
}
function TaskSessionsScope({ api, project, task, sessionId, selectSession }: Props) {
  const writable = project.accessRole !== 'viewer' && !task.deletedAt
  const begin = useOperationLifetime([api, project.id, task.id, writable])
  const pending = useMemo(() => new PendingTaskSession(() => window.sessionStorage, { ...api.taskSessionScope, projectId: project.id, taskId: task.id }), [api, project.id, task.id])
  const [saved, setSaved] = useState<Readonly<CreateTaskSessionRequest> | null>(() => { try { return pending.read() } catch { return null } })
  const [storageError, setStorageError] = useState(() => { try { pending.read(); return '' } catch (cause) { return accountError(cause) } })
  const [title, setTitle] = useState(task.title), [target, setTarget] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const inFlight = useRef(false)
  const resources = useAccountData<[WorkspaceDTO[], WorkerDTO[]]>(() => writable ? Promise.all([api.workspaces(project.id, 'all'), api.workers()]) : Promise.resolve([[], []]), [api, project.id, writable])
  const sessions = useAccountData(() => api.taskSessions(project.id, task.id), [api, project.id, task.id])
  const options = taskSessionOptions(project.id, project.teamId, resources.data?.[0] ?? [], resources.data?.[1] ?? [])
  const selected = options.find(option => option.key === target)
  function readPending() {
    try { setSaved(pending.read()); setStorageError('') }
    catch (cause) { setStorageError(accountError(cause)) }
  }
  function create() {
    return submit(() => {
      if (!selected || !title.trim()) throw Error('请选择完整执行环境并填写会话标题。')
      return { title: title.trim(), workspaceId: selected.workspaceId, workerId: selected.workerId, agentKey: selected.agentKey, modelId: selected.modelId }
    })
  }
  function retry() {
    if (!saved) return
    // A retry can join the shared operation, but must never supply a new intent.
    return submit(() => { throw reconciledRequest }, saved)
  }
  const reconciledRequest = useMemo(() => new Error('原请求已不再待确认，请核对最新会话列表。'), [])
  async function submit(intent: () => TaskSessionIntent, expected?: Readonly<CreateTaskSessionRequest>) {
    if (!writable || inFlight.current) return
    const active = begin()
    inFlight.current = true; setBusy(true); setError(''); setNotice('')
    try {
      const matches = (body: Readonly<CreateTaskSessionRequest> | null) => JSON.stringify(body) === JSON.stringify(expected)
      if (expected && !matches(pending.read())) throw reconciledRequest
      const result = await pending.run(intent, body => {
        // Recheck at send: another view may have replaced storage after the initial read.
        if (expected && !matches(body)) throw reconciledRequest
        return api.createTaskSession(project.id, task.id, body)
      })
      if (!active()) return
      // A joined operation may settle for a newer identity; do not claim it as this retry.
      if (expected && result.session.creation?.requestId !== expected.requestId) throw reconciledRequest
      setNotice(`已确认会话：${result.session.title}（${result.session.id}）。未启动 Run。`)
      sessions.reload()
    } catch (cause) {
      if (active()) {
        if (cause === reconciledRequest) { setNotice('保存的请求状态已变化，未发送新的创建请求。请核对最新会话列表和待确认请求。'); sessions.reload() }
        else setError(accountError(cause))
      }
    }
    finally { inFlight.current = false; if (active()) { setBusy(false); readPending() } }
  }
  return <section className="task-sessions" aria-label="任务会话">
    <h3>任务会话</h3><p>固定归属：{task.title}。可创建多个独立 Session，不改变任务指派或工作区关联，不启动 Run。</p>
    <p className="muted">此入口创建的会话按项目共享，由服务端校验访问权限。可打开会话查看历史，并在具备权限时发送消息、取消排队、停止当前 Turn 或处理审批。</p>
    {!writable && <p role="status">{task.deletedAt ? '任务已删除，不能创建会话。' : '当前为只读权限，可查看获权会话，不能创建。'}</p>}
    {sessionId && <SessionConversation api={api} project={project} taskId={task.id} sessionId={sessionId} close={() => selectSession('')} />}
    {storageError && <div role="alert">{storageError}<Button variant="outline" onClick={readPending}>重新读取保存请求</Button></div>}
    {saved && <div className="account-row" aria-label="待确认的会话请求"><h4>待确认的原请求</h4><p>{saved.title}</p><p>Workspace：{saved.workspaceId ?? '原任务指派'} / Worker：{saved.workerId ?? '原任务指派'} / Agent：{saved.agentKey ?? '原任务指派'} / Model：{saved.modelId ?? '原请求默认模型'}</p><p className="machine">请求标识：{saved.requestId}</p><p>创建结果尚未核对。重试将使用完全相同的请求，不采用下方改动或最新指派；刷新页面后仍可核对。</p><p>仅支持当前标签页刷新后恢复；关闭标签页或清除浏览器存储后不保证恢复，不保证跨标签页去重。</p><Button disabled={!writable || busy || !!storageError} onClick={() => void retry()}>重试原会话请求</Button></div>}
    {writable && <><div className="account-actions"><Button variant="outline" disabled={busy} onClick={resources.reload}>刷新会话执行环境</Button></div>{resources.feedback}
      <form className="account-form" onSubmit={event => { event.preventDefault(); if (!saved && !storageError) void create() }}><fieldset disabled={busy}>
        <label>会话标题<Input aria-label="会话标题" value={title} maxLength={200} required onChange={event => setTitle(event.target.value)} /></label>
        <label>会话执行环境<select aria-label="会话执行环境" value={target} onChange={event => setTarget(event.target.value)} required><option value="">选择 Workspace / Worker / Agent / Model</option>{options.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}</select></label>
        {selected && <p className="session-selection">已选择：{selected.label}。Placement 已就绪，Worker 在线；最终可执行性由服务端核验。</p>}
        {resources.data && !options.length && <p>没有可用执行环境。需要同项目未删除的 Workspace、已就绪 Placement、在线 Worker、可执行 Agent 和已上报的具体 Model。请核实授权与资源状态后刷新。</p>}
        <Button type="submit" disabled={!!saved || !!storageError || !selected || !title.trim()}>创建任务会话</Button>
      </fieldset></form></>}
    {busy && <p role="status">正在核对创建结果…</p>}{error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <Button variant="outline" onClick={sessions.reload}>刷新任务会话</Button>{sessions.feedback}
    {sessions.data && <><p role="status">当前获权会话：{sessions.data.length} 个</p>{!sessions.data.length && <p>此任务暂无当前账号可见的会话。</p>}<ul className="task-session-list">{sessions.data.map(session => <li className="account-row" key={session.id} data-session-id={session.id}><h4>{session.title}</h4><Button variant="outline" aria-pressed={sessionId === session.id} onClick={() => selectSession(session.id)}>查看会话：{session.title}</Button><p className="machine">{session.id}</p><p>运行状态：{runtimeLabels[session.runtimeState]}；历史新鲜度：{freshnessLabels[session.freshness.status]}（连续序号 {session.freshness.contiguousSeq} / Worker {session.freshness.workerLastSeq ?? '未知'}）</p><p>Workspace：{resources.data?.[0].find(workspace => workspace.id === session.workspaceId)?.name ?? session.workspaceId} / Worker：{resources.data?.[1].find(worker => worker.id === session.binding.agent.workerId)?.name ?? session.binding.agent.workerId} / Agent：{session.binding.agent.agentKey} / Model：{session.binding.modelId ?? '未指定'}</p><p>{session.access.canWrite ? '可写会话' : '只读会话'}{session.archivedAt ? '，已归档' : ''}{session.deletedAt ? '，已删除' : ''}</p></li>)}</ul></>}
  </section>
}
