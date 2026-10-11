# 接受验收：Worker 命令帧授权校验（票据 02）

日期：2026-10-12
范围：`packages/wire-protocol` 命令断言合同、Server 全部有副作用命令的签发与在线复核端点、Worker 收帧/恢复/启动边界的 fail-closed 校验与审计。
结论：**已实现并已在干净实例验证**。票据 `.scratch/web-next-coordination-closure/issues/02-command-frame-authorization.md` 的 10 条验收项全部满足；负例断言原始输出留存在 `/tmp/wemux-t02-evidence/`（不入库）。

## 变更要点

- **断言合同（v3）**：`packages/wire-protocol` 的 `EnqueueAuthorization` 升到 `version: 3`，新增 `kind`（绑定命令类型）并把会话类范围字段放宽为可空，覆盖无会话命令（`workspace.provision`、`connector.*`）。新增 `WORKER_COMMAND_KINDS`、`requiresCommandAssertion`、`assertionVersionAccepted`（enqueue 接受 1|3、approval 接受 2|3、其余仅 3）、`assertionScopeMatches`（按命令类型绑定 sessionId/workspaceId/projectId）。合入集成分支后同步覆盖新增的 `session.attachment.deliver`（附件投递，会话范围）。v1/v2 字节布局冻结不变，旧断言仍可验签。
- **Server 签发全覆盖**：`workspace.provision`（创建与重指派）、`session.create`、`session.enqueue`、`session.cancel-queued`、`session.delete`、`turn.stop`（含成员撤销、账号停用/删除、Run 取消三类来源）、`runtime.command`、`runtime.approval.resolve`、`connector.definition.sync`、`connector.test` 全部经 `issueCommandAssertion` 签 v3 断言。既有严格规则不变：有签名能力而无主体时 403 `enqueue_actor_required`，有主体而无签名能力时 503 `enqueue_signing_unavailable`；撤销类停止命令在主体不可用或签名缺失时降级为不签名但照常下发（停止本身是撤销语义的一部分）。
- **在线复核端点通用化**：`authorizeEnqueueLaunch` 从 enqueue/approval 扩到全部签名类型，校验受众、版本矩阵、范围绑定、摘要、主体活跃与 authVersion、Worker 未撤销；`session.enqueue`/`runtime.approval.resolve`/`session.create`/`runtime.command` 走会话写权限与任务可变检查，`workspace.provision` 走工作区存在、放置归属与项目贡献者（operator 兜底），其余类型做基础检查。`refreshPendingApproval` 接受 v2|v3 并按原版本重签。
- **投递阻断**：`WorkerService.deliverable` 在签名能力已配置时不再投递任何无断言的有副作用命令（此前仅拦 enqueue/approval），未清理的旧数据不会被执行或外发。
- **Worker fail-closed**：`runtime.command()` 的入口门从 enqueue/approval 两类扩展到全部集群命令与未知类型：未知类型记 `unknown_command_kind`，缺断言记 `authorization_missing`，验签/受众/范围/有效期失败记 `authorization_invalid`/`authorization_expired`，回执统一为通用文案 `Command authorization unavailable`（不泄露内部细节），原因码经 `appendAuthorizationDenial` 持久化到 worker.sqlite 的 `authorization-denials` 桶（幂等）。历史上未签名的持久记录不得被同 commandId 的签名帧替换。
- **启动边界统一**：排队 Turn 启动（`schedule → run → claimNext → execute`，既有）之外，`workspace.provision` 的新启动、`initialize()` 恢复、`connected()` 重试共用同一启动门：持久断言按启动语义复验 + 在线 `authorize-launch` 复核，离线或被拒则暂缓并做有界退避（250ms 起步、至多 4 次、上限 2s），恢复后自动重试。本地宿主命令（`executeLocal`）不要求集群断言，独立操作不受影响。
- **验收拒绝中的撤权并发**：审批解析在原生适配器锁内与待定日志读取前都重做在线复核（既有），本票把入口门扩到全部类型后，恢复路径与重复投递也复用同一判定时点；已执行命令只去重（`payloadFingerprint` 冲突即 `conflicting-command`），不重复执行原生副作用。

## 测试与证据

可重复验证（本机 2026-10-12，TMPDIR 指向磁盘目录）：

```bash
npm run build:packages
npm run typecheck
TMPDIR=/var/tmp/<dir> node --import tsx --test packages/wire-protocol/src/command-authorization.test.ts
TMPDIR=/var/tmp/<dir> node --import tsx --test apps/worker/test/command-frame-authorization.test.ts
TMPDIR=/var/tmp/<dir> node --import tsx --test apps/server/src/test/command-frame-signing.test.ts
TMPDIR=/var/tmp/<dir> npm test --workspace @wemux/worker
TMPDIR=/var/tmp/<dir> npm test --workspace @wemux/server
```

真实结果：

- `npm run typecheck`：0 错误（全部 workspace）。
- wire-protocol 合同测试：5/5 通过（v1/v2 字节冻结、v3 范围矩阵、未知类型 fail-closed、版本接受矩阵）。
- Worker 负例矩阵 `apps/worker/test/command-frame-authorization.test.ts`：9/9 通过，覆盖无签名矩阵（7 类命令，无记录、无会话/工作区副作用）、篡改/错受众/错范围/过期/旧版本断言、未知类型、签名命令可执行且排队 Turn 仍需在线复核、provisioning 离线暂缓与重启恢复、恢复路径拒绝未签名与不可验签记录、历史未签名记录阻断签名重放、本地旁路、审批在线前置检查不落库。
- Server 签发测试 `apps/server/src/test/command-frame-signing.test.ts`：5/5 通过，覆盖全部签发点带 v3 断言、在线复核端点的受众/新鲜字段/主体存亡/范围分支（含删除工作区、撤销 Worker、停用主体）、无签名有副作用帧的投递阻断、连接器命令签名、会话删除补签。
- 全量：`@wemux/worker` 532 tests / 528 pass / 4 skipped（既有跳过）/ 0 fail；`@wemux/server` 964 tests / 964 pass / 0 fail（均为合入 integration/web-next-coordination-closure tip 后的复跑）。
- 既有验收回归：`apps/server/src/test/ticket06-evidence.test.ts` 11/11（审批签名与绑定、撤权后不达原生解析）通过。

证据（不入库）：`/tmp/wemux-t02-evidence/00-meta.txt`（基线 `4eb0800` 与 merge-base 一致）、`01-worker-negative-matrix.txt`、`02-wire-protocol-contract.txt`、`03-server-signing.txt`、`04-suite-summaries.txt`。

## 范围外（未做，票据亦声明）

生产混合版本升级、旧命令补签/迁移、旧备份显式对账、密钥轮换与防回滚、操作员解除流程；`workspace.delete` 仍不支持（保留拒绝）。撤销类停止命令（成员撤销、账号停用）按设计不做主体在线复核，签名在主体不可用时降级。
