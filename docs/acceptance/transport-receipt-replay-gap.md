# 传输层收据/重连序号空洞修复（2026-09-29）

全量测试中 R1 双 Worker E2E 曾出现 Worker 记录的 `transport gap: expected 4, received 5/6` 和 `transport integrity error: message ... reused`。定位两个独立错误：

1. Server `apps/server/src/worker-ws/transport-store.ts:discardCommand` 收到应用层收据时删掉尚未获得**传输 ACK** 的 outbox 帧，若 transport ACK 丢失就形成不可填的 `directionSeq` 空洞。修复为保留原帧直到 transport ACK；领域层已收据不再重新入队，传输重放只触发 Worker 的 messageId 去重和重复 ACK。原“收到收据即丢弃未发送帧”在此情形下错误，已修订 `docs/design/worker-reliable-connection.md` §10.2。
2. Worker `apps/worker/src/transport/transport-store.ts:acceptServerHello` 在同一 `deliveryEpoch` 的重连时，采纳滞后的 Server 声明把**已经本机持久接收**的 cursor 回退；旧帧重放便被误判为复用 `messageId`。修复为保持本机已提交的高水位；拒绝 Server 声明超前于本机已提交水位。新世代仅在尚未建立本地水位时初始化；跨世代晚到数据不得擅自重新激活旧 epoch。Server 偶然重新观察到原 worker epoch 时也保留原已提交 cursor，不回退到 0。

回归：`apps/server/src/test/transport-receipt.test.ts` 红→绿，检验收据不能打开序号空洞；`apps/worker/test/transport-store.test.ts` 新增重连同 epoch 不回退、重放去重、越界声明拒绝、跨世代晚帧拒绝；Server 测试增加 epoch A→B→A 回返不重置 cursor；真实 Server + 双 Worker + 断线恢复资源 E2E 通过 `/tmp/transport-reconnect-double-fix.log`。`npm run typecheck` 通过 `/tmp/wemux-transport-final-typecheck.log`，完整 `npm test` 再次通过：Node 850 tests / 844 pass / 0 fail / 6 skipped；package 10 pass，Web 291 pass；日志 `/tmp/wemux-after-epoch-full-test.log`。额外审计发现 Worker 握手曾在验证全部 cursor 之前写入 ACK，且未限制 Server 所报 outbound ACK 不得大于本机已入队序号；补红绿测试并改为先校验两个方向、再同事务更新状态，定向 10/10 通过。后续 `npm test` 已复测通过：Node 851 tests / 845 pass / 0 fail / 6 skipped、package 10/10、Web 291/291（`/tmp/wemux-transport-hello-full-test.log`）；`npm run typecheck` 通过（`/tmp/wemux-transport-hello-typecheck.log`）；没有对线上长期故障注入做证明，后续仍须真实网络 ACK 丢失/乱序演练。
