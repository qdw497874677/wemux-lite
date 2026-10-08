# 05: Phase 6 同候选签收

**What to build:** 在固定候选上重跑测试与 e2e，核对 NEXT-15 的整票验收条件，给出"旧版可删除"的明确结论或未完成清单。

**Blocked by:** 04

**Status:** ready-for-human

- [ ] typecheck 与 server / worker / web-next 测试同候选全绿
- [ ] 三个 e2e 同候选退出码 0
- [ ] NEXT-15 验收条件逐项核对：逐操作迁移、跨页/宿主/Runtime、桌面手机、旁路移除验证
- [ ] 给出旧版可删除结论或未完成清单（含责任票）
- [ ] 脱敏验收摘要入 `docs/acceptance/`，原始证据留 `.scratch/`
- [ ] 未过项如实标注，不勾选整票
