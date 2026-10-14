# 接受验收：机器范围、执行意图、申领与持久承接（票据 01）

日期：2026-10-14
范围：`packages/domain` 派发判定合同、`packages/web-contract` 派发线协议、`apps/server` 的 SQLite 持久承接与 `TaskService` 派发服务、任务侧与 Worker 侧 HTTP 接口、`apps/web-next` 与 `packages/web-client` 的任务详情派发界面。
结论：**合同层、存储层、应用服务层、接口层与界面层已实现并验证**（真实 SQLite 并发、真实两 Worker 进程链路、真实浏览器桌面与手机）。票据 01 的 18 条验收项中 10 条逐条验证通过，8 条为**部分完成或未开始**（逐条列在「未完成与残余」），因此票据仍为 `ready-for-agent`。

## 变更要点

- **领域判定合同（`packages/domain/src/dispatch.ts`）**：机器范围三形态（任意获权 / 候选集合 / 固定机器）与 `normalizeMachineScope` 校验；`resolveExecutionCapacity` 未配置或非法一律回落默认容量 1，机器管理者可配置上限；`WorkerExecutionState`（授权、资格、容量上限与已占用）与 `hasExecutionCapacity`/`remainingCapacityRatio`；`claimDecision` 把「可派发 → 范围 → 本人身份与授权 → 资格 → 代次 → 被接替执行是否已对账停止 → 已有承接 → 容量」冻结为固定判定顺序，拒绝原因即 `ClaimRejectionReason`；`rankDispatchCandidates` 按剩余容量比例降序、采样时间与标识升序；`orderDispatchQueue` 按持久入队序号稳定排序。
- **线协议（`packages/web-contract/src/task-dispatch.ts`）**：`TaskDispatchView`（机器范围、执行意图、承接记录、等待原因）、`DispatchIntentView`（种类、代次、状态、执行意图内容、入队序号、入队时间、被接替承接）、`DispatchClaimView`（含释放原因）、请求体与 `dispatchErrorCodes`。任务侧错误码并入 `taskErrorStatus`（`machine_scope_invalid`/`machine_scope_unauthorized`/`worker_not_a_candidate`/`claim_already_held`/`claim_stale_generation`/`insufficient_capacity`/`prior_execution_in_flight`/…），HTTP 与 `TaskError` 共用一张表。
- **持久承接（`apps/server/src/storage/sqlite/dispatch-claims.ts`）**：`task_dispatch_intents`（`UNIQUE(task_id, generation)`、按 `queue_order` 索引）与 `task_dispatch_claims`（`UNIQUE(intent_id, request_id)` 支撑请求幂等）；**并发唯一性由部分唯一索引 `task_dispatch_claims_active ON task_dispatch_claims(intent_id) WHERE state <> 'released'` 裁决**，因此「结果未知」的承接同样占位，不凭超时释放。建表与建索引写成幂等形式，历史镜像测试重放迁移链不再撞名。承接与意图的索引列出与 JSON 身份不一致时按 `AppError(409)` 拒绝，身份字段只读、只有状态可更新。
- **应用服务（`apps/server/src/application/task-service.ts`）**：任务进入待处理时按状态驱动建立执行意图（**没有独立入队开关**），离开待处理且尚未被承接的意图随终态撤销；`arrangeDispatch` 只就地更新尚未被承接意图的范围与执行意图内容，**不重排入队序号、不推进代次**；`setMachineScope` 是候选过滤，**不换绑已建立 Session**；`claimDispatch` 仅接受传输层认证出的 Worker 身份（请求体出现别的机器身份即拒），在单个 SQLite 事务内完成请求幂等、最新权限与执行权、资格、容量预约与承接写入；`releaseDispatch` 区分启动/放弃/启动前失败/对账停止四种释放原因，只有被接替承接被本人升级为「已对账停止」后接手才可被承接；`openHandoff` 在 in_progress 上绑定被接替承接身份与代次。容量准入证明即承接记录：没有承接就没有启动。
- **接口层**：任务侧 `GET .../tasks/:id/dispatch`、`PUT .../dispatch/machine-scope`、`POST .../dispatch`、`POST .../dispatch/handoff`（沿用 `auth: 'task'` 的项目授权与 CSRF）；Worker 侧 `POST /workers/:workerId/dispatch-claims`、`DELETE /workers/:workerId/dispatch-claims/:claimId`（`auth: 'worker'`，以 Worker 自身凭据认领，路径标识与凭据不符 403）。
- **界面层**：`apps/web-next/src/components/TaskDispatch.tsx` 接入任务详情，展示机器范围、执行意图（第几次安排、入队序、状态）、承接记录与等待原因措辞、结果未知的处置说明、接手绑定说明；写入表单支持三种范围形态与「只更新范围 / 安排这次执行 / 安排接手」三种操作。措辞常量表（`waitingReasonLabels` 等）可直接被票据 02 的团队看板复用。

## 验证命令与结果

全部在 `/tmp/wemux-p01`（分支 `dispatch-01-placement`，基点 `8cf9bff`）执行，日志在 `/var/tmp/wemux-p01-logs/`。下表为合并 `main`（`72b8b0b`，无冲突）后的复验结果；`merge-*.log` 即合并后复跑，未合并前的同名日志见同目录。

| 命令 | 结果 |
| --- | --- |
| `npm run build:packages` | 退出码 0（`build-packages.log`） |
| `npm run build --workspace @wemux/server` / `@wemux/worker` | 退出码 0 |
| `npm run typecheck` | 退出码 0（`typecheck.log`） |
| `node --import tsx --test packages/domain/src/dispatch.test.ts` | tests 14 / pass 14 / fail 0 |
| `node --import tsx --test apps/server/src/test/dispatch-claims.test.ts` | tests 5 / pass 5 / fail 0 |
| `node --import tsx --test apps/server/src/test/task-dispatch-service.test.ts` | tests 5 / pass 5 / fail 0 |
| `node --import tsx --test apps/server/src/test/*.test.ts` | tests 988 / pass 988 / fail 0，退出码 0（`server-tests.log`）；合并 `main`（`72b8b0b`）后复验 tests 1008 / pass 1008 / fail 0，退出码 0（`merge-server-tests.log`） |
| `npm test --workspace @wemux/worker` | tests 532 / pass 527 / fail 0 / skip 5（既有跳过），退出码 0（`worker-tests.log`） |
| `node --import tsx apps/e2e/dispatch-claim-transport.mjs` | 13 项真实链路断言全部通过，退出码 0（`e2e-dispatch.log`） |
| `node --import tsx apps/web-next/tests/task-dispatch.browser.mts`（`WEMUX_NEXT_TEST_DIST` + Playwright） | 7 项检查通过（桌面 1440×900、手机 390×844），退出码 0，稳定复跑 2 次（`browser-dispatch-2.log`） |

关键证据（脱敏）：

- **并发唯一承接（多进程）**：4 个子进程以同一执行意图并发申领，恰好 1 个返回 200，其余报 `UNIQUE constraint failed: task_dispatch_claims.intent_id`；同进程双连接竞争的败者可能报 `database is locked`（`node:sqlite` 的 `BEGIN IMMEDIATE` 是同步忙等，阻塞事件循环），两种败因都意味着没有第二个承接。
- **真实两 Worker 进程 + 真实 HTTP 凭据**（`apps/e2e/dispatch-claim-transport.mjs`）：backlog 无意图；迁移到 todo 建立 `generation 0 / queueOrder 1` 的意图并显示等待原因；未知机器进范围被拒；候选集合与固定机器范围真实生效且不重排入队序号；范围外机器申领 409 `worker_not_a_candidate`；冒用他人机器路径 403；并发申领恰好 1 个 200；同 `requestId` 重放返回同承接且 `changed:false`，跨机器复用同 `requestId` 报 `request_id_conflict`；承接被置为结果未知后另一台机器申领仍被拒；非承接方释放 403；本人以「已启动」释放后接手报 `prior_execution_in_flight`，过期代次报 `claim_stale_generation`，他人伪造「已对账停止」403，本人升级后接手成功且旧承接记录保留；取消后不能再申领（`intent_not_dispatchable`），已被承接的意图保留执行事实。
- **真实浏览器**（桌面与手机）：任务详情展示机器范围、执行意图、保持 todo 的等待原因；固定机器与候选集合范围经界面写入后服务端一致，任务状态与既有 Session 绑定不受影响；重复修改范围不重排入队序号、不推进代次；手机端无横向溢出；真实 Worker 凭据申领后界面按服务端记录展示承接方与承接状态并撤下等待原因。
- **本机进程不冒充异构宿主**：两 Worker 是同机两个独立进程、独立 home 与凭据，只证明协议链路与并发唯一性，不构成异构宿主（不同操作系统/Runtime）证据。

## 未完成与残余

- **① 任务管理 Module 可替换 Interface 与异构 Adapter 测试替身：未开始。** 现实现沿用仓库既有形态（`TaskService` 直接读写 `ServerStore` 端口），本票尚未引入可替换 Interface 与「异构状态/标识」测试 Adapter；冻结该 Interface 与 `packages/web-next-plan-handoff/issues/01` 共用，属未做工作。
- **⑤ 版本化依赖资格（前置待审查不启动下游、依赖解除重新匹配）：未开始**，需与计划交接 01 联合验收，该票仍为 `ready-for-agent`。本票只实现「任务状态消费执行意图」的状态驱动部分。
- **⑬ 共同 Interface 冻结：未开始**（同 ①）。已满足的部分是「接手不重新解析项目默认」：接手意图不触碰首次 Run 固定的审查策略。
- **⑥ 实际启动后进入 in_progress：未实装。** 已实现并验证的是终态阻断派发与「Run 成功不自动完成、提交成果按审查策略处理」（既有链路，回归全绿）；把 Run 启动回写为 in_progress 需要改 `apps/server/src/application/run-projection.ts` 的共享投影，且真正产生这些 Run 事件的机器侧启动接线尚不存在（属票据 02 与计划交接 01），本票未改动。
- **⑧ 幂等重试/重启不重复建立 Run/Session 或启动进程：部分。** 意图/承接层面已实现且验证（请求幂等、重放不重复承接、重启不重排入队序号、持久承接唯一）；但「建立 Run/Session 或启动进程」这条路径本票未接线，无对应证据。
- **⑨ 一个 Task 可有多个明确安排的 Session：部分。** 「修改范围不换绑已建 Session」已验证（服务端与真实浏览器）；「多个明确安排的 Session」只到执行意图/接手意图层，新 Session 的实际建立仍由执行侧完成。
- **⑩ Worker 启动前准入检查：部分。** 承接判定在事务内重新读取 Worker 的授权、可用执行 Agent 与模型、以及「容量上限减当前占用」，陈旧资格不能绕过承接；但机器进程实际启动前的门（本票头注要求的「启动准入证明」）尚未与既有 `authorize-launch` 边界接线。
- **⑰ 后续 Task 新建自己的执行及 Session：部分。** 已验证「修改范围、重入 todo、重复改派不绕过未知执行的安全核验」与「平台不自动重试任务」；后续 Task 的执行/Session 建立路径未实装。

已知实现取舍：容量上限读取自 Worker 记录新增的 `executionCapacityLimit?` 字段，未配置即默认 1；容量占用按「未释放的承接数」统计，机器侧真实并发数由后续票据与遥测接入（票据 02 声明扩展共享策略与遥测）。
