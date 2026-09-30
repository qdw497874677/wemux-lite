# R3 Provider 启动前绑定选择（局部完成）

Worker `ResourceReconciler.providerForLaunch(projectId, agentKey, modelId)` 可从**当前且已确认新鲜**的 ResourceSet 为 `provider::model` 精确选择一个非秘密 Provider 绑定，优先 Project 绑定于全局绑定、精确 Agent 绑定于泛绑定。同优先级多条冲突直接拒绝；选中绑定的内容 hash、Agent 映射及 locator 在启动前重验，缺失/撤销/不可解密的凭据、断线或并发期望态变更均 fail closed，不降级至全局绑定；异步凭据解析跨过断线再重连同一 revision 时也以连接 epoch 拒绝旧选择。此选择器尚未绑定子进程启动，凭据解析与轮换间的原子租约仍是后续进程级实施门槛。只返回 resourceId、revisionId、bindingId、providerKey 和模型 ID，不返回密钥。测试覆盖作用域、冲突、hash 篡改、撤权、异步解密时断线以及 SQLite/report 不含 Secret。

**该选择器还没有接入 `WorkerRuntime` 的 Session/Agent 启动路径。** 它不物化 Pi 模型配置、不注入子进程、不认证远端 endpoint，也不改变 `credential-required` 报告。下一切片须将选择器与 Session 的 Project/Agent/model 合同及受信 Pi 进程生命周期相连，复核同进程多 Turn 的轮换/撤销；安全门槛见 `docs/design/r3-pi-provider-process-materialization.md`。未授权真实模型调用，不声称 Provider `ready`。

验证：`node --import tsx --test --test-name-pattern='Provider launch selection' apps/worker/test/resource-reconciler.test.ts` 通过，`npm run typecheck` 通过；完整 `npm test` 再次通过（Node 845 tests / 839 pass / 0 fail / 6 skipped；package 10 pass；Web 291 pass），最新日志 `/tmp/wemux-final-full-test-current-2.log`；`npm run typecheck` 通过，日志 `/tmp/wemux-typecheck-final-current.log`。资源 E2E 的注册 Token 偶发以减号开头问题已另行修复，不影响本切片的待接入状态。
