import { useState } from 'react'
import type { NodeResourcePresetDTO, NodeResourcePresetEntryDTO, ResourceDTO } from '@wemux/web-contract/resource-write'
import type { ProjectClient } from './ProjectManagement.tsx'
import { attempt, useResourceDetail, useWrite, WriteForm, type WorkerOption } from './ResourceWriteActions.tsx'
import { Button, Input } from './primitives.tsx'
import { useCreateIntent } from '../lib/create-intent.ts'
import { resourceKindLabels } from '../lib/resource-write.ts'

/**
 * 预设写入：保存（expectedRevision 乐观并发）与应用（requestId 幂等 + expectedSetRevision 乐观并发）。
 * 应用前必须先读当前资源集合修订，Server 会用它对 Worker 上的绑定做一致性校验。
 */
export function PresetWriteActions({ api, refresh, presets, resources, workers, generation }: {
  api: ProjectClient; refresh: () => void; presets: readonly NodeResourcePresetDTO[]
  resources: readonly ResourceDTO[]; workers: readonly WorkerOption[]; generation: number
}) {
  const save = useWrite(refresh), apply = useWrite(refresh)
  const presetIntent = useCreateIntent(), applyIntent = useCreateIntent()
  const [editingId, setEditingId] = useState('')
  const [entries, setEntries] = useState<NodeResourcePresetEntryDTO[]>([])
  const [entryResourceId, setEntryResourceId] = useState(''), [entryRevisionId, setEntryRevisionId] = useState(''), [entryAgentKey, setEntryAgentKey] = useState('')
  const [presetId, setPresetId] = useState(''), [workerId, setWorkerId] = useState('')
  const detail = useResourceDetail(api, entryResourceId, generation)
  const published = (detail.detail?.revisions ?? []).filter(revision => revision.state === 'published')
  const selectedRevision = published.find(revision => revision.id === entryRevisionId)
  const selected = presets.filter(preset => preset.id === presetId).sort((left, right) => right.revision - left.revision)[0]
  const editing = presets.filter(preset => preset.id === editingId).sort((left, right) => right.revision - left.revision)[0]
  const workerName = (id: string) => workers.find(worker => worker.id === id)?.name ?? id
  // Server 按 (id, revision) 逐行保存预设：列表与选择器只展示每个预设的最新修订，否则同一预设会重复出现。
  const currentPresets = Object.values(presets.reduce<Record<string, NodeResourcePresetDTO>>((latest, preset) => {
    if (!latest[preset.id] || preset.revision > latest[preset.id].revision) latest[preset.id] = preset
    return latest
  }, {})).sort((left, right) => left.name.localeCompare(right.name))

  function addEntry() {
    if (!selectedRevision) return
    const agentKey = entryAgentKey.trim()
    if (selectedRevision.kind === 'model-provider') {
      const allowed = selectedRevision.payload.mode === 'inline-config' ? (selectedRevision.payload.config.agentKeys as readonly string[]) : []
      if (!agentKey) throw new Error('Provider 修订必须指定使用它的 Agent。')
      if (!allowed.includes(agentKey)) throw new Error(`该 Provider 修订只对 ${allowed.join('、')} 生效，请选择匹配的 Agent。`)
    }
    setEntries(previous => [...previous, { resourceId: entryResourceId, resourceRevisionId: selectedRevision.id, agentKey: (agentKey || null) as unknown as NodeResourcePresetEntryDTO['agentKey'], projectId: null, required: true }])
  }

  return <section className="account-section" aria-label="资源预设">
    <h3>资源预设</h3>
    <p>预设把若干已发布修订打包成实例级集合；保存用 expectedRevision 做乐观并发，应用用 requestId 保证重复提交不产生重复绑定。</p>
    <section className="account-section" aria-label="预设条目">
      <h4>预设条目</h4>
      <label>资源<select className="input" value={entryResourceId} onChange={event => { setEntryResourceId(event.target.value); setEntryRevisionId('') }}>
        <option value="">请选择</option>
        {resources.map(resource => <option key={resource.id} value={resource.id}>{resourceKindLabels[resource.kind]}｜{resource.name}</option>)}
      </select></label>
      <label>已发布修订<select className="input" value={entryRevisionId} onChange={event => setEntryRevisionId(event.target.value)}>
        <option value="">请选择</option>
        {published.map(revision => <option key={revision.id} value={revision.id}>v{revision.version}｜{revision.id}</option>)}
      </select></label>
      <label>Agent<Input value={entryAgentKey} onChange={event => setEntryAgentKey(event.target.value)} placeholder="pi" /></label>
      <Button variant="outline" disabled={!selectedRevision} onClick={() => { try { addEntry() } catch (cause) { window.alert(cause instanceof Error ? cause.message : '条目无效。') } }}>添加条目</Button>
      {entries.length === 0 ? <p>还没有条目。</p> : <ul>{entries.map((entry, index) => <li key={`${entry.resourceRevisionId}-${index}`}>
        {entry.resourceRevisionId}｜Agent {entry.agentKey ?? '不限'}
        <Button variant="ghost" onClick={() => setEntries(previous => previous.filter((_, position) => position !== index))}>移除</Button>
      </li>)}</ul>}
    </section>
    <WriteForm key={editing?.id ?? 'new'} label={editing ? '保存为新修订' : '创建预设'} write={save} submit={async values => {
      const presetName = (values.name ?? '').trim()
      if (!presetName) throw new Error('请填写预设名称。')
      if (entries.length === 0) throw new Error('预设至少需要一个资源条目。')
      const body = { name: presetName, description: (values.description ?? '').trim(), entries }
      const id = editing?.id ?? presetIntent.id(body)
      const created = await attempt(() => api.createResourcePreset({ id, ...body, expectedRevision: editing?.revision ?? 0 }))
      presetIntent.complete()
      setEditingId(created.id)
      return `预设「${created.name}」已保存为 revision ${created.revision}`
    }}>
      <label>预设名称<Input name="name" required defaultValue={editing?.name} /></label>
      <label>预设描述<Input name="description" defaultValue={editing?.description} /></label>
      {editing && <p>将基于现有预设「{editing.name}」的 revision {editing.revision} 保存为新修订（expectedRevision {editing.revision}）。</p>}
    </WriteForm>
    {currentPresets.length === 0 ? <p>还没有预设。</p> : <ul>{currentPresets.map(preset => <li key={preset.id} className="account-row">
      <article aria-label={`预设 ${preset.name}`}>
        <p>{preset.name}｜revision {preset.revision}｜{preset.entries.length} 个条目</p>
        <Button variant="outline" onClick={() => { setEditingId(preset.id); setEntries([...preset.entries]) }}>载入到编辑器</Button>
      </article>
    </li>)}</ul>}
    <WriteForm label="应用预设" write={apply} disabled={currentPresets.length === 0 || workers.length === 0} submit={async values => {
      if (!selected) throw new Error('请选择要应用的预设。')
      const target = values.workerId ?? workerId
      if (!target) throw new Error('请选择要应用预设的工作节点。')
      const desired = await attempt(() => api.resourceSet(target))
      const request = { presetId: selected.id, presetRevision: selected.revision, workerId: target, expectedSetRevision: desired.revision }
      const application = await attempt(() => api.applyResourcePreset(selected.id, { ...request, requestId: applyIntent.id(request) }))
      applyIntent.complete()
      return `已应用预设「${selected.name}」到 ${workerName(target)}：绑定 ${application.bindingIds.length} 个，当前集合修订 ${desired.revision}`
    }}>
      <label>预设<select className="input" name="presetId" value={presetId} onChange={event => setPresetId(event.target.value)}>
        <option value="">请选择</option>
        {currentPresets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}（revision {preset.revision}）</option>)}
      </select></label>
      <label>工作节点<select className="input" name="workerId" value={workerId} onChange={event => setWorkerId(event.target.value)}>
        <option value="">请选择</option>
        {workers.map(worker => <option key={worker.id} value={worker.id}>{worker.name}（{worker.connectionState}）</option>)}
      </select></label>
      {selected && <p>应用会把 {selected.entries.length} 个条目绑定到所选节点；已存在的有效绑定会触发冲突提示，需先撤销旧绑定。</p>}
    </WriteForm>
  </section>
}
