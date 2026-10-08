import { useQuery } from '@tanstack/react-query'
import type { Artifact } from '@wemux/server-domain'
import { Check, Eye, FilePlus2, RotateCcw, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Api } from '../../api/client.ts'
import { randomId } from '../../lib/random.ts'

export function ArtifactsSection({ api, projectId, taskId, runs, onChanged }: { readonly api: Api; readonly projectId: string; readonly taskId: string; readonly runs: readonly { readonly id: string; readonly status: string }[]; readonly onChanged?: () => void }) {
  const query = useQuery({ queryKey: ['artifacts', taskId], queryFn: () => api.artifacts(projectId, taskId) })
  const runsQuery = useQuery({ queryKey: ['artifact-runs', taskId], queryFn: () => api.taskRunsForArtifacts(projectId, taskId), enabled: runs.length === 0 })
  const availableRuns = runs.length ? runs : runsQuery.data?.items ?? []
  const [path, setPath] = useState('')
  const [mimeType, setMimeType] = useState('text/plain')
  const [size, setSize] = useState('')
  const [runId, setRunId] = useState(runs.find(run => run.status === 'succeeded')?.id ?? '')
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (!runId) setRunId(availableRuns.find(run => run.status === 'succeeded')?.id ?? '') }, [availableRuns, runId])
  const submit = async () => { if (!path || !runId || !Number.isSafeInteger(Number(size))) return; setBusy(true); try { await api.registerArtifact(projectId, taskId, { artifactId: randomId(), runId, relativePath: path, mimeType, size: Number(size), requestId: randomId() }); setPath(''); setSize(''); await query.refetch(); onChanged?.() } finally { setBusy(false) } }
  const review = async (artifact: Artifact, decision: 'approved' | 'changes_requested') => { setBusy(true); try { await api.reviewArtifact(artifact.id, { decision, expectedRevision: artifact.revision, requestId: randomId() }); await query.refetch(); onChanged?.() } finally { setBusy(false) } }
  return <section className="artifact-section" data-testid="artifacts-section">
    <header><div><h2>交付物</h2><p>登记已完成 Run 在 Worker workspace 中生成的文件引用。</p></div></header>
    <div className="artifact-form">
      <select aria-label="Run" value={runId} onChange={event => setRunId(event.target.value)}><option value="">选择已完成 Run</option>{availableRuns.filter(run => run.status === 'succeeded').map(run => <option key={run.id} value={run.id}>{run.id}</option>)}</select>
      <input aria-label="相对路径" value={path} onChange={event => setPath(event.target.value)} placeholder="reports/result.md" />
      <input aria-label="MIME" value={mimeType} onChange={event => setMimeType(event.target.value)} placeholder="text/markdown" />
      <input aria-label="大小" type="number" min="0" value={size} onChange={event => setSize(event.target.value)} placeholder="字节数" />
      <button type="button" disabled={busy || !path || !runId || size === ''} onClick={() => void submit()}><FilePlus2 size={14} />登记</button>
    </div>
    {query.data?.items.length === 0 ? <div className="artifact-empty">还没有登记交付物</div> : null}
    <div className="artifact-list">{query.data?.items.map(artifact => <article key={artifact.id} className="artifact-row"><div><strong>{artifact.relativePath}</strong><small>{artifact.mimeType} · {artifact.size} B · {reviewLabel(artifact.reviewState)} · 修订 {artifact.revision}</small></div><div className="artifact-actions"><a href={`/api/artifacts/${encodeURIComponent(artifact.id)}/content?preview=1`} target="_blank" rel="noreferrer"><Eye size={14} />预览</a><button type="button" disabled={busy} onClick={() => void review(artifact, 'approved')}><Check size={14} />通过</button><button type="button" disabled={busy} onClick={() => void review(artifact, 'changes_requested')}><X size={14} />需修改</button>{artifact.reviewState !== 'pending' ? <span><RotateCcw size={12} />已审查</span> : null}</div></article>)}</div>
  </section>
}

function reviewLabel(state: Artifact['reviewState']) { return state === 'pending' ? '待审查' : state === 'approved' ? '已通过' : '需修改' }
