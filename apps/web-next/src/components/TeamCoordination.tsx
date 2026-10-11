import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { randomId } from '@wemux/web-client'
import type { ProjectDTO, WorkspaceDTO, WorkerDTO } from '@wemux/web-contract/browser-host'
import type { ProjectClient } from './ProjectManagement.tsx'
import { SessionConversation } from './SessionConversation.tsx'
import { accountError } from './AccountForms.tsx'
import { Button } from './primitives.tsx'
import { taskSessionOptions } from '../lib/task-session-options.ts'

export function TeamCoordination({ api, teamId }: { api: ProjectClient; teamId: string }) {
  type CoordinationAttachmentView = Awaited<ReturnType<ProjectClient['coordinationAttachmentView']>>['attachment']
  const [resources, setResources] = useState<{ projects: ProjectDTO[]; workspaces: WorkspaceDTO[]; workers: WorkerDTO[] } | null>(null)
  const [sessions, setSessions] = useState<Awaited<ReturnType<ProjectClient['teamCoordinationSessions']>>>([])
  const [target, setTarget] = useState(''), [content, setContent] = useState(''), [selected, setSelected] = useState('')
  const [reopenTaskId, setReopenTaskId] = useState('')
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [file, setFile] = useState<File | null>(null), [uploadBusy, setUploadBusy] = useState(false)
  const [attachment, setAttachment] = useState<CoordinationAttachmentView | null>(null)
  const pendingUpload = useRef<{ teamId: string; requestId: string; file: File; workspaceId: string; workerId: string; agentKey: string; modelId: string } | null>(null)
  const pending = useRef<{ body: { requestId: string; commandId: string; workspaceId: string; workerId: string; agentKey: string; modelId: string; content: string }; teamId: string } | null>(null)
  const generation = useRef(0)
  const refreshGeneration = useRef(0)
  // A successful first-send receipt is authoritative even when a read replica returns an older list.
  const accepted = useRef<Awaited<ReturnType<ProjectClient['teamCoordinationSessions']>>>([])
  async function refresh(team: string, ticket: number) {
    const refreshTicket = ++refreshGeneration.current
    const [projects, workers, existing] = await Promise.all([api.projects(), api.workers(), api.teamCoordinationSessions(team)])
    const eligible = projects.filter(project => project.teamId === team && project.accessRole !== 'viewer')
    const spaces = await Promise.all(eligible.map(project => api.workspaces(project.id, 'all')))
    if (generation.current !== ticket || refreshGeneration.current !== refreshTicket) return
    const ids = new Set(existing.map(item => item.id))
    accepted.current = accepted.current.filter(item => !ids.has(item.id))
    setResources({ projects: eligible, workspaces: spaces.flat(), workers })
    setSessions([...accepted.current, ...existing])
  }
  useLayoutEffect(() => {
    const ticket = ++generation.current
    accepted.current = []
    setResources(null); setSessions([]); setSelected(''); setTarget(''); setReopenTaskId(''); setBusy(false); pending.current = null; setError(''); setFile(null); setUploadBusy(false); setAttachment(null); pendingUpload.current = null
    void refresh(teamId, ticket).catch(cause => { if (generation.current === ticket) setError(accountError(cause)) })
    return () => { generation.current++ }
  }, [api, teamId])
  const options = useMemo(() => resources?.projects.flatMap(project => taskSessionOptions(project.id, teamId, resources.workspaces, resources.workers)) ?? [], [resources, teamId])
  const choice = options.find(option => option.key === target)
  const session = sessions.find(item => item.id === selected)
  const project = session && resources?.projects.find(item => item.id === session.projectId)
  function prepareReopen() {
    if (!session || !session.taskId || busy || pending.current) return
    const sameAgent = options.filter(item => item.workspaceId === session.workspaceId && item.workerId === session.binding.agent.workerId && item.agentKey === session.binding.agent.agentKey)
    const option = sameAgent.find(item => item.modelId === session.binding.modelId) ?? sameAgent[0]
    if (!option) { setError('原协调会话的执行环境当前不可用，不能在同一 Task 下重开。'); return }
    setTarget(option.key); setReopenTaskId(session.taskId); setSelected(''); setContent('')
    setError(option.modelId === session.binding.modelId ? '' : '原模型不可用，重开将使用当前可用模型。')
  }
  async function send() {
    if (busy || (!pending.current && (!choice || !content.trim()))) return
    if (reopenTaskId && choice && !sessions.some(item => item.taskId === reopenTaskId && item.workspaceId === choice.workspaceId && item.binding.agent.workerId === choice.workerId && item.binding.agent.agentKey === choice.agentKey)) { setError('重开目标已变化，请重新选择原协调会话。'); return }
    const ticket = generation.current
    const intent = pending.current?.teamId === teamId ? pending.current.body : { requestId: randomId(), commandId: randomId(), workspaceId: choice!.workspaceId, workerId: choice!.workerId, agentKey: choice!.agentKey, modelId: choice!.modelId, content: content.trim() }
    pending.current = { teamId, body: intent }; setBusy(true); setError('')
    try {
      const result = await api.createTeamCoordinationSession(teamId, intent)
      if (generation.current !== ticket) return
      // Acceptance is definitive even if the subsequent list refresh fails.
      pending.current = null; setContent(''); setSelected(result.session.id); setReopenTaskId('')
      if (!accepted.current.some(item => item.id === result.session.id)) accepted.current = [result.session, ...accepted.current]
      setSessions(current => current.some(item => item.id === result.session.id) ? current : [result.session, ...current])
      try { await refresh(teamId, ticket) }
      catch (cause) { if (generation.current === ticket) setError(accountError(cause)) }
    } catch (cause) { if (generation.current === ticket) setError(accountError(cause)) }
    finally { if (generation.current === ticket) setBusy(false) }
  }
  async function upload() {
    if (uploadBusy || (!pendingUpload.current && (!choice || !file))) return
    const ticket = generation.current
    const intent = pendingUpload.current?.teamId === teamId ? pendingUpload.current : { teamId, requestId: randomId(), file: file!, workspaceId: choice!.workspaceId, workerId: choice!.workerId, agentKey: choice!.agentKey, modelId: choice!.modelId }
    if (intent.file.size > 1024 * 1024) { setError('附件超过 1 MiB 上限，请压缩后再试。'); return }
    pendingUpload.current = intent; setUploadBusy(true); setError('')
    try {
      const result = await api.uploadTeamCoordinationAttachment(teamId, { file: intent.file, requestId: intent.requestId, workspaceId: intent.workspaceId, workerId: intent.workerId, agentKey: intent.agentKey, modelId: intent.modelId })
      if (generation.current !== ticket) return
      pendingUpload.current = null; setFile(null); setAttachment(result.attachment); setSelected(result.session.id); setReopenTaskId('')
      if (!accepted.current.some(item => item.id === result.session.id)) accepted.current = [result.session, ...accepted.current]
      setSessions(current => current.some(item => item.id === result.session.id) ? current : [result.session, ...current])
      try { await refresh(teamId, ticket) }
      catch (cause) { if (generation.current === ticket) setError(accountError(cause)) }
    } catch (cause) {
      if (generation.current !== ticket) return
      setError(accountError(cause))
      const message = cause instanceof Error ? cause.message : String(cause)
      // 4xx 是明确拒绝：重试同样载荷也只会再拒绝，按新意图处理而不是死循环。
      if (/HTTP 4\d\d/.test(message)) pendingUpload.current = null
    } finally { if (generation.current === ticket) setUploadBusy(false) }
  }
  // 阶段二轮询：只在待投递期间查询，达到终态或超时后停止，不伪装完成。
  useEffect(() => {
    if (!attachment || attachment.delivery.state !== 'pending') return
    const ticket = generation.current
    const timer = setInterval(() => {
      void api.coordinationAttachmentView(teamId, attachment.id).then(view => {
        if (generation.current !== ticket) return
        setAttachment(current => current && current.delivery.state === view.attachment.delivery.state && current.delivery.detail === view.attachment.delivery.detail && current.delivery.workerConnectionState === view.attachment.delivery.workerConnectionState ? current : view.attachment)
      }).catch(() => undefined)
    }, 2000)
    const stop = setTimeout(() => clearInterval(timer), 60000)
    return () => { clearInterval(timer); clearTimeout(stop) }
  }, [attachment, teamId, api])
  return <section aria-labelledby="team-coordination-heading"><h1 id="team-coordination-heading">团队协调</h1>
    <p>选择已获权的项目工作区与 Worker，首次发送自动创建 Team 协调 Task 和绑定会话。协调 Agent 使用普通执行权限，操作仍需遵守项目、节点及工具审批。</p>
    {error && <p role="alert">{error}</p>}
    <Button variant="outline" disabled={busy || !!pending.current} onClick={() => { const ticket = generation.current; void refresh(teamId, ticket).catch(cause => { if (generation.current === ticket) setError(accountError(cause)) }) }}>刷新协调环境与会话</Button>
    {reopenTaskId && <p role="status">将在原协调 Task 下新建会话，旧会话历史保留；输入首条消息后发送。<Button variant="outline" disabled={busy || !!pending.current} onClick={() => setReopenTaskId('')}>取消重开</Button></p>}
    <label>执行环境<select aria-label="协调执行环境" value={target} disabled={!!reopenTaskId || busy || uploadBusy || !!pending.current || !!pendingUpload.current} onChange={event => setTarget(event.target.value)}><option value="">选择 Workspace / Worker / Agent / Model</option>{options.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}</select></label>
    <label>首条消息<textarea aria-label="协调首条消息" maxLength={100000} value={content} disabled={busy || !!pending.current} onChange={event => setContent(event.target.value)} /></label>
    <label>附件<input type="file" aria-label="协调附件" disabled={!!reopenTaskId || busy || uploadBusy || !!pending.current || !!pendingUpload.current || !choice || !choice.agentAttachments} onChange={event => { setFile(event.target.files?.[0] ?? null); setError('') }} /></label>
    {choice && !choice.agentAttachments && <p role="status">所选 Agent 未声明附件读取能力，上传入口未开启。</p>}
    {pendingUpload.current && <p role="status">上次上传结果未知；只能按原附件重试，不能修改文件或切换会话。</p>}
    <Button disabled={uploadBusy || busy || !!pending.current || !choice || !choice.agentAttachments || (!pendingUpload.current && !file)} onClick={() => void upload()}>{pendingUpload.current ? '重试原附件上传' : '上传附件并创建会话'}</Button>
    {attachment && <p role="status" data-attachment-state={attachment.delivery.state}>附件两阶段：Server 已收件「{attachment.filename}」（{attachment.size} 字节）；投递到 Worker：{attachment.delivery.state === 'pending' ? '待投递' : attachment.delivery.state === 'delivered' ? '已投递' : `失败（${attachment.delivery.detail ?? '原因未知'}）`}{attachment.delivery.state === 'pending' && attachment.delivery.workerConnectionState !== 'online' ? '，Worker 当前离线，恢复后自动继续' : ''}。工作区内路径 {attachment.subpath}。</p>}
    {pending.current && <p role="status">上次发送结果未知；只能按原请求重试，不能修改首条消息或切换会话。</p>}
    <Button disabled={busy || (!pending.current && (!choice || !content.trim()))} onClick={() => void send()}>{pending.current ? '重试原首条消息' : '发送并创建会话'}</Button>
    {resources && !options.length && <p role="status">暂无获权且已就绪的工作区与可用 Agent。</p>}
    <h2>我的协调会话</h2><div className="account-actions">{sessions.map(item => <Button key={item.id} variant="outline" disabled={busy || !!pending.current} onClick={() => { setReopenTaskId(''); setSelected(item.id) }}>{item.title}（{item.binding.agent.agentKey}）</Button>)}</div>
    {session && <Button variant="outline" disabled={busy || !!pending.current} onClick={prepareReopen}>在此 Task 下重开新会话</Button>}
    {session && project && <SessionConversation api={api} project={project} taskId={session.taskId!} sessionId={session.id} close={() => { if (!pending.current) setSelected('') }} />}
  </section>
}
