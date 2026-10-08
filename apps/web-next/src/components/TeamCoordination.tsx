import { useEffect, useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import { Failure } from './Failure.tsx'
import { errorPresentation } from '../application.ts'

/** 服务端资格门投影；字段由 /api/teams/:id/coordination/availability 下发，浏览器不硬编码结论。 */
export type CoordinationAvailability = { status: 'disabled' | 'enabled'; gate: { verdict: 'FAIL' | 'PASS'; reasons: readonly string[]; evidencePath: string; remediationSection: string; reopenConditions: readonly string[] } }
export type CoordinationApi = { teamCoordinationAvailability: (teamId: string, signal?: AbortSignal) => Promise<CoordinationAvailability> }

/**
 * Team 范围的协调入口（D-01/D-03）：可见但处于可诊断禁用态。
 * 不渲染任何发送或上传控件；禁用原因、证据与解除条件全部来自 Server 资格门投影。
 */
export function TeamCoordination({ api, teamId }: { api: CoordinationApi; teamId: string }) {
  const [availability, setAvailability] = useState<CoordinationAvailability | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError(null)
    api.teamCoordinationAvailability(teamId, controller.signal)
      .then(value => { if (!controller.signal.aborted) { setAvailability(value); setLoading(false) } })
      .catch(cause => { if (!controller.signal.aborted) { setError(cause); setLoading(false) } })
    return () => controller.abort()
  }, [api, teamId])
  if (loading) return <section aria-labelledby="team-coordination-heading"><h1 id="team-coordination-heading">团队协调</h1><p role="status">正在获取协调入口状态…</p></section>
  if (error) return <section aria-labelledby="team-coordination-heading"><h1 id="team-coordination-heading">团队协调</h1><Failure error={errorPresentation(error)} retry={() => { setLoading(true); setError(null); api.teamCoordinationAvailability(teamId).then(setAvailability).catch(setError).finally(() => setLoading(false)) }} /><p>协调入口状态暂时不可用；服务端在资格门 FAIL 期间同样拒绝任何协调会话创建。</p></section>
  const disabled = availability?.status === 'disabled'
  return <section aria-labelledby="team-coordination-heading" aria-busy={false}>
    <h1 id="team-coordination-heading">团队协调</h1>
    <p>Team 范围的协调对话入口：用于团队讨论与交接的专用 Task 会话。当前处于禁用状态，仅呈现诊断信息。</p>
    {disabled && <div className="account-section" role="region" aria-label="协调资格门状态">
      <h2><ShieldAlert aria-hidden /> 协调入口不可用</h2>
      <p>资格门判定：{availability?.gate.verdict}（运行时隔离资格门，服务端同源拒绝）。</p>
      <h3>不可用原因</h3>
      <ul>{availability?.gate.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
      <h3>证据</h3>
      <p>判定证据与探测过程见仓库内 <code>{availability?.gate.evidencePath}</code>；写入通道复核矩阵见 <code>docs/acceptance/coordination-write-channel-matrix.md</code>。</p>
      <h3>解除条件</h3>
      <ol>{availability?.gate.reopenConditions.map(condition => <li key={condition}>{condition}</li>)}</ol>
      <p>以上条件全部满足并重新探测为 PASS 前，服务端对所有协调会话创建请求返回 403 coordination_gate_closed；此页面不提供任何发送或上传控件。</p>
    </div>}
  </section>
}
