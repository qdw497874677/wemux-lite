# Ticket04 自动审批失效持久链路

## 范围与状态

主会话实现，最终独立只读复审 `102364ca-94b0-4b1d-b8b2-286086fff839` 为 **OK for this bounded approval-expiry increment**，未发现问题。初审的两处 P1（清理漏等已启动的终结发布、关闭期间新审批准入窗口）均已修复并经复审关闭，取代初审 BLOCK。审查者检查源码和主会话日志，未独立执行测试。Ticket04 保持 partial，所有票据未完成。

本增量为 Connector 自动失效新增 `approval.expired`，原因限定 `timeout | cancelled | turn_released | shutdown`。它不是人工拒绝，不记录人工决策者。Worker 请求发布先于对应失效事件；ClusterLifecycle 写入 Session Journal；Server 校验事件并将精确 Session/Turn/Approval 的待决投影置 expired；共享客户端回放、Next 历史和 Worker 本地待决查询移除失效审批。重复请求、晚到人工决定不能重新打开已失效项，已人工决定的项目不被自动失效改写。

## 可重复验证

- `npm run build:packages`
- `node --import tsx --test apps/worker/test/connector-turn-snapshot.test.ts apps/worker/test/approval-command-identity.test.ts apps/server/src/test/projection-service.test.ts apps/server/src/test/approval-projection-http.test.ts`：71/71。
- `npm test --workspace @wemux/web-client`：215/215。
- `node --import tsx --test apps/worker/test/cluster-lifecycle.test.ts`：13/13。
- `npm test --workspace @wemux/worker`：389 tests，385 pass，4 skip，0 fail。
- Worker、Server、Next typecheck 通过；Worker 在最后集成测试修改后再次通过。
- `apps/e2e/next-controls-browser.mjs`：桌面 1440×1000、手机 390×844，共 30 checks 通过。使用真实 Next/共享客户端/Server HTTP，合成执行事件；四种自动失效均在 Turn 未结束时移除控件、刷新不恢复待决且不自动提交决定。该浏览器测试不是 Worker/native Runtime 全链路证明，也不是截图视觉签字。

浏览器命令：先 `npm run build --workspace @wemux/web-next -- --outDir /tmp/wemux-approval-expiry/next-dist`，然后显式设置 `WEMUX_NEXT_TEST_DIST`、`PLAYWRIGHT_CORE_PATH`、`PLAYWRIGHT_CHROMIUM_PATH` 执行 `node --import tsx apps/e2e/next-controls-browser.mjs`。路径由验收者提供，禁止使用生产服务。

真实本地集成测试通过 ClusterLifecycle 初始化 Worker、创建本地 Session、执行受控 TestRuntimeSessionAdapter，调用真实 loopback capability gateway。Turn 结束触发 Connector 释放，记录匹配请求的 `approval.expired`，HTTP 返回 `approval_denied`；独立打开 SQLite 后 Journal 一致。外部 HTTP executor 被设为一旦执行就失败，并验证零调用。不是付费或已认证原生 Agent 证明。

## 证据与发现

原始日志：`/tmp/wemux-approval-expiry/`，包括 `focused-final.log`、`client-final.log`、`gateway-final.log`、`worker-all.log`、`*-types*.log`、`browser-final.log`、`build.log`。浏览器原始证据 `/tmp/wemux-next-controls-browser-PqsNq8/`。

两次测试夹具纠正：首次 reopen 错用 Journal.read 的位置参数，改为对象后通过；首次浏览器在新增 reload 之后继续模型控制而未显式复核旧人工决定，按产品既有安全约束补同身份显式 retry 后通过（失败证据 `/tmp/wemux-next-controls-browser-tRzEom/`）。不是产品修复红绿证明。工具包装器的简要 pass/fail 统计存在误判，以上数字取 Node 原始日志末尾汇总。

## 审查修正

- `apps/worker/test/connector-approval-finalization.test.ts` 初始 9 项全部红灯，直接复现上述两处 P1（`review-red.log`）。覆盖 abort/timeout × release/shutdown × requested/expired 发布阻塞。
- Runtime 独立跟踪非待决但尚未完成的发布 Promise；按精确 Session/Turn 等待，重复清理复用未完发布，不阻塞其他 Turn。关闭在首次 await 前清空活动 Turn 并设置 closing；registerTurn 在异步发现前后均检查 closing，避免正在准备或注册的新工作越过关闭边界。
- 新增重复清理、无关 Turn 不被阻塞和正在异步发现的注册被关闭拒绝断言；最终 10 个新增回归随 Worker 全量 399 tests（395 pass、4 skip、0 fail）通过，Worker typecheck、diff check 通过。日志 `review-worker-all.log`、`review-types.log`；初次修复的相关 31/31 见 `review-green.log`。
- 本修正仅影响 Worker 终结发布等待和关闭准入；此前浏览器证据不冒充这两个服务端并发问题的验证。

## 未覆盖与剩余工作

- 不证明进程硬崩溃后的未发事件补偿、Journal 写失败重试或外部调用前最终撤销竞态全部解决。
- Gateway 当前未将 HTTP 客户端断线传为 AbortSignal；`cancelled` 的 ConnectorRuntime 测试直接传入 AbortSignal，不能声称浏览器断线已完整传播。
- 四种原因的 Server HTTP/SQLite 投影、客户端回放与浏览器都已分别验证；真实 Gateway→Journal 集成验证的是 `turn_released`，不混称全部原因端到端通过。
- Worker 独立 Next UI、真实 Pi/Claude 原生审批、真实集群传输到浏览器、任务自动绑定与其余票据仍须各自完整验收。
