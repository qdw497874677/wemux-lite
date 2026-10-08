# 04: Phase 3 同候选签收

**What to build:** 在固定候选上重跑全部测试与端到端验证，核对 NEXT-06、NEXT-08 的整票验收条件，输出可复查的签收记录；未过项如实登记为缺口与责任票。

**Blocked by:** 03

**Status:** ready-for-human

- [ ] `npm run typecheck` 与 server / worker / web-next 测试同候选全绿
- [ ] 三个 e2e 同候选退出码 0（协调入口、重连配对、写通道探针）
- [ ] NEXT-06 验收条件逐项核对：revision 批准、授权幂等一致交接、讨论继续可用
- [ ] NEXT-08 验收条件逐项核对：各 Runtime 同一流程、差异明示、真实执行验证
- [ ] 脱敏验收摘要入 `docs/acceptance/`，原始证据留 `.scratch/`
- [ ] 未过项如实标注为未完成，登记缺口与责任票，不勾选整票
