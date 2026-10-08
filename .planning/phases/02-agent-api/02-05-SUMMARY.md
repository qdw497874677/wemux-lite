# 02-05 SUMMARY — 协调模式写入通道复核矩阵（票 05 / D-06）

状态：探针脚本与矩阵文档完成并两次复跑一致；**矩阵已获用户签收（2026-10-08，回复"都接受"，含缺口登记方式）**。票 05 / NEXT-05 保持 in-progress，未整票通过；本切片不开放任何写入通道，不构成风险接受（D-02）。

## 交付

- 探针脚本 `apps/e2e/coordination-write-channel-probes.mjs`（约 470 行，无产品代码改动）：
  - 真 Server（动态端口、显式 `capabilitySecret`）+ 真 Worker CLI（经脚本自建 TCP 代理连接，握手给出真实出站代际与下一个序号）+ 确定性 Test Agent（不调用付费模型）；owner/admin 账号经 `seedLocalAccount` 真实签发。
  - 协调身份：02-01 只读 `allowedTools`（`coordinationQueryOperations`）的已签名能力 Grant，绑定真实 Session 与真实账号代际；协调 Task 行由 02-01 真实创建路径产生并通过 `coordinationTaskId` 复用键核验。
  - 六类通道（名称与计划一致）：文件、终端、连接器、外部投递、Web API、Worker 帧。每条通道同时尝试协调 Grant、完整 Turn Grant（对照组）、owner cookie（对照组）与 Server→Worker transport v2 帧（易失 `realtime` 帧与持久 `command` 帧，持久帧使用握手协商出的代际与下一个序号）。
  - 三态归档：`blocked-with-evidence` / `documented-gap` / `unhandled`（unhandled 或对协调身份返回 2xx 而无缺口登记即失败，退出码 1）。证据入册前对敏感字段（能力令牌等）做 redaction，并内置凭据哨兵检查。
- 矩阵文档 `docs/acceptance/coordination-write-channel-matrix.md`（逐行：入口路径 / 协调身份实测 / 结论 / 缺口责任归属）。
- 原始证据 `.scratch/web-next-project-agent-platform/evidence/02-05/result.json`（两跑结果；失败时才产生 `failure.json`）。

## 验证结果（两次复跑一致）

- 10 项检查通过、退出码 0、`unhandled` 0；六行结论稳定：文件、终端、外部投递、Web API 为 blocked-with-evidence；连接器、Worker 帧为 documented-gap（各 1 项缺口）；观测帧数两次均为 37。
- 关键拒绝证据（协调身份，真实请求）：文件 `403 write_channel_closed`（worker 帧 `ok=false` + 同一文案）、终端三条 HTTP 路由 `403 write_channel_closed`、连接器协调 Grant `403` 且完整 Grant `404`（服务端无该操作）、外部投递三个操作 `403` 且重放路由拒绝能力令牌 `401`（owner 对照 `404 delivery_not_found`）、协调入口 `403 coordination_gate_closed` 且 `availability` 投影 `{status:'disabled'}`、协调 Grant `task.create` `403` 而完整 Grant `200`（对照组），协调 Grant 读协调 Task `404`。
- Worker 帧：05-H 已封部分复核仍有效（`fs.request(write)` / `terminal.request` 无条件 `write_channel_closed`）；真实持久命令帧（lane=command）被 Worker 接受并回执 `status=accepted`，本地库产生 Session 行。
- 命令：`node --import tsx apps/e2e/coordination-write-channel-probes.mjs`（无需 Next 构建产物；未跑根 build，遵守单写者纪律）。

## 缺口与处置（资格门阻塞项）

1. Worker 工具执行网关 `authorize()` 不校验 allowedTools/binding（当前无活路径：服务端不暴露连接器/工具调用操作）。
2. Worker 不校验命令帧授权（信任集群连接），本次以真实持久帧证明可在 Worker 本地产生副作用。
   两项均回链 `.scratch/web-next-project-agent-platform/evidence/ticket-05-runtime-isolation-gate.md`（§五环境变更选项、§六 A/B 岔路）与 `02-CONTEXT.md` D-01/D-02；解除条件为环境变更后重跑资格门，并同步重跑本矩阵（D-06 reversible）。

## 非阻塞观察

- 能力端点拒绝返回 `403` 时响应体 `code` 为 `internal_error`（`apps/server/src/http/handler.ts:113` 只映射状态码）；本切片未改变对外错误码。
- 矩阵不覆盖 Worker 本地控制入口（`apps/worker/src/local-control/`，需 Worker 本地管理员身份）与 OS 层面的写入；前者在本切片无协调身份入口，后者由资格门 §五环境变更负责。

## 待办与后续

- **用户签收**：矩阵已由用户在 2026-10-08 签收（回复"都接受"），含缺口登记方式——两行缺口各回责任票（Worker 工具网关 `allowedTools`/binding 校验、命令帧授权审计），不在本阶段顺修。
- 02-02 的禁用态 UX 人审 checkpoint 也已获批准（同日），两者共同支撑协调入口的关闭态结论。
- 02-06 总账需引用本切片的六行结论与两项缺口，并明确 NEXT-05 不得勾选。