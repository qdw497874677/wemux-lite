# 票 03 收尾复核：协调 Task/Session 创建、发送与真实对话（2026-10-11）

候选：`integration/web-next-coordination-closure` tip `4eb0800`（分支 `t03-closure` 同基线复核）。本记录只覆盖 `.scratch/web-next-coordination-closure/issues/03-gate-standard-reprobe.md` 的收尾验证；付费 Runtime 只引用既有记录（见 `web-next-team-coordination-browser-partial.md`），本次未发起新付费调用。

## 复现环境

- `npm install` 后 `npm run build:packages`、`npm run build --workspace @wemux/server`、`npm run build --workspace @wemux/worker`、`npm run build --workspace @wemux/web-next` 退出码均 0；`npm run typecheck --workspace @wemux/server` 退出码 0。
- `TMPDIR=/var/tmp`（磁盘），所有端口由 `app.listen(0)` 动态分配，未使用 8004。
- 浏览器：`PLAYWRIGHT_CORE_PATH=/home/qdw/.cache/wemux-pw/node_modules/playwright-core/index.mjs`、`PLAYWRIGHT_CHROMIUM_PATH=/usr/bin/chromium`、`WEMUX_NEXT_TEST_DIST` 指向 `/tmp` 一次性 dist 拷贝（脚本断言 `startsWith('/tmp/')`）。

## 本次实际运行（全部非付费 Test Agent）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `node --import tsx --test --test-concurrency=1 src/test/team-coordination-functional.test.ts src/test/team-coordination-entry.test.ts src/test/team-coordination-source-migration.test.ts src/test/capability-task-projection.test.ts src/test/team-coordination-task.test.ts`（apps/server） | 0 | 23/23 pass |
| `node --import tsx --test --test-concurrency=1 --test-reporter=tap src/test/*.test.ts`（apps/server，全量串行） | 1（时序） | 952 tests：950 pass；仅 `retention-destination.test.ts` 两项因运行先于 server/worker dist 构建而失败 |
| `node --import tsx --test --test-concurrency=1 src/test/retention-destination.test.ts`（dist 就位后单独复跑） | 0 | 2/2 pass |
| `node --import tsx apps/e2e/team-coordination-first-send.mjs` | 0 | 5 组：Worker Test Agent 就绪、Project Workspace placement ready、Task 绑定首发回显、同身份 replay、后续发送 |
| `node --import tsx apps/e2e/team-coordination-transport.mjs` | 0 | 4 组：非成员拒绝且不泄漏、签名 WS 首发 + Test Agent 回显 + turn.finished、首发幂等与第二发送、同 home Worker 重启恢复 |
| `node --import tsx apps/e2e/coordination-command-transport.mjs` | 0 | 3 组：合法签名创建/入队/回显；无签名注入被 Worker ACK 拒绝且不入队；撤权排队 actor 恢复不启动 |
| `node --import tsx apps/e2e/coordination-approval-transport.mjs` | 0 | 5 组：撤权准入拒绝；健康连接瞬时拒绝→序列化过期→新签名重放→一次原生审批与终态回执；提交回执+丢 ACK→帧重放；无签名持久审批拒绝；过期/篡改断言拒绝 |
| `node --import tsx apps/e2e/team-coordination-real-browser.mjs`（真实 Chromium 桌面+手机） | 0 | 14 组：桌面/手机首发、刷新恢复、原 Task 显式重开、非成员 HTTP 负例、离线 Worker 不可选但历史可读、重连后再完成对话、原生审批批准/拒绝、指定 Turn 停止、失败 Journal 可见、编辑器恢复重发 |

本次新增一项服务端行为测试（TDD 补证据缺口）：

- `apps/server/src/test/team-coordination-functional.test.ts` 新增 `coordination Task reuse key ignores the model; a different model opens a new Session under the same Task`：同一 Team/用户/Worker/Agent 换 `modelId: 'second'` 首发仍落在同一协调 Task（复用键不含 Model），新 Session 记录所请求模型，历史仅一个 Task。补齐票内“Model 不参与”验收项的直接 HTTP 级证据。

## 权限与能力链路核对（源码级）

- `apps/server/src/application/capability-service.ts` `prepareTurn` 对协调与普通 Session 使用同一份 ordinary 工具清单（含 `task.create`、`mcp.call`、`http.call` 等），无协调分支；`apps/server/src/application/team-coordination-task.ts` 的 `coordinationQueryOperations` 注释明确其为写通道探针的遗留 fixture，Runtime grant 走普通能力策略（ADR 0008）。
- `apps/server/src/application/coordination-gate.ts` 为真实可用投影（`{status:'enabled'}`），`POST /api/teams/:id/coordination/sessions` 返回真实 201 创建；Server 源内无协调路径 501/`coordination_gate_closed` 残留。
- Worker 源内无协调身份专属环境收口残留（仅一处与协调无关的进程注释）。

## 既有付费证据（引用，不重跑）

真实 Pi `5.3-flash` 协调首发、同 Session 文件创建 + 工具读回（按 Turn 边界加强版通过一次）与真实模型切换（`model.changed`、双 Turn 模型快照）见 `web-next-team-coordination-browser-partial.md`；第二 Turn 历史失败已诊断为上游模型侧（highspeed 空回复/超时、免费模型 `[SILENT]`），链路无缺陷证据。本次收尾未发起任何付费调用（付费脚本需显式 `WEMUX_REAL_PAID_PI_E2E=1`）。

## 已知边界

- 终端/网络类原生工具在协调 Session 中的等价性由共享能力签发路径 + 真实 Pi 文件工具证据结构性支撑，未单独逐工具实测；平台 HTTP fs/terminal 写通道对全体身份保持关闭（非协调专属降级）。
- `apps/e2e/next-coordination-entry-browser.mjs` 是旧隔离门时代的探针（断言 `disabled`+`FAIL`），与现行行为相反，仅被 2026-10-08 历史 phase2 文档引用，不构成现役验收程序。
- 旧 `apps/e2e/pi-provider-https-offline.test.ts` 独立回归仍失败（其 WorkerRuntime 直接发送无签名命令，与现行签名合同不符），维持既有登记，不在本票范围。
- 本次运行仅使用脚本自建临时目录（关闭后自清理），未清理或触碰用户数据。
