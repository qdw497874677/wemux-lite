# 03: 授权交叉矩阵、全链路与迁移签收

Status: ready-for-agent
Blocked by: [01](01-bypass-survey-ledger.md)、[02](02-remove-bypass.md)、[跨 Runtime 交接闭环](../../web-next-plan-handoff/issues/02-cross-runtime-loop-acceptance.md)、[协作界面验收](../../web-next-collaboration-surfaces/issues/03-connector-channel-acceptance.md)、[双宿主验收](../../web-next-dual-host/issues/02-local-host-enrollment-acceptance.md)全部完成。

**Spec:** [迁移收口与旧版移除条件](../spec.md)
**合并来源:** `43966aa` 的原票 04、05。
**What to build:** 完成跨页、跨宿主、跨 Runtime 的授权交叉矩阵与桌面手机全链路，在同候选核对 NEXT-15，形成“旧版可删除”的候选结论或未完成清单。实际删旧版与切根仍只在[切根 ticket](../../web-next-cutover/issues/02-go-no-go-cutover.md)人工确认后执行。

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
- [ ] 给出旧版可删除结论或未完成清单（含责任票）
- [ ] 脱敏验收摘要入 `docs/acceptance/`，原始证据留 `.scratch/`
- [ ] 未过项如实标注，不勾选整票

## 人工关闭门

矩阵和同候选证据准备完成后，将本票 `Status:` 改为 `ready-for-human`；用户审阅并确认前，不关闭本票、不认定迁移 spec 验收通过、不勾选 NEXT-15。记录签收人、候选、证据与结论；即使通过，也不构成切根或其他破坏性操作授权。
