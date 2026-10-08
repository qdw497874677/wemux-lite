# 02: 旧调用方改造与无 Task 旁路移除

Status: ready-for-agent
Blocked by: [01](01-bypass-survey-ledger.md) 的旁路勘察与调用方转换清单完成；旧 Worker 调用方转换还需[双宿主 02](../../web-next-dual-host/issues/02-local-host-enrollment-acceptance.md)的本地 Task Session 能力可用并验证。迁移全链路验收另需完整迁移登记表。

**Spec:** [迁移收口与旧版移除条件](../spec.md)
**合并来源:** `43966aa` 的原票 03（仅重编号）。
**What to build:** 旧根前端与旧 Worker 工作台改用合法 Task Session 创建与发送；验证转换后移除无 Task 兼容业务旁路，且旧调用方功能不回退。保留“先转换并验证、再移除”的顺序，不在本票删除旧版。

## 验收

- [ ] 旧调用方通过合法 Task Session 完成创建与发送
- [ ] 旁路移除前有转换验证证据
- [ ] 旁路移除后旧调用方功能不回退
- [ ] 移除后不存在可绕过的无 Task 路径（负例断言）
- [ ] 断言与截图作为证据留存
