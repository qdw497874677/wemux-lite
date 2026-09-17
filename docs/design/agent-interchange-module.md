# Agent 互操作模块设计

状态：P0 协议基线。目标是为 Pi、OpenCode、Claude Code 及后续 Coding Agent 提供一个职责单一、ADK 兼容的执行 Module。该 Module 输出的 `@wemux/agent-interchange` `AgentEvent` 是 Worker 面向本地 Web 与 Server 的唯一公共 Wemux ADK Profile；二者只允许使用不同传输封装，不得各自定义对话模型。`AgentTurnEvent`/`AgentSignal` 只属于 Worker 内部 Provider seam，`SessionEventPayload`/`JournalEvent` 只属于持久化与 UI 投影，transport v2 只增加可靠交付字段。Project、Workspace、Worker、Task 与权限治理使用独立的非对话 Management API。

## 1. 决策

采用一个外部 Seam、三个内部模块：

```text
WorkerRuntime
    │ 只依赖 AgentRunner
    ▼
┌───────────────────────────────────────────────┐
│ Agent Interchange Module                      │
│                                               │
│ AgentRunner                                   │
│ - run(request): AsyncIterable<AgentEvent>     │
│ - command(request): Promise<void>             │
│ - resolveApproval(request): Promise<void>     │
│ - close(): Promise<void>                      │
│                                               │
│ internal:                                     │
│ - SessionPool：复用、互斥、generation、回收  │
│ - SessionStore：ADK Session/Event 持久化端口  │
│ - ProviderAgent：Pi/OpenCode 原生协议适配     │
└───────────────────────────────────────────────┘
```

外部调用方不直接操作 Provider 进程、不管理 Session 租约，也不拼装 `InvocationContext`。这样复杂度不会泄漏到 `WorkerRuntime`。

## 2. 单一职责

本 Module 唯一职责：

> 在一个已确定的产品 Session 中执行一次 Agent invocation，并输出可重放的 ADK 兼容 Event 流。

它负责：

- 将产品 Session 绑定转换成一次 invocation。
- 保证同一 Session 同时最多一个活动 invocation。
- 打开、恢复、复用和回收 Provider 原生会话。
- 把 Provider 输出标准化为 ADK 兼容 Event。
- 保证每次 invocation 恰好一个终态。
- 将非 partial Event 交给 SessionStore 持久化。
- 把取消、命令和批准路由到当前 invocation；批准决定以 `invocationId + approvalId` 关联，超时或断线不自动批准。

它不负责：

- HTTP、WebSocket、Worker 注册和 Server 重连。
- Team、Project、Workspace、Task、Run、Review 权限和状态机。
- UI DTO、Journal 页面投影和文案。
- 安装或认证 Pi、OpenCode、Claude Code。
- 任意 shell 执行或远程下发 executable/argv。

删除此 Module 后，Session 互斥、Provider 生命周期、事件标准化和终态保证会重新散落到多个调用方，因此它是深 Module，不是转发层。

## 3. 外部 Interface

第一版外部 Interface 保持小而完整：

```ts
interface AgentRunner {
  run(request: RunRequest): AsyncIterable<AgentEvent>
  command(request: CommandRequest): Promise<void>
  resolveApproval(request: ApprovalDecision): Promise<void>
  close(): Promise<void>
}
```

`run` 接收完整 invocation 输入，不返回需要调用方释放的租约。异步迭代结束即表示该 invocation 已完成清理。调用方只消费 Event。

### 3.1 RunRequest

包含：

- `appName`：ADK application 名称。
- `userId`：调用主体；本地单机模式也必须显式提供稳定值。
- `sessionId`：产品 Session ID，同时作为 ADK Session key 的一部分。
- `agentKey`、`modelId`、`cwd`：不可在 invocation 中途改变的绑定。
- `invocationId`：一次 ADK invocation 的稳定身份，同时作为对话调用幂等键和 Event 关联 ID；网络重发不得重新生成。
- `message`：用户 Content。
- `resume`：Worker 私有 Provider 原生会话引用。
- `launchContext`：本次操作授权与资产快照。
- `configurationFingerprint`：决定运行时实例能否安全复用。

### 3.2 AgentEvent

字段与 Google ADK Event 语义对齐：

- `id`
- `invocationId`
- `author`
- `content`
- `actions`
- `partial`
- `timestamp`
- `customMetadata`

Wemux 状态放在 `customMetadata.wemux` 中；Provider 私有数据放在 `customMetadata.provider` 中。公共 Event 不暴露 Pi RPC 或 Claude stream-json 原始记录。

终态通过 `customMetadata.wemux.terminal` 表示：`completed | failed | cancelled`。每个 invocation 恰好一个终态 Event。partial Event 可流式输出但不进入持久历史；非 partial Event 由 Runner 追加至 SessionStore。

## 4. ADK 兼容级别

公共契约命名为版本化的 **Wemux ADK Profile**，当前标识为 `wemux.adk.v1`，常量定义在 `@wemux/domain`，由 transport 握手引用而不是重新定义。其 wire schema 由 Wemux 独立维护，不直接采用某个 `@google/adk` 版本的内部序列化格式；但核心字段必须保持可无损映射。

事件转换链固定为单向链路：

```text
Provider 原生事件
  → Worker 内部 AgentSignal / AgentTurnEvent
  → @wemux/agent-interchange AgentEvent（唯一公共执行契约）
  → SessionEventPayload / JournalEvent（持久化与 UI 读模型）
  → transport v2 data frame（可靠交付封装）
```

禁止从 Journal 反推另一套 Agent Event，也禁止把 `deliveryEpoch`、`directionSeq`、ACK 或连接状态写入 Agent 语义。

“兼容”分三层，避免宣称不真实的 SDK 互换：

1. **语义兼容**：Session key、Invocation、Event、Content、EventActions、partial/non-partial 持久化规则与 ADK 对齐。
2. **结构兼容**：公共 TypeScript 类型可无损映射到 `@google/adk` 的 `Session`、`Event`、`BaseSessionService`、`BaseArtifactService` 核心字段。
3. **SDK 适配**：提供可选 Adapter 把本地 `SessionStore` 映射为 ADK `BaseSessionService`，或把 ADK `BaseAgent.runAsync()` 包成 `ProviderAgent`。

核心包不直接依赖 `@google/adk`。原因：Worker 的生产依赖必须最小；Pi/Claude 是本机 CLI 协议，不应为类型兼容强制引入完整 ADK SDK。只有真正接入 ADK Agent 时，才在独立可选包增加 SDK 依赖。

## 5. 内部 Seam

### 5.1 ProviderAgent

这是唯一 Provider 变化点：

```ts
interface ProviderAgent {
  readonly key: AgentKey
  detect(): Promise<AgentCapability>
  openSession(input: ProviderSessionOpenInput): Promise<ProviderSession>
}
```

`ProviderSession` 只表达 Provider 原生会话能力：执行、命令、批准、关闭。它不持久化 ADK Session，不知道 Project/Workspace/Task，也不发送 Server 协议消息。

P1 首批真实 Adapter 基线为 Pi 与 OpenCode，因此该 Seam 必须以两者的能力差异完成验证。Claude Code 保留现有兼容能力，但不作为 P1 主验收目标。测试使用协议桩，不再增加一个只会透传的“通用 CLI Adapter”。

### 5.2 SessionPool

只负责生命周期：

- Session 级串行化。
- fingerprint 不变时复用。
- generation 隔离迟到事件。
- TTL 与最大空闲数量回收。
- fault 后关闭再替换。

它不解析 Provider Event，不持久化对话，不做权限决策。

### 5.3 SessionStore

采用 ADK Session Service 的最小子集：

```ts
interface SessionStore {
  getOrCreate(request: SessionKey & { state?: Record<string, unknown> }): Promise<AgentSession>
  get(request: SessionKey): Promise<AgentSession | undefined>
  appendEvent(request: { session: AgentSession; event: AgentEvent }): Promise<AgentEvent>
  delete(request: SessionKey): Promise<void>
}
```

第一版 SQLite Adapter 复用 Worker Store；测试使用内存 Adapter。列表和分页不是执行 Module 的必要能力，不进入外部 Interface，需要时由管理查询 Module 提供。

## 6. Provider Adapter 规则

Pi 与 OpenCode Adapter 必须满足同一合同；Claude Code 兼容 Adapter 也遵守同一基础约束：

- `execute` 只能在空闲 Session 上调用。
- Event 必须携带当前 invocationId。
- Provider 原生 session ID 只作为内部恢复引用及 metadata，不成为客户端句柄。
- `stop` 幂等，只中断当前 invocation。
- stream 提前关闭、解析失败、进程退出均转换成一个 failed 终态。
- Adapter 不直接写 SQLite、不调用 Server transport、不创建产品 Session。
- 原始 JSONL/RPC 解析和事件映射留在 Adapter 内部。

Pi 可复用常驻 RPC 进程；OpenCode 当前按 invocation 执行 `opencode run --format json` 并用 `--session` 恢复。外部 Interface 不暴露这一区别。

P1 能力必须由 `AgentCapability.runtime` 显式报告，而不是由 UI 按 Agent 名称猜测。当前验证矩阵：

| 能力 | Pi | OpenCode |
| --- | --- | --- |
| resume | 支持，原生 session file | 支持，`sessionID` / `--session` |
| tool lifecycle | 支持 | 支持 |
| approval | 支持 RPC approval response | CLI JSON 模式不支持，必须报告 false |
| usage | 当前未标准化报告 | 支持，聚合 step token/cache/cost |
| cancel | 支持，abort + 有界进程回收 | 支持，SIGTERM 后 1 秒升级 SIGKILL |
| structured output | 当前公共 Profile 未开放 | 当前公共 Profile 未开放 |
| runtime commands | `compact`、`set_model`、`set_thinking_level` | 无；停止通过 invocation cancel |

不支持的能力必须 fail closed；例如 OpenCode 不得伪造 approval 响应或向 UI 暴露不可执行命令。

## 7. 与现有代码的迁移

现状中的 `RuntimeSessionAdapter`、`AgentRuntimeSession` 和 `RuntimeSessionManager` 已接近内部结构，但 Seam 泄漏给 `WorkerRuntime`。迁移顺序：

1. 在 `packages/agent-interchange` 定义零运行时依赖的兼容类型与 `AgentRunner` Interface。
2. 将 `RuntimeSessionManager` 收入 Runner implementation，调用方不再获取/释放 lease。
3. 将现有 Pi/OpenCode runtime-session adapter 保持在 `ProviderAgent` 内部 Seam；Claude Code 作为兼容 Adapter。
4. 增加 Worker SQLite `SessionStore` Adapter；非 partial Event 在 Runner 内先持久化再 yield。
5. `WorkerRuntime` 只调用 `runner.run()` 并将 `AgentEvent` 映射到现有 Journal；过渡期保留一个单向 mapper。
6. 删除 `LegacyRuntimeSessionAdapter` 和旧 `startTurn` 双状态机。

迁移期间不得长期并存两套 Session 生命周期。过渡 Adapter 只允许从旧接口指向新 Runner，并设置删除门禁。

## 8. 测试面

测试只穿过 `AgentRunner` 外部 Interface，Provider 使用真实子进程协议桩，SessionStore 使用内存或 SQLite Adapter。

必须覆盖：

- 连续两次 invocation 复用同一 Pi 进程且 Session 历史连续。
- OpenCode 按轮进程恢复时对调用方保持同一语义。
- 同 Session 并发被拒绝或排队，不出现两个活动 invocation。
- 不同 Session 不串 Event、native session、批准或错误。
- partial Event 被流式返回但不持久化；背压时允许合并、限速或丢弃；非 partial Event 按 `sessionSequence` 顺序持久化并可重放。
- 正常、取消、解析错误、进程崩溃都恰好一个终态。
- fault generation 的迟到 Event 不能进入替代 Session。
- fingerprint 改变时旧 Provider Session 完全关闭后再打开。
- command/approval 只能路由到匹配的活动 invocation。
- ADK 映射往返不丢失核心字段。

## 9. 明确拒绝

- 不把 `WorkerRuntime` 改名为 Runner。
- 不让 Agent Module 理解 Task/Run/Review。
- 不把 SQLite、WebSocket、HTTP client 塞进 Provider Adapter。
- 不为了“插件化”暴露 spawn、argv、env 或原始 JSON parser。
- 不创建 Agent、Runner、SessionManager、EventBus 四个同样浅的公开 Interface。
- 不宣称 Pi/OpenCode/Claude Code 本身实现了 Google ADK；它们是可映射到 ADK 执行语义的 Provider Adapter。

## 10. 参考基线

设计核对 Google ADK JS 当前公开合同：

- `BaseAgent.runAsync(parentContext): AsyncGenerator<Event>`
- `Runner.runAsync(...)` 负责 Session 获取、Event 处理与持久化
- `BaseSessionService.createSession/getSession/listSessions/deleteSession/appendEvent`
- `Session { id, appName, userId, state, events, lastUpdateTime }`
- `Event { invocationId, author, actions, partial, ... }`

参考源码：

- https://github.com/google/adk-js/blob/main/core/src/agents/base_agent.ts
- https://github.com/google/adk-js/blob/main/core/src/sessions/base_session_service.ts
- https://github.com/google/adk-js/blob/main/core/src/sessions/session.ts
- https://github.com/google/adk-js/blob/main/core/src/events/event.ts
