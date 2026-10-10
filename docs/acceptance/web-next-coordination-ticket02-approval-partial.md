# 协调票 02：原生审批命令传输受控切片（2026-10-10）

状态：**部分实现、未验收**。集成候选 `3f97262`；`apps/server/src/application/coordination-gate.ts` 的 `verdict: 'FAIL'` 未变。票 01/02 保持未完成，票 03 前置未解除，票 04 的人工书面残余风险接受未取得。本记录不是协调入口开放、OS 隔离、旧备份恢复或所有 Worker 命令授权的证明。未调用付费 Runtime，未删除数据。

## 范围与边界

- `runtime.approval.resolve` 增加 Server 持久签名断言、Worker 验签与当前在线授权复核；在原生 Runtime 的每 Session 串行锁内、调用 Adapter 前再次复核。集群失联或撤权不执行新的原生审批；本地已鉴权操作不依赖集群在线。
- 审批命令健康 WebSocket 临时拒绝后有界重试；签名过期时仅在原主体与权限仍有效的条件下刷新，已发送帧在未获传输 ACK 前保持不变。应用收据已提交但传输 ACK 丢失时，只重放原已发送帧以修复序号屏障，不能把已结算命令重新签发为新的原生操作。
- 授权检查与异步 Adapter 调用之间仍存在有限的执行时间窗口，不能声称撤权在任何瞬间都能中断已进入的调用。丢 ACK 的 E2E 只证明同连接的序号恢复；**未**在收据提交与重放之间重启 Worker/Server，也未证明重建 Worker 传输库后的恢复。历史未签名集群帧不能自动获权；其他有副作用的命令（包括 provisioning、connector sync/test、runtime.command）和恢复路径尚未普遍完成同等授权。因此票 02 验收项一律不勾选。

## 同候选验证

以下命令均在隔离合并工作树 `/tmp/wemux-coordination-approval-merge` 的相同代码候选执行，之后作为 `3f97262` 快进集成；原始日志保存在 `/var/tmp`，不入库。

- `npm run build:packages`、Server/Worker typecheck：退出码 0，日志 `/var/tmp/wemux-approval-build-packages.log`、`/var/tmp/wemux-approval-server-type.log`、`/var/tmp/wemux-approval-worker-type.log`。
- Worker 原始 Node 串行汇总：`515` tests，`510` pass、`5` skipped、`0` fail（`/var/tmp/wemux-approval-worker-full.tap`）。
- Server 原始 Node 串行汇总：`944` pass、`0` fail，使用磁盘临时目录 `TMPDIR=/var/tmp/wemux-approval-server-qdw`（`/var/tmp/wemux-approval-server-full.tap`）。此前 tmpfs 路径测试曾报 SQLite `disk I/O error`，不计为通过。
- 非付费 Test Agent + 实际 Server/已入群 Worker WebSocket：`apps/e2e/coordination-approval-transport.mjs` 五组检查通过，包括暂时拒绝与签名刷新、应用收据成功但传输 ACK 丢失后下一帧继续、无签名与篡改拒绝（`/var/tmp/wemux-approval-transport-final.log`）；`apps/e2e/coordination-command-transport.mjs` 三组既有 enqueue 检查通过（`/var/tmp/wemux-enqueue-transport-final.log`）。
- 独立静态复审在把在线复核放入 RuntimeSessionManager 每 Session 串行锁后给出 **SAFE PARTIAL**，不是整票通过；保留重启边界和检查后 Adapter 异步耗时的限制。

## 下一步

继续按 `.scratch/web-next-coordination-closure/issues/02-command-frame-authorization.md` 覆盖剩余命令类别、离线/重启/恢复负例，并按票 01 补 Server 权威的 grant 签发 Worker 与当前 Turn 校验。不得据此解除票 03/04 前置门或开放协调入口。
