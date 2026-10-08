# 协调模式写入通道复核矩阵（票05 / D-06）

**状态：用户已签收（2026-10-08，含缺口登记方式：两行缺口各回责任票、不在本阶段顺修）。** 本矩阵是受控切片（协调入口保持关闭，`02-CONTEXT.md` D-01 选择 A）的证据产物：逐条记录协调性质身份对全部既有写入通道的**实测行为**，不留静默项。它不构成本票完成证明，不构成风险接受（D-02），也不开放、不承诺任何通道。

探针：`apps/e2e/coordination-write-channel-probes.mjs`
```bash
node --import tsx apps/e2e/coordination-write-channel-probes.mjs
```
退出码语义：三态归档 `blocked-with-evidence`（真实请求给出拒绝）/ `documented-gap`（显式缺口 + 责任归属）/ `unhandled`（既无证据也无登记，脚本失败、退出码 1）。任一探针对协调身份返回 2xx 而矩阵无对应缺口登记也算失败。

真实部分：真 Server（动态端口、显式 capabilitySecret）+ 真 Worker CLI + 确定性 Test Agent（不调用付费模型）；协调身份是 02-01 定义的只读 `allowedTools`（`coordinationQueryOperations`：session.info / project.list / project.get / project.resources / task.list / task.get / task.sessions / session.get / session.events / agent.list）的已签名 Grant，签名校验、账号代际、权限判定全部在服务端真实执行；协调 Task 行由 02-01 的真实创建路径产生；Worker 帧通道通过与 Server 的真实 WebSocket 链路注入 transport v2 帧（持久帧使用握手给出的真实出站代际与下一个序号）。证据原件：`.scratch/web-next-project-agent-platform/evidence/02-05/result.json`（含两跑结果）。

## 矩阵

| 通道 | 入口路径 | 协调身份下的实测行为 | 结论 |
| --- | --- | --- | --- |
| 文件 | `POST /api/sessions/:id/fs/write`；能力面 `session.fs.write`；Worker 帧 `fs.request(write)` | HTTP（owner cookie，最高权限调用方）`403 write_channel_closed`；协调 Grant `403`；完整 Turn Grant `403`（服务端无该操作）；Worker 帧 `fs.response ok=false, error=write_channel_closed: 平台当前未开放文件和终端写入通道。` | blocked-with-evidence |
| 终端 | `POST /api/sessions/:id/terminal`、`/terminal/:id/write`、`/terminal/:id/resize`；能力面 `session.terminal.write`；Worker 帧 `terminal.request(create)` | 三条 HTTP 路由均 `403 write_channel_closed`；协调 Grant `403`；Worker 帧 `terminal.response ok=false, error=write_channel_closed…`（未创建 PTY） | blocked-with-evidence |
| 连接器 | 能力面 `mcp.call`；Web 路由 `POST /api/projects/:id/connectors/:id/test`；Worker `tool-execution-gateway` | 协调 Grant `403`；完整 Turn Grant `404`（服务端未暴露该操作）；能力令牌打 Web 路由 `401`；owner cookie 读连接器元数据 `200`（只读可见性不受影响） | documented-gap（服务端不可达 + Worker 网关缺 allowedTools 校验，见缺口 1） |
| 外部投递 | 能力面 `outbound.replay` / `channel.send` / `delivery.replay`；`POST /api/projects/:id/channel-deliveries/:id/replay` | 三个操作对协调 Grant 均 `403`；重放路由接受能力令牌 `401`；owner cookie 走同一路由 `404 delivery_not_found`（仍只对真实用户凭据 + 写权限开放） | blocked-with-evidence |
| Web API | `POST /api/teams/:teamId/coordination/sessions`；`GET /api/teams/:teamId/coordination/availability`；能力面 `task.create` / `task.get`；`POST /api/projects/:id/tasks` | 协调入口 `403 coordination_gate_closed`；availability 投影 `200 {status:'disabled'}`（服务端裁决，非 UI 假象）；协调 Grant `task.create` `403` 而完整 Turn Grant `200`（对照组：同一入口对非协调身份仍可用）；协调 Grant 读协调 Task `task.get` `404`（02-03 作用域规则）；能力令牌打 Web Task 路由 `401` | blocked-with-evidence |
| Worker 帧 | Server→Worker transport v2 直连帧（含 05-H 已封部分的复核） | 05-H 已封部分复核仍有效（`fs.request` / `terminal.request` 无条件 `write_channel_closed`）；注入的**持久命令帧**（lane=command）被 Worker 直接接受：回执 `status=accepted`，并在 Worker 本地库建出 Session 行 | documented-gap（命令帧无授权校验，见缺口 2） |

## 缺口与处置

两项缺口均为**资格门阻塞项**，回链 `.scratch/web-next-project-agent-platform/evidence/ticket-05-runtime-isolation-gate.md`（§五环境变更选项、§六 A/B 岔路原始定义）与 `02-CONTEXT.md` D-01/D-02。矩阵本身不解除任何一项，票05 保持 in-progress，Ticket06 前置门不解除。

1. **Worker 工具执行网关不校验 allowedTools/binding。** `apps/worker/src/application/tool-execution-gateway.ts` 的鉴权只校验会话与授权来源，协调快照的只读 `allowedTools` 不会在 Worker 侧形成强制门。**影响**：一旦服务端把连接器/工具调用重新暴露为能力操作，协调身份可能经 Worker 侧网关越权调用；当前无活路径（服务端不暴露这些操作，见矩阵连接器行）。**责任归属**：开放协调写通道（或恢复连接器调用能力）的票据必须先补 Worker 侧 allowedTools/binding 校验，并重跑本矩阵。
2. **Worker 不校验命令帧授权（信任集群连接）。** 注入的 transport v2 持久命令帧（lane=command）被 Worker 直接执行并落库；协调身份的门只在 Server 侧，Worker 侧对任何到达的帧没有 allowedTools/binding 校验。**影响**：若 Server 侧转发策略出现缺陷，越权命令可在 Worker 上直接生效并产生本地副作用。**责任归属**：任何开放协调的设计必须先补 Worker 侧命令帧授权（或保证 Server 侧永不转发越权命令并加审计），解除条件满足后重跑本矩阵。

## 非阻塞观察

- 能力端点对不允许的操作返回状态码 `403`，但响应体的 `code` 落到 `internal_error`（`apps/server/src/http/handler.ts:113` 只把 `CapabilityError` 映射到状态码）。拒绝结论不受影响；本切片不改变对外错误码，避免影响 Agent CLI 既有错误处理。
- 证据入册前做凭据 redaction：Server 下发的能力令牌等敏感字段在被写入 `result.json` / `failure.json` 前替换为指纹，脚本内含凭据哨兵检查（命中即失败）。

## 复跑与更新

- 两次连续运行结果一致：10 项检查通过、六行结论与 2 项缺口稳定、观测帧数一致（37），无 `unhandled`。
- 本矩阵**随资格门重跑而更新**（D-06 reversible）：环境变更（bubblewrap/userns/Landlock、独立账号或独立宿主）到位后按原探针集重跑资格门，矩阵需同步重跑并更新本文件。