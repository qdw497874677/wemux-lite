# Phase 1: 存量主链路收尾 - Context

**Gathered:** 2026-10-06
**Status:** Ready for planning, subject to external acceptance gates

<domain>
## Phase Boundary

依据 `.planning/ROADMAP.md`，在保留原票依赖和逐票验收的前提下收尾 Web-next 票 01、02、03、04、07；核查 #58 SSE 超时遗留、#57 deleted-Task SSE 裁决、#60 Server 全量回归。先复用已有局部成果，再以同一候选快照完成真实浏览器、Worker 与授权验收；未满足的外部条件不降级。阶段 2 的 05-F2 A/B、后续票的功能及最终切根不属于本阶段。

</domain>

<decisions>
## Implementation Decisions

### 票 03 历史 Task 与 Workspace 准备生命周期
- **D-01:** 带历史 Session/Run 的普通 Task 删除必须先完成安全删除合同并验证；不能证明安全的情形继续拒绝，不能在此缺口未解决时关闭票 03。现有只允许无关联 Session 的受限正例不构成完整验收。规划时必须梳理历史引用保留、可查询性与执行竞态，不能通过删除关联数据来解锁。
- **D-02:** Workspace 正在准备时，本阶段保持明确的保护性取消拒绝，不宣称已停止 Worker 或实现物理取消。对照票 03 已有的“相关有效行为”验收与现有拒绝证据，明确写出该范围裁定，不把未来物理停止协议当成既有能力。
- **D-03:** 若存在无法证明终结的历史准备尝试，用户请求删除 Workspace 时允许一种**仅对当前用户隐藏、可手动恢复**的操作，而不是删除；底层 Workspace、历史命令与文件不动，也不宣称 Worker 已停止。其他获权成员的可见性不变。— **Reversibility:** costly — 若公开了个人隐藏状态，撤销它需调整持久状态、查询过滤及已隐藏入口。
- **D-04:** 隐藏期间即使准备尝试后来成功或失败，真实状态继续更新，Workspace 对该用户仍保持隐藏；“已隐藏”列表展示最新状态并提供手动恢复，不能自动恢复到常规列表。
- **D-05:** D-03/D-04 是本次讨论新确定的**产品行为，未实施未验收**。规划时需先对照原票 03、权限/删除合同和交接的受保护拒绝；把“隐藏”与“删除”显式区分，补录可验证的票据验收与测试，不能私自用隐藏代替原票要求的安全删除，也不能凭阶段上下文宣称票 03 已满足。

### 票 02 真实外部门槛
- **D-06:** Google/SMTP 的真实外部验收门保持不变。可先完成独立可验证部分，但条件缺失时票 02 与第 1 阶段均保持未完成，记录 blocked/未验证；本地替身或已有局部 review 不当作真实通过。

### 候选版本与最终验收
- **D-07:** 最终桌面、手机、真实 Worker 验收固定**一次统一候选快照**，记录源码和构建产物身份并集中复验。历史各轮证据只用于识别余量，不能拼接不同源码时点的绿灯作为关门证明。不要求自动 Git 提交，不能混入共享工作树的其他构建产物。— **Reversibility:** costly — 变更候选后需重做依赖该候选的真实验收及证据绑定。

### Claude's Discretion
- 在以上验收与权限约束内选择切片、存储与 UI 实现方式；既有安全合同、任务关联和权限边界不因本次讨论重开。工作区个人隐藏的权限过滤/恢复行为需要计划与测试明确化，不可由实现自行扩大为共享删除。

</decisions>

<canonical_refs>
## Canonical References

**下游规划/实施前必须读取，按当前证据重新核实在制品状态。**

### 阶段与原票
- `.planning/PROJECT.md` — 产品范围、硬约束、七阶段决策。
- `.planning/ROADMAP.md` — 第一阶段目标、依赖、门槛；后续 05 独立安全门。
- `.planning/REQUIREMENTS.md` — NEXT-01/02/03/04/07 分别追踪，不得因合并阶段合并验收。
- `.scratch/web-next-project-agent-platform/issues/01-next-entry-login-projects.md` — 新版入口原始验收与范围。
- `.scratch/web-next-project-agent-platform/issues/02-account-team-membership.md` — 外部身份、Team/账号及验收余量。
- `.scratch/web-next-project-agent-platform/issues/03-project-workspace-task-management.md` — Workspace/Task 生命周期及 CURRENT 状态。
- `.scratch/web-next-project-agent-platform/issues/04-task-session-conversation.md` — 有界 Session 关门证据、依赖例外范围。
- `.scratch/web-next-project-agent-platform/issues/07-run-completion-review-attention.md` — Run、显式完成、审查与待办余量。
- `docs/acceptance/web-next-project-workspace-task-management.md` — 票 03 当前矩阵与历史 prepare proof、受限删除的准确边界。
- `docs/acceptance/web-next-account-team-membership.md` — 票 02 当前真实外部/候选门与既有本地证据。
- `docs/acceptance/web-next-dedicated-conversation-task.md` — 票 04 有界真实会话证据的适用边界。
- `docs/acceptance/web-next-task-run-increment.md` — 票 07 人工审查局部证据与剩余门。

### 领域、安全与交接
- `AGENTS.md` — 安全、单写者、构建与验收纪律。
- `CONTEXT.md` — Task/Workspace/Session/Placement 的领域术语。
- `docs/specs/web-next-project-agent-platform.md` — 当前产品规格与双宿主/数据重置边界。
- `docs/specs/web-next-project-agent-prd.md` — 原产品要求；新裁定须明确标注为增补，不伪称旧条款原文。
- `docs/adr/0006-paperclip-frontend-foundation.md` — Paperclip 参考与新旧入口关系。
- `docs/adr/0007-task-bound-conversation-direction.md` — Session 固定 Task 与协调/实施规则。
- `.scratch/web-next-project-agent-platform/evidence/ticket-10-terminal-write-closed.md` — Ticket10 R2 写通道关闭受保护裁定，第一阶段安全回归不能推翻。
- `/tmp/wemux-mini-web-next-session-handoff-2026-10-06.md` — #58/#57/#60 精确现场、禁止付费 Runtime 与未知归属数据清理。此文件在仓库外，后续不可用时应使用仓库内证据复核，不能据过期快照声明完成。

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `apps/web-next/src/components/ProjectManagement.tsx`、`apps/web-next/src/components/Teams.tsx`、`apps/web-next/src/components/TaskRuns.tsx` — 新版项目、Team 和 Run 现有入口；优先评估余量而非重写页面。
- `apps/web-next/src/components/ProjectConversation.tsx`、`apps/web-next/src/application.ts` — 已有 Task 会话与应用接线；票 04 有界证据应核对当下快照后复用。

### Established Patterns
- `docs/acceptance/web-next-project-workspace-task-management.md` — 既有受限 Task/Workspace 删除、每次准备尝试的证明与谨慎拒绝；个人隐藏是**新增**行为，不能错认作已存在。
- `apps/server/src/test/terminal-write-closed.test.ts`、`apps/server/src/test/sse-credential-revalidation.test.ts` — 相关安全回归测试入口；修复须遵守受保护政策及交接裁定。

### Integration Points
- `apps/server/src/http/routes/task-routes.ts`、`apps/server/src/http/routes/workspace-routes.ts` — Task/Workspace 授权、生命周期与公开 API 边界；隐藏/恢复的可见性需复用服务端授权，不能只做前端过滤。
- `apps/web-next/src/components/ProjectManagement.tsx` — 如交付“已隐藏”入口，应保持真实状态与当前用户权限边界；具体 UI/存储由后续计划设计。

</code_context>

<specifics>
## Specific Ideas

用户选择：对无法证明终结的历史准备尝试，不强制删 Workspace；仅当前用户隐藏，其他获权者仍可见，状态照常更新，在“已隐藏”列表手动恢复。这个新行为需作为明确的 Ticket03 范围增补，不能当作原先保守拒绝已经交付。

</specifics>

<deferred>
## Deferred Ideas

- Workspace 准备任务真正物理停止属于后续能力；本阶段保持有理由的拒绝，不把物理取消伪装成已验证。
- 阶段 2 的 #52 05-F2 A/B 决策不在阶段 1 偷选；阶段 7 数据重置/切根需单独实操确认。

</deferred>

---
*Phase: 01-existing-core-closure*
*Context gathered: 2026-10-06*
