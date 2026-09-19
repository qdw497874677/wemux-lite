import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { unavailableCapability, type Run, type TaskDetail, type ReviewStatus } from '@wemux/web-contract/task-platform'
import type { Api } from '../../api/client'
import { projectKeys } from '../../app/project-query'
import { Button } from '../../components/ui/button'

export function RunReview({ api, task, run, refresh }: { api: Api; task: TaskDetail; run: Run; refresh: () => void }) {
  const review = useQuery({ queryKey: projectKeys.review(task.projectId, task.id, run.id), queryFn: ({ signal }) => api.review(task.projectId, task.id, run.id, signal) })
  const [pending, setPending] = useState(false), [error, setError] = useState('')
  const [intent, setIntent] = useState<ReviewStatus | null>(null)
  const actions = [
    { status: 'requested' as const, label: '请求人工审查', capability: run.capabilities?.reviewRequest },
    { status: 'approved' as const, label: '批准 → Done', capability: run.capabilities?.reviewApprove },
    { status: 'changes_requested' as const, label: '请求修改 → Blocked', capability: run.capabilities?.reviewChangesRequested },
  ]
  async function act(status: ReviewStatus) {
    if (pending || !navigator.onLine || !(actions.find(a => a.status === status)?.capability ?? unavailableCapability).allowed) return
    if (!window.confirm(`确认${actions.find(a => a.status === status)?.label}？当前任务版本 v${task.version}。`)) return
    setPending(true); setIntent(status); setError('')
    try { await api.reviewAction(task.projectId, task.id, run.id, { status, version: task.version }); setIntent(null); refresh() }
    catch (cause) { setError(cause instanceof Error ? cause.message : '审查失败'); refresh() }
    finally { setPending(false) }
  }
  return <section aria-label="Run 审查" className="space-y-3 border-t border-border py-3"><h4>人工审查</h4>
    {run.status === 'succeeded' && <p>Run 已成功，建议核对结果后请求审查；不会自动完成 Task。</p>}
    {review.isPending && <p role="status">正在读取审查…</p>}{review.error && <p role="alert">{review.error.message}</p>}
    {review.data && <p>{review.data.review ? `${review.data.review.status} · ${review.data.review.reviewer ?? review.data.review.actor}` : '尚未请求审查。'}</p>}
    {error && <p role="alert">{error}。已保留意图 {intent}；请核对最新任务，再次显式确认，不会自动重试。</p>}
    {actions.map(a => { const capability = a.capability ?? unavailableCapability; return <div key={a.status}><Button variant="outline" disabled={pending || !navigator.onLine || !capability.allowed} onClick={() => void act(a.status)}>{a.label}</Button>{!capability.allowed && <p className="text-xs">{capability.reason}</p>}</div> })}
  </section>
}
