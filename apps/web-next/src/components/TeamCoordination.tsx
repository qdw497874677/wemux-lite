import { useEffect, useMemo, useRef, useState } from 'react'
import { randomId } from '@wemux/web-client'
import type { ProjectDTO, WorkspaceDTO, WorkerDTO } from '@wemux/web-contract/browser-host'
import type { ProjectClient } from './ProjectManagement.tsx'
import { SessionConversation } from './SessionConversation.tsx'
import { accountError } from './AccountForms.tsx'
import { Button } from './primitives.tsx'
import { taskSessionOptions } from '../lib/task-session-options.ts'

export function TeamCoordination({ api, teamId }: { api: ProjectClient; teamId: string }) {
  const [resources, setResources] = useState<{ projects: ProjectDTO[]; workspaces: WorkspaceDTO[]; workers: WorkerDTO[] } | null>(null)
  const [sessions, setSessions] = useState<Awaited<ReturnType<ProjectClient['teamCoordinationSessions']>>>([])
  const [target, setTarget] = useState(''), [content, setContent] = useState(''), [selected, setSelected] = useState('')
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const pending = useRef<{ body: { requestId: string; commandId: string; workspaceId: string; workerId: string; agentKey: string; modelId: string; content: string }; teamId: string } | null>(null)
  async function refresh() {
    const [projects, workers, existing] = await Promise.all([api.projects(), api.workers(), api.teamCoordinationSessions(teamId)])
    const eligible = projects.filter(project => project.teamId === teamId && project.accessRole !== 'viewer')
    const spaces = await Promise.all(eligible.map(project => api.workspaces(project.id, 'all')))
    setResources({ projects: eligible, workspaces: spaces.flat(), workers }); setSessions(existing)
  }
  useEffect(() => { let active = true; setResources(null); setSessions([]); setSelected(''); pending.current = null; setError('')
    void refresh().catch(cause => { if (active) setError(accountError(cause)) })
    return () => { active = false }
  }, [api, teamId])
  const options = useMemo(() => resources?.projects.flatMap(project => taskSessionOptions(project.id, teamId, resources.workspaces, resources.workers)) ?? [], [resources, teamId])
  const choice = options.find(option => option.key === target)
  const session = sessions.find(item => item.id === selected)
  const project = session && resources?.projects.find(item => item.id === session.projectId)
  async function send() {
    if (busy || (!pending.current && (!choice || !content.trim()))) return
    const intent = pending.current?.teamId === teamId ? pending.current.body : { requestId: randomId(), commandId: randomId(), workspaceId: choice!.workspaceId, workerId: choice!.workerId, agentKey: choice!.agentKey, modelId: choice!.modelId, content: content.trim() }
    pending.current = { teamId, body: intent }; setBusy(true); setError('')
    try {
      const result = await api.createTeamCoordinationSession(teamId, intent)
      await refresh(); setSelected(result.session.id); setContent(''); pending.current = null
    } catch (cause) { setError(accountError(cause)) }
    finally { setBusy(false) }
  }
  return <section aria-labelledby="team-coordination-heading"><h1 id="team-coordination-heading">团队协调</h1>
    <p>选择已获权的项目工作区与 Worker，首次发送自动创建 Team 协调 Task 和绑定会话。协调 Agent 使用普通执行权限，操作仍需遵守项目、节点及工具审批。</p>
    {error && <p role="alert">{error}</p>}
    <Button variant="outline" disabled={busy} onClick={() => void refresh().catch(cause => setError(accountError(cause)))}>刷新协调环境与会话</Button>
    <label>执行环境<select aria-label="协调执行环境" value={target} onChange={event => setTarget(event.target.value)}><option value="">选择 Workspace / Worker / Agent / Model</option>{options.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}</select></label>
    <label>首条消息<textarea aria-label="协调首条消息" maxLength={100000} value={content} onChange={event => setContent(event.target.value)} /></label>
    <Button disabled={busy || (!pending.current && (!choice || !content.trim()))} onClick={() => void send()}>{pending.current ? '重试原首条消息' : '发送并创建会话'}</Button>
    {resources && !options.length && <p role="status">暂无获权且已就绪的工作区与可用 Agent。</p>}
    <h2>我的协调会话</h2><div className="account-actions">{sessions.map(item => <Button key={item.id} variant="outline" onClick={() => setSelected(item.id)}>{item.title}（{item.binding.agent.agentKey}）</Button>)}</div>
    {session && project && <SessionConversation api={api} project={project} taskId={session.taskId!} sessionId={session.id} close={() => setSelected('')} />}
  </section>
}
