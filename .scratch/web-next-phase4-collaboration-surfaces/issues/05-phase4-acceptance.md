# 05: Phase 4 同候选签收

**What to build:** 在固定候选上重跑测试与 e2e，核对 NEXT-09、NEXT-10、NEXT-12 的整票验收条件，重跑写通道矩阵确认"其余通道全拒绝"，输出签收记录。

**Blocked by:** 03、04

**Status:** ready-for-human

- [ ] typecheck 与 server / worker / web-next 测试同候选全绿
- [ ] 三个 e2e 同候选退出码 0，写通道矩阵重跑结论更新
- [ ] NEXT-09 / NEXT-10 / NEXT-12 验收条件逐项核对
- [ ] 桌面与移动端主要流程真实浏览器验收通过
- [ ] 脱敏验收摘要入 `docs/acceptance/`，原始证据留 `.scratch/`
- [ ] 未过项如实标注，登记缺口与责任票，不勾选整票
