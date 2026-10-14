# 迁移收口 01：无 Task 旁路勘察报告（NEXT-15）

本报告是[迁移收口与旧版移除条件](../../.scratch/web-next-migration-closure/spec.md)票据 01 的勘察交付，只读、不改产品行为。登记表见[操作级迁移登记表](web-next-migration-closure-operation-ledger.md)；历史基线（含更细的行级内容与旧版证据）见[新版操作级迁移登记（Ticket01基线）](web-next-operation-migration.md)。

## 结论摘要

1. **集群侧已不存在"新建无 Task Session"的旁路。** `POST /api/sessions` 仍可省略 `taskId`，但 Server 在同一事务内自动提供专用 Project Task（`dedicated-conversation-task.ts`），新写入的 Session 一律带 `taskId`。该行为已有验收记录（[web-next-dedicated-conversation-task.md](web-next-dedicated-conversation-task.md)，Server 662/662）与本票断言。
2. **真正残留的无 Task 创建路径只有 Worker 本地宿主。** `POST /api/local/workbench/sessions` → `LocalWorkbenchService.createSession` 完全不涉及 Task（`apps/worker/src/application/local-workbench.ts` 内 `taskId` 零命中）。本地 Task 合同尚未实现，因此 02 不能在集群侧"删入口"了事，必须等本地 Task 能力落地。
3. **legacy 无 Task 数据只剩读兼容。** 契约层保留 `taskId: string | null`、列表过滤与终端流有兼容分支、存储触发器禁止改写归属；新版会话控制器要求 `session.taskId === scope.taskId`，**打不开** taskId 为 null 的旧会话。产品决策允许历史无 Task 会话全部清理、不做补绑迁移（`docs/specs/web-next-project-agent-prd.md`）。
4. **旧调用方有两处需要转换动作，一处只需要等待。** 旧根前端快捷会话（`apps/web/src/features/sessions/quick-start.ts`）与旧根本地宿主（`apps/web/src/hosts/local-session.ts`）仍走无 `taskId` 调用；前者对集群已兼容（Server 自动绑定专用 Task），后者被本地 Task 能力阻塞。
5. **旧版入口整体（`/`、`/local/*`）仍在服务，删除属切根票**（[切根 go/no-go](../../.scratch/web-next-cutover/issues/02-go-no-go-cutover.md)），本 spec 不执行。

## 方法与证据

- 可重复断言脚本：`scripts/migration-bypass-survey.mjs`（只读源码；29 条 present/absent 断言；退出码 0 表示实况与勘察结论一致）。
  - 运行：`node scripts/migration-bypass-survey.mjs --json /var/tmp/wemux-m01-verify/bypass-inventory.json`
  - 本票输出：`/var/tmp/wemux-m01-verify/bypass-survey.log`（29/29 OK，EXIT=0）、`/var/tmp/wemux-m01-verify/bypass-inventory.json`
- 断言级行为证据（本票运行，工作树 `/tmp/wemux-m01` @ `8cf9bff`）：
  - `node --import tsx --test apps/server/src/test/task-session-contract.test.ts` → 19/19 pass，EXIT=0（`/var/tmp/wemux-m01-verify/task-session-contract.log`）
  - `node --import tsx --test apps/worker/test/local-workbench.test.ts` → 3/3 pass，EXIT=0（`/var/tmp/wemux-m01-verify/local-workbench.log`）
- 本票**未**执行浏览器验收：本机没有 playwright-core 与 chromium 缓存（`/tmp/wemux-tailnet-pw`、`/opt/data/.cache/ms-playwright` 均不存在）。凡依赖真实浏览器的结论一律沿用仓库既有记录并标注，不冒称本票复验。

## 旁路与兼容入口清单

状态词：**已验证（本票）**=本票断言/测试覆盖；**已实现未验证**=代码存在但无本轮证据；**未实现**=新版无该能力；**数据兼容（有意保留）**=为读旧数据保留，不是新创建旁路。

| ID | 入口 / 源码接缝 | 调用方 | 调用场景 | 是否仍在使用 | 应替换到的合法路径 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| B-01 | `POST /api/sessions`（`apps/server/src/http/routes/session-routes.ts:30` → `apps/server/src/application/server-service.ts:837`）可省略 `taskId` | 旧根前端 `apps/web/src/features/sessions/quick-start.ts:144`；`apps/web/src/api/client.ts:302`；新版 `packages/web-client/src/task-sessions.ts:19` `createDedicatedSession` | 快速试聊 / Agent 测试 / 项目试聊 | 是 | 同端点已自动绑定专用 Task；显式 Task 合同为 `POST /api/projects/:p/tasks/:t/sessions`（`apps/server/src/http/routes/task-routes.ts:78`） | 已验证（本票）：S1–S4、L1–L6 |
| B-02 | `POST /api/projects/:p/tasks/:t/sessions`（`task-routes.ts:78` → `apps/server/src/application/task-service.ts:355`） | 新版 `packages/web-client/src/task-sessions.ts` `createTaskSession` | Task 内创建执行会话 | 是（合法路径，非旁路） | 无需替换 | 已验证（本票）：L1–L2 |
| B-03 | legacy task-less Session 读兼容：列表过滤 `taskId?: string \| null`（`session-routes.ts:18`）、终端流 `if (session.taskId && context.tasks)`（`session-routes.ts:119`） | 旧根前端会话页；`packages/web-client/src/session-conversation.ts:60` 规范化 | 读取历史无 Task 会话与回执重放 | 是（仅读） | 无（PRD 允许历史无 Task 会话清理，不做补绑迁移） | 数据兼容（有意保留）：R1–R4、R6 |
| B-04 | 存储层 provenance 不可变：`run-invariants.ts:68` `Session creation provenance is immutable`（另见 `migrations.ts:83`、`session_source_replace`、`source_task_delete`） | Server 事务 | 拒绝把 taskId 由 null 改写为某 Task 或换绑 | 是（约束） | 无（约束本身即收口） | 已验证（本票）：R5 |
| B-05 | Worker 本地创建会话：`apps/worker/src/local-control/server.ts:300` `workbench.createSession({...})` → `apps/worker/src/application/local-workbench.ts:30/93` | Worker 本地 Web（旧共享 Web）与内联兜底 `apps/worker/src/local-control/client.ts:48` | 独立宿主建会话、发送 | 是 | 本地 Task Session（**未实现**，见缺口 G-01） | 未实现：W1–W3 |
| B-06 | 旧根本地宿主调用面：`apps/web/src/hosts/local-session.ts:54-55`（`workbench/sessions` POST 无 taskId） | 旧根 `/local/*` 页面 | 独立宿主会话列表/创建 | 是 | 同上（本地 Task Session） | 已实现未验证：C4 |
| B-07 | Worker 本地 Web 服务旧共享 Web 产物：`apps/worker/src/cli.ts:203` `webStaticPath: hasWebBundle ? webStaticPath : undefined` | Worker CLI | 无 bundle 时降级内联工作台（`cli.ts:202` 提示） | 是 | 双宿主共享前端（未迁移，见缺口 G-01） | 已实现未验证：W4–W5 |
| B-08 | 旧根集群入口整体：`apps/web/src/app/host-paths.ts:3` `clusterPaths` | 旧版控制台 `/`；新版壳 `Shell.tsx` 提供"旧版控制台"链接 | 所有未迁移操作 | 是 | 逐操作迁到 `/next/*` | 已实现未验证：O1、O3 |
| B-09 | 旧根本地入口整体：`host-paths.ts:4` `localPaths`（`/local`、`/local/sessions`、`/local/settings`、`/local/cluster`） | 旧版控制台本地宿主 | 独立宿主全部操作 | 是 | 新版明确未迁移（`apps/web-next/src/App.tsx:42` "新版尚未迁移本地任务与会话"） | 未实现：O2、O4 |
| B-10 | `apps/server/src/application/command-assertion-issuer.ts:28/32` 的 `taskId: null` | Server 命令签发 | Project/Workspace 级命令断言作用域 | 是（非 Session 旁路） | 无需替换 | 已验证（本票）：不属于无 Task 会话入口（差异 D-03） |

## 调用方转换清单（票据 02 输入）

| 序 | 调用方（路径:行） | 当前行为 | 需要做的转换 | 前置 | 转换后可移除什么 |
| --- | --- | --- | --- | --- | --- |
| 1 | `apps/web/src/features/sessions/quick-start.ts:144` + `apps/web/src/components/quick-conversation.tsx:16,43` + `apps/web/src/App.tsx:250-251,323-327,424` | `api.createSession({ requestId, workspaceId, workerId, agentKey, modelId, title, shareScope })`，**不传 taskId**；文件内无 `taskId` 字样 | 显式走 Task 合同：先确定/创建 Task（或接受 Server 自动专用 Task 并把返回的 `taskId` 带入会话 scope 与后续发送/列表） | 无（集群侧已兼容） | 转换并验证创建+发送后，可收紧"省略 taskId 的 root 创建"形态（改为仅 legacy 重放） |
| 2 | `apps/web/src/api/client.ts:95-96,302` | `createSession: '/api/sessions'`，`CreateSessionDTO` 无 `taskId` | 若保留旧方法，需明确专用 Task 语义与 `scenario`；否则改用 `POST /api/projects/:p/tasks/:t/sessions` | 同 1 | 同上 |
| 3 | `apps/web/src/hosts/local-session.ts:54-55` + `apps/web/src/hosts/local-workbench.tsx` | `POST workbench/sessions`，无 taskId | 等待本地 Task 合同，再改为本地 Task Session 创建/发送 | 本地 Task 能力（G-01） | 移除本地无 Task 创建链（`local-control/server.ts:300`、`local-workbench.ts`） |
| 4 | `apps/worker/src/local-control/client.ts:48`（内联兜底工作台表单） | 直接 POST 本地会话 | 同 3 | 同 3 | 同 3 |
| 5 | `apps/worker/src/local-control/server.ts:300`、`apps/worker/src/application/local-workbench.ts:30,93` | 本地会话创建无 Task | 增加本地 Task 归属（本地 Task 合同落地后） | 同 3 | 同 3 |

## 旁路移除顺序建议

1. **先落本地 Task 合同**（双宿主 spec 13 / 迁移收口 02 前置），再转换调用方 3–5；**本地 Task 可用前不得移除**任何本地创建链，否则独立宿主直接不可用。
2. **转换调用方 1–2 并验证创建+发送**（真实浏览器证据按 02 要求补），然后收紧 root 创建：无 `taskId` 且非 legacy 重放的请求改为显式错误（或强制 `scenario` 语义），并补负例断言。
3. **legacy 读兼容（B-03）与数据清理同批**，交切根/数据重置票；本 spec 不删旧数据、不改写历史归属。
4. **旧版入口整体删除（B-08/B-09）由切根票执行**，本 spec 只要求逐操作迁移证据齐备。

## 与票据/规格假设的差异

- **D-01**：票据假设"旧根前端与旧 Worker 工作台仍保留无 Task 的兼容业务旁路，调用方可能继续走旧路径"。实况：集群侧旧调用方走的 root 创建**已被 Server 强制绑定专用 Task**，不再是"无 Task 旁路"；真正无 Task 的创建只剩 Worker 本地宿主。02 的集群侧工作是"调用方显式化 + 收紧省略 taskId 的 API 形态"，不是删除创建能力。
- **D-02**：票据实现计划提到"旧 CLI/API 调用方"。实况：仓库无创建无 Task Session 的 CLI 路径；Worker CLI 的 `start` 只启动本地/集群服务，会话创建在本地控制面 HTTP（B-05）。旧调用方是旧 Web（集群 + 本地）与 Worker 内联工作台。
- **D-03**：`command-assertion-issuer.ts` 的 `taskId: null` 属命令断言作用域（Project/Workspace 级），不是 Session 旁路，不应计入"无 Task 入口"。
- **D-04**：`docs/acceptance/web-next-phase1-candidate.md` 记载的源指纹（如 `apps/worker/src` = `96836fb3a860dda2`）在本地用 5 种聚合变体均无法复现，仓库未提供指纹生成脚本。**"同候选"判定本票无法给出，留给 03**；本票只记录该事实，不据此宣称或否认同候选。
- **D-05**：本票无法产出浏览器证据（本机无 playwright/chromium）。凡"已验证"仅指断言/测试级；浏览器级迁移证据仍缺，须在 02/03 补齐，不能由本票替代。

## 缺口与责任票

| 缺口 | 内容 | 责任票 | 备注 |
| --- | --- | --- | --- |
| G-01 | 本地（独立 Worker）宿主 Task Session 能力未实现；无 Task 本地创建链不能移除 | [双宿主 13](../../.scratch/web-next-dual-host/issues/02-local-host-enrollment-acceptance.md)、[迁移收口 02](../../.scratch/web-next-migration-closure/issues/02-remove-bypass.md) | 02 的硬前置 |
| G-02 | 旧调用方 1–2 未显式走 Task 合同；root 创建仍接受省略 taskId | [迁移收口 02](../../.scratch/web-next-migration-closure/issues/02-remove-bypass.md) | 转换 + 负例断言 |
| G-03 | legacy 无 Task 会话清理/切根未实施 | [切根 02 go/no-go](../../.scratch/web-next-cutover/issues/02-go-no-go-cutover.md) | 本 spec 不执行 |
| G-04 | 浏览器级迁移证据本票不可得 | [迁移收口 03](../../.scratch/web-next-migration-closure/issues/03-authz-matrix-acceptance.md) | 需在具备浏览器设施的环境执行 |

## 复查方法

```bash
node scripts/migration-bypass-survey.mjs                      # 29 条断言，EXIT=0 表示实况与勘察一致
node --import tsx --test apps/server/src/test/task-session-contract.test.ts
node --import tsx --test apps/worker/test/local-workbench.test.ts
```

任一断言由 OK 变 FAIL，说明旁路形态已变化：先更新本报告与[操作级迁移登记表](web-next-migration-closure-operation-ledger.md)，再考虑移除。
