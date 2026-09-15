import { isExecutable, capabilityLabel } from '../lib/capability'
import { useState } from 'react'
import type { Api } from '@/api/client'
import type { SessionDTO, WorkerDTO, WorkspaceDTO } from '@/api/dto'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'
import { workerStateLabel, workspaceStateLabel } from '@/lib/display'

export const selectClass = 'h-10 w-full rounded-md border border-input bg-background px-3 text-xs'
export type CreateKind = 'project' | 'workspace' | 'session'
const titles: Record<CreateKind, string> = { project: '新建项目', workspace: '新建工作区', session: '新建会话' }

export function CreateDialog({ kind, api, teamId, projectId, defaultWorkspaceId = '', workers, workspaces, onClose, onCreated }: {
  kind: CreateKind; api: Api; teamId: string; projectId: string; defaultWorkspaceId?: string
  workers: WorkerDTO[]; workspaces: WorkspaceDTO[]
  onClose: () => void; onCreated: (kind: CreateKind, id: string, session?: SessionDTO) => void
}) {
  const [name, setName] = useState('')
  const defaultWorkspace = workspaces.find(item => item.id === defaultWorkspaceId)
  const [workerId, setWorkerId] = useState(defaultWorkspace?.workerId ?? '')
  const [workspaceId, setWorkspaceId] = useState(defaultWorkspace?.id ?? '')
  const [agentKey, setAgentKey] = useState('')
  const [modelId, setModelId] = useState('')
  const [workspaceSource, setWorkspaceSource] = useState<'empty' | 'git'>('empty')
  const [gitUrl, setGitUrl] = useState('')
  const [branch, setBranch] = useState('main')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const selectedWorkerId = workerId || workers[0]?.id || ''
  const worker = workers.find(item => item.id === selectedWorkerId)
  const workspace = workspaces.find(item => item.id === workspaceId && item.workerId === selectedWorkerId)
  const agents = worker?.capabilities ?? []
  const agent = agents.find(item => item.agentKey === agentKey && isExecutable(item))
  const valid = Boolean(name.trim() && (kind === 'project' ? teamId : projectId) && (
    kind === 'project' || kind === 'workspace' && worker && (workspaceSource === 'empty' || gitUrl.trim() && branch.trim()) ||
    kind === 'session' && workspace?.status === 'ready' && worker?.connectionState === 'online' && agent && agent.models.some(model => model.modelId === modelId)
  ))

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!valid || busy) return
    setBusy(true); setError('')
    try {
      switch (kind) {
        case 'project': {
          const result = await api.createProject({ name: name.trim(), teamId, shareScope: 'owner-only' })
          onCreated(kind, result.id); break
        }
        case 'workspace': {
          const result = await api.createWorkspace(projectId, workspaceSource === 'empty'
            ? { name: name.trim(), workerId: selectedWorkerId, source: 'empty' }
            : { name: name.trim(), workerId: selectedWorkerId, source: 'git', repository: { name: name.trim(), gitUrl: gitUrl.trim(), revision: branch.trim() } })
          onCreated(kind, result.id); break
        }
        case 'session': {
          const result = await api.createSession({ title: name.trim(), workspaceId, agentKey, modelId: modelId.trim(), shareScope: 'owner-only' })
          onCreated(kind, result.id, result); break
        }
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '请求失败'
      setError(`无法创建${kind === 'project' ? '项目' : kind === 'workspace' ? '工作区' : '会话'}：${message}`)
    }
    finally { setBusy(false) }
  }

  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}><DialogContent className="max-h-[90dvh] overflow-y-auto"><DialogHeader><DialogTitle>{titles[kind]}</DialogTitle><DialogDescription>{kind === 'project' ? '项目用来组织相关的工作区和会话。' : kind === 'workspace' ? '工作区会固定到所选工作节点，可创建空白目录或克隆 Git 仓库。' : '选择工作区、智能体和模型，创建后即可开始对话。'}</DialogDescription></DialogHeader>
    <form onSubmit={submit} className="space-y-4">
      <label className="grid gap-2 text-xs">名称<Input autoFocus required value={name} onChange={event => setName(event.target.value)} /></label>
      {kind === 'project' && <p className="rounded-lg bg-muted/30 p-3 text-xs text-muted-foreground">项目将创建在当前默认团队中。</p>}
      {kind === 'workspace' && <><fieldset className="grid gap-2"><legend className="mb-2 text-xs">工作区来源</legend><div className="grid grid-cols-2 gap-2"><label className={`cursor-pointer rounded-lg border p-3 text-xs ${workspaceSource === 'empty' ? 'border-primary bg-primary/10' : 'border-border'}`}><input className="mr-2" type="radio" name="workspaceSource" checked={workspaceSource === 'empty'} onChange={() => setWorkspaceSource('empty')} />空白工作区<span className="mt-1 block text-muted-foreground">创建独立的空目录</span></label><label className={`cursor-pointer rounded-lg border p-3 text-xs ${workspaceSource === 'git' ? 'border-primary bg-primary/10' : 'border-border'}`}><input className="mr-2" type="radio" name="workspaceSource" checked={workspaceSource === 'git'} onChange={() => setWorkspaceSource('git')} />Git 仓库<span className="mt-1 block text-muted-foreground">克隆代码仓库</span></label></div></fieldset>{workspaceSource === 'git' && <><label className="grid gap-2 text-xs">Git 仓库地址<Input required value={gitUrl} onChange={event => setGitUrl(event.target.value)} placeholder="https://… 或 git@…" /></label><label className="grid gap-2 text-xs">分支或版本<Input required value={branch} onChange={event => setBranch(event.target.value)} /></label><p className="text-xs text-muted-foreground">Git 凭证只保留在工作节点中，请勿在仓库地址中填写密码或令牌。</p></>}</>}
      {(kind === 'workspace' || kind === 'session') && <label className="grid gap-2 text-xs">工作节点<select required className={selectClass} value={selectedWorkerId} onChange={event => { setWorkerId(event.target.value); setWorkspaceId(''); setAgentKey(''); setModelId('') }}><option value="">选择工作节点</option>{workers.map(item => <option key={item.id} value={item.id} disabled={item.connectionState === 'revoked' || kind === 'session' && item.connectionState !== 'online'}>{item.name} · {workerStateLabel[item.connectionState]}</option>)}</select></label>}
      {kind === 'workspace' && <p className="text-xs text-muted-foreground">创建后，工作节点会异步准备独立目录{workspaceSource === 'git' ? '并拉取仓库' : ''}。显示“已就绪”后才可以创建会话；节点离线时会等待处理。</p>}
      {kind === 'session' && <><label className="grid gap-2 text-xs">工作区<select required className={selectClass} value={workspaceId} onChange={event => setWorkspaceId(event.target.value)}><option value="">选择已就绪的工作区</option>{workspaces.filter(item => item.workerId === selectedWorkerId).map(item => <option key={item.id} value={item.id} disabled={item.status !== 'ready'}>{item.name} · {workspaceStateLabel[item.status]}</option>)}</select></label><label className="grid gap-2 text-xs">智能体<select required className={selectClass} value={agentKey} onChange={event => { setAgentKey(event.target.value); setModelId('') }}><option value="">选择可执行的智能体</option>{agents.map(item => <option key={item.agentKey} value={item.agentKey} disabled={!isExecutable(item)}>{item.displayName} {item.version} · {capabilityLabel(item)}</option>)}</select></label><label className="grid gap-2 text-xs">模型<select required className={selectClass} value={modelId} onChange={event => setModelId(event.target.value)} disabled={!agent}><option value="">选择工作节点已报告的模型</option>{agent?.models.map(item => <option key={item.modelId} value={item.modelId}>{item.displayName}</option>)}</select></label><p className="text-xs text-muted-foreground">{worker && !agents.length ? '该工作节点尚未报告可执行且已认证的智能体。' : '会话创建后会固定到当前工作节点、工作区、智能体和模型。会话内容可能包含敏感信息。'}</p></>}
      {error && <p role="alert" className="rounded-lg border border-red-500/25 bg-red-500/10 p-3 text-sm text-red-200">{error}</p>}
      <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={onClose}>取消</Button><Button type="submit" disabled={!valid || busy}>{busy ? '正在创建…' : '创建'}</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>
}
