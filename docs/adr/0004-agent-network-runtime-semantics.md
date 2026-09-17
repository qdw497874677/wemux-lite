# Agent Network runtime semantics

Wemux Agent Network 采用 Server 编排而非 Agent 或 Worker 横向直连。父 Invocation 可以在实际用户授权范围内，经 Server 鉴权、路由和审计后创建独立的子 Session 或 Invocation；执行链记录 `parentInvocationId`、发起 Agent、目标 Agent 与用户身份，结果以结构化 Tool Result 返回父 Invocation。首版可以仅支持人工编排，但后续自动委托必须沿用同一边界。

委托权限只能收窄。子 Invocation 的有效权限是发起用户、父 Invocation 授权范围、目标 Agent、目标 Worker和目标 Workspace 权限的交集。跨 Project 委托默认禁止，Agent 不得自行扩大 Workspace、Secret、Shell、网络或文件权限。

Worker 为每个持久化 Event 分配 Session 内单调递增的 `sessionSequence`，持久化后才同步给 Server。Server 保存最后连续 cursor、检测缺口，并在重连后请求补传。partial delta 只用于实时体验，可以合并、限速或在背压时丢弃；非 partial Event 必须持久化和可重放，每个 Invocation 恰好一个持久化终态。

Worker 离线时，用户可以明确创建可取消、可过期的 `queued_for_worker` 调用；恢复投递仍使用原 `invocationId`。系统必须区分 `queued_for_worker`、`delivered`、`accepted`、`running` 和终态，危险操作可以禁止离线排队。Session 不做透明跨 Worker 故障转移；用户只能等待、Fork，或执行未来定义的显式迁移。
