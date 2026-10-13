# 协调命令授权：实施约束与首条链路

Status: 设计中；不构成资格门通过或开门许可。追踪：[协调执行边界收口](../../.scratch/web-next-coordination-closure/spec.md)、[票 02](../../.scratch/web-next-coordination-closure/issues/02-command-frame-authorization.md)、[可靠投递 ADR](../adr/0003-reliable-worker-command-delivery.md)。

## 已确认安全策略

1. **启动前在线复核。** 每次新的集群副作用启动前，Worker 向 Server 核验当前主体、任务/会话/Worker 范围及撤权状态。断网、超时或核验失败均不启动新的集群工作；不使用离线租约。经本地鉴权的独立宿主操作不依赖集群复核。
2. **认证信任根。** Server 持有持久的非对称签名私钥；Worker 仅在经认证的入群流程中固定 Server 公钥，持久化 keyId/信任记录。命令帧自带的新公钥不可信，Worker 注册 bearer 不能兼作签名密钥。生产密钥保管、经认证轮换和备份防回滚后续设计；开发期不得将当前 SQLite 中的明文私钥及其备份当作生产安全方案。
3. **开发期清空，生产升级后置。** 用户确认当前仍在开发阶段，历史数据可清理；本次仅在明确选定开发目标后，允许清空旧 Server/Worker 队列与测试身份，再从干净实例验证新协议，不实际执行未指定目标的删除。未清理的无授权旧命令不得自动恢复、外发或在不核对主体时补签。混合版本滚动升级、旧备份恢复的显式对账/解除、旧密钥轮换及防回滚另行设计，不用于当前门验收；真实用户数据环境不得采用此清空捷径。

此三项仅是实施策略，不是 L1 残余风险书面接受；协调入口仍保持 FAIL。

## 首条纵向链路及不变量

从 `session.enqueue` 的已认证用户与 Session/Task/Worker 授权开始，在 Server 命令持久化事务里保存不可变签发依据（主体及 authVersion、目标 Worker、任务/会话/Workspace、命令类型/摘要、签发与失效时间、签名 keyId），再投递到持久 transport outbox。Worker 在任何 `validate()` 或本地副作用前验签、核对命令摘要与受众，原子保存来源与可复核依据；排队 Turn 在实际 claim/launch 前在线复核权限，重启路径同样复核。签收回执与真正启动不是同一时点。撤权与启动并发的线性化/有界窗口须明确，不能一次复核后无限等待。

注意 `apps/server/src/application/server-service.ts` 的 `sentByAccountId`、审计管理员兜底与 `apps/server/src/application/ports/server-store-types.ts` 的旧 PendingCommand 都不是可直接重构历史主体的授权证据。`apps/server/src/worker-ws/transport-store.ts` 已持久序列化载荷：开发期若旧 outbox 存在，须先隔离或在选定目标后清空，不能靠新 deliverable 签名修复。`apps/worker/src/application/runtime.ts` 的 command 验证必须先于可能产生副作用的 validate；队列记录与命令签收要保留同源依据；`initialize()` 的 provisioning 恢复和普通 queue 恢复均不能把旧 cluster 项视作 local。独立宿主走已认证的 `executeLocal()`，不能伪造 cluster 断言。

## 分步交付，不以局部代替整票

1. 协议版本与持久信任根；先建立受控 `session.enqueue` tracer 的认证签发与验签负例，并在明确目标的开发实例盘点/清空旧帧后验证干净部署。生产密钥轮换及混合版本次序另行设计。
2. 通过 Server PendingCommand 与已序列化 outbox 到 Worker 接收/持久队列的真实正向链路；合法集群命令不被 blanket 拒绝，缺断言/签名伪造/错受众/过期在协商强制模式下拒绝。
3. 在线新鲜度复核与撤权并发语义，覆盖延迟 Turn、重启、离线、provisioning 和所有其余命令种类，取消/审批在副作用前检查。
4. 对当前开发实例保留的旧帧/队列阻断执行和外发；仅在选定目标后清理旧状态，从干净实例验证同版本重启的进程、Workspace 变更及 outbox 行为。旧备份对账、生产迁移与回滚演练后续另行设计，不以本次验收代替。

在前述每一步之前和之后，`GET /api/teams/:id/coordination/availability` 继续显示 FAIL；票 03 只能重新探测，票 04 仍由人工完成书面残余风险接受与开门授权。任何局部 tracer 都不得宣称已完成票 02。
