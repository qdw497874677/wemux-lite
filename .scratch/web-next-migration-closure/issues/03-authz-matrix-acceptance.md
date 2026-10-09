# 03: 授权交叉矩阵、全链路与迁移签收

Status: ready-for-agent
Blocked by: [01](01-bypass-survey-ledger.md)、[02](02-remove-bypass.md)、[跨 Runtime 交接闭环分项 A](../../web-next-plan-handoff/issues/02-cross-runtime-loop-acceptance.md)、[协作界面验收](../../web-next-collaboration-surfaces/issues/03-connector-channel-acceptance.md)、[双宿主验收](../../web-next-dual-host/issues/02-local-host-enrollment-acceptance.md)对应范围完成并签收；依 D5，本次整体验收还需交接闭环分项 B 持续推进、[派发与容量验收](../../web-next-task-dispatch/issues/02-capacity-team-board-acceptance.md)、[任务管理可替换合同](../../web-next-task-dispatch/issues/01-placement-claim-dispatch.md)及[单 Worker loop-out 完整链路](../../web-next-runtime-topologies/issues/01-topology-contract-and-tracer.md)的真实签收。矩阵准备和原范围测试可先行，不等待上述整批完成。

**Spec:** [迁移收口与旧版移除条件](../spec.md)
**合并来源:** `43966aa` 的原票 04、05。
**What to build:** 完成跨页、跨宿主、跨 Runtime 的授权交叉矩阵与桌面手机全链路，在同候选核对 NEXT-15，形成“旧版可删除”的候选结论或未完成清单。实际删旧版与切根仍只在[切根 ticket](../../web-next-cutover/issues/02-go-no-go-cutover.md)人工确认后执行。

## 实现计划

1. 从 01 的登记表构建权限 × 页面/宿主/Runtime 的读写、下载、终端、外发矩阵；新增调度/自主推进/运行形态覆盖另列，不混入旧完成数。
2. 同候选真实浏览器桌面/手机跑授权、撤权、失联与恢复，复用三 e2e 并记录未覆盖点。
3. 按已确认 D5 引用持续推进、任务管理可替换、派发/容量/重新分配及 loop-in/单 Worker loop-out 的真实签收；原范围证据可先记录，但新增能力未过不签收本次整体迁移，不给新版整体可删除/切换结论。
4. 完成矩阵后转人工验收，任何签收都不自动授权删旧。

## 授权矩阵与全链路

- [ ] 矩阵覆盖权限 × 页面/宿主/Runtime，含撤权与删除后的过滤
- [ ] 每个交叉点有断言或截图证据
- [ ] 桌面视口全链路通过
- [ ] 手机视口全链路通过（不安全上下文约束遵守）
- [ ] 未覆盖交叉点如实标注

矩阵须涵盖读取、写入、下载、终端与外部投递，不因合并而缩减权限面。

## 同候选验收

- [ ] typecheck 与 server / worker / web-next 测试同候选全绿
- [ ] 三个 e2e 同候选退出码 0
- [ ] NEXT-15 验收条件逐项核对：逐操作迁移、跨页/宿主/Runtime、桌面手机、旁路移除验证
- [ ] 给出范围明确的迁移结论或未完成清单；新版整体可删除还需已确认 D5 全部能力签收，不代替切根授权
- [ ] 脱敏验收摘要入 `docs/acceptance/`，原始证据留 `.scratch/`
- [ ] 未过项如实标注，不勾选整票

## 人工关闭门

矩阵和同候选证据准备完成后，将本票 `Status:` 改为 `ready-for-human`；用户审阅并确认前，不关闭本票、不认定迁移 spec 验收通过、不勾选 NEXT-15。记录签收人、候选、证据与结论；即使通过，也不构成切根或其他破坏性操作授权。
