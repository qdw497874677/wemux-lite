import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ResourceInventoryDTO } from '@wemux/web-contract/browser-host'
import type { ResourceBindingProjectionDTO, ResourceDTO, ResourceRevisionDTO } from '@wemux/web-contract/resource-write'
import type { ProjectClient } from './ProjectManagement.tsx'
import { useAccountData } from './AccountForms.tsx'
import { Button, Input } from './primitives.tsx'
import { PresetWriteActions } from './PresetWriteActions.tsx'
import { copyText, describeResourceWriteError, randomId, selectElementText } from '@wemux/web-client'
import { useCreateIntent } from '../lib/create-intent.ts'
import {
  isModelProvider, isRetiredBinding, isSkill, latestRevision, nextRevisionVersion, prepareProviderDefinition,
  prepareProviderRevision, prepareSkillRevision, providerDefinitionFromDefinition, resourceCreateInput, resourceKindLabels,
  resourceUpdateInput, writableResourceKinds, type WritableResourceKind,
} from '../lib/resource-write.ts'

/**
 * 管理动作：在既有的受审计 API 上提供写入入口。
 *
 * 这里不做权限判定（Server 是唯一判定者），不发明旁路路由；每次写入后重新核验四态投影，
 * 冲突码与校验码都翻译成可执行的中文原因，绝不静默失败。
 */
export type Write = ReturnType<typeof useWrite>

/** 可选工作节点：连接状态来自资源清单投影，可能为空。 */
export type WorkerOption = { id: string; name: string; connectionState: string | null }

/** 写入动作的共享状态：失败原因来自 Server 的冲突码/校验码，成功后刷新数据与投影。 */
export function useWrite(refresh: () => void) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const pending = useRef(false)
  async function run(work: () => Promise<string>) {
    if (pending.current) return
    pending.current = true; setBusy(true); setError(''); setNotice('')
    try {
      const result = await work()
      if (alive.current) { setNotice(result); refresh() }
    } catch (cause) {
      if (alive.current) setError(describeResourceWriteError(cause))
    } finally {
      pending.current = false
      if (alive.current) setBusy(false)
    }
  }
  return { busy, run, error, notice }
}

/** 写入反馈：进行中/失败原因/成功结果，冲突与校验失败都给出可执行的中文说明。 */
export function WriteFeedback({ write }: { write: Write }) {
  return <>{write.busy && <p role="status">正在提交…</p>}{write.error && <p role="alert">{write.error}</p>}{write.notice && <p role="status">{write.notice}</p>}</>
}

/** 复制写入结果（例如 blob 摘要）；非安全上下文不假成功，降级为选中文本。 */
function CopyNotice({ write }: { write: Write }) {
  const text = useRef<HTMLParagraphElement>(null)
  const [notice, setNotice] = useState('')
  return <div><p ref={text} className="machine" tabIndex={0}>{write.notice}</p><Button variant="outline" onClick={async () => {
    if (await copyText(write.notice)) setNotice('已复制写入结果。')
    else { if (text.current) selectElementText(text.current); setNotice('无法自动复制。已选中文本，请按 Ctrl+C 或长按复制。') }
  }}>复制结果</Button><p role="status">{notice}</p></div>
}

/** 把失败原因交给界面：ActionForm 风格的反馈使用同一套翻译，不暴露原始 HTTP 前缀。 */
export async function attempt<T>(work: () => Promise<T>): Promise<T> {
  try { return await work() } catch (cause) { throw new Error(describeResourceWriteError(cause)) }
}

/** 与 ActionForm 相同的表单骨架，但错误映射到资源写入语义，并允许附带自定义控件。 */
export function WriteForm({ label, write, disabled, confirm, children, submit }: {
  label: string; write: Write; disabled?: boolean; confirm?: string; children: ReactNode
  submit: (values: Record<string, string>) => Promise<string>
}) {
  return <form className="account-form" onSubmit={event => {
    event.preventDefault()
    const form = event.currentTarget
    if (confirm && !window.confirm(confirm)) return
    const values = Object.fromEntries(new FormData(form)) as Record<string, string>
    void write.run(async () => { const result = await submit(values); form.reset(); return result })
  }}>
    <fieldset disabled={disabled || write.busy}>{children}<Button type="submit">{label}</Button></fieldset>
    <WriteFeedback write={write} />
    {write.notice && <CopyNotice write={write} />}
  </form>
}

export function ConfirmWriteButton({ children, confirm, write, act, disabled }: { children: ReactNode; confirm: string; write: Write; act: () => Promise<string>; disabled?: boolean }) {
  return <div><Button variant="outline" disabled={disabled || write.busy} onClick={() => { if (window.confirm(confirm)) void write.run(act) }}>{children}</Button><WriteFeedback write={write} /></div>
}

export function ResourceWriteActions({ api, inventory, onChanged }: { api: ProjectClient; inventory: ResourceInventoryDTO; onChanged: () => void }) {
  const data = useAccountData(async () => {
    const [resources, bindings, presets] = await Promise.all([api.resourceList(), api.resourceBindings(), api.resourcePresets()])
    return { resources, bindings, presets }
  }, [api])
  // 每次写入成功后推进一代：各区块的修订详情缓存必须失效，否则刚发布的修订在选择器里不可见。
  const [generation, setGeneration] = useState(0)
  const refresh = () => { data.reload(); setGeneration(value => value + 1); onChanged() }
  const workers: WorkerOption[] = inventory.workers.map(worker => ({ id: worker.workerId ?? worker.id, name: worker.workerName ?? worker.name, connectionState: worker.connectionState }))
  const actor = api.controlIdentity.accountId ?? ''
  return <section className="account-section" aria-label="资源管理动作">
    <h2>管理动作</h2>
    <p>每个动作都调用既有的受审计接口，权限与并发由 Server 判定；提交后会重新核验四态投影。撤销绑定只转入待回收状态，不做物理删除。</p>
    {data.feedback}
    {data.data && <>
      <CreateResourceSection api={api} refresh={refresh} />
      <ResourceListSection api={api} refresh={refresh} resources={data.data.resources} />
      <SkillRevisionSection api={api} refresh={refresh} resources={data.data.resources} generation={generation} />
      <ProviderRevisionSection api={api} refresh={refresh} resources={data.data.resources} actor={actor} generation={generation} />
      <BindingSection api={api} refresh={refresh} resources={data.data.resources} workers={workers} bindings={data.data.bindings} generation={generation} />
      <PresetWriteActions api={api} refresh={refresh} presets={data.data.presets} resources={data.data.resources} workers={workers} generation={generation} />
    </>}
  </section>
}

function CreateResourceSection({ api, refresh }: { api: ProjectClient; refresh: () => void }) {
  const write = useWrite(refresh)
  const intent = useCreateIntent()
  const [kind, setKind] = useState<WritableResourceKind>('skill')
  const provider = kind === 'model-provider'
  return <section className="account-section" aria-label="新建资源">
    <h3>新建资源</h3>
    <p>Provider 资源只登记非秘密定位信息；密钥留在 Worker 本地，不进资源体。</p>
    <WriteForm label="新建资源" write={write} submit={async values => {
      const definition = provider
        ? prepareProviderDefinition({ endpoint: values.endpoint ?? '', modelId: values.modelId ?? '', credentialRef: values.credentialRef ?? '' })
        : kind === 'skill' ? { entryFile: 'SKILL.md', compatibleAgents: ['pi'], containsExecutableFiles: false } : {}
      const now = new Date().toISOString()
      const id = intent.id({ kind, name: values.name, description: values.description, definition })
      const created = await attempt(() => api.createResource(resourceCreateInput({ id, kind, name: values.name ?? '', description: values.description ?? '', definition, now })))
      intent.complete()
      return `已创建${resourceKindLabels[created.kind]}资源「${created.name}」（${created.id}）`
    }}>
      <label>资源类型<select className="input" name="kind" value={kind} onChange={event => setKind(event.target.value as WritableResourceKind)}>
        {writableResourceKinds.map(item => <option key={item} value={item}>{resourceKindLabels[item]}</option>)}
      </select></label>
      <label>名称<Input name="name" required maxLength={200} /></label>
      <label>描述<Input name="description" /></label>
      {provider && <>
        <label>HTTPS 端点<Input name="endpoint" type="url" required placeholder="https://api.example.com/v1" /></label>
        <label>模型 ID<Input name="modelId" required placeholder="gpt-4o-mini" /></label>
        <label>凭据引用<Input name="credentialRef" required placeholder="openai-default" /></label>
      </>}
    </WriteForm>
  </section>
}

function ResourceListSection({ api, refresh, resources }: { api: ProjectClient; refresh: () => void; resources: readonly ResourceDTO[] }) {
  return <section className="account-section" aria-label="资源清单与修改">
    <h3>资源清单</h3>
    {resources.length === 0 ? <p>还没有资源。先在上方新建一个。</p> : <ul>{resources.map(resource => <ResourceRow key={resource.id} api={api} refresh={refresh} resource={resource} />)}</ul>}
  </section>
}

function ResourceRow({ api, refresh, resource }: { api: ProjectClient; refresh: () => void; resource: ResourceDTO }) {
  // 保存与删除各自持有反馈：共用同一个写入状态会让同一通知在行内出现两次。
  const save = useWrite(refresh)
  const remove = useWrite(refresh)
  const provider = isModelProvider(resource) ? resource.definition : null
  return <li className="account-row">
    <article aria-label={`管理资源 ${resource.name}`}>
      <h4>{resource.name}</h4>
      <p>{resourceKindLabels[resource.kind]}｜{resource.id}｜更新于 {new Date(resource.updatedAt).toLocaleString('zh-CN')}</p>
      {provider && <p>端点：{provider.endpoint}｜模型：{provider.modelIds.join('、')}｜凭据引用：{provider.credential.kind === 'worker-credential' ? provider.credential.credentialRef : provider.credential.variableNames.join('、')}</p>}
      <WriteForm label="保存名称与描述" write={save} submit={async values => {
        const updated = await attempt(() => api.updateResource(resourceUpdateInput(resource, { name: values.name ?? '', description: values.description ?? '' }, new Date().toISOString())))
        return `已更新资源「${updated.name}」`
      }}>
        <label>名称<Input name="name" defaultValue={resource.name} required maxLength={200} /></label>
        <label>描述<Input name="description" defaultValue={resource.description} /></label>
      </WriteForm>
      <ConfirmWriteButton write={remove} confirm={`删除资源「${resource.name}」？已发布的修订会保留在历史记录中，但不再可绑定。`} act={async () => {
        await attempt(() => api.deleteResource(resource.id))
        return `已删除资源「${resource.name}」`
      }}>删除资源</ConfirmWriteButton>
    </article>
  </li>
}

export function useResourceDetail(api: ProjectClient, resourceId: string, generation = 0) {
  const [state, setState] = useState<{ api: ProjectClient; resourceId: string; detail: { resource: ResourceDTO; revisions: readonly ResourceRevisionDTO[] } }>()
  useEffect(() => {
    if (!resourceId) return
    let live = true
    void api.resourceDetail(resourceId).then(detail => { if (live) setState({ api, resourceId, detail }) }).catch(() => { if (live) setState({ api, resourceId, detail: { resource: undefined as never, revisions: [] } }) })
    return () => { live = false }
  }, [api, resourceId, generation])
  const current = state && state.api === api && state.resourceId === resourceId ? state.detail : undefined
  return { detail: current && current.resource ? current : undefined, settled: Boolean(current) }
}

function SkillRevisionSection({ api, refresh, resources, generation }: { api: ProjectClient; refresh: () => void; resources: readonly ResourceDTO[]; generation: number }) {
  const write = useWrite(refresh)
  const skills = resources.filter(isSkill)
  const [resourceId, setResourceId] = useState('')
  const { detail } = useResourceDetail(api, resourceId, generation)
  const version = detail ? nextRevisionVersion(detail.revisions) : undefined
  return <section className="account-section" aria-label="发布技能修订">
    <h3>发布技能修订</h3>
    <p>技能修订是静态内容：先按 sha256 上传 SKILL.md（内容相同即去重），再发布引用该 blob 的不可变修订。</p>
    <WriteForm label="发布技能修订" write={write} disabled={skills.length === 0} submit={async values => {
      if (!resourceId) throw new Error('请选择要发布修订的技能资源。')
      const fresh = await attempt(() => api.resourceDetail(resourceId))
      if (fresh.resource.kind !== 'skill') throw new Error('所选资源不是技能资源，请重新选择。')
      const next = nextRevisionVersion(fresh.revisions)
      const { revision, blobSha256, base64Content } = prepareSkillRevision({
        resourceId, revisionId: randomId(), version: next, name: fresh.resource.name, description: fresh.resource.description,
        content: values.content ?? '', agentKeys: fresh.resource.definition.compatibleAgents, createdAt: new Date().toISOString(),
      })
      const blob = await attempt(() => api.putResourceBlob(blobSha256, base64Content))
      await attempt(() => api.publishResourceRevision(resourceId, revision))
      return `已发布技能修订 v${next}；blob sha256 ${blob.sha256}（${blob.deduplicated ? '内容已存在，已去重' : '新写入'}）`
    }}>
      <label>技能资源<select className="input" name="resourceId" value={resourceId} onChange={event => setResourceId(event.target.value)}>
        <option value="">请选择</option>
        {skills.map(skill => <option key={skill.id} value={skill.id}>{skill.name}</option>)}
      </select></label>
      {detail && <p>下一个版本号：v{version}｜现有修订 {detail.revisions.length} 个</p>}
      <label>SKILL.md 内容<textarea className="input" name="content" rows={6} required /></label>
    </WriteForm>
  </section>
}

function ProviderRevisionSection({ api, refresh, resources, actor, generation }: { api: ProjectClient; refresh: () => void; resources: readonly ResourceDTO[]; actor: string; generation: number }) {
  const write = useWrite(refresh)
  const providers = resources.filter(isModelProvider)
  const [resourceId, setResourceId] = useState('')
  const { detail } = useResourceDetail(api, resourceId, generation)
  const latest = detail ? latestRevision(resourceId, detail.revisions) : undefined
  const selected = providers.find(provider => provider.id === resourceId)
  const current = selected ? providerDefinitionFromDefinition(selected.definition) : undefined
  return <section className="account-section" aria-label="发布 Provider 修订">
    <h3>发布 Provider 修订</h3>
    <p>首个修订必须与资源当前定义完全一致（走通用修订接口）；后续修订用 expectedVersion 做乐观并发校验。这里从不输入密钥。</p>
    <WriteForm label="发布 Provider 修订" write={write} disabled={providers.length === 0 || !actor} submit={async values => {
      if (!resourceId) throw new Error('请选择要发布修订的 Provider 资源。')
      if (!actor) throw new Error('当前会话缺少账号标识，无法发布 Provider 修订。')
      const fresh = await attempt(() => api.resourceDetail(resourceId))
      if (!isModelProvider(fresh.resource)) throw new Error('所选资源不是 Provider 资源，请重新选择。')
      const latestVersion = fresh.revisions.reduce((highest, revision) => Math.max(highest, revision.version), 0)
      const definition = latestVersion === 0 ? fresh.resource.definition : prepareProviderDefinition({
        endpoint: values.endpoint ?? '', modelId: values.modelId ?? '', credentialRef: values.credentialRef ?? '', agentKeys: fresh.resource.definition.agentKeys,
      })
      const revision = prepareProviderRevision({
        resourceId, revisionId: randomId(), version: latestVersion + 1, name: fresh.resource.name,
        definition, createdAt: new Date().toISOString(), createdBy: actor,
      })
      if (latestVersion === 0) await attempt(() => api.publishResourceRevision(resourceId, revision))
      else await attempt(() => api.publishProviderRevision(resourceId, { expectedVersion: latestVersion, revision }))
      return `已发布 Provider 修订 v${latestVersion + 1}；端点 ${definition.endpoint}，模型 ${definition.modelIds.join('、')}；凭据仍需在 Worker 本地配置。`
    }}>
      <label>Provider 资源<select className="input" name="resourceId" value={resourceId} onChange={event => setResourceId(event.target.value)}>
        <option value="">请选择</option>
        {providers.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
      </select></label>
      {detail && latest && <p>最新修订 v{latest.version}，下一个版本号 v{latest.version + 1}（expectedVersion {latest.version}）</p>}
      {detail && !latest && <p>该资源还没有修订：首个修订固定使用当前定义，端点 {current?.endpoint}，模型 {current?.modelId}。</p>}
      {detail && latest && <>
        <label>HTTPS 端点<Input name="endpoint" type="url" required defaultValue={current?.endpoint} /></label>
        <label>模型 ID<Input name="modelId" required defaultValue={current?.modelId} /></label>
        <label>凭据引用<Input name="credentialRef" required defaultValue={current?.credentialRef} /></label>
      </>}
    </WriteForm>
  </section>
}

function BindingSection({ api, refresh, resources, workers, bindings, generation }: {
  api: ProjectClient; refresh: () => void; resources: readonly ResourceDTO[]
  workers: readonly WorkerOption[]; bindings: readonly ResourceBindingProjectionDTO[]; generation: number
}) {
  const write = useWrite(refresh)
  const revoke = useWrite(refresh)
  const [resourceId, setResourceId] = useState('')
  const { detail } = useResourceDetail(api, resourceId, generation)
  const published = (detail?.revisions ?? []).filter(revision => revision.state === 'published')
  const workerName = (id: string) => workers.find(worker => worker.id === id)?.name ?? id
  return <section className="account-section" aria-label="资源绑定">
    <h3>资源绑定与撤销</h3>
    <p>绑定把某个已发布修订指派给一个工作节点；撤销是状态迁移，转入待回收后由 Worker 收敛。</p>
    <WriteForm label="创建绑定" write={write} disabled={workers.length === 0} submit={async values => {
      const workerId = values.workerId ?? '', resourceRevisionId = values.resourceRevisionId ?? ''
      if (!workerId || !resourceRevisionId) throw new Error('请选择工作节点与已发布修订。')
      const duplicate = bindings.find(item => item.binding.workerId === workerId && item.binding.resourceRevisionId === resourceRevisionId && !isRetiredBinding(item.binding.status))
      if (duplicate) throw new Error('该工作节点已绑定这个修订，无需重复创建。')
      const binding = await attempt(() => api.createResourceBinding({
        id: randomId(), workerId, resourceRevisionId,
        ...(values.agentKey ? { agentKey: values.agentKey } : {}), ...(values.projectId ? { projectId: values.projectId } : {}),
      }))
      return `已创建绑定 ${binding.id}（${binding.status}）`
    }}>
      <label>工作节点<select className="input" name="workerId" required defaultValue="">
        <option value="">请选择</option>
        {workers.map(worker => <option key={worker.id} value={worker.id}>{worker.name}（{worker.connectionState}）</option>)}
      </select></label>
      <label>资源<select className="input" name="resourceId" value={resourceId} onChange={event => setResourceId(event.target.value)}>
        <option value="">请选择</option>
        {resources.map(resource => <option key={resource.id} value={resource.id}>{resourceKindLabels[resource.kind]}｜{resource.name}</option>)}
      </select></label>
      <label>已发布修订<select className="input" name="resourceRevisionId" required defaultValue="">
        <option value="">请选择</option>
        {published.map(revision => <option key={revision.id} value={revision.id}>v{revision.version}（{revision.id}）</option>)}
      </select></label>
      <label>Agent（可选）<Input name="agentKey" /></label>
      <label>项目（可选）<Input name="projectId" /></label>
    </WriteForm>
    {bindings.length === 0 ? <p>当前没有资源绑定。</p> : <ul>{bindings.map(item => <li key={item.binding.id} className="account-row">
      <article aria-label={`绑定 ${item.binding.id}`}>
        <p>{workerName(item.binding.workerId)}｜{item.binding.resourceId}｜修订 {item.binding.resourceRevisionId}｜状态 {item.binding.status}</p>
        {item.reconcile && <p>收敛：{item.reconcile.result}｜{item.reconcile.phase ?? '无阶段'}｜{item.reconcile.message ?? '无说明'}</p>}
        {isRetiredBinding(item.binding.status)
          ? <p>该绑定已撤销，等待 Worker 回收。</p>
          : <ConfirmWriteButton write={revoke} confirm={`撤销绑定 ${item.binding.id}？将转入待回收状态，不做物理删除。`} act={async () => {
            const revoked = await attempt(() => api.revokeResourceBinding(item.binding.id, item.binding.revision))
            return `绑定 ${revoked.id} 已转入 ${revoked.status}`
          }}>撤销绑定</ConfirmWriteButton>}
      </article>
    </li>)}</ul>}
  </section>
}
