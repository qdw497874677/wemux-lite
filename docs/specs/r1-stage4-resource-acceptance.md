# R1 阶段 4：资源分发与调用验收

## 已实现的纵向切片

1. `apps/e2e/resource-reconcile.test.ts` 启动真实 Server 和两个独立 Worker CLI 进程。两节点各自下载首版 Skill、上报 `installed/ready`；第一个 Worker 停机时发布第二版并重新绑定，重连后它追赶第二版，而第二个 Worker 仍使用首版。
2. ResourceSet 的 binding snapshot 明确携带 `projectId` 与 `agentKey`，wire 校验必填字段和类型。Worker 根据当前完整期望态、安装身份、revision、integrity、项目及 Agent 范围解析 Skill。断线或收到较新通知时暂停**新** Invocation 的注入，直到权威快照完成收敛；不使用本地旧期望态授予权限。重绑同一版本可复用磁盘文件，同时更新绑定身份。
3. `FilesystemAgentLaunchContextProvider` 在 WorkerRuntime 的 launch seam 将已校验的 `SKILL.md` 复制到该 Turn 的隔离目录。活跃 Invocation 的内容不随新版本切换；撤权后新 Invocation 不注入。`apps/worker/test/resource-invocation.test.ts` 通过真实 WorkerRuntime 的命令、Session/Workspace store 与伪 Agent runtime 观察 launchContext，不仅测试解析函数。
4. 文件 hash 错误不得激活、磁盘缓存内容漂移不得注入；Skill ID/revision 路径拒绝跨目录值。缓存 GC 保留 current/previous；活跃 Invocation 使用隔离副本，缓存回收不改变该副本。断线期间 fail closed 是安全优先的取舍：暂时无法验证权威期望态时不注入 Skill，不影响普通会话运行。

## 独立验收命令与结果

- `npm run build:packages && npm run typecheck`：通过。`packages/domain` 和 `packages/wire-protocol` 的快照合同先构建，再检查所有 workspace。
- `node --import tsx --test apps/worker/test/resource-materializer.test.ts apps/worker/test/resource-reconciler.test.ts packages/wire-protocol/test/resource-frames.test.ts`：17/17 通过。
- `node --import tsx --test apps/worker/test/resource-invocation.test.ts`：1/1 通过。
- `npm run build --workspace @wemux/server && npm run build --workspace @wemux/worker && node --import tsx --test apps/e2e/resource-reconcile.test.ts`：1/1 真实进程 E2E 通过。
- `npm test`：814 项 TypeScript 测试中 809 通过、5 跳过、0 失败；包测试 9/9；Web 测试 280/280。

原始目录树和脱敏真实进程验收输出保存在未追踪的 `.scratch/r1-stage4/`；测试日志位于 `/tmp/r1-s4-*.log`，不提交凭据或本地数据库。上述 E2E 的双 Worker 为真实进程；Invocation 固定与撤权由真实 WorkerRuntime 的进程内集成测试覆盖，并未宣称测试 Agent CLI/云端模型实际执行。

## 边界与后续

本切片限静态 Skill。`agent-runtime`、`model-provider` 和 Preset 的无人值守部署属于 R2/R3；自动磁盘预算和 GC 调度尚未实现（目前 GC 为可调用的安全操作，并验证 LRU/强引用行为）。断线或过时通知期间的新 Skill 注入暂不可用，待权威快照完成后恢复。后续队列以交接文档及设计文档为准，不将其计入本阶段验收。
