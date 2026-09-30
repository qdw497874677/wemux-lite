import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, Layers3, RefreshCw } from 'lucide-react'
import type { Api } from '../../api/client.ts'
import { randomId } from '../../lib/random.ts'
import type { AgentKey, NodeResourcePreset, NodeResourcePresetApplication, NodeResourcePresetEntry, ResourceBinding, ReconcileReport, Resource, ResourceRevision } from '@wemux/domain'
import type { WorkerDTO } from '../../api/dto.ts'
import { useConfirmDialog } from '../../components/ui/confirm-dialog.tsx'
import { prepareProviderRevision } from './provider-publish.ts'

type Projection = { binding: ResourceBinding; reconcile: ReconcileReport | null }
type Application = { application: NodeResourcePresetApplication; items: Projection[] }
const resourceKindLabel: Record<string, string> = { skill: 'Skill', 'agent-runtime': 'Agent', 'model-provider': '模型供应商' }
const phaseLabel: Record<string, string> = { queued: '排队中', downloading: '下载中', verifying: '校验中', installing: '安装中', ready: '已就绪', 'restart-required': '待重启', 'credential-required': '待认证', failed: '失败', gc: '回收中' }
const statusLabel: Record<string, string> = { assigned: '待通知', notified: '待安装', installed: '已安装', failed: '失败', 'pending-gc': '待回收', "gc'd": '已回收' }
function statusOf(item: Projection) {
  if (item.binding.status === 'pending-gc' && item.reconcile?.phase !== 'gc' || item.binding.status === "gc'd") return statusLabel[item.binding.status]
  return item.reconcile?.phase ? phaseLabel[item.reconcile.phase] ?? item.reconcile.phase : statusLabel[item.binding.status] ?? item.binding.status
}

export function PresetStudio({ api, workers }: { api: Api; workers: WorkerDTO[] }) {
  const confirm = useConfirmDialog()
  const [expanded, setExpanded] = useState(false)
  const [presets, setPresets] = useState<NodeResourcePreset[]>([])
  const [applications, setApplications] = useState<Application[]>([])
  const [resources, setResources] = useState<Resource[]>([])
  const [revisions, setRevisions] = useState<ResourceRevision[]>([])
  const [editingId, setEditingId] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [entries, setEntries] = useState<NodeResourcePresetEntry[]>([])
  const [resourceId, setResourceId] = useState('')
  const [revisionId, setRevisionId] = useState('')
  const [agentKey, setAgentKey] = useState('')
  const [presetId, setPresetId] = useState('')
  const [workerId, setWorkerId] = useState('')
  const [providerName, setProviderName] = useState(''), [providerEndpoint, setProviderEndpoint] = useState(''), [providerModel, setProviderModel] = useState(''), [providerRef, setProviderRef] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const latest = useMemo(() => [...presets].reverse().filter((preset, index, items) => items.findIndex(item => item.id === preset.id) === index).reverse(), [presets])
  const available = useMemo(() => resources.filter(resource => resource.kind === 'skill' || resource.kind === 'agent-runtime' || resource.kind === 'model-provider'), [resources])
  const chosen = resources.find(resource => resource.id === resourceId)
  const eligibleRevisions = revisions.filter(revision => revision.resourceId === resourceId && revision.state === 'published')
  const selected = latest.find(preset => preset.id === presetId)

  async function refresh() {
    const [presetResponse, applicationResponse, resourceResponse] = await Promise.all([api.resourcePresets(), api.resourcePresetApplications(), api.resources()])
    setPresets(presetResponse.items); setApplications(applicationResponse.items); setResources(resourceResponse)
    const details = await Promise.all(resourceResponse.filter(item => item.kind === 'skill' || item.kind === 'agent-runtime' || item.kind === 'model-provider').map(item => api.resourceDetail(item.id)))
    setRevisions(details.flatMap(item => item.revisions))
  }
  useEffect(() => {
    if (!expanded) return
    let active = true
    const poll = () => { void refresh().catch(error => { if (active) setError(error instanceof Error ? error.message : String(error)) }) }
    poll()
    const interval = setInterval(poll, 5000)
    return () => { active = false; clearInterval(interval) }
  }, [expanded, api])

  async function publishProvider() {
    setError(''); setMessage(''); setBusy(true)
    try {
      const actor = await api.currentAccount()
      const resourceId = randomId()
      const createdAt = new Date().toISOString()
      const { definition, revision } = prepareProviderRevision({ resourceId, revisionId: randomId(), version: 1, name: providerName, endpoint: providerEndpoint, modelId: providerModel, credentialRef: providerRef, createdBy: actor.user.id, createdAt })
      await api.createResource({ id: resourceId, kind: 'model-provider', name: providerName.trim(), description: '', definition, createdBy: actor.user.id as Resource['createdBy'], createdAt: createdAt as Resource['createdAt'], updatedAt: createdAt as Resource['updatedAt'] })
      await api.publishResourceRevision(resourceId, revision)
      setProviderName(''); setProviderEndpoint(''); setProviderModel(''); setProviderRef('')
      setMessage('已发布非秘密模型供应商版本。请在目标 Worker 本地配置对应凭据；尚未完成模型认证，不可用于新建会话。')
      await refresh()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  function addEntry() {
    setError('')
    if (!chosen || !revisionId || ((chosen.kind === 'agent-runtime' || chosen.kind === 'model-provider') && !agentKey)) { setError('请选择已发布版本；Agent runtime 和模型供应商还需选择 Agent'); return }
    const revision = eligibleRevisions.find(item => item.id === revisionId)
    if (!revision) { setError('资源版本详情不可用，请刷新后重试'); return }
    if (chosen.kind === 'agent-runtime' && (revision.payload.mode !== 'artifact' || ({ pi: '@earendil-works/pi-coding-agent', 'claude-code': '@anthropic-ai/claude-code', opencode: 'opencode-ai' } as Record<string, string>)[agentKey] !== revision.payload.packageName)) { setError('Agent 与受信任的 runtime 包不匹配'); return }
    if (chosen.kind === 'model-provider' && (revision.payload.mode !== 'inline-config' || !revision.payload.config.agentKeys.includes(agentKey as AgentKey))) { setError('所选 Agent 不在模型供应商版本的适配范围内'); return }
    if (entries.some(item => item.resourceRevisionId === revisionId || (item.resourceId === resourceId && item.agentKey === (agentKey || null)))) { setError('同一资源版本或资源与 Agent 不可重复添加'); return }
    setEntries(items => [...items, { resourceId, resourceRevisionId: revisionId, agentKey: agentKey ? agentKey as AgentKey : null, projectId: null, required: true }])
    setResourceId(''); setRevisionId(''); setAgentKey('')
  }
  async function save() {
    setError(''); setMessage('')
    if (!name.trim() || !entries.length) { setError('请填写名称并添加至少一个资源'); return }
    setBusy(true)
    try {
      const previous = latest.find(item => item.id === editingId)
      const created = await api.createResourcePreset({ id: previous?.id ?? randomId(), name: name.trim(), description: description.trim(), expectedRevision: previous?.revision ?? 0, entries, autoApply: { enabled: false } })
      setPresetId(created.id); setEditingId(''); setName(''); setDescription(''); setEntries([]); setMessage(`已发布预设 v${created.revision}；不会自动应用到任何节点`)
      await refresh()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  async function apply() {
    setError(''); setMessage('')
    if (!selected || !workerId) { setError('请选择预设及工作节点'); return }
    const contents = selected.entries.map(entry => {
      const resource = resources.find(item => item.id === entry.resourceId)
      const revision = revisions.find(item => item.id === entry.resourceRevisionId)
      if (!resource || !revision) return `${entry.resourceId}：版本详情不可用，请刷新后重试`
      if (revision.kind === 'agent-runtime') return `${resource.name} v${revision.version}（${revision.payload.mode === 'artifact' ? `${revision.payload.packageName}@${revision.payload.packageVersion}` : '制品未知'}）：npm 安装依赖时可能执行安装脚本；安装后需重启 Worker、单独配置凭证和模型`
      if (revision.kind === 'model-provider') return `${resource.name} v${revision.version}：只下发非秘密配置；凭据须在 Worker 本地录入或预置环境变量，当前仅显示待认证，不代表模型可用`
      return `${resource.name} v${revision.version}：静态 Skill，不执行脚本；约 ${revision.manifest?.bytes ?? '未知'} 字节`
    })
    if (contents.some(item => item.includes('版本详情不可用'))) { setError('资源版本详情不可用，请刷新后重试'); return }
    if (!await confirm({ title: '确认手工应用资源预设', description: `工作节点：${workers.find(item => item.id === workerId)?.name ?? workerId}。将安装：${contents.join('；')}。仅应用到此节点；安装完成不代表 Agent 已认证或模型可用。`, confirmLabel: '确认应用' })) return
    setBusy(true)
    try {
      const desired = await api.resourceSet(workerId)
      await api.applyResourcePreset(selected.id, { presetRevision: selected.revision, workerId, requestId: randomId(), expectedSetRevision: desired.revision })
      setMessage('已提交手工应用；请查看每个资源的收敛状态')
      await refresh()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  return <section className="rounded-xl border border-border bg-card p-5" aria-label="节点预设">
    <button type="button" className="flex w-full items-center justify-between gap-4 text-left" onClick={() => setExpanded(value => !value)} aria-expanded={expanded}>
      <span className="flex items-center gap-2 text-sm font-semibold"><Layers3 className="h-4 w-4" />节点预设</span>
      <span className="flex items-center gap-2 text-xs text-muted-foreground">按需发布并手工应用 {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}</span>
    </button>
    {expanded && <div className="mt-5 grid gap-6 border-t border-border pt-5 lg:grid-cols-2">
      <div className="space-y-3">
        <h3 className="text-sm font-medium">发布模型供应商（非秘密）</h3>
        <p className="text-xs text-muted-foreground">当前仅支持隔离 Pi 的 OpenAI 兼容端点、单模型与本机加密凭据引用。此处不输入密钥；新建资源和不可变 v1 后，才可加入下方预设。发布不代表认证通过。</p>
        <label className="block space-y-1 text-xs">供应商名称<input aria-label="供应商名称" className="w-full rounded-lg border border-border bg-background px-3 py-2" value={providerName} maxLength={200} onChange={event => setProviderName(event.target.value)} /></label>
        <label className="block space-y-1 text-xs">HTTPS 端点<input aria-label="供应商 HTTPS 端点" className="w-full rounded-lg border border-border bg-background px-3 py-2" value={providerEndpoint} onChange={event => setProviderEndpoint(event.target.value)} placeholder="https://models.example.com/v1" /></label>
        <label className="block space-y-1 text-xs">模型 ID<input aria-label="供应商模型 ID" className="w-full rounded-lg border border-border bg-background px-3 py-2" value={providerModel} onChange={event => setProviderModel(event.target.value)} /></label>
        <label className="block space-y-1 text-xs">Worker 本机凭据引用<input aria-label="供应商本机凭据引用" className="w-full rounded-lg border border-border bg-background px-3 py-2" value={providerRef} onChange={event => setProviderRef(event.target.value)} placeholder="local-ref" /></label>
        <button type="button" disabled={busy || !providerName.trim() || !providerEndpoint.trim() || !providerModel.trim() || !providerRef.trim()} className="rounded-lg border border-border px-3 py-2 text-xs disabled:opacity-50" onClick={() => void publishProvider()}>发布非秘密版本</button>
        <h3 className="border-t border-border pt-5 text-sm font-medium">发布资源预设</h3>
        <select aria-label="编辑预设" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs" value={editingId} onChange={event => {
          const previous = latest.find(item => item.id === event.target.value)
          setEditingId(previous?.id ?? ''); setName(previous?.name ?? ''); setDescription(previous?.description ?? ''); setEntries(previous ? [...previous.entries] : [])
        }}><option value="">创建新预设</option>{latest.map(item => <option key={item.id} value={item.id}>新版本：{item.name} · v{item.revision}</option>)}</select>
        <p className="text-xs text-muted-foreground">预设是不可变版本，当前仅支持实例范围和手工应用。运行中的 Agent 更新需重启 Worker。</p>
        <input aria-label="预设名称" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" value={name} onChange={event => setName(event.target.value)} placeholder="预设名称" />
        <input aria-label="预设描述" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" value={description} onChange={event => setDescription(event.target.value)} placeholder="描述（可选）" />
        <div className="grid gap-2 sm:grid-cols-3">
          <select aria-label="预设资源" className="min-w-0 rounded-lg border border-border bg-background px-2 py-2 text-xs" value={resourceId} onChange={event => { setResourceId(event.target.value); setRevisionId(''); setAgentKey('') }}><option value="">选择资源</option>{available.map(item => <option key={item.id} value={item.id}>{item.name}（{resourceKindLabel[item.kind] ?? item.kind}）</option>)}</select>
          <select aria-label="预设版本" className="min-w-0 rounded-lg border border-border bg-background px-2 py-2 text-xs" value={revisionId} onChange={event => setRevisionId(event.target.value)}><option value="">选择版本</option>{eligibleRevisions.map(item => <option key={item.id} value={item.id}>v{item.version}</option>)}</select>
          <select aria-label="预设 Agent" className="min-w-0 rounded-lg border border-border bg-background px-2 py-2 text-xs" value={agentKey} onChange={event => setAgentKey(event.target.value)}><option value="">{chosen?.kind === 'agent-runtime' || chosen?.kind === 'model-provider' ? '选择 Agent' : '任意 Agent'}</option>{['pi', 'claude-code', 'opencode'].map(key => <option key={key} value={key}>{key}</option>)}</select>
        </div>
        <button type="button" className="rounded-lg border border-border px-3 py-2 text-xs" onClick={addEntry}>添加资源</button>
        {entries.map((item, index) => <div key={`${item.resourceRevisionId}-${index}`} className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-xs"><span>{resources.find(resource => resource.id === item.resourceId)?.name ?? item.resourceId} · v{revisions.find(revision => revision.id === item.resourceRevisionId)?.version ?? '?'} · {item.agentKey ?? '任意 Agent'}</span><button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setEntries(old => old.filter((_, i) => i !== index))}>移除</button></div>)}
        <button type="button" disabled={busy} className="rounded-lg bg-primary px-4 py-2 text-xs text-primary-foreground disabled:opacity-50" onClick={() => void save()}>{editingId ? '发布新版本' : '发布预设'}</button>
      </div>
      <div className="space-y-3">
        <h3 className="text-sm font-medium">手工应用到节点</h3>
        <div className="grid gap-2 sm:grid-cols-2">
          <select aria-label="应用预设" className="min-w-0 rounded-lg border border-border bg-background px-2 py-2 text-xs" value={presetId} onChange={event => setPresetId(event.target.value)}><option value="">选择预设</option>{latest.map(item => <option key={item.id} value={item.id}>{item.name} · v{item.revision}</option>)}</select>
          <select aria-label="应用工作节点" className="min-w-0 rounded-lg border border-border bg-background px-2 py-2 text-xs" value={workerId} onChange={event => setWorkerId(event.target.value)}><option value="">选择工作节点</option>{workers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
        </div>
        <button type="button" disabled={busy} className="rounded-lg bg-primary px-4 py-2 text-xs text-primary-foreground disabled:opacity-50" onClick={() => void apply()}>应用到节点</button>
        <button type="button" className="ml-2 inline-flex items-center gap-1 text-xs text-muted-foreground" onClick={() => void refresh().catch(cause => setError(String(cause)))}><RefreshCw className="h-3 w-3" />刷新状态</button>
        <div className="max-h-72 space-y-2 overflow-y-auto" aria-label="预设应用进度">{applications.map(({ application, items }) => <div key={application.id} className="rounded-lg border border-border p-3 text-xs"><p className="mb-2 font-medium">{presets.find(item => item.id === application.presetId && item.revision === application.presetRevision)?.name ?? application.presetId} · {workers.find(item => item.id === application.workerId)?.name ?? application.workerId}</p>{items.map(item => <p key={item.binding.id} className="flex justify-between gap-2 py-1"><span>{resources.find(resource => resource.id === item.binding.resourceId)?.name ?? item.binding.resourceId}</span><span>{statusOf(item)}{item.reconcile?.errorCode ? ` · ${item.reconcile.errorCode}` : ''}</span></p>)}</div>)}</div>
      </div>
      {(error || message) && <p role="status" className={`text-xs lg:col-span-2 ${error ? 'text-destructive' : 'text-muted-foreground'}`}>{error || message}</p>}
    </div>}
  </section>
}
