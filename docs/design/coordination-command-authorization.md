# 协调命令授权：实施约束与首条链路

Status: 设计中；不构成资格门通过或开门许可。追踪：[协调执行边界收口](../../.scratch/web-next-coordination-closure/spec.md)、[票 02](../../.scratch/web-next-coordination-closure/issues/02-command-frame-authorization.md)、[可靠投递 ADR](../adr/0003-reliable-worker-command-delivery.md)。

## 已确认安全策略

1. **启动前在线复核。** 每次新的集群副作用启动前，Worker 向 Server 核验当前主体、任务/会话/Worker 范围及撤权状态。断网、超时或核验失败均不启动新的集群工作；不使用离线租约。经本地鉴权的独立宿主操作不依赖集群复核。
2. **认证信任根。** Server 持有持久的非对称签名私钥；Worker 仅在经认证的入群流程中固定 Server 公钥，持久化 keyId/信任记录。轮换须走经认证的更新与交叠退役流程；命令帧自带的新公钥不可信。Worker 注册 bearer 不能兼作签名密钥。
3. **旧数据与备份。** 无法核验授权主体与范围的历史待执行命令不得自动恢复，也不能在不重新核验主体的情况下补签。备份恢复显式进入对账模式：新执行与 outbox 外发均暂停，由有权限的操作员核对、迁移或放弃待办后解除；正常断网不自动进入对账模式。恢复旧信任记录及撤权状态必须防止回滚。

此三项仅是实施策略，不是 L1 残余风险书面接受；协调入口仍保持 FAIL。

## 首条纵向链路及不变量

从 `session.enqueue` 的已认证用户与 Session/Task/Worker 授权开始，在 Server 命令持久化事务里保存不可变签发依据（主体及 authVersion、目标 Worker、任务/会话/Workspace、命令类型/摘要、签发与失效时间、签名 keyId），再投递到持久 transport outbox。Worker 在任何 `validate()` 或本地副作用前验签、核对命令摘要与受众，原子保存来源与可复核依据；排队 Turn 在实际 claim/launch 前在线复核权限，重启路径同样复核。签收回执与真正启动不是同一时点。撤权与启动并发的线性化/有界窗口须明确，不能一次复核后无限等待。

注意 `apps/server/src/application/server-service.ts` 的 `sentByAccountId`、审计管理员兜底与 `apps/server/src/application/ports/server-store-types.ts` 的旧 PendingCommand 都不是可直接重构历史主体的授权证据。`apps/server/src/worker-ws/transport-store.ts` 已持久序列化载荷：仅在新 deliverable 上签名不能修复旧 outbox。`apps/worker/src/application/runtime.ts` 的 command 验证必须先于可能产生副作用的 validate；队列记录与命令签收要保留同源依据；`initialize()` 的 provisioning 恢复和普通 queue 恢复均不能把旧 cluster 项视作 local。独立宿主走已认证的 `executeLocal()`，不能伪造 cluster 断言。

## 分步交付，不以局部代替整票

1. 协议版本与持久信任根、密钥轮换/升级次序和出站旧帧盘点；先建立受控 `session.enqueue` tracer 的认证签发与验签负例。
2. 通过 Server PendingCommand 与已序列化 outbox 到 Worker 接收/持久队列的真实正向链路；合法集群命令不被 blanket 拒绝，缺断言/签名伪造/错受众/过期在协商强制模式下拒绝。
3. 在线新鲜度复核与撤权并发语义，覆盖延迟 Turn、重启、离线、provisioning 和所有其余命令种类，取消/审批在副作用前检查。
4. 旧帧及旧队列显式迁移或隔离，备份对账启动与有权限的解除方式；反例覆盖进程、Workspace 变更及 outbox 外发数，部署升级和回滚演练。

在前述每一步之前和之后，`GET /api/teams/:id/coordination/availability` 继续显示 FAIL；票 03 只能重新探测，票 04 仍由人工完成书面残余风险接受与开门授权。任何局部 tracer 都不得宣称已完成票 02。
