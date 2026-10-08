import { useMemo, useRef, useState } from 'react'
import { PendingTaskSession, type TaskSessionIntent } from '@wemux/web-client'
import type { CreateTaskSessionRequest } from '@wemux/web-contract/task-platform'
import type { ProjectDTO, WorkspaceDTO, WorkerDTO } from '@wemux/web-contract/browser-host'
import type { ProjectClient } from './ProjectManagement.tsx'
import { accountError, useAccountData } from './AccountForms.tsx'
import { Button, Input } from './primitives.tsx'
import { useOperationLifetime } from '../lib/operation-lifetime.ts'
import { taskSessionOptions } from '../lib/task-session-options.ts'
import { navigate } from '../lib/navigation.ts'

type Props = { api: ProjectClient; project: ProjectDTO }
export function ProjectConversation({ api, project }: Props) {
  const [scenario, setScenario] = useState<'quick-chat' | 'agent-test'>('quick-chat')
  return <section aria-label="项目试聊"><h3>项目试聊</h3>
    <p>自动关联专用 Task，无需先创建普通任务。按用户、项目、Workspace、Worker、Agent 和场景复用 Task，切换 Model 不会改变复用范围；每次显式创建一个新 Session。</p>
    <label>试聊场景<select aria-label="试聊场景" value={scenario} onChange={e => setScenario(e.target.value as typeof scenario)}><option value="quick-chat">快速对话</option><option value="agent-test">Agent 测试</option></select></label>
    <ProjectConversationScope key={JSON.stringify([api.taskSessionScope, project.id, project.accessRole, scenario])} api={api} project={project} scenario={scenario} />
  </section>
}
function ProjectConversationScope({ api, project, scenario }: Props & { scenario: 'quick-chat' | 'agent-test' }) {
  const writable = project.accessRole !== 'viewer'
  const begin = useOperationLifetime([api, project.id, writable, scenario])
  const pending = useMemo(() => new PendingTaskSession(() => window.sessionStorage, { ...api.taskSessionScope, projectId: project.id, scenario }), [api, project.id, scenario])
  const [saved, setSaved] = useState<Readonly<CreateTaskSessionRequest> | null>(() => { try { return pending.read() } catch { return null } })
  const [storageError, setStorageError] = useState(() => { try { pending.read(); return '' } catch (cause) { return accountError(cause) } })
  const [title, setTitle] = useState(scenario === 'quick-chat' ? '快速对话' : 'Agent 测试')
  const [target, setTarget] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const inFlight = useRef(false)
  const resources = useAccountData<[WorkspaceDTO[], WorkerDTO[]]>(() => writable ? Promise.all([api.workspaces(project.id, 'all'), api.workers()]) : Promise.resolve([[], []]), [api, project.id, writable])
  const options = taskSessionOptions(project.id, project.teamId, resources.data?.[0] ?? [], resources.data?.[1] ?? [])
  const selected = options.find(option => option.key === target)
  function readPending() {
    try { setSaved(pending.read()); setStorageError('') }
    catch (cause) { setStorageError(accountError(cause)) }
  }
  async function submit(expected?: Readonly<CreateTaskSessionRequest>) {
    if (!writable || inFlight.current || storageError) return
    const active = begin(), stale = new Error('原请求状态已变化，未创建新的会话。请核对待确认请求或任务列表。')
    inFlight.current = true; setBusy(true); setError('')
    try {
      const matches = (body: Readonly<CreateTaskSessionRequest> | null) => JSON.stringify(body) === JSON.stringify(expected)
      if (expected && !matches(pending.read())) throw stale
      const intent = (): TaskSessionIntent => {
        if (expected) throw stale
        if (!selected || !title.trim()) throw Error('请填写标题并选择完整执行环境。')
        return { title: title.trim(), workspaceId: selected.workspaceId, workerId: selected.workerId, agentKey: selected.agentKey, modelId: selected.modelId }
      }
      const result = await pending.run(intent, body => {
        if (expected && !matches(body)) throw stale
        return api.createDedicatedSession(project.id, scenario, body)
      })
      if (!active()) return
      if (expected && result.session.creation?.requestId !== expected.requestId) throw stale
      navigate(`/next/projects/${encodeURIComponent(project.id)}?task=${encodeURIComponent(result.session.taskId)}&session=${encodeURIComponent(result.session.id)}`)
    } catch (cause) { if (active()) setError(accountError(cause)) }
    finally { inFlight.current = false; if (active()) { setBusy(false); readPending() } }
  }
  return <div>
    <p>专用会话默认仅创建者可见，可使用所选 Agent 执行操作，不是只读沙箱。不会创建 Run，也不会改动普通任务的指派。</p>
    {!writable && <p role="status">当前为只读权限，不能创建试聊会话。</p>}
    {storageError && <p role="alert">{storageError}<Button onClick={readPending}>重新读取试聊请求</Button></p>}
    {saved && <div aria-label="待确认的试聊请求"><p>{saved.title}</p><p>Workspace：{saved.workspaceId} / Worker：{saved.workerId} / Agent：{saved.agentKey} / Model：{saved.modelId}</p><p className="machine">请求标识：{saved.requestId}</p><p>结果尚未确认，重试保留原请求全部内容，不使用下方表单。</p><Button disabled={!writable || busy || !!storageError} onClick={() => void submit(saved)}>重试原试聊请求</Button></div>}
    <p className="muted">待确认请求支持当前标签页刷新恢复，不自动重试；关闭标签页或清理存储后不保证恢复，不保证跨标签页去重。</p>
    {writable && <><Button variant="outline" disabled={busy} onClick={resources.reload}>刷新试聊执行环境</Button>{resources.feedback}
      <form className="account-form" onSubmit={e => { e.preventDefault(); if (!saved) void submit() }}><fieldset disabled={busy}>
        <label>试聊标题<Input aria-label="试聊标题" required maxLength={200} value={title} onChange={e => setTitle(e.target.value)} /></label>
        <label>试聊执行环境<select aria-label="试聊执行环境" value={target} required onChange={e => setTarget(e.target.value)}><option value="">选择 Workspace / Worker / Agent / Model</option>{options.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}</select></label>
        {resources.data && !options.length && <p>没有可用执行环境。请先准备获权的工作区落点、在线 Worker、可执行 Agent 和具体 Model。</p>}
        <Button type="submit" disabled={!!saved || !!storageError || !selected || !title.trim()}>创建试聊会话</Button>
      </fieldset></form></>}
    {busy && <p role="status">正在核对试聊创建结果…</p>}{error && <p role="alert">{error}</p>}
  </div>
}
