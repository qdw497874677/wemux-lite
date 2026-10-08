# 03: 旧调用方改造与无 Task 旁路移除

**What to build:** 旧根前端与旧 Worker 工作台改用合法 Task Session 创建与发送；验证转换后移除无 Task 兼容业务旁路，且旧调用方功能不回退。

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] 旧调用方通过合法 Task Session 完成创建与发送
- [ ] 旁路移除前有转换验证证据
- [ ] 旁路移除后旧调用方功能不回退
- [ ] 移除后不存在可绕过的无 Task 路径（负例断言）
- [ ] 断言与截图作为证据留存
