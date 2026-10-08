import { ApiError } from '@wemux/web-client'
import { registerUnsaved } from '../lib/unsaved-navigation.ts'
import { useEffect, useReducer, useState, useRef } from 'react'
import type { TaskDetail, TaskPriority } from '@wemux/web-contract/task-platform'
import { TaskContentDraft } from '../lib/task-content-draft.ts'
import type { ProjectClient } from './ProjectManagement.tsx'
import { useAction } from './AccountForms.tsx'
import { Button, Input } from './primitives.tsx'

const labels = { title: '编辑标题', description: '编辑描述', acceptanceCriteria: '编辑验收标准', priority: '编辑优先级', metadataJson: '编辑 Metadata JSON（schemaVersion 1）' }
export function TaskContentEditor({ api, task, writable, changed }: { api: ProjectClient; task: TaskDetail; writable: boolean; changed: () => void }) {
  const [draft] = useState(() => new TaskContentDraft(task))
  const [, redraw] = useReducer(value => value + 1, 0)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const action = useAction()
  const [needsReload, setNeedsReload] = useState(false)
  useEffect(() => registerUnsaved(() => writable && draft.dirty), [draft, writable])
  useEffect(() => { draft.receive(task); redraw() }, [draft, task])
  return <form className="account-form" onSubmit={event => {
    event.preventDefault()
    void action.run(async () => {
      if (!writable || needsReload) return
      // Reject malformed raw metadata before any preflight read or write.
      if (!draft.conflicts.length) draft.submission()
      // Reconcile fields with authority, then CAS the same snapshot in the write transaction.
      const current = await api.task(task.projectId, task.id)
      if (!alive.current) return
      draft.receive(current); redraw()
      const sent = draft.submission()
      if (!Object.keys(sent.patch).length) return '没有需要保存的内容修改。'
      try {
        const saved = await api.patchTask(task.projectId, task.id, { ...sent.patch, version: current.version })
        if (!alive.current) return
        draft.saved(sent, saved); redraw(); changed()
        return '任务内容已保存。'
      } catch (error) {
        if (!alive.current) return
        if (error instanceof ApiError && error.code === 'version_conflict') setNeedsReload(true)
        throw error
      }
    })
  }}>
    <p className="muted">仅保存编辑过的字段。加载最新版本会保留本地草稿；同字段冲突需明确选择。保存携带读取版本，服务端原子校验；版本冲突后须重新加载并核实草稿，不自动重试。</p>
    {needsReload && <div role="alert"><p>任务版本已变化，草稿已保留。请重新加载内容版本，再处理字段冲突。</p><Button variant="outline" disabled={action.busy} onClick={() => void action.run(async () => {
      const current = await api.task(task.projectId, task.id)
      if (!alive.current) return
      draft.receive(current); setNeedsReload(false); redraw()
      return '已加载最新内容版本，请核实草稿。'
    })}>重新加载内容版本</Button></div>}
    <fieldset disabled={!writable || action.busy}>
      <label>{labels.title}<Input name="title" required value={draft.values.title} onChange={event => { draft.edit('title', event.target.value); redraw() }} /></label>
      <label>{labels.description}<textarea className="input" aria-label={labels.description} name="description" rows={5} value={draft.values.description} onChange={event => { draft.edit('description', event.target.value); redraw() }} /></label>
      <label>{labels.acceptanceCriteria}<textarea className="input" aria-label={labels.acceptanceCriteria} name="acceptanceCriteria" rows={5} value={draft.values.acceptanceCriteria ?? ''} onChange={event => { draft.edit('acceptanceCriteria', event.target.value); redraw() }} /></label>
      <label>{labels.priority}<select name="priority" value={draft.values.priority} onChange={event => { draft.edit('priority', event.target.value as TaskPriority); redraw() }}><option value="none">未设置</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label>
      <details><summary>高级设置</summary><label>{labels.metadataJson}<textarea className="input" aria-label={labels.metadataJson} name="metadataJson" rows={8} value={draft.values.metadataJson} onChange={event => { draft.edit('metadataJson', event.target.value); redraw() }} /></label></details>
      {draft.conflicts.map(field => <div key={field} role="alert"><p>{labels[field]}存在远端修改，请选择保留哪一份。</p><p>远端内容：</p><pre className="machine" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{draft.remote(field) ?? '未设置（null）'}</pre><div className="account-actions"><Button variant="outline" onClick={() => { draft.resolve(field, 'local'); redraw() }}>保留本地{labels[field]}</Button><Button variant="outline" onClick={() => { draft.resolve(field, 'remote'); redraw() }}>采用远端{labels[field]}</Button></div></div>)}
      <Button type="submit" disabled={needsReload || draft.conflicts.length > 0}>保存任务内容</Button>
    </fieldset>{action.feedback}
  </form>
}
