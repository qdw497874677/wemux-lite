import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, CheckCircle2, RefreshCw, Sparkles } from 'lucide-react'
import type { Resource, ResourceBinding, ResourceRevision, ReconcileReport } from '@wemux/domain'
import type { Api } from '../../api/client.ts'
import type { WorkerDTO } from '../../api/dto.ts'
import { randomId } from '../../lib/random.ts'
import { Button } from '../../components/ui/button.tsx'
import { Input } from '../../components/ui/input.tsx'
import { prepareSkillRevision } from './skill-publish.ts'

const phaseLabels: Record<string, string> = { queued: '排队中', downloading: '下载中', verifying: '校验中', installing: '安装中', ready: '已就绪', gc: '等待回收', 'restart-required': '等待重启', 'credential-required': '需要凭证' }
const statusLabels: Record<string, string> = { assigned: '待通知', notified: '待安装', installed: '已安装', failed: '失败', 'pending-gc': '待回收', "gc'd": '已回收' }
type Projection = { binding: ResourceBinding; reconcile: ReconcileReport | null }
const message = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试。'

export function SkillStudio({ api, canManage, workers, projectId, connected }: { api: Api; canManage: boolean; workers: WorkerDTO[]; projectId: string; connected: boolean }) {
  const [resources, setResources] = useState<Resource[]>([]), [bindings, setBindings] = useState<Projection[]>([])
  const [selected, setSelected] = useState(''), [revisions, setRevisions] = useState<ResourceRevision[]>([]), [actorId, setActorId] = useState('')
  const [name, setName] = useState(''), [description, setDescription] = useState(''), [content, setContent] = useState('')
  const [revisionId, setRevisionId] = useState(''), [workerId, setWorkerId] = useState(''), [agentKey, setAgentKey] = useState('')
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const refresh = useCallback(async () => {
    try {
      const [catalog, projections] = await Promise.all([api.resources(), api.resourceBindings()])
      setResources(catalog.filter(item => item.kind === 'skill')); setBindings(projections); setError('')
    } catch (cause) { setError(message(cause)) } finally { setLoading(false) }
  }, [api])
  useEffect(() => {
    if (!canManage) return
    void refresh()
    const timer = window.setInterval(() => void refresh(), 5000)
    return () => window.clearInterval(timer)
  }, [canManage, refresh])
  useEffect(() => {
    if (!canManage) return
    let active = true
    void api.currentAccount().then(account => { if (active) setActorId(account.user.id) }).catch(cause => { if (active) setError(message(cause)) })
    return () => { active = false }
  }, [api, canManage])
  useEffect(() => {
    if (!canManage) return
    if (!selected) { setRevisions([]); return }
    let active = true
    void api.resourceDetail(selected).then(detail => { if (active) setRevisions(detail.revisions) }).catch(cause => { if (active) setError(message(cause)) })
    return () => { active = false }
  }, [api, canManage, selected])
  const execute = async (action: () => Promise<void>, success: string) => {
    setBusy(true); setError(''); setNotice('')
    try { await action(); setNotice(success); await refresh() } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }
  const publish = () => void execute(async () => {
    if (!name.trim()) throw new Error('请填写技能名称。')
    if (!actorId) throw new Error('账号信息尚未加载。')
    const resourceId = selected || randomId()
    const existing = resources.find(item => item.id === resourceId)
    // 发布前重新读取权威版本，避免选中旧目录数据时创建重复版本。
    const currentRevisions = existing ? (await api.resourceDetail(resourceId)).revisions : []
    const version = currentRevisions.reduce((highest, item) => Math.max(highest, item.version), 0) + 1
    const prepared = prepareSkillRevision({ resourceId, revisionId: randomId(), version, name: name.trim(), description: description.trim(), content, createdBy: actorId, createdAt: new Date().toISOString() })
    if (!existing) {
      const created = await api.createResource({ id: resourceId, kind: 'skill', name: name.trim(), description: description.trim(), definition: { entryFile: 'SKILL.md', compatibleAgents: [], containsExecutableFiles: false }, createdBy: prepared.revision.createdBy, createdAt: prepared.revision.createdAt, updatedAt: prepared.revision.createdAt })
      setResources(items => [...items, created]); setSelected(resourceId)
    }
    await api.putResourceBlob(prepared.blobSha256, prepared.base64Content)
    await api.publishResourceRevision(resourceId, prepared.revision)
    const detail = await api.resourceDetail(resourceId); setRevisions(detail.revisions); setRevisionId(prepared.revision.id)
  }, '已发布不可变 revision。现在可选择 Worker 进行分发。')
  const bind = () => void execute(async () => {
    if (!selected || !revisionId || !workerId) throw new Error('请先选择技能版本和目标 Worker。')
    if (bindings.some(item => item.binding.resourceId === selected && item.binding.workerId === workerId && !['pending-gc', "gc'd"].includes(item.binding.status))) throw new Error('请先撤销该 Worker 上此技能的旧绑定。')
    await api.bindResource({ id: randomId(), workerId, resourceRevisionId: revisionId, agentKey: agentKey || null, projectId })
  }, '已创建绑定；等待 Worker 报告实际安装状态。')
  const revoke = (binding: ResourceBinding) => void execute(async () => {
    await api.transitionResourceBinding(binding.id, 'pending-gc', binding.revision)
  }, '已撤销绑定，等待 Worker 回收。')
  const visibleBindings = bindings.filter(item => item.binding.projectId === projectId && resources.some(resource => resource.id === item.binding.resourceId))
  const revisionVersions = new Map(revisions.map(item => [item.id, item.version]))
  const selectedResource = resources.find(item => item.id === selected)
  const worker = workers.find(item => item.id === workerId)
  const agentOptions = worker?.capabilities ?? []
  const hasExistingBinding = bindings.some(item => item.binding.resourceId === selected && item.binding.workerId === workerId && !['pending-gc', "gc'd"].includes(item.binding.status))
  if (!canManage) return <section className="mx-auto max-w-5xl py-8"><h1 className="text-lg font-semibold">技能工作室</h1><p role="status" className="mt-3 text-sm text-muted-foreground">当前资源 API 仅向实例管理员开放。项目成员不能在此发布或查看分发状态。</p></section>
  return <div className="mx-auto w-full max-w-6xl space-y-6 py-4">
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4"><div><h1 className="flex items-center gap-2 text-lg font-semibold"><Sparkles className="size-5" />技能工作室</h1><p className="mt-1 text-sm text-muted-foreground">编辑 SKILL.md，发布不可变版本，再分发到指定 Worker。绑定状态来自 Worker 报告。</p></div><Button size="sm" variant="outline" onClick={() => void refresh()}><RefreshCw className="size-4" />刷新</Button></header>
    {error && <p role="alert" className="flex gap-2 rounded-md border border-destructive/40 p-3 text-sm text-destructive"><AlertCircle className="size-4 shrink-0" />{error}</p>}
    {notice && <p role="status" className="flex gap-2 rounded-md border border-border p-3 text-sm"><CheckCircle2 className="size-4 shrink-0" />{notice}</p>}
    {loading ? <p role="status">正在读取技能和分发状态…</p> : <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(17rem,0.75fr)]">
      <section className="space-y-4"><h2 className="text-sm font-semibold">编辑与发布</h2>
        <label className="grid gap-2 text-sm">技能<select className="h-9 rounded-md border border-input bg-background px-3" value={selected} onChange={event => { const resource = resources.find(item => item.id === event.target.value); setSelected(event.target.value); setName(resource?.name ?? ''); setDescription(resource?.description ?? ''); setContent(''); setRevisionId('') }}><option value="">新建技能</option>{resources.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label className="grid gap-2 text-sm">名称<Input value={name} maxLength={200} disabled={Boolean(selectedResource)} onChange={event => setName(event.target.value)} /></label>
        <label className="grid gap-2 text-sm">描述<Input value={description} disabled={Boolean(selectedResource)} onChange={event => setDescription(event.target.value)} /></label>
        <label className="grid gap-2 text-sm">SKILL.md<textarea className="min-h-56 w-full rounded-md border border-input bg-background p-3 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" value={content} onChange={event => setContent(event.target.value)} spellCheck={false} placeholder="# 技能名称&#10;描述智能体如何使用此技能。" /></label>
        <p className="text-xs text-muted-foreground">UTF-8 静态内容，最大 1 MiB；版本发布后不可修改。已发布内容不随编辑器草稿自动回填。</p>
        <Button disabled={!connected || busy || !content.trim() || !name.trim()} onClick={publish}>发布新版本</Button>
      </section>
      <section className="space-y-4"><h2 className="text-sm font-semibold">分发目标</h2>
        <label className="grid gap-2 text-sm">已发布版本<select className="h-9 rounded-md border border-input bg-background px-3" value={revisionId} onChange={event => setRevisionId(event.target.value)}><option value="">选择版本</option>{revisions.filter(item => item.state === 'published').map(item => <option key={item.id} value={item.id}>版本 {item.version}（{item.id.slice(0, 8)}）</option>)}</select></label>
        <label className="grid gap-2 text-sm">Worker<select className="h-9 rounded-md border border-input bg-background px-3" value={workerId} onChange={event => { setWorkerId(event.target.value); setAgentKey('') }}><option value="">选择 Worker</option>{workers.filter(item => item.connectionState !== 'revoked').map(item => <option key={item.id} value={item.id}>{item.name}（{item.connectionState === 'online' ? '在线' : '离线'}）</option>)}</select></label>
        <label className="grid gap-2 text-sm">Agent 范围<select className="h-9 rounded-md border border-input bg-background px-3" value={agentKey} onChange={event => setAgentKey(event.target.value)}><option value="">全部兼容 Agent</option>{agentOptions.map(item => <option key={item.agentKey} value={item.agentKey}>{item.displayName}</option>)}</select></label>
        <Button disabled={!connected || busy || !selected || !revisionId || !workerId || hasExistingBinding} onClick={bind}>绑定并分发</Button>
        {hasExistingBinding && <p role="status" className="text-xs text-amber-600 dark:text-amber-400">此 Worker 已绑定该技能，请先撤销旧绑定。</p>}
        <p className="text-xs text-muted-foreground">同一 Worker 的同一技能更新版本前，先撤销旧绑定。离线 Worker 将在重连后追赶。</p>
      </section>
    </div>}
    <section className="space-y-3 border-t border-border pt-5"><h2 className="text-sm font-semibold">本项目绑定与收敛状态</h2>
      {!visibleBindings.length ? <p className="rounded-md border border-dashed border-border p-6 text-sm text-muted-foreground">尚无技能绑定。发布版本后选择 Worker 分发。</p> : <div className="divide-y divide-border rounded-md border border-border">{visibleBindings.map(({ binding, reconcile }) => <div key={binding.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm"><div className="min-w-36 flex-1"><strong>{resources.find(item => item.id === binding.resourceId)?.name ?? binding.resourceId}</strong><p className="text-xs text-muted-foreground">{workers.find(item => item.id === binding.workerId)?.name ?? binding.workerId} / {binding.agentKey ?? '全部 Agent'} / 版本 {revisionVersions.get(binding.resourceRevisionId) ?? binding.resourceRevisionId.slice(0, 8)}</p></div><span className="rounded border border-border px-2 py-1 text-xs">{statusLabels[binding.status] ?? binding.status}{reconcile?.phase && (binding.status !== 'pending-gc' || reconcile.phase === 'gc') && binding.status !== "gc'd" ? ` / ${phaseLabels[reconcile.phase] ?? reconcile.phase}` : ''}</span>{reconcile?.errorCode && <span role="alert" className="text-xs text-destructive">{reconcile.errorCode}</span>}{binding.status !== 'pending-gc' && binding.status !== "gc'd" && <Button size="sm" variant="outline" disabled={!connected || busy} onClick={() => revoke(binding)}>撤销</Button>}</div>)}</div>}
    </section>
  </div>
}
