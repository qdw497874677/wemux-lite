# 02: 跨 Runtime 闭环与阶段签收

Status: ready-for-agent
Blocked by: [01](01-plan-approval-and-handoff.md)。

**Spec:** [计划修订、批准与交接](../spec.md)
**合并来源:** `43966aa` 的原票 03、04。
**What to build:** pi / claude / opencode 以各自入口完成查询、交接、执行、报告；至少一个有效 Runtime 以本地或免费模型真实跑通。同候选复核 NEXT-06、NEXT-08 并准备人工签收，不再另设签收票。

## 跨 Runtime 闭环

- [ ] 至少一个有效 Runtime 真实执行完成查询 → 交接 → 执行 → 报告，证据含命令与输出
- [ ] 同一流程在其余有效 Runtime 上以各自入口执行，差异（能力、入口形态、认证）明示
- [ ] 执行失败或取消在协调上下文可见并带原因
- [ ] 交接与启动过程留审计记录（主体、目标、revision、来源）
- [ ] 未覆盖项与限制如实标注，不冒充已覆盖
- [ ] 不调用付费模型；使用本地或免费模型

## 同候选验收

- [ ] `npm run typecheck` 与 server / worker / web-next 测试同候选全绿
- [ ] 三个 e2e 同候选退出码 0（协调入口、重连配对、写通道探针）
- [ ] NEXT-06 验收条件逐项核对：revision 批准、授权幂等一致交接、讨论继续可用
- [ ] NEXT-08 验收条件逐项核对：各 Runtime 同一流程、差异明示、真实执行验证
- [ ] 脱敏验收摘要入 `docs/acceptance/`，原始证据留 `.scratch/`
- [ ] 未过项如实标注为未完成，登记缺口与责任票，不勾选整票

## 人工关闭门

实施和证据准备完成后，将本票 `Status:` 改为 `ready-for-human`；用户审阅并确认签收前，不关闭本票或 Phase 3、不勾选 NEXT-06 / NEXT-08。记录签收人、候选、证据与结论；合并票据不取消原人工签收要求。
