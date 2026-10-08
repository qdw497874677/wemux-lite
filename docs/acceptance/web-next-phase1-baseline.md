# Web-next 阶段 1：01-01 Server 安全及回归基线

状态：01-01 局部安全/回归已核证；五票与阶段 1 均**未签收**。源码基线 `93c9f67cab09ca51bd95d8bdb14d7d0ca99f0255` + 共享工作树未提交改动；提交号本身不能唯一标识候选。原始命令输出保存在 `/tmp/wemux-phase1-focused-canvas-fix2.log`、`/tmp/wemux-phase1-server-canvas-fix2.log`、`/tmp/wemux-phase1-server-canvas-fix3.log`；`/tmp/wemux-phase1-server-canvas-fix4.log` 显示 `909 tests / 909 pass / 0 fail`；同轮独立保存 `/tmp/wemux-phase1-server-canvas-fix4.exit` 为 `0`。01-11 最终候选仍须重新验证。服务端类型检查见 `/tmp/wemux-phase1-typecheck-canvas-fix.log`，`git diff --check` 无输出。此前失败的 `/tmp/wemux-phase1-server-canvas-fix.log` 是 canvas SSE backpressure 错误处理异常，已修并以定向 38/38 验证；不能把失败轮当成功证据。

## #58 超时改动六文件逐 hunk 归属与处置

对照 `git diff`、`/tmp/wemux-phase1-01-sse-diff.txt`、`/tmp/wemux-mini-web-next-session-handoff-2026-10-06.md` 和读写通道 R2：

| 文件 / hunk | 归属与裁定 |
| --- | --- |
| `apps/server/src/http/sse.ts`：原始 Cookie/PAT 重验，通知/心跳 generation，idle 不造 freshness、关闭背压连接 | #58；保留，凭据变化/静默变化/正常心跳有定向测试。不重启 Cookie idle 到期时间。 |
| `apps/server/src/http/project-sse.ts`：按 generation 重验原始凭据及项目访问，事件待发队列限额与失败关闭 | #58；保留，未授权事件不从通知直写；上限 1 MiB。 |
| `apps/server/src/http/canvas-collaboration-sse.ts`：重建可见 presence 投影、重验、同步失效、防背压堆积、心跳通过校验后发送 | #58；保留，经只读复审指出并修补心跳先写与无限背压两项 P2，待复审最终结果。不得把旧快照缓存当作认证可见数据。 |
| `apps/server/src/http/routes/canvas-routes.ts`：把原始请求凭据绑定 canvas SSE | #58；保留。 |
| `apps/server/src/http/routes/project-routes.ts`：`/events` 原始凭据绑定 | #58；保留；同文件新增 review-policy 路由和 session-graph 访问变化**属于其他票据，不撤回或挪用**。 |
| `apps/server/src/http/routes/session-routes.ts`：session stream 原始凭据绑定、terminal stream 重验/Task 生命周期 | #58/#57；保留；同文件其他会话功能属共享工作树其他切片。 |
| `apps/server/src/http/stream-credential-authorizer.ts`：原凭据身份/权限约束 | #58 新文件；保留，不降级为静默刷新或匿名回退。 |
| `apps/server/src/http/handler.ts`：Next 静态路由和 Cookie 归一化 | **非 01-01 归属**，本计划未修改；R2 保护约束照旧。 |

## #57 / #60 取证

- `apps/server/src/server.ts` 将 `terminalStreams` 注入真实路由；`apps/server/src/test/fixtures/session-effect-fixture.ts` 原夹具未注入，夹具中的 404 只证明缺失组件。生产路由在删除 Task 时以 404 拒绝新 terminal SSE，不能因夹具伪 404 改成 200。现在测试保留已连接时 200 和删除后 404 的分别断言；历史文件读依现行合同可继续读。
- `apps/server/src/test/session-effect-service.test.ts`、`apps/server/src/test/session-effect-authorization.test.ts` 的五类 effect 写入口按 Ticket10 R2 统一关闭 (`403/write_channel_closed`)，未授权仍按入口真实验证返回 401 或 PAT scope 错误；写拒绝早于正文解析和资源可见性，不泄漏 gateway effect。`apps/server/src/test/task-delete-artifacts.test.ts` 中消息生命周期仍 410，文件/terminal 写入口 403。
- `apps/server/src/test/canvas-collaboration-http.test.ts`：私有项目的图查询匿名暴露被改为 404；撤权边界允许一条已排队的 `presence.updated` 后接 `presence.left`，最终可见投影不可泄漏私有 Session。未改生产权限来适配断言。
- 第一轮 Server 全量 `/tmp/wemux-phase1-server-latest.log` 显示 909/909；修补 canvas 心跳/背压后的定向 38/38（`/tmp/wemux-phase1-focused-canvas-fix2.log`），后两轮全量显示 909/909。外部 OAuth/SMTP、真实 Worker、桌面手机和五票逐项签收尚未进行；不能把此处的局部绿灯合成阶段完成。

## 待办

1. Canvas SSE 二次只读复审无安全 blocker；01-01 局部基线已完成，不等于票 #58 或阶段签收。最终全量 Server 命令须绑定 01-11 同一候选产物。
2. 01-02 的受控 Chromium 回归已局部通过，最新运行 `/tmp/wemux-phase1-ticket01-controlled11/result.json` 为 7/7 且无未预期诊断。夹具匿名/退出后 Project 请求返回 401，故障期仅把匹配注入来源的控制台/网络失败标为预期；这仍不是实际账号授权或线上 OAuth/SMTP 的证据。后续按 01-03..01-11 逐项实施/验证。票 02 真实 Google/SMTP、票 03 历史 Task 安全删除和个人隐藏、票 07 全流程等尚未证明；最后统一候选重验并请人工逐票签收。
