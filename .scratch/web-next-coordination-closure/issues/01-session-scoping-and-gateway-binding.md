# 01: 会话级作用域与工具网关绑定强制

Status: ready-for-agent
Blocked by: 无。

**Spec:** [协调执行边界收口](../spec.md)
**合并来源:** `43966aa` 的原票 01、02。
**What to build:** 为协调 Session 配置独立 Agent home、会话工作目录及按需 Provider 环境；工具执行网关同时强制 allowedTools 与 project / workspace / worker / connector / connectorRevision / toolName 绑定。越权 fail-closed、无外部副作用并留审计。两部分是同一票的实施检查项，不再拆票。

**边界:** L1 only。home、环境变量和 cwd 作用域不构成文件系统或网络隔离，不能阻止绝对路径、`..`、符号链接或直接外联；不得宣称“已隔离”，本票不开放协调入口。

## 实现计划

1. 盘点 `apps/worker/src/agents` 全部 spawn 与热会话复用，以共同启动边界配置 home/cwd/环境；覆盖 pi、claude、opencode。
2. `ToolExecutionGateway` 在新执行和缓存结果返回前校验当前授权、allowedTools 及全部资源绑定，复用能力验证端口；审批等待结束后、实际外发前再次校验，不能沿用等待前的许可。
3. 测标记宿主变量不注入、PATH 等必要环境可用、Provider 显式注入、合法只读与管理操作、过期/撤权/旧 connector revision；最后重跑写通道探针，不开门。

## 会话级运行环境

- [ ] 协调 Session 的 Agent home/配置目录位于会话工作区内，可在进程启动边界观测到
- [ ] 进程环境只含白名单必要运行变量与该 Session 显式获权 Provider 配置，不透传其他宿主凭据环境（负例断言：注入标记变量不出现在子进程）
- [ ] Agent 进程工作目录为会话工作区，相对路径操作不落到工作区之外
- [ ] 作用域对全部有效 Runtime 的启动路径生效（pi / claude / opencode），不只是 Pi
- [ ] 普通（非协调）Session 行为不变，现有测试全绿
- [ ] 断言与命令输出作为证据留存（原始证据留 `.scratch/`，脱敏摘要入 `docs/acceptance/`）

上面的相对路径验收仅检查正常运行时配置/状态路径，不是对任意路径访问的安全保证。

## 工具网关强制

- [ ] allowedTools 之外的工具调用被拒，返回明确错误码，不执行外部调用
- [ ] 资源绑定不匹配（跨 project、跨 workspace、跨 worker、connectorRevision 过期、toolName 不符）被拒
- [ ] 伪造或过期的能力令牌被拒
- [ ] 拒绝路径不产生外部副作用（无连接器调用、无文件写入、无进程）
- [ ] 审批等待期间撤权，审批结束后不外发、不返回失权缓存结果
- [ ] 每次拒绝记录主体、操作、范围与原因码
- [ ] 合法只读查询/搜索不受影响；计划保存单列为平台管理写操作，未授权拒绝，现有 worker 测试全绿
- [ ] 负例测试与断言输出作为证据留存
