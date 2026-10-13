# 接受验收：Worker 命令帧授权校验（票据 02）

日期：2026-10-12
范围：`packages/wire-protocol` 命令断言合同、Server 全部有副作用命令的签发与在线复核端点、Worker 收帧/恢复/启动边界的 fail-closed 校验与审计。
结论：**已实现并已在干净实例验证**。票据 `.scratch/web-next-coordination-closure/issues/02-command-frame-authorization.md` 的 10 条验收项全部满足；负例断言原始输出留存在 `/tmp/wemux-t02-evidence/`（不入库）。

## 变更要点

- **断言合同（v3）**：`packages/wire-protocol` 的 `EnqueueAuthorization` 升到 `version: 3`，新增 `kind`（绑定命令类型）并把会话类范围字段放宽为可空，覆盖无会话命令（`workspace.provision`、`connector.*`）。新增 `WORKER_COMMAND_KINDS`、`requiresCommandAssertion`、`assertionVersionAccepted`（enqueue 接受 1|3、approval 接受 2|3、其余仅 3）、`assertionScopeMatches`（按命令类型绑定 sessionId/workspaceId/projectId）。合入集成分支后同步覆盖新增的 `session.attachment.deliver`（附件投递，会话范围）。v1/v2 字节布局冻结不变，旧断言仍可验签。
- **Server 签发全覆盖**：`workspace.provision`（创建与重指派）、`session.create`、`session.enqueue`、`session.cancel-queued`、`session.delete`、`turn.stop`（含成员撤销、账号停用/删除、Run 取消三类来源）、`runtime.command`、`runtime.approval.resolve`、`connector.definition.sync`、`connector.test` 全部经 `issueCommandAssertion` 签 v3 断言。既有严格规则不变：有签名能力而无主体时 403 `enqueue_actor_required`，有主体而无签名能力时 503 `enqueue_signing_unavailable`；账号停用/删除的撤销类停止命令以操作主体（管理员或待删账号自身，状态变更提交前取样）签发，主体缺失、已停用或实例无签名能力时才降为不签名，而不签名帧在签名实例上不投递、Worker 收帧即拒收（fail-closed，见下方修正记录与已知限制）。
- **在线复核端点通用化**：`authorizeEnqueueLaunch` 从 enqueue/approval 扩到全部签名类型，校验受众、版本矩阵、范围绑定、摘要、主体活跃与 authVersion、Worker 未撤销；`session.enqueue`/`runtime.approval.resolve`/`session.create`/`runtime.command` 走会话写权限与任务可变检查，`workspace.provision` 走工作区存在、放置归属与项目贡献者（operator 兜底），其余类型做基础检查。`refreshPendingApproval` 接受 v2|v3 并按原版本重签。
- **投递阻断**：`WorkerService.deliverable` 在签名能力已配置时不再投递任何无断言的有副作用命令（此前仅拦 enqueue/approval），未清理的旧数据不会被执行或外发。
- **Worker fail-closed**：`runtime.command()` 的入口门从 enqueue/approval 两类扩展到全部集群命令与未知类型：未知类型记 `unknown_command_kind`，缺断言记 `authorization_missing`，验签/受众/范围/有效期失败记 `authorization_invalid`/`authorization_expired`，回执统一为通用文案 `Command authorization unavailable`（不泄露内部细节），原因码经 `appendAuthorizationDenial` 持久化到 worker.sqlite 的 `authorization-denials` 桶（幂等）。历史上未签名的持久记录不得被同 commandId 的签名帧替换。
- **启动边界统一**：排队 Turn 启动（`schedule → run → claimNext → execute`，既有）之外，`workspace.provision` 的新启动、`initialize()` 恢复、`connected()` 重试共用同一启动门：持久断言按启动语义复验 + 在线 `authorize-launch` 复核，离线或被拒则暂缓并做有界退避（250ms 起步、至多 4 次、上限 2s），恢复后自动重试。本地宿主命令（`executeLocal`）不要求集群断言，独立操作不受影响。
- **验收拒绝中的撤权并发**：审批解析在原生适配器锁内与待定日志读取前都重做在线复核（既有），本票把入口门扩到全部类型后，恢复路径与重复投递也复用同一判定时点；已执行命令只去重（`payloadFingerprint` 冲突即 `conflicting-command`），不重复执行原生副作用。

## 修正记录（2026-10-12 双轴 review）

集成分支合入后经 Standards/Spec 双轴 review 发现四处问题，已在 `t02-review-fixes` 分支修复并补测（本节同步修正本文档此前的失实描述）：

- **P0 账号停用/删除的停止命令未签名**：`AccountLifecycleService` 构造时 `commandAuthority` 接线参数从未传入，`revokeExecution` 在签名实例上签出的 `turn.stop` 恒为无断言帧，被 `deliverable` 滤掉且 Worker 拒收，停用账号停不掉在跑 Turn（安全回归）。修复：删除死参数，`revokeExecution` 直接以操作主体签发（`disable` 用管理员 actorId，`requestDeletion` 用待删账号自身，同一事务内先取样后改状态，主体仍为 active）。行为边界：主体存在且 active 时签 v3；主体缺失、已停用或实例无签名能力时降为不签名；不签名帧在签名实例上不投递、Worker 以 `authorization_missing` 终态拒收（此前文档描述的“降级为不签名但照常下发”与代码不符，已修正）。回归测试 `apps/server/src/test/account-revocation-signing.test.ts` 2/2：disable 与 requestDeletion 后待定停止命令带可验 v3 断言，且在签名/未签名两种 `WorkerService` 装配下都可投递。
- **P1a 审批断言刷新版本门不一致**：`ServerService.refreshPendingApproval` 接受 v2|v3 重签，但存储层 `refreshApprovalAuthorization` 只认 v2，v3 待定审批在窗口过期重签时会 409。修复：版本门放宽为 v2|v3，保持原/新版本必须相等的身份一致性检查（当前签发面 approval 仍为 v2，属前向兼容修复）。测试见 `apps/server/src/test/ticket06-evidence.test.ts` 新增 v3 刷新用例。
- **P1b 未签名装配下 Run 取消自撞主键**：`clusterCommandIssuer` 无签名分支插入命令后返回 undefined，`ensureRunCancel` 视作未发而裸插入同一 commandId，触发 commands 主键冲突。生产装配恒有签名能力，仅测试装配可触；修复为无签名分支照常返回命令 id。测试见 `apps/server/src/test/task-runs.test.ts` 新增未签名取消用例。
- **SessionLineageService 核查**：其构造第 4 参为 `SessionLineageAccess` 测试接缝而非签发接线，类本身不直接下发 Worker 命令，fork 目标 Session 经 `ServerService.createForkTargetInTx` 走已签名的 `session.create` 路径，无同类问题，不改。

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

Review 修复后复跑（基线 `893061f`，`t02-review-fixes`）：

- 新增用例：`TMPDIR=/var/tmp node --import tsx --test apps/server/src/test/account-revocation-signing.test.ts` 2/2；`apps/server/src/test/ticket06-evidence.test.ts` 12/12（含新增 v3 刷新用例）；`apps/server/src/test/task-runs.test.ts` 126/126（含新增未签名取消用例）。三个修复均先在未修复代码上观察到红（断言缺失、`Approval authorization identity changed`、`UNIQUE constraint failed: commands.id`）。
- 全量：`npm run build:packages` 0 错误；`npm run typecheck` 0 错误（全部 workspace）；`@wemux/worker` 532 tests / 527 pass / 5 skipped（本机环境相关的既有跳过项）/ 0 fail；`@wemux/server` 968 tests / 968 pass / 0 fail（新增 4 条用例后的全量）。

## 已知限制（断言 5 分钟有效期，Worker 离线；2026-10-13 票据 05 第 1 项更新）

原版本节记录的行为已在票据 05 第 1 项部分修正：pending 命令的断言过期现在有补签路径，终态语义不变。当前行为：

- 有效期窗口：签发时 `ASSERTION_WINDOW_MS` 5 分钟，Worker 验证为 `SIGNATURE_WINDOW_MS` 5 分钟加 `CLOCK_SKEW_MS` 30 秒。窗口剩余超过 30 秒时不会无谓重签。
- 补签路径：除既有 `runtime.approval.resolve`（`refreshPendingApproval`，行为不变）外，其余全部需断言类型的 pending 命令现在也有重签：`ServerService.refreshPendingCommandAuthorization` 在有界投递唤醒（hello/重连/新命令/应用层收据，不含纯传输 ACK）与重放阶段先走 `authorizeEnqueueLaunch` 在线复核（主体 active 且 authVersion 一致、会话/工作区权限仍满足、Worker 未撤销、摘要与受众一致），通过后以原领域身份重签（同 commandId，仅更新 issuedAt/expiresAt；存储层 `refreshCommandAuthorization` 拒绝任何其他字段变动，签名不匹配不可洗白）。重放阶段对已发送但未被 Worker 处理的过期帧做原位替换（同 directionSeq/messageId，Worker 按序号去重）；`pending()` 在不含过期帧的读取路径（`gateway.send` 直发）对过期命令帧设屏障。测试 `apps/server/src/test/command-assertion-refresh.test.ts` 9/9（集成重签投递、主体停用/Worker 撤销/会话删除负例、替换后重投、拒绝后终态回执落库）。
- 重签被拒（主体停用、权限丧失如会话已删除、Worker 已撤销、验签不通过）：不重签，按原始字节投递，Worker 终态拒收（`retryable: false`，通用文案 `Command authorization unavailable`），原因码 `authorization_expired` 经 `appendAuthorizationDenial` 持久化，无本地副作用。Server 侧收到拒绝回执后的后果不变（均为终态）：`session.enqueue` 拒绝则消息出队并通知会话，用户重发走新 commandId 新断言；Run 创建命令拒绝则 Run 置 failed，后续 enqueue 一并取消；Run 取消命令拒绝则 Run 记 `cancel_rejected` 失败，可显式重试（新 commandId）；`workspace.provision` 拒绝则放置置 failed，重试走新命令。
- 撤销类 `turn.stop`：重签同样要求操作主体仍 active；主体已停用时保持 fail-closed（终态拒绝，Turn 继续跑到自然结束；停用本身幂等，按状态判定，命令行已存在且为 rejected 不再重发；账号停用本身仍生效，登录/新命令被拒），残余风险仅是已排队的 Turn 不被截停。
- 会话不再有“断言过期即永久不可用”：`session.create` 过期后经重签正常投递即可用；仅当重签条件（主体/权限/Worker）不再满足时按诚实失败终止。
- 首次收帧时断言已过期且重签同样被拒的终态语义同上一条；已收帧落地过回执的记录按启动语义复验，容忍过期窗口（仅复验签名与身份，不新增副作用）。
- 历史已终态的旧命令（此前版本已拒绝入库的）不做补签迁移，仍按终态处理；本票只针对 pending 命令。

## 范围外（未做，票据亦声明）

生产混合版本升级、历史终态命令补签/迁移、旧备份显式对账、密钥轮换与防回滚、操作员解除流程；`workspace.delete` 仍不支持（保留拒绝）。撤销类停止命令（成员撤销、账号停用）不做主体在线复核（turn.stop 在 Worker 无 authorizeLaunch 回查，仅验签与窗口），签名主体为操作主体；无活跃签发主体或无签名能力时降为不签名，不签名帧不投递且 Worker 拒收。断言过期的离线重签路径见“已知限制”（票据 05 第 1 项已实现 pending 命令重签）。
