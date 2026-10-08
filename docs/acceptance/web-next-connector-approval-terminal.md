# Connector 审批终态清理（部分验收）

主会话实现，最终独立复审 `e3965141-75d5-4074-ad4a-e19a290aaa02` 为 **OK**，未发现问题；原审查指出的准备竞态测试盲点已修正并关闭。本增量不是 Ticket04 审批生命周期全部完成证明。

## 缺陷与修复

`WorkerConnectorRuntime.registerTurn()` 返回的 release 原先只删除 capability token，不清除所属 Turn 的待决审批，留下最长五分钟的孤立请求。`requestApproval()` 也未检查调用信号已取消或异步准备期间 Turn 已释放。

现在释放 Turn 会按 Session + Turn 精确拒绝其待决请求；其他 Turn 不受影响。创建审批前再次检查活动 Turn 与取消信号，失效时直接拒绝，不挂起、不执行外部调用。

## 验证

- 真实 SQLite/WorkerConnectorRuntime 回归先红：4 项中 1 项失败，断言释放后不应遗留待决审批。
- 聚焦 7/7：所属与无关 Turn 释放、异步准备期间释放、预先取消、五分钟计时器到期、迟到批准拒绝及零外部调用。超时用 Node mock timers 推进，fetch 使用受控桩。
- Worker 全量 384 项：380 通过、4 跳过、0 失败。Worker typecheck 与 diff 检查通过。
- 原始证据 `/tmp/wemux-approval-terminal/{red,green,timeout,worker-all,types}.log`。
- 审查后把准备竞态阻塞点移到成功鉴权并持久化执行记录之后；释放 Turn 后再放行，明确断言 `approval_denied`、零请求事件、零待决项及零外部调用。聚焦 7/7 与 Worker typecheck 通过，日志 `review-fix-green.log`、`review-fix-types.log`。
- 在 `/tmp/wemux-approval-terminal/mutation/` 的独立源码副本仅删除活动 Turn 检查，修正测试立即因孤立审批断言失败（`review-fix-mutation-red.log`）；仓库实现未回退。首次副本缺少 package.json，产生 ESM 加载错误，不计缺陷证据；补齐后才取得上述行为红灯。

可重复：

```sh
./node_modules/.bin/tsx --test apps/worker/test/connector-turn-snapshot.test.ts apps/worker/test/approval-command-identity.test.ts
npm test --workspace @wemux/worker
npm run typecheck --workspace @wemux/worker
```

## 未完成边界

仍需完善审批超时与取消的持久 Journal 终态及新版显示。当前 cluster-lifecycle 只记录 Connector 请求事件，不记录自动超时/取消事件，不能把内存清理通过当成 UI 待决状态已同步。批准之后、真正调用外部工具之前的终态竞态需另外验证；崩溃恢复、真实 Runtime、双宿主和视觉验收尚未签字。此次没有发起真实外部写入。
