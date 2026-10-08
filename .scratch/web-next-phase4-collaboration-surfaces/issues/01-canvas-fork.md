# 01: 画布共享与 Fork 血缘

**What to build:** 会话画布按权限共享与访问；用户可在同 Task 下从固定 cursor Fork 出新会话，保留血缘；撤权后列表、血缘、缓存与实时流同步过滤，无残留可见。

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] 画布内容只对获权成员可见，未获权访问被拒
- [ ] 同 Task 下 Fork 固定 cursor，血缘可追溯
- [ ] 撤权后列表、血缘、缓存与实时流四个出口同步不可见
- [ ] Fork 不修改原会话历史
- [ ] 断言与截图作为证据留存
