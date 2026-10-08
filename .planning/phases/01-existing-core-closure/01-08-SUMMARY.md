# 01-08 显式完成、策略与成果引用（阶段 1）

状态：**本计划可本地验证部分完成。** 分层证据在 `docs/acceptance/web-next-task-run-increment.md`（末节 2026-10-07 显式完成回执丢失恢复）。

## 已实现并验证（当前快照）

- 完成请求端到端恢复语义：`packages/web-client/src/pending-task-completion.ts`（`PendingTaskCompletion`）持久化完整原始请求（版本/runId/摘要/证据/requestId，按 host+account+team+project+task 作用域）；不确定失败仅允许原请求精确重放，回执身份不符拒绝且保留，确定性 409 以 `CompletionVersionConflict` 区分、显式丢弃后才能重发；并发共用一次飞行、成功清理、存储损坏防御。`packages/web-client/tests/pending-task-completion.test.mjs` 5/5。
- 新版 UI：`apps/web-next/src/components/TaskRuns.tsx` 待确认完成请求时隐藏完成表单并显示恢复条（重试原请求 / 409 后经用户确认丢弃并刷新），新 Run 启动同样被待确认请求与存储错误阻塞；重试路径校验请求身份未变。
- 真实 Worker 浏览器（桌面/手机）：`apps/e2e/next-worker-task-run-browser.mjs` 8 条 checks、`errors=[]`、退出码 0。新增场景：服务端已提交但响应丢失（`route.fetch()` 后 abort）→ 页面进入“原完成请求结果尚未确认” → 刷新仍持原请求 → 精确重试取回回执，`completion.submitted` 活动恰 1 条且摘要/证据持久。既有四段（复用/幂等/409、运行中取消、暂停 Worker 取消、显式失败）全数复跑通过。证据 `/tmp/wemux-next-worker-run-browser-QGY9SN/`。
- `npm run build:packages`、全仓 `npm run typecheck`、`task-completion-http.test.ts` 与 `project-review-policy.test.ts` 复跑通过。

## 明确未证（不勾选对应票项）

- 配置审查（human/agent/multi-stage）下的完成链、多阶段审查、外部付费 Runtime、双宿主：未实现或未验收，不冒认。
- 排队取消阻止 Turn 启动与真实 Worker 端完成/取消抢占：仅服务端确定性测试（见 01-07）。
- 工作树 1030 个未提交文件、快照未冻结；01-11 冻结同一候选后串行复验。

## 遗留

- 无新增 BLOCK。下一计划 01-09（按阶段文件顺序推进）。
