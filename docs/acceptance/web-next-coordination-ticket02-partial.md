# 协调命令授权票 02：受控部分合并

状态：**未完成，协调入口仍关闭**。候选 `integration/web-next-coordination-closure` 的 `9460183`，签名链路部分合并 `d4d0ad4`，真实传输测试合并 `836df8e`，Server Run/Ticket06/Worker head 测试夹具修复合并 `1a59848`、`3876932`、`9460183`。未勾选 `.scratch/web-next-coordination-closure/issues/02-command-frame-authorization.md` 任一整票验收项。

## 已实现与复核

- 新签发的、带已认证用户主体的 `session.enqueue` 保存 Ed25519 断言；Worker 经认证入群固定 Server 公钥，收帧验签、命令摘要/受众/期限，排队与同版本重启时查持久来源，claim 前在线复核。无授权的恢复队列不启动。新入群缺公钥拒绝；Server 缺签发主体或签名器拒绝新 enqueue。
- Server 持久 transport outbox 内无签名的旧 enqueue 设为顺序屏障，不跳过帧、不静默补签；已入队的合法命令若超过收帧时效，尚无重新授权重投递流程。开发实例若存在旧状态须先明确目标并另行清理，**本次没有删除任何历史数据**。
- 独立实际 Server + 已入群 Worker WebSocket + Test Agent（非付费）测试：合法 Task-bound create/enqueue 可执行、持久通道注入无签名 enqueue 获拒绝回执且无排队、副操作者被停用后的同 home 重启不启动其等待中的 Turn。脚本与日志见 `apps/e2e/coordination-command-transport.mjs`、`docs/acceptance/web-next-coordination-ticket02-transport-harness.md`、`/tmp/wemux-coord02-merge-e2e.log`。
- 同候选 `9460183`：`npm run build:packages`、Server/Worker build/typecheck 通过；Server Node 汇总 `935/935`，Worker `464` 项中 `459` 通过、`5` 跳过、`0` 失败；对应 `/tmp/wemux-coord02-server-full-final.log`、`/tmp/wemux-coord02-merge-worker-test.log`。包装器状态与 Node 汇总不一致，按原始测试汇总陈述，未把此当成完整门验收。

## 未完成，不得开门

1. 仅 `session.enqueue` 受签名边界约束；`workspace.provision`（含启动恢复）、`session.create`、控制命令、`runtime.command`、审批与 Connector 等有副作用的集群命令尚可无断言执行；Server 待签发主体需按实际人/受限系统来源贯通，不得回退到审计管理员。
2. claim 前在线复核与真实 Agent `iterator.next()` 间仍有 Workspace/Provider 等 await，撤权与启动竞态尚未定义/约束。失败在线复核只做四次有限重试，超过窗口需连接事件或新命令唤醒；离线超过五分钟才首次投递会过期并缺重新授权重投递方案。
3. 拒绝原因码审计、结果读取当前权限、所有命令/恢复反例和审批/取消竞态尚未逐项复核。旧 outbox 屏障导致后续帧停滞是安全优先的可用性成本，不能通过跳过序号解除。
4. 票 01 的 Server grant 原 Worker/当前 Turn 证明、具体 MCP 工具名授权、发现前审批和可信审计仍未收口，见 `docs/acceptance/web-next-coordination-01-follow-up.md`。L1 进程 HOME/cwd/env 作用域不是 OS 文件或网络隔离；本记录不是部署者残余风险书面接受。

`apps/server/src/application/coordination-gate.ts` 的 verdict 仍为 `FAIL`；票 03 前置门未解除，票 04 人工签收/开门没有授权。后续生产升级/旧备份对账另行设计，不以开发期可清空数据为由放宽当前新命令安全边界。
