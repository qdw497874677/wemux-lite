import { useEffect, useId, useState } from 'react'
import type { ConversationSession } from '@wemux/web-contract'
import type { WorkerDTO } from '@wemux/web-contract/browser-host'
import type { ProjectClient } from './ProjectManagement.tsx'
import { conversationModelOptions } from '../lib/conversation-model-options.ts'
import { Button } from './primitives.tsx'

export function ConversationModelSelection({ api, teamId, session, disabled, select }: { api: ProjectClient; teamId: string; session: ConversationSession; disabled: boolean; select(modelId: string): void }) {
  const selectId = useId()
  const [catalogue, setCatalogue] = useState<{ api: ProjectClient; workers: WorkerDTO[] } | null>(null)
  const [error, setError] = useState(false), [revision, setRevision] = useState(0), [selected, setSelected] = useState('')
  useEffect(() => {
    let live = true; setCatalogue(null); setError(false)
    void api.workers().then(workers => { if (live && !api.controlIdentity.signal.aborted) setCatalogue({ api, workers }) }).catch(() => { if (live) setError(true) })
    return () => { live = false }
  }, [api, teamId, session.id, revision])
  const models = catalogue?.api === api && !api.controlIdentity.signal.aborted ? conversationModelOptions(teamId, session, catalogue.workers) : []
  const available = models.some(model => model.modelId === selected)
  return <section aria-label="模型选择"><h5>后续 Turn 模型</h5>
    <p>已确认选择：{session.binding.modelId ?? 'Agent 默认模型'}。选择变更不修改已经启动的 Turn；执行结果以 Worker 历史为准。</p>
    <label htmlFor={selectId}>选择后续模型</label><select id={selectId} value={available ? selected : ''} disabled={disabled || !models.length} onChange={event => setSelected(event.target.value)}><option value="">请选择模型</option>{models.map(model => <option key={model.modelId} value={model.modelId}>{model.displayName}（{model.modelId}）</option>)}</select>
    <Button variant="outline" disabled={disabled || !available} onClick={() => { if (!disabled && available) select(selected) }}>应用到后续 Turn</Button>
    <Button variant="outline" disabled={disabled} onClick={() => { setCatalogue(null); setRevision(value => value + 1) }}>刷新模型清单</Button>
    {error ? <p role="alert">模型清单读取失败，请刷新后重试。</p> : !catalogue ? <p role="status">正在读取模型清单…</p> : !models.length && <p>当前 Worker 未提供可切换模型，或此 Agent 的模型已固定。</p>}
  </section>
}
