import { AppError } from './errors.ts'

/**
 * Ticket 05 运行时隔离资格门的当前裁决快照。
 * 唯一事实来源是 gate 证据文档（判定 FAIL：本机 OS 隔离与网络出口收敛不可用）。
 * 这是常量投影，不是可被普通请求翻转的开关；重新探测 PASS 后由部署者改代码发版启用。
 */
export const coordinationGate = Object.freeze({
  verdict: 'FAIL' as const,
  reasons: Object.freeze(['OS 级隔离（Landlock 等）在本机不可用', '网络出口收敛（Agent 出站收敛）在本机不可用']),
  evidencePath: '.scratch/web-next-project-agent-platform/evidence/ticket-05-runtime-isolation-gate.md',
  remediationSection: '五',
  reopenConditions: Object.freeze([
    '按 gate 证据 §五完成环境变更（OS 隔离与网络出口收敛）并重新探测',
    '写入通道复核矩阵（docs/acceptance/coordination-write-channel-matrix.md）全部通道复核为拒绝',
    '重探测判定为 PASS 后由部署者修改本常量发版启用，不提供按请求开关',
  ]),
})
export type CoordinationGate = typeof coordinationGate

/** 可用性投影：UI 禁用态与禁用原因的唯一事实来源。 */
export function coordinationAvailability(): { status: 'disabled'; gate: CoordinationGate } {
  return { status: 'disabled', gate: coordinationGate }
}

/** 协调 enqueue 的服务端强制：资格门 FAIL 时任何路径（含绕过 UI 的直接 HTTP）都 403。 */
export function assertCoordinationGateOpen(): void {
  if (coordinationGate.verdict === 'FAIL') throw new AppError(403, `Team 协调入口被运行时隔离资格门关闭（判定 FAIL）。证据与解除条件见 ${coordinationGate.evidencePath} §${coordinationGate.remediationSection}。`, 'coordination_gate_closed')
}
