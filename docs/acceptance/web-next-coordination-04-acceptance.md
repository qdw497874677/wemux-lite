# Web 协调聊天功能验收（票据 04）

日期：2026-10-12
候选：分支 `t04-acceptance`（基线 `integration/web-next-coordination-closure` tip `2cbf22c`，本分支仅追加验收资产与 Test Agent 模型切换能力声明）
票据：`.scratch/web-next-coordination-closure/issues/04-coordination-acceptance.md`

## 环境与公共前置

- 真实 Server（`node:http`，进程内 `createWemuxServer`）+ 真实 Worker 子进程（`node --import tsx apps/worker/src/cli.ts register/start`，独立 home）+ 真实浏览器（playwright-core 1.61.0 @ `/home/qdw/.cache/wemux-pw/node_modules/playwright-core/index.mjs`，系统 Chromium `/usr/bin/chromium`，headless）。
- 唯一执行的 Agent：Test Agent（`apps/worker/src/agents/test-agent.ts`）。无付费模型调用；真实 Pi 证据沿用 `docs/acceptance/web-next-team-coordination-browser-partial.md`，不在本次重跑。
- 所有端口动态分配（`listen(0)`），未使用 8004；`TMPDIR=/var/tmp`；每脚本独立数据库/home 目录，结束即清理。
- Web-next 静态产物：`npm run build:packages` 与 `npm run build --workspace @wemux/web-next` 后复制到一次性 `/tmp/wemux-t04b-next-dist-4gk2`（`WEMUX_NEXT_TEST_DIST`）。
- 浏览器脚本统一运行方式：

```bash
TMPDIR=/var/tmp \
WEMUX_NEXT_TEST_DIST=/tmp/wemux-t04b-next-dist-4gk2 \
PLAYWRIGHT_CORE_PATH=/home/qdw/.cache/wemux-pw/node_modules/playwright-core/index.mjs \
PLAYWRIGHT_CHROMIUM_PATH=/usr/bin/chromium \
node --import tsx apps/e2e/<脚本>.mjs
```

原始日志（含每步 checks JSON）在 `/var/tmp/wemux-t04b-evidence/`，不入库；本文件为脱敏摘要。

## 本次新增的可复跑脚本（apps/e2e/）

| 脚本 | 退出码 | 覆盖 |
| --- | --- | --- |
| `team-coordination-model-switch-browser.mjs` | 0 | 桌面 1440×1000 与手机 390×844（isMobile/hasTouch）：打开页面不创建 Task/Session；首次发送自动创建并显示消息与 Agent 结果；跨视口复用同一协调 Task（复用键不含模型）；`set_model` 后 journal 出现 `model.changed`，UI 显示"模型历史：prev → new，不追溯改变已有 Turn"与"已确认选择：new"；后续 Turn 的 `turn.started.modelId` 为新模型，首 Turn 仍为旧模型（仅对下一 Turn 生效） |
| `team-coordination-network-recovery-browser.mjs` | 0 | A 相：Turn 执行中 SIGKILL Worker（`close(null,'SIGKILL')` 已断言）；不产生幽灵成功（completed=0，UI 仅基线 1 个"Turn 已完成"）；离线期间页面不假死（输入框可编辑、刷新可点击，freshness 如实显示"Worker 离线"）；重启后 journal 记 `interrupted` 失败并在 UI 可见"Turn 失败"；对同一未知结果显式重发后恰好一次 completed（无重复成功）。B 相：通过 `app.server` 关闭连接与监听（同进程连接级断网，见"边界"）；浏览器读取失败出现警示（不挂起）；Worker WebSocket 在 60s 内重连；断网期间缓冲的 Turn 恰好完成一次；恢复后新消息正常完成 |
| `team-coordination-approval-timeout-browser.mjs` | 0 | 挂起中的原生审批可操作（"批准操作"按钮、"尚未处理的审批：1"、"审批请求（尚未处理）"）；停止 Turn → `turn.finished cancelled`；控制入口消失、"没有待决审批。"、"审批请求（已过期）"（如实呈现为过期而非人工拒绝）；过期后经 HTTP 迟到的 resolve 不产生任何 `approval.resolved` 事件、不复活按钮；会话此后仍可继续对话（第二个 Turn completed） |
| `team-coordination-authz-matrix.mjs` | 0 | HTTP 级 25 项探针：非成员对 availability/sessions/首发/读/events/写/停止/审批/普通 Project Session 全部 403/404 且响应体不泄漏会话内容；同 Team 成员（邀请制）列表只见自己（owner 会话不可见）、读/写/停止/审批/在无 contributor 权限的两个 Project 首发均被拒；正向对照（owner 在有权限 Project 首发 201 且 taskId 以 `coordination:` 开头）；结构负例（无 placement 的 Worker 409、伪造 workspaceId/workerId 4xx）；反向跨 Team（他人 Team 且实例管理员无成员身份同样被拒） |

既有脚本同候选重跑记录退出码：

| 脚本 | 退出码 |
| --- | --- |
| `team-coordination-real-browser.mjs`（桌面+手机 14 组：首发/刷新恢复/原 Task 重开/非成员负例/离线重连/原生批准与拒绝/停止/失败态/恢复发送） | 0 |
| `team-coordination-attachments.mjs`（两阶段附件、字节精确投递、撤权） | 0 |
| `team-coordination-first-send.mjs`（HTTP 首发幂等与回显） | 0 |
| `team-coordination-transport.mjs`（签名 WS 首发与越权负例） | 0 |

## 同候选测试与构建退出码

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npm run build:packages` | 0 | — |
| `npm run build --workspace @wemux/server` / `@wemux/worker` / `@wemux/web-next` | 0 | — |
| `npm run typecheck` | 0 | — |
| `npm test --workspace @wemux/server` | 0 | 959/959 通过 |
| `npm test --workspace @wemux/worker` | 0 | 519 通过、0 失败、4 跳过（skip 为既有标记） |
| `npm test --workspace @wemux/web-next`（含 PLAYWRIGHT 环境变量） | 0 | 169/169 通过 |
| `npm test --workspace @wemux/web` | 1 | 283 通过、4 失败；失败仅 `tests/base-ui-coexistence.test.mjs`、`command-palette.test.mjs`、`plan-card.test.mjs`、`project-query-rendered.test.mjs`，原因是这些测试硬编码了另一台机器的绝对路径 `/opt/data/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs` 与 `/opt/data/.cache/ms-playwright/chromium-1243`（本机均不存在，`ERR_MODULE_NOT_FOUND`）。本分支未改动 `apps/web/**`，属环境性既有失败，与本票验收无关 |

## 为浏览器级模型切换做的最小代码改动

- `apps/worker/src/agents/test-agent.ts`：`detect()` 增加 `modelSwap: true` 与第二个模型 `test-alt`。执行仍与模型无关；声明两个模型只为让浏览器 E2E 真实走通运行时 `set_model` 通道（能力校验 → 绑定持久化 → `model.changed` journal → 下一 Turn 生效）。与此前为附件验收声明 `attachments` 同一先例。
- `apps/worker/src/test/agent-command-capabilities.test.ts`：对应断言由"不得声明 modelSwap"改为"必须声明"。
- `apps/e2e/session.ts`：测试会话助手新增 `raw()`（同鉴权、不抛非 2xx，返回 `{status,ok,data}`），供授权矩阵负例断言。

## 边界与如实声明

- **B 相"Server 断网"是同进程连接级中断**：关闭 `app.server` 监听并销毁既有 socket，再重新 listen 同一端口。它真实同时切断浏览器 HTTP/SSE 与 Worker WebSocket，但没有进程内存丢失；完整的进程重启（内存态清零）未在本脚本模拟。Worker 侧的崩溃恢复（SIGKILL + 冷启动回放）在 A 相为真实进程级。
- **原生审批没有墙钟超时**：本次验证的"超时路径"是 Turn 释放（停止/取消）使挂起审批过期——UI 如实显示"已过期……不代表人工拒绝"，迟到的 resolve 不产生 `approval.resolved`。连接器审批的 5 分钟超时由既有单元测试覆盖（`docs/acceptance/web-next-approval-expiry.md`），未重复验证。
- **迟到的审批 resolve HTTP 返回 202**：这是传输层接受（命令入队）语义；执行层因 Turn 已释放而拒绝。验收断言的是终态不变式（无 `approval.resolved`、UI 不复活），而非 HTTP 状态码。
- **上传能力已两阶段交付并验收**（见 `docs/acceptance/web-next-coordination-attachments-two-phase.md` 与本次 `team-coordination-attachments.mjs` 退出码 0），Web 上传控件仅对声明 `attachments` 的 Agent 开启，真实 Pi 未声明则保持关闭——不存在"未交付却宣称支持"。
- UI/文档审计：`apps/web-next/src`、`packages/web-client/src`、`packages/web-contract/src` 无"隔离"字样；"只读"仅用于如实权限态文案；`ProjectConversation.tsx` 明示"不是只读沙箱"。`docs/acceptance/` 中的历史"隔离"记录均为历史证据，不改写。无旧静态 FAIL 或 501 假开门状态残留于协调路径。

## NEXT-05 逐项签收

按 `.scratch/web-next-coordination-closure/spec.md`：

| NEXT-05 要求 | 证据 |
| --- | --- |
| 打开页面不创建 Task，首次发送自动创建/复用并显示消息与 Agent 结果 | `model-switch` 脚本断言 sessions 数量不变 + 首发后对话可见；`real-browser` 首发 14 组 |
| 按 Team+用户+Worker+Agent 复用协调 Task（模型不参与） | `model-switch`：跨视口 `coordinationTaskIds.size === 1` |
| 恢复对话、原 Task 重开 Session | `real-browser`：刷新恢复 + 显式重开保持原 Task 与历史 |
| 获权 Worker/Agent/Workspace 选择、停止/审批/失败重试按实际能力 | `real-browser`（停止/原生批准/拒绝/失败态/恢复发送）+ `approval-timeout` + `network-recovery` |
| 同 Session 模型切换仅对下一 Turn 生效 | `model-switch`：`turn.started.modelId` 首/后 Turn 对比 + `model.changed` journal |
| 断线/重连、未知结果不产生幽灵成功 | `network-recovery` A/B 相 |
| 非成员/跨 Team/Project/Worker/他人 Session 不可探测写入；普通 Task 权限不回归 | `authz-matrix` 25 项 + `real-browser` 非成员组 + `transport` |
| 不另加协调身份文件/终端/网络限制；UI/文档不声称隔离 | 代码审计（grep 无"隔离"；文案如实）；协调 Agent 走普通执行权限与既有审批 |
| 上传两阶段如实（Server 收件 ≠ Agent 可读） | `attachments` 退出码 0 + 既有两阶段文档 |
| 真实有效 Runtime 至少一次 | Pi CLI 1.0.4 + `zai-coding-cn::glm-5.3-flash` 证据沿用 `web-next-team-coordination-browser-partial.md`（含付费模型切换一次通过） |

结论：NEXT-05 功能项逐项有据，签收。遗留边界（连接级 vs 进程级 Server 重启、原生审批无墙钟超时的语义、`apps/web` 4 个环境性失败测试）如上如实记录，不构成功能缺口。
