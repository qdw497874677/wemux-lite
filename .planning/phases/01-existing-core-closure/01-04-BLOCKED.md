# 01-04 历史 Task 删除：安全阻塞记录

状态：**blocked，不是 01-04-SUMMARY；Ticket03 和 Phase1 均未完成**。此记录只保存合同调查和保护性回归，不宣称历史 Task 已可删除。时间：2026-10-06。

## 现有边界

- `apps/server/src/application/task-service.ts` 的 `TaskService.delete` 在同一事务中校验 Project owner/manager、requestId 重放、CAS、活动 Run/Review，再对有 Session 或 Run.sessionId 引用的 Task 返回 `task_has_sessions`。仅无关联历史的普通 Task 能 tombstone；Workspace/Worker 文件不随之清理。
- 带 Session 的终结 Run 正例**不存在**；`apps/server/src/test/task-delete-artifacts.test.ts` 是合成行及合成 tombstone，能证明拒绝和写保护，不能证明真实执行安全删除。
- 已读历史的接缝：`TaskService.sessions` 对 tombstone 返回 410；Task 的 `get/activity/runs` 可读；`WorkerService` 的晚到 receipt/journal/sync 可修改 Run/Session，`projectRuns` 只遍历未删除 Task。若解除当前守卫，会产生执行/历史投影与查询不一致风险。现有 `deletedAt` Session 的列表/详情不可见；Run、activity 和 artifact 读受 Project 权限约束，存续 Session 的读取按 shareScope/Grant/Project 等规则，各资源不能合并成“所有历史都可读”。跨 Task Session 历史共享在既有模型中允许，但在本拟议成功资格下仍拒绝。不得以 Run 终态、Worker ACK、Session archived/deleted 或用户删除 Session 替代可证终结。

安全合同及需覆盖的正反例列在 `docs/acceptance/web-next-project-workspace-task-management.md` 顶部，并在 `.scratch/web-next-project-agent-platform/issues/03-project-workspace-task-management.md` 记录仍 OPEN。

## 本地增量证据（非最终候选）

- `/tmp/wemux-phase1-0104-contract-tests-current.log`：`node --import tsx --test apps/server/src/test/task-delete-artifacts.test.ts apps/server/src/test/task-delete.test.ts`，5/5 PASS；增加合成 tombstone 的 Task-scoped Session 410 与 retained Run 可读断言。
- `/tmp/wemux-phase1-0104-typecheck.log`：`npm run typecheck --workspace @wemux/server` exit 0。
- 当前修改 `git diff --check` exit 0；这些检查均不是终结历史的正例，也不是双 Worker 同候选取证。

## 解阻条件

在数据库事务、命令投递、断线重连和 Worker 晚到收据/日志投影中证明“不会再执行”与“保留原授权可读历史”，先补真实已终结 Run+Session 成功例，再补 queued/running/cancelling/未决指令/缺失或矛盾记录/跨 Task 引用及撤权重放的拒绝。Worker receipt/journal/sync、Run 投影、Session 授权等必须扩大审计/实现/测试范围，不能只改 Task service 和 route。真实双 Worker 文件与关联历史取证、Server 全量/typecheck、独立复审都通过后，才能产生 01-04-SUMMARY 并继续声明依赖 01-04 的计划已完成；否则保留 fail-closed。最终同一候选验收在 01-11。独立只读复审结论（2026-10-06）：合同补齐上述授权/删除 Session/跨 Task/晚到接缝后，仍只能维持 01-04 blocked；未得到可放行的成功删除证明。
