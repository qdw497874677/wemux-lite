# Ticket04 重复 Worker 进度通知与浏览器稳定性

状态：初次独立审查 `2d9a18d4-335c-4c7b-af5e-86d699b2661e` 为 BLOCK，指出无 Run 的 enqueue 被拒绝后缺少 Session 通知。该 P1 已修复并通过定向红绿，复审 `accb4c30-f364-45ef-9882-09ca7519564c` 为 **OK with notes**，原 BLOCK 已关闭；仅认可此有界修复，不代表新试聊入口获审或 Ticket04 全票完成。

## 原因与修复

Worker `apps/worker/src/application/runtime.ts` 每秒上报 `sync.heads`。Server `apps/server/src/application/worker-service.ts` 原先对每个有效 Session 无条件加入 changed，导致完全相同的 head 也广播 Session 更新和 commands 投递。Next 收到 SSE 后重新读取元数据，保守的发送和控制准入在刷新期间拒绝操作，从而产生不必要的周期性按钮禁用。

修复比较事务内 head 更新前后的完整 freshness，只在状态确实变化时通知。未知/已删除/非归属 Session 与回退拒绝规则不变；同一 gap 仍请求缺失 Journal，offline→synced 即使序号不变仍通知。不放宽前端权限与新鲜度检查，不重复用户点击，也不自动重发。

去掉周期性刷新后，能力变更不能依赖下次 head 间接刷新，因此能力报告确实变化时显式通知该 Worker 的未删除 Session，相同能力报告保持安静。

## 红绿与回归

原始日志仅在私有 `/tmp/wemux-head-refresh-fix/`：

- `red.log`：10 次重复 head 得到 invalidations=11、deliveries=11，预期均为1，断言失败。
- `capability-red.log`：新增明确能力刷新断言失败（4 !== 5），随后补充能力变化事件。
- `regression-final.log`：Worker head、通知隔离、可靠传输及历史取消/重启投影回归 **10/10**。
- `types-final.log`：Server typecheck 退出0。先前一次发现测试能力帧缺少 detectedAt，已修复并重跑，不沿用早期退出结果。

```bash
npx tsx --test apps/server/src/test/worker-head-notifications.test.ts \
  apps/server/src/test/notifications.test.ts \
  apps/server/test/transport-v2-integration.test.ts \
  apps/server/src/test/ticket06-evidence.test.ts
npm run typecheck --workspace @wemux/server
```

## 真实 Worker 浏览器

`apps/e2e/next-worker-conversation-browser.mjs` 使用自有临时 Server、实际 Worker CLI、确定性 Test Agent；不使用原生收费 Runtime。

最初去掉重复 head 后6轮通过，第7轮手机首次发送仍在初始 Session 创建的真实 Journal 更新期间被禁用。第8轮根入口转换首次发送也遇到初始化刷新。两次失败保留于 `browser-7.log` / `browser-8.log`，不是修复成功证据。

将响应丢失及根入口发送场景的前置条件修正为：Worker 接收 Session 命令后，继续等待该 Session 初始 Journal synced 且 contiguousSeq>=1，再打开对话。接收回执不冒充运行时就绪；这里不覆盖“创建过程中抢先发送”。刷新中指针/submit 拒绝的安全边界仍由 `apps/e2e/next-composer-browser.mjs` 单独受控验证。脚本不重复点击、不延时猜测稳定窗口、不改生产准入。

最终相同代码与测试前提下，`browser-9.log` 至 `browser-13.log` **连续5轮，每轮桌面/手机共12 checks**。覆盖真实创建、响应丢失后同身份重试、取消排队、停止明确 Turn 不清空后续消息、重启恢复和根入口自动 Task。

```bash
WEMUX_NEXT_TEST_DIST=/tmp/wemux-worker-browser-diagnosis/not-sent-dist \
node --import tsx apps/e2e/next-worker-conversation-browser.mjs
```

最终原始证据：`/tmp/wemux-next-worker-browser-LtjJfT`、`/tmp/wemux-next-worker-browser-jWCNGc`、`/tmp/wemux-next-worker-browser-dJDCd8`、`/tmp/wemux-next-worker-browser-uVXTo2`、`/tmp/wemux-next-worker-browser-rVWpNH`。固定前端构建未改变，本次生产改动在 Server，脚本直接加载当前 Server/Worker 源码。

## 独立审查 P1 跟进

停止依赖周期性 head 刷新后，普通 Task Session 的 enqueue 拒绝没有 Journal，也没有 Session 通知，可能残留排队显示。ACK 分支现在仅在新拒绝收据上读取保留的命令，校验 Session 归属和未删除状态，显式加入 changed；重复收据仍由原状态比较提前过滤。

- `rejection-red.log`：公开 service enqueue 后元数据出现队列项，Worker 拒绝后项消失但通知数量 1 !== 2，先红。
- `rejection-green.log`：增加拒绝通知后相关 **10/10**，覆盖无 Run、无 Journal、重复拒绝及同 head 安静；`rejection-types.log` Server 类型检查通过。
- 后续完整真实 Worker 桌面/手机 **14 checks**：`/tmp/wemux-dedicated-entry/browser.log`、`/tmp/wemux-next-worker-browser-hJD9SI/`。包含新增 Next 试聊入口，因此不冒称与之前5轮完全同一测试集合。

## 边界

重复 head 导致的周期性刷新已获确定性红绿证明。真实状态变化仍可使旧操作失效，不能保证任何时刻点击都被准入，也不应绕过最新权限。连续5轮通过不是所有时序无缺陷的数学证明。原生 Runtime、成功模型切换、专用试聊新入口及整票关闭仍另行验收。原始浏览器证据可能包含本机 Agent/model 名称，仅留私有临时目录。
