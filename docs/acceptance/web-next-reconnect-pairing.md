# 阶段 2 / 02-04 验收摘要：断连重放观测与浏览器/CLI 配对（票 05 查询缺口 b）

对应计划：`.planning/phases/02-agent-api/02-04-PLAN.md`（票 05 切片，NEXT-05 仍为 in-progress）
原始证据：`.scratch/web-next-project-agent-platform/evidence/02-04/`（`result.json`、`worker-restart.log`、四张双视口截图；脚本日志在 /tmp）
脚本：`apps/e2e/next-worker-reconnect-pairing.mjs`

## 范围与结论

在真实链路中断下观测 durable 重放：Turn 进行中真实阻断 Worker→Server 连接，Worker 离线把整轮 Turn 写进本地 Journal 与 durable outbox（outbox 滞留、ack 水位不推进），SIGKILL 后以同一 home 重启，由 transport 有界重放补传。脚本断言：断连期间 Worker Journal 已推进而 Server 缓存停滞、三侧（HTTP / 浏览器 / CLI）对**同一未补传区间**的观测一致且不提前露出、重放收敛后事件序号与内容逐条一致，以及撤销/查看者/篡改令牌的拒绝路径。

**结论：主路径通过；"持久 `gap` 缓存状态"一项如实 blocked（见下），未降级为缓存模拟。**

## 验证环境

- Node v26.5.1；Server 为 `createWemuxServer` 动态端口（禁用 8004）+ 临时 SQLite；管理员账号经注册/登录取得 Cookie + CSRF。
- 真实 Worker CLI（仓库 `apps/worker/dist/cli.js` 拷贝，node_modules 符号链接）+ 确定性 Test Agent（**非**付费模型、非本机原生运行时）；Worker home 全部落在临时目录。
- 前端：`WEMUX_NEXT_TEST_DIST=/tmp/wemux-next-dist-0204`（`apps/web-next` 构建产物拷贝，未跑根 build）。
- 浏览器：Chromium `chromium-1228/chrome-linux64/chrome` + playwright-core 1.61.0，桌面 1440×1000 与手机 390×844 各一轮。
- 命令：`WEMUX_NEXT_TEST_DIST=/tmp/wemux-next-dist-0204 node --import tsx apps/e2e/next-worker-reconnect-pairing.mjs`

## 已验证检查项（本次运行，`result.json`）

| # | 检查 | 结果 |
|---|------|------|
| 1 | 真实 Worker 上线并上报确定性 Test Agent 能力 | 通过 |
| 2 | 断连前两 Session 已同步（`synced`），双视口浏览器绑定同一 Session | 通过 |
| 3 | 真实断连（Turn 中阻断 TCP）：Server 冻结在连续序号 5，Worker Journal 离线推进到 136（event 131 / sync 5），outbox 滞留 136 帧、ack 停在 19 | 通过 |
| 4 | 冻结窗口三侧一致：Server 缓存 `syncing`、连续序号 8、事件 1..8 在屏；HTTP/浏览器/CLI 看到同一未补传区间 9..136；5 次采样均无提前露出 | 通过 |
| 5 | SIGKILL 后同 home 重启，durable 重放补传：outbox 排空（last 317 = ack 317）；HTTP 与 CLI 各 136 事件序号与内容**逐条一致**；Server Journal 与 Worker Journal 序列一致 | 通过 |
| 6 | 双侧浏览器渲染 9 行（8 个锚点 + 文本段落首行）、按序、无 Server 之外 seq、末事件 136 在屏、新鲜度"已同步"、历史含本 Turn 的 Echo 文本 | 通过（双视口）|
| 7 | 负例：viewer 在 HTTP（404）与 CLI 双通道拒绝；撤销授权后 editor 通道 HTTP 404 `project_not_found`、CLI `project_not_found: Project not found`；篡改令牌被拒 | 通过 |
| 8 | 凭据卫生：11 处扫描（日志/结果 JSON/DOM）命中 0 次令牌片段 | 通过 |
| 9 | 双视口零 `pageerror`；四张截图（gap / synced × 桌面/手机）存档 | 通过 |

补充事实（`result.json`）：观测窗口为帧按原序锁步放行（25ms/帧）后冻结链路 4770ms、滞留 262 帧，期间 Server **未**下发 `sync` 请求（`syncRequests: 0`），补传完全来自 Worker 的有界重放。

## 未验证 / blocked

- **持久 `gap` 缓存状态在主机制下不可达（如实 blocked，不降级模拟）**：Server 的 `gap` 需要 heads 上报声明 `workerLastSeq > contiguousSeq`（`apps/server/src/storage/sqlite/store.ts:689`：`status: old.contiguousSeq === lastSeq ? 'synced' : 'gap'`），而 Worker 的 durable outbox 严格按序（`directionSeq` 连续）重放、`sync: heads` 总排在其所报告的事件之后，heads 到达时连续游标已追平，故状态直接落到 `synced`；`apps/server/src/application/worker-service.ts:274` 还会把头部回退判为 `409 Worker journal head regressed`。Worker 侧 `sync: gap` 仅在所请求 Journal 区间确实不可得时发出（`apps/worker/src/application/runtime.ts:170-185`）。
- 因此本切片**不声称**曾观察到持久 `gap`；缺口可见性以"真实游标滞后窗口 + 三侧同一快照 + 不提前露出 + 收敛逐条一致"作为替代证据，脚本保留机会性捕获（`gapStatesSeen`，本次为 0）并把原因写入 `result.json.notes`。
- 未使用本机原生运行时或付费模型；Test Agent 为确定性桩，不构成模型质量证据。
- 桌面/手机截图为浅色主题（应用跟随系统主题，深色为默认偏好），非缺陷。
- 冻结窗口在毫秒级真实窗口之外人为延长（帧按原序缓冲、不改状态、不干预协议，等价于慢链路/链路抖动）；真实的"秒级 gap 停留"依赖 `sync: heads` 早于事件到达的链路形态，本切片未构造该形态。

## 签收状态

- 自动检查全部通过，无 `MISMATCH` / `assertion failed` / `gap not created`，错误计数 0；进程退出码 0。
- 02-04 的自动任务完成；"持久 gap 状态"作为**已知 blocked 项**随 SUMMARY 记录，票 05 / NEXT-05 保持 in-progress，未整票通过。
- 本切片不阻塞 02-05 写作通道矩阵（其依赖为 02-02 禁用态 UX 人审 checkpoint）。