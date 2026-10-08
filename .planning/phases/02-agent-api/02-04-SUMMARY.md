# 02-04 SUMMARY — 断连重放观测与浏览器/CLI 配对（票 05 查询缺口 b）

状态：自动任务全部完成并通过；主路径已验证，**"持久 `gap` 缓存状态"一项如实 blocked**（不降级为缓存模拟）。票 05 / NEXT-05 保持 in-progress，未整票通过。

## 交付

- e2e 脚本 `apps/e2e/next-worker-reconnect-pairing.mjs`（约 520 行，无产品代码改动）：
  - 自建 TCP 代理承载 Worker↔Server 连接，支持"锁步放行（25ms/帧）—冻结（原序缓冲、不丢帧）—恢复"三种态；冻结触发条件为真实 `/api/sessions/:id/journal` 连续游标出现滞后（轮询探测，最多 45s），不依赖协议内部时序。
  - Test Agent Turn 采用**流式**模式（`streamMs`：端口回显后继续回显 120 段），离线期间 Journal 增长到 136 事件；`SIGKILL`（非优雅关闭）后以同一 home 重启，由 durable outbox 重放补传。
  - 三侧观测：HTTP `session.journal`/`session.metadata`（管理员 Cookie + CSRF）、浏览器面板（`data-journal-seq` 行 + "元数据新鲜度"文案）、CLI（`invokeCapability` + `parseInvocation`，Test Agent 短期 Grant）。
  - 负例：viewer 账号双通道拒绝、撤销授权后的 editor 通道拒绝、篡改令牌拒绝；另扫描日志/结果 JSON/DOM 断言凭据零泄漏。
- 验收摘要：`docs/acceptance/web-next-reconnect-pairing.md`；原始证据 `.scratch/web-next-project-agent-platform/evidence/02-04/`（`result.json` + 四张双视口截图 + `worker-restart.log`）。

## 验证结果（本次运行）

- 7 项检查全绿、`errors` 0、退出码 0；断连时 Server 停在连续序号 5 而 Worker Journal 136、outbox 滞留 136（ack 19）；冻结窗口 4770ms / 262 帧，三侧一致看到未补传区间 9..136，5 次采样无提前露出；恢复后 outbox 排空（last 317 = ack 317），HTTP/CLI 136 事件逐条一致并与 Worker Journal 相同；双侧浏览器渲染 9 行（8 锚点 + 段落首行）、新鲜度"已同步"、本 Turn Echo 文本在屏。
- 凭据扫描 11 处命中 0；双视口零 `pageerror`。
- 命令：`WEMUX_NEXT_TEST_DIST=/tmp/wemux-next-dist-0204 node --import tsx apps/e2e/next-worker-reconnect-pairing.mjs`（需先有 Next 构建产物；脚本自身不构建，也未跑根 build，遵守单写者纪律）。

## Blocked 项（如实记录）

- 持久 `gap` 缓存状态不可由真实链路中断产生：`sync: heads` 在 durable outbox 中总排在其所报告事件之后，Server 记录头部时连续游标已追平，`store.ts:689` 直接落到 `synced`；头部回退还会被 `worker-service.ts:274` 判 `409 Worker journal head regressed`；Worker 仅在所请求区间不可得时才发 `sync: gap`（`runtime.ts:170-185`）。
- 处理：按计划授权，不降级为缓存模拟；以"真实游标滞后窗口 + 三侧同一快照 + 不提前露出 + 收敛逐条一致"为替代证据，脚本保留机会性捕获并把原因写入 `result.json.notes`；验收文档明确不声称观察到持久 `gap`。
- 冻结窗口是在毫秒级真实窗口之外按原序延长（等价慢链路），非持久状态注入；秒级真实 gap 停留所需的链路形态（heads 早于事件到达）本切片未构造。

## 后续

- 02-05 写作通道矩阵不受本切片阻塞（其依赖为 02-02 禁用态 UX 人审 checkpoint）；02-06 总账需引用本切片结论与 blocked 项。