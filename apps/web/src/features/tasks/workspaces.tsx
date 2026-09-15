import { useEffect, useRef, useState } from 'react'
import { randomId } from '../../lib/random.ts'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { TaskDetail } from '@wemux/web-contract/task-platform'
import type { Api } from '../../api/client'
import { projectKeys } from '../../app/project-query'
import { isExecutable, capabilityLabel } from '../../lib/capability'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'

export function TaskWorkspaces({ task, api, refresh, onDirty }: { task: TaskDetail; api: Api; refresh: () => void; onDirty: (dirty: boolean) => void }) {
  const client = useQueryClient()
  const workers = useQuery({ queryKey: ['workers'], queryFn: ({ signal }) => api.workers(signal) })
  const workspaces = useQuery({ queryKey: projectKeys.workspaces(task.projectId), queryFn: ({ signal }) => api.workspaces(task.projectId, signal) })
  const [workerId, workerSet] = useState(task.assignee?.workerId ?? ''), [workspaceId, workspaceSet] = useState(task.assignee?.workspaceId ?? '')
  const [agentKey, agentSet] = useState(task.assignee?.agentKey ?? ''), [modelId, modelSet] = useState(task.assignee?.modelId ?? '')
  const [version, setVersion] = useState(task.version), [dirty, setDirty] = useState(false), [error, setError] = useState('')
  const [pending, setPending] = useState<Record<string, boolean>>({})
  const pendingRef = useRef(new Set<string>())
  const [createWorkerId, createWorkerSet] = useState(''), [createDirty, setCreateDirty] = useState(false)
  const busy = pending.assignment === true
  const [name, setName] = useState(task.title), [source, setSource] = useState<'empty' | 'git'>('empty'), [gitUrl, setGitUrl] = useState(''), [revision, setRevision] = useState('main')
  const retries = useRef<Record<string, string>>({})
  const worker = workers.data?.find(value => value.id === workerId), agent = worker?.capabilities.find(value => value.agentKey === agentKey)
  const available = workspaces.data?.filter(value => value.workerId === workerId) ?? []
  const edit = () => { setDirty(true) }
  const editCreate = () => { setCreateDirty(true) }
  useEffect(() => { onDirty(dirty || createDirty) }, [dirty, createDirty, onDirty])
  useEffect(() => {
    if (!workers.data || !workspaces.data) return
    if (!worker || worker.connectionState === 'revoked') { workerSet(''); workspaceSet(''); agentSet(''); modelSet(''); return }
    if (workspaceId && !available.some(value => value.id === workspaceId)) workspaceSet('')
    if (!agent || !isExecutable(agent)) { agentSet(''); modelSet('') }
    else if (!agent.models.some(value => value.modelId === modelId)) modelSet('')
  }, [workers.data, workspaces.data, workerId, workspaceId, agentKey, modelId])
  async function act(key: string, work: () => Promise<unknown>) {
    if (pendingRef.current.has(key)) return
    pendingRef.current.add(key); setPending(value => ({ ...value, [key]: true })); setError('')
    try { await work(); refresh(); await workspaces.refetch() }
    catch (cause) { setError(cause instanceof Error ? cause.message : '请求失败'); refresh() }
    finally { pendingRef.current.delete(key); setPending(value => ({ ...value, [key]: false })) }
  }
  async function saveAssignment(clear = false) {
    const key = projectKeys.task(task.projectId, task.id)
    await client.cancelQueries({ queryKey: key })
    const saved = clear ? await api.clearTaskAssignment(task.projectId, task.id, version) : await api.assignTask(task.projectId, task.id, { version, assignee: { workspaceId, workerId, agentKey, modelId } })
    await client.cancelQueries({ queryKey: key })
    client.setQueryData(key, saved)
    setVersion(saved.version); workerSet(saved.assignee?.workerId ?? ''); workspaceSet(saved.assignee?.workspaceId ?? ''); agentSet(saved.assignee?.agentKey ?? ''); modelSet(saved.assignee?.modelId ?? ''); setDirty(false)
  }
  return <section className="space-y-4" aria-label="任务工作区与指派">
    <p>当前指派：{task.assignee ? `${task.assignee.agentKey} / ${task.assignee.modelId}` : '未指派'}。只影响后续运行；历史绑定保留。</p>
    <ul>{task.workspaces.map(binding => {
      const workspace = workspaces.data?.find(value => value.id === binding.workspaceId)
      return <li key={binding.workspaceId} className="border-b border-border py-3 break-words"><strong>{workspace?.name ?? binding.workspaceId}</strong><p>{workspace?.status ?? '加载中'} · {workspace?.failureReason}</p>
        {workspace?.status === 'failed' && <Button disabled={pending[`retry:${binding.workspaceId}`]} onClick={() => void act(`retry:${binding.workspaceId}`, async () => { const requestId = retries.current[binding.workspaceId] ??= randomId(); await api.retryTaskWorkspace(task.projectId, task.id, binding.workspaceId, requestId); delete retries.current[binding.workspaceId] })}>重试初始化</Button>}
        <Button variant="outline" disabled={pending[`unbind:${binding.workspaceId}`]} onClick={() => void act(`unbind:${binding.workspaceId}`, () => api.unbindTaskWorkspace(task.projectId, task.id, binding.workspaceId, { version: task.version }))}>解除绑定</Button></li>
    })}</ul>
    {!task.workspaces.length && <p>尚未绑定工作区。</p>}
    <label className="block">Worker<select disabled={busy} aria-label="指派 Worker" value={workerId} onChange={event => { edit(); workerSet(event.target.value); workspaceSet(''); agentSet(''); modelSet('') }}><option value="">选择 Worker</option>{workers.data?.map(value => <option key={value.id} value={value.id} disabled={value.connectionState === 'revoked'}>{value.name} · {value.connectionState}</option>)}</select></label>
    <label className="block">Workspace<select disabled={busy} aria-label="指派 Workspace" value={workspaceId} onChange={event => { edit(); workspaceSet(event.target.value) }}><option value="">选择工作区</option>{available.map(value => <option key={value.id} value={value.id}>{value.name} · {value.status}</option>)}</select></label>
    <Button disabled={pending.bind || !workspaceId} onClick={() => void act('bind', () => api.bindTaskWorkspace(task.projectId, task.id, workspaceId))}>绑定已有工作区</Button>
    <label className="block">Agent<select disabled={busy} aria-label="指派 Agent" value={agentKey} onChange={event => { edit(); agentSet(event.target.value); modelSet('') }}><option value="">选择 Agent</option>{worker?.capabilities.map(value => <option key={value.agentKey} value={value.agentKey} disabled={!isExecutable(value)}>{value.displayName} · {capabilityLabel(value)}</option>)}</select></label>
    <label className="block">Model<select disabled={busy} aria-label="指派 Model" value={modelId} onChange={event => { edit(); modelSet(event.target.value) }}><option value="">选择 Model</option>{agent?.models.map(value => <option key={value.modelId} value={value.modelId}>{value.displayName}</option>)}</select></label>
    <div className="flex flex-wrap gap-2"><Button disabled={busy || !workspaceId || !agent || !isExecutable(agent) || !modelId} onClick={() => void act('assignment', () => saveAssignment())}>保存指派</Button><Button variant="outline" disabled={busy || !task.assignee} onClick={() => void act('assignment', () => saveAssignment(true))}>清除指派</Button></div>
    {version !== task.version && <div role="alert">远端指派或状态已变化，草稿已保留。当前版本 {task.version}，权威指派 {task.assignee ? `${task.assignee.workspaceId} / ${task.assignee.agentKey} / ${task.assignee.modelId}` : '未指派'}。<Button onClick={() => setVersion(task.version)}>已核对最新状态，使用最新版本</Button></div>}
    <form className="space-y-2" onSubmit={event => { event.preventDefault(); void act('create', async () => { await api.createTaskWorkspace(task.projectId, task.id, { name, workerId: createWorkerId, source, ...(source === 'git' ? { repository: { gitUrl, revision } } : {}) }); setCreateDirty(false) }) }}>
      <h3>创建并绑定新工作区</h3><fieldset disabled={pending.create} className="space-y-2"><label>Worker<select aria-label="创建 Worker" value={createWorkerId} onChange={event => { editCreate(); createWorkerSet(event.target.value) }}><option value="">选择 Worker</option>{workers.data?.map(value => <option key={value.id} value={value.id} disabled={value.connectionState === 'revoked'}>{value.name} · {value.connectionState}</option>)}</select></label><label>工作区名称<Input required maxLength={200} value={name} onChange={event => { editCreate(); setName(event.target.value) }} /></label>
      <label>来源<select aria-label="来源" value={source} onChange={event => { editCreate(); setSource(event.target.value as 'empty' | 'git') }}><option value="empty">空白</option><option value="git">Git</option></select></label>
      {source === 'git' && <><label>Git URL<Input required value={gitUrl} onChange={event => { editCreate(); setGitUrl(event.target.value) }} /></label><label>Revision<Input required value={revision} onChange={event => { editCreate(); setRevision(event.target.value) }} /></label></>}
      <p className="text-xs">目录路径由 Worker 分配；离线 Worker 可先创建 pending 工作区。</p><Button disabled={pending.create || !createWorkerId}>创建工作区</Button></fieldset>
    </form>
    {(error || workers.error || workspaces.error) && <p role="alert">{error || String(workers.error ?? workspaces.error)}</p>}
    <p className="text-xs">每 5 秒刷新初始化状态，无需 Session。Launch 将由 Ticket05 提供；本页不启动运行。</p>
  </section>
}
