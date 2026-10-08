# 阶段 2 受控切片总账（票05 / NEXT-05）

**状态：草案待用户签收（2026-10-08）。** 本文件汇总 02-01 至 02-05 的受控切片证据，用于防止把受控切片误读为票05完成。

**口径声明（不得改写）**：票05 保持 in-progress；`NEXT-05` 不勾选完成；Ticket06 前置门（协调 Runtime 隔离资格门）**未解除**；协调入口保持禁用（`GET /api/teams/:id/coordination/availability` → `{ status: 'disabled', gate.verdict: 'FAIL' }`）；本总账不构成风险接受（`02-CONTEXT.md` D-02 未选），未替用户预选任何环境方案（选项 E 未选）。

## 候选身份（本文件全部证据的同一候选）

- 源码：`HEAD = 54585bc76dfc0da36cb267eec40a4b36c39ca6c4`（02-05 提交；工作树在取证时无未提交改动）。
- 运行时：Node `v26.5.1`；`npm run build:packages` 产物（domain / wire-protocol / web-contract / web-client）。
- 浏览器：`playwright-core@1.61.0`（`/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs`）+ Chromium `chromium-1228`（`/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`），桌面与移动两种视口。
- Next 静态产物（本次重跑用一次性拷贝，未污染仓库）：`/tmp/wemux-next-dist-head`（来自 `apps/web-next/dist`，`npm run build --workspace @wemux/web-next`）。
- Worker / Agent：仓库构建 Worker CLI（`apps/worker/dist/cli.js`）+ 确定性 Test Agent（不调用付费模型，不需要外部运行时凭据）。

## 同候选门（本次在 HEAD 全量重跑，全部退出码 0）

| 门 | 命令 | 结果 |
| --- | --- | --- |
| 包构建 | `npm run build:packages` | 通过 |
| 类型 | `npm run typecheck --workspace @wemux/{server,worker,web-next}` | 三者通过 |
| Server 测试 | `npm test --workspace @wemux/server` | **930 / 930 pass**，0 fail，0 skip |
| Worker 测试 | `npm test --workspace @wemux/worker` | **440 pass**，0 fail，4 skip（既有浏览器配置门，与本阶段无关） |
| Web 测试 | `npm test --workspace @wemux/web` | **297 / 297 pass**（含源码契约扫描） |
| Web-next 测试 | 带 `PLAYWRIGHT_CORE_PATH` / `PLAYWRIGHT_CHROMIUM_PATH` 的 `test:prepared` | **168 / 168 pass**（不带时 4 项浏览器用例按设计报配置错） |
| 02-02 e2e | `WEMUX_NEXT_TEST_DIST=/tmp/wemux-next-dist-head node --import tsx apps/e2e/next-coordination-entry-browser.mjs` | 退出码 0，14 项检查全绿，零 `pageerror`（HTTP 3 + 桌面 5 + 手机 5 + 汇总） |
| 02-04 e2e | `WEMUX_NEXT_TEST_DIST=/tmp/wemux-next-dist-head node --import tsx apps/e2e/next-worker-reconnect-pairing.mjs` | 退出码 0，7 项检查；`stalledAt: 9`、`withheld: [10,136]`、`gapStatesSeen: 0`、4 次采样 |
| 02-05 探针 | `node --import tsx apps/e2e/coordination-write-channel-probes.mjs` | 退出码 0，10 项检查；六行结论与已提交矩阵逐条一致 |

漂移核对：02-02 / 02-04 / 02-05 的原始证据在各自切片提交时取得（`5404504` / `5e9cc8f` / `54585bc`），本次在 HEAD 重新执行全部三个 e2e 并复现同一结论（含截图与 `result.json` 覆盖）；上述单元/组件/契约测试与类型门也在 HEAD 重跑。跨切片的源码改动（02-03 的能力面投影与共享解析函数）已包含在本次重跑中，故总账内不存在"不同 HEAD 绿灯相加"。

## 逐计划证据索引

| 计划 | 交付与状态 | 证据路径 |
| --- | --- | --- |
| 02-01 协调 Task 模型与身份合同 | 完成；D-04 身份合同五条已获用户批准（m05288） | SUMMARY `.planning/phases/02-agent-api/02-01-SUMMARY.md`；测试 `apps/server/src/test/team-coordination-task.test.ts`（7 项）、`apps/worker/test/coordination-session-gate.test.ts`（4 项）；提交 `79b8901` |
| 02-02 协调入口 UI 与服务端关闭态 | 完成；**禁用态 UX 人审待批** | SUMMARY `02-02-SUMMARY.md`；验收 `docs/acceptance/web-next-phase2-coordination-entry.md`；e2e `apps/e2e/next-coordination-entry-browser.mjs`；截图 `.scratch/web-next-project-agent-platform/evidence/02-02/coordination-{desktop,mobile}.png`；组件测试 `apps/web-next/src/components/__tests__/TeamCoordination.test.mjs`；提交 `5404504` |
| 02-03 查询缺口 (a)：共享 Task 计划与审查投影 | 完成（票面验收框不勾） | SUMMARY `02-03-SUMMARY.md`；测试 `apps/server/src/test/capability-task-projection.test.ts`、`packages/web-contract/src/task-platform.test.ts`；契约 `contractVersion: 2`；提交 `bd7cf81` |
| 02-04 断连重放观测与浏览器/CLI 配对（缺口 b） | 完成；**"持久 `gap` 缓存状态"如实 blocked** | SUMMARY `02-04-SUMMARY.md`；验收 `docs/acceptance/web-next-reconnect-pairing.md`；e2e `apps/e2e/next-worker-reconnect-pairing.mjs`；证据 `.scratch/.../evidence/02-04/result.json` + 四张双视口截图；提交 `5e9cc8f` |
| 02-05 协调模式写入通道复核矩阵 | 完成；**矩阵草案待签收**；两项资格门阻塞缺口 | SUMMARY `02-05-SUMMARY.md`；矩阵 `docs/acceptance/coordination-write-channel-matrix.md`；探针 `apps/e2e/coordination-write-channel-probes.mjs`；证据 `.scratch/.../evidence/02-05/result.json`；提交 `54585bc` |

### 受控切片已交付的能力（仍受禁用态约束）

- 协调 Task 模型：复用键 `[teamId, ownerId, workerId, agentKey]`、确定性 `coordination:<sha256>`、存储锚 `team:{teamId}` 隔离（普通 Project 路由不可寻址）、只读 `coordinationQueryOperations`；协调 Task 不进普通 done/cancelled 审查流，`active/waiting` 仅由 Session 运行态投影。
- 服务端关闭态：资格门常量唯一事实来源（`apps/server/src/application/coordination-gate.ts`）→ 可用性投影与 `403 coordination_gate_closed`。
- 项目 Agent API 查询缺口 (a)：`task.get` / `task.list` 返回计划与审查要求投影；审查要求解析唯一权威（Task 钉选 → Project 默认 → 平台 `none`，空值覆写不放宽）。
- 查询缺口 (b)：真实断连—重放—收敛观测与三侧（HTTP / 浏览器 / CLI）逐条一致性；配对拒绝路径（viewer/editor 撤权/篡改令牌）与凭据零泄漏扫描。
- 写入通道复核矩阵：六类通道逐行取拒绝证据或登记缺口（见下）。

## 剩余缺口与未决项

1. **持久 `gap` 缓存状态不可由真实链路中断产生**（02-04）：`sync: heads` 在 durable outbox 中总排在其所报告事件之后；头部回退会被判 `409 Worker journal head regressed`。已按计划授权不降级为缓存模拟，以"真实游标滞后窗口 + 三侧同一快照 + 不提前露出 + 收敛逐条一致"为替代证据。
2. **写入通道缺口 1**：Worker 工具执行网关不校验 `allowedTools`/binding（当前无活路径——服务端不暴露连接器/工具调用操作）。
3. **写入通道缺口 2**：Worker 不校验命令帧授权（信任集群连接），实测真实持久命令帧被接受并产生本地副作用。
4. **两项人审 checkpoint 未批**：02-02 禁用态 UX 人审、02-05 矩阵签收（两者共同支撑"协调入口关闭态"结论）。
5. **Ticket06 前置门未解除**：协调 Runtime 隔离资格门判定 FAIL（`apps`/OS 级隔离与网络出口收敛均不可用）。
6. `project.list` 仍只允许来源 Project，不宣称跨项目发现（不在本切片范围）。

缺口 2、3 均为**资格门阻塞项**，回链 `.scratch/web-next-project-agent-platform/evidence/ticket-05-runtime-isolation-gate.md`（§五环境变更选项、§六 A/B 岔路）与 `02-CONTEXT.md` D-01/D-02。

## 资格门重跑清单（环境变更后执行，不替用户预选方案）

1. **环境选项（gate 证据 §五，均未选）**：bubblewrap / user namespaces / Landlock 之一或组合、独立系统账号、独立宿主。选择属用户决策，本切片不预选。
2. **岔路（gate 证据 §六）**：05-F2 环境 A/B 仍需用户决策（选项 E 未选）；未决时协调执行保持关闭，只允许独立 API/审查切片。
3. **重跑探针集与口径**：
   - 平台探针：`node --import tsx apps/e2e/coordination-write-channel-probes.mjs`（六类通道 × 拒绝证据/缺口三态；退出码非 0 或出现 `unhandled` 即门未过）。
   - 隔离探针：按 gate 证据 §二/§三 的真实系统调用探针重新逐项执行（文件系统、进程、网络出口）。
   - 配对观测：`node --import tsx apps/e2e/next-worker-reconnect-pairing.mjs`（用于确认重放/收敛在目标环境仍成立）。
4. **矩阵更新（D-06 reversible）**：环境变更或通道开放后必须重跑探针并更新 `docs/acceptance/coordination-write-channel-matrix.md`；缺口责任票（Worker 网关 `allowedTools` 校验、命令帧授权审计）须先落地。
5. **收尾口径**：门通过后仍需真实验证"协调读/搜索/计划允许 + 代码/安装/部署/外部写被阻止"（Phase 2 成功标准 2），并完成票05 合并验收，方可勾选 `NEXT-05`。

## 结论

阶段 2 受控切片（模型、入口禁用态、查询缺口 a+b、写入通道矩阵）在同一候选下交付并复跑通过；**票05 未完成，阶段保持 OPEN**，协调入口保持禁用，Ticket06 前置门不解除。签收本口径后方可推进阶段收尾；对口径或证据有异议时指出条目，总账保持草案。