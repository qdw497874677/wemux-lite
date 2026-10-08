# 01-07 Run 生命周期与 Session reuse（阶段 1）

状态：**本计划可本地验证部分完成；票 07 组合验收仍 OPEN。** 证据矩阵在 `docs/acceptance/web-next-phase1-conversation-run-gap.md`（含 2026-10-07 同候选复验小节）。

## 已实现并验证（当前快照）

- 严格 Session reuse 规则：候选 Session 必须属于该 Task（`session.taskId === task.id`）且被本 Task 历史 Run 引用，否则 409 `reuse_ineligible`、零写入零通知。落点 `packages/web-contract/src/action-capability.ts`、`apps/server/src/application/action-capabilities.ts`；`apps/server/src/test/reuse-rejections.test.ts` 23/23（含终态历史 Run + 新鲜空闲 Journal 放行、非终态 Run 与未收敛取消仍拒）。
- 确定性取消/竞态服务端证明：`apps/server/src/test/task-runs.test.ts` 126/126。新增排队取消（accepted cancel 非终结证据；queued cancel 无 turnId/startedAt/`run.started` 活动、唯一 `run.finished`，重复回据/取消不重开）；完成与取消抢占两测补终态与 `activeRun` 清理断言；idle 安全测试先落历史 Run 再检测独立 pending enqueue。
- 真实 Worker + 浏览器（桌面/手机各四段）：`apps/e2e/next-worker-task-run-browser.mjs` exit 0，八条 checks、`errors=[]`。覆盖 UI 显式复用（同 Session 新 Run、精确重放同 Run、改载荷 409）、运行中取消、暂停 Worker 后 pending 取消收敛、`[test-agent:fail]` 显式失败（唯一 failed terminal、可见诊断、无完成入口）。私有构建与证据路径、命令、SHA256 见差距文档。
- Test Agent 本地测试 3/3；`npm run build:packages`、Server/Worker/Next 类型检查通过。

## 明确未证（不勾选票 07 对应项）

- 排队取消阻止 Turn 启动（暂停恢复后每端 `turn.started` 计 1）、取消与自然完成的真实 Worker 端抢占、重连后收据/Journal 一致性：仅服务端投影确定性，无端到端证据。
- Test Agent 不是 Pi/Claude 或真实审查 Agent；独立 Worker 双宿主属 Phase 5；截图未逐张人工视觉审核。
- 工作树 1030 个未提交文件、快照未冻结；01-11 需冻结同一候选串行复验五票。

## 遗留

- 无新增 BLOCK；真实外部 Runtime 未获授权部分保持不冒认。后续按 01-08（显式完成/策略矩阵/成果引用）推进。
