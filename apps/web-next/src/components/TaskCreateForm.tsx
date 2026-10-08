import { useLayoutEffect, useReducer, useRef } from 'react'
import type { TaskPriority } from '@wemux/web-contract/task-platform'
import { defaultTaskMetadataJson, parseTaskMetadata, sameTaskMetadata, taskMetadataIntentKey } from '../lib/task-metadata.ts'
import { registerUnsaved } from '../lib/unsaved-navigation.ts'
import { useOperationLifetime } from '../lib/operation-lifetime.ts'
import { useCreateIntent, type ProjectClient } from './ProjectManagement.tsx'
import { useAction } from './AccountForms.tsx'
import { Button, Input } from './primitives.tsx'

type Draft = { title: string; description: string; acceptanceCriteria: string; priority: TaskPriority; metadataJson: string }
const emptyDraft = (): Draft => ({ title: '', description: '', acceptanceCriteria: '', priority: 'none', metadataJson: defaultTaskMetadataJson })
/** Memory-only ordinary Task creation. Selection keys retire the draft only after navigation is approved. */
export function TaskCreateForm({ api, projectId, created }: { api: ProjectClient; projectId: string; created: (taskId: string) => void }) {
  const draft = useRef(emptyDraft()), [, render] = useReducer(value => value + 1, 0)
  const intent = useCreateIntent(), action = useAction(), begin = useOperationLifetime([api, projectId])
  useLayoutEffect(() => {
    draft.current = emptyDraft(); render()
    const unregister = registerUnsaved(() => {
      const value = draft.current
      return value.title !== '' || value.description !== '' || value.acceptanceCriteria !== '' || value.priority !== 'none' || !sameTaskMetadata(value.metadataJson, defaultTaskMetadataJson)
    })
    return () => { unregister(); draft.current = emptyDraft() }
  }, [api, projectId])
  const edit = <K extends keyof Draft>(field: K, value: Draft[K]) => { draft.current = { ...draft.current, [field]: value }; render() }
  const values = draft.current
  return <form className="account-form" onSubmit={event => {
    event.preventDefault()
    void action.run(async () => {
      const active = begin(), value = draft.current
      const body = { ...value, acceptanceCriteria: value.acceptanceCriteria || null, metadataJson: parseTaskMetadata(value.metadataJson) }
      const requestId = intent.id({ ...body, metadataJson: taskMetadataIntentKey(body.metadataJson) })
      const task = await api.createTask(projectId, { ...body, requestId })
      if (!active()) return
      // Update the guard's ref synchronously, before intentional detail navigation.
      // Inputs stay disabled while pending, so this never discards edits made after submission.
      draft.current = emptyDraft(); render(); intent.complete()
      created(task.id)
      return '任务已创建。'
    })
  }}><fieldset disabled={action.busy}>
    <label>任务标题<Input name="title" required value={values.title} onChange={event => edit('title', event.target.value)} /></label>
    <label>任务描述<textarea className="input" aria-label="任务描述" name="description" rows={5} value={values.description} onChange={event => edit('description', event.target.value)} /></label>
    <label>验收标准<textarea className="input" aria-label="验收标准" name="acceptanceCriteria" rows={5} value={values.acceptanceCriteria} onChange={event => edit('acceptanceCriteria', event.target.value)} /></label>
    <label>优先级<select name="priority" value={values.priority} onChange={event => edit('priority', event.target.value as TaskPriority)}><option value="none">未设置</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label>
    <details><summary>高级设置</summary><label>Metadata JSON（schemaVersion 1）<textarea className="input" aria-label="Metadata JSON（schemaVersion 1）" name="metadataJson" rows={8} value={values.metadataJson} onChange={event => edit('metadataJson', event.target.value)} /></label></details>
    <Button type="submit">创建任务</Button>
  </fieldset>{action.feedback}</form>
}
