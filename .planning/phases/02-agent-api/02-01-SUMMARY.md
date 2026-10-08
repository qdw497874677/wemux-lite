# 02-01 SUMMARY — 协调 Task 模型与身份合同

状态：三个自动任务完成并通过全量门；D-04 身份合同 checkpoint 已获用户批准（回复“继续”，m05288），批准以上五条为后续阶段实施基线。

## 交付

- 契约（`packages/web-contract/src/task-platform.ts`）：`TaskSummary.teamCoordination?: TeamCoordinationIdentity { teamId, ownerId, workerId, agentKey }`；`teamCoordinationAnchorPrefix = 'team:'` + `isTeamCoordinationAnchor()`。Model 与 Session requestId 刻意不入复用键。
- 模型（`apps/server/src/application/team-coordination-task.ts`）：
  - 复用键 `JSON [teamId, ownerId, workerId, agentKey]`，确定性 ID `coordination:<sha256>`；
  - `teamCoordinationTask(tx, identity, requestId)` 事务内创建/幂等复用：存在即校验身份一致（否则 409 `request_id_conflict`，错误体不含已存元数据）、已删除 410；
  - `assertTeamCoordinationCreator` 用 `tx.identity.getIdentityRecords({userId, teamId})` 在创建事务内校验成员资格（非成员/跨 Team 403）；
  - 存储锚 `team:{teamId}`：真实 Project ID 由服务端生成，永不带 `team:` 前缀，普通 `task.list(projectId)` 天然排除协调 Task；
  - `coordinationActivityState(states)` 从 Session 运行态推导 active/waiting，纯函数不落 status/currentReviewId；
  - `coordinationQueryOperations` 固定协调身份 allowedTools 为只读查询面（无 mcp.call/http.call/task.create/file.write/terminal/channel）。
- 守卫（`apps/server/src/application/task-service.ts`）：`task()` 检出后若 `teamCoordination` 或锚前缀命中即 403 `forbidden`（T-2-03 纵深防御；patch/assignment/launch/complete/createSession 均过此门）。
- Session 溯源隔离：`createSessionWithLineageInTx` 的 `task.projectId !== workspace.projectId` 检查使普通 Project Session 无法把协调 Task 当溯源（404），换绑路径不存在（Session taskId 创建后不可变）。

## 验证（全量门，Node v26，--test-name-pattern 忽略故用全量）

- `npm run build:packages`、server/worker 单独构建：通过。
- `npm test --workspace @wemux/server`：924/924，0 skip。新增 `src/test/team-coordination-task.test.ts` 7 项（并发幂等收敛单 Task + 单 activity、成员资格三向负例、409 无元数据泄漏、410、浏览/列表零创建 + 排除、active/waiting 纯推导、普通执行面拒绝、allowedTools 只读断言）。
- `npm test --workspace @wemux/worker`：444 测试 440 过 0 fail，4 skip 为既有浏览器配置门（与本计划无关）。新增 `test/coordination-session-gate.test.ts` 4 项（受限快照注册零连接器、写类 operation scope_denied、查询面直通上游、协调/普通身份 allowedTools 交集为空且令牌不可跨 Turn 借用）。
- 提交：`79b8901`。

## 待决 checkpoint：D-04 身份合同（blocking-human）

1. 复用键 = Team + 用户 + Worker + Agent（Model 不参与；重开上下文=新 Session 同 Task）。
2. 确定性 ID `coordination:<sha256(键)>`；持久化字段 `teamCoordination` + 存储锚 `team:{teamId}`（进库后变更需迁移）。
3. 不进普通 done/cancelled 审查流；active/waiting 仅投影。
4. 协调 Task 对普通 Project 路由不可寻址（锚隔离 + task() 守卫双保险）。
5. 本计划未开放真实协调执行；enqueue 关闭态接线归 02-02。

替代方案（若异议）：projectId 存空串 + 新增可空 teamId 列（需迁移 tasks 表与所有 join）；或复用 dedicatedConversation 结构（但会与项目内测试会话语义混淆，已被否决）。

## checkpoint 结论

已批准（m05288，2026-10-07）：五条合同即实施基线，无异议；后续计划（02-02 服务端关闭态、02-06 收尾）以此为准。
