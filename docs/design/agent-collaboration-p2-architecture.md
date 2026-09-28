# Agent 间协作与跨主机编排架构

状态：P2 最小可用切片设计基线

日期：2026-10-01

关联路线：P2、C6 Ticket 23、A3、G48 Approvals、G49 Routines

## 0. 设计摘要

本设计以 Server 作为委派权威、授权与路由中心，以 Worker 作为 Agent 执行和 Session Journal 权威，以共享包承载稳定合同。Agent 不横向直连，委派先固化 Delegation、目标 Workspace Placement、实际用户和收窄后的权限，再经可靠 Worker Command 投递。目标 Agent 通过兼容现有 inbox 的结构化请求接受或拒绝，接受后创建独立子 Invocation；关联 Task 时同时创建 Agent Run，独立委派不伪造无 Task 的 Agent Run。结果以稳定 resultId 回投父 Session Journal。首版支持同 Project 自动委派、跨 Project 人工审批、父取消向子执行传播、离线排队、幂等去重和 ownership_unverified 恢复，并以深度、子项数、期限和 Artifact 大小构成静态预算。所有状态转换均与 transport ACK 分离，画布只投影权威关系。逐 token 预算、自动重放未知所有权执行和通用工作流编排留给 M8。

## 1. 目标、范围与现状依据

### 1.1 目标

P2 首版提供一个可审计、可取消、可恢复的 Agent 间协作闭环：

1. 父 Session 中的 Agent 或获权用户发起结构化 Delegation。
2. Server 以 A3 权限交集校验并锁定目标 Worker、Agent 与 Workspace Placement。
3. 目标 Worker 收到可靠 Command，目标 Agent 的 inbox 出现 `delegation_request`。
4. 目标 Agent 或用户接受、拒绝或让请求超时。
5. 接受后创建子 Session 与 child Invocation；有 Task 引用时复用 `Task → Run → Session`，无 Task 时使用独立 `Session → Invocation`。
6. 子执行结果以 `delegation_result` 和结构化 Journal 事件回投父 Session。
7. 父取消可幂等传播到未启动或已运行的子执行，结果由既有 Journal 事实收敛。

该闭环不要求任务看板存在，不要求会话协作画布存在，也不允许 Agent 或 Worker 直接横向连接。

### 1.2 首版范围

首版包含：

- Delegation 权威实体、状态机、CAS、幂等和审计。
- `InboxMessage` 的兼容扩展。
- 同 Worker 与跨 Worker 的目标 Placement 路由。
- 接受、拒绝、超时、离线排队、结果回投和取消传播。
- 同 Project 自动委派，跨 Project 委派进入 G48 审批聚合。
- 子执行使用既有 ToolExecutionGateway 处理高危工具审批。
- 最小 `ArtifactReference` 与 `RunAttachment` 合同。
- 启动恢复与 `ownership_unverified` 失败关闭状态。
- 委派深度、循环、背压和权限收窄。

首版不包含：

- 按 token、金额或模型价格实时扣减的预算账本。
- Agent 自主发现组织结构、自主组队或跨 Project 自动授权。
- 任意 DAG、工作流 DSL、群聊共识或多 Agent 投票。
- Worker 间 P2P、共享文件系统、透明 Session 迁移或透明重新放置。
- 在无法证明旧执行已终止时自动重跑。
- 将画布边、transport ACK 或 WebSocket 状态作为编排权威。

### 1.3 已核实的可复用积木

| 积木 | 代码事实 | P2 用法 |
|---|---|---|
| Agent 点对点消息 | `apps/worker/src/capabilities/pi-tools.ts` 已注册 `wemux_agent_send`、`wemux_inbox_list`、`wemux_inbox_read`；`apps/server/src/application/capability-service.ts` 持久化并读取 `AgentInboxMessage` | 保持现有工具可用，扩展消息判别类型，不以新协议替换普通消息 |
| Inbox 合同 | `packages/domain/src/capabilities.ts` 定义 `AgentInboxMessage` 与 `accepted | delivered | read` | 增加 message kind 与类型化 payload，旧记录按 `direct_message` 读取 |
| 统一 Agent Event | `packages/agent-interchange/src/event.ts` 定义唯一公共 `AgentEvent`；`journal-projection.ts` 单向投影到 Session Journal | 委派请求、结果和终态先成为公共事件或专用 Journal payload，不从 Journal 反推 Provider 协议 |
| Journal 权威 | Worker 持久化非 partial Event，Server 只持有投影和同步 cursor | 跨 Worker 结果必须回到父 Worker 落 Journal，Server 不直接篡写父 Journal |
| Task、Run、Session | `apps/server/src/application/task-service.ts` 通过事务创建或复用 Session、入队消息并保存不可变 Run snapshot | 有 Task 的委派复用现有 launch seam；独立委派只建 Session 与 Invocation |
| Run 取消 | `task-service.ts#cancelRun`、`run-projection.ts` 与 `docs/design/task-platform-contract-decisions.md` 已实现排队取消、启动竞态补发 stop、Journal 终态收敛 | 父取消对子 Run 调用同一取消应用接口，不另造弱化版停止逻辑 |
| A3 授权 | Project、Worker、Session Grant 和执行入口已落地，执行取权限交集 | Delegated Authority 在 dispatch 与执行前均重新求交，只能收窄 |
| 写入幂等与 CAS | Task launch 使用 `requestId + fingerprint`，Task 更新使用 version CAS，H4 使用 `requestId + fingerprint + expectedRevision` | Delegation 创建与动作沿用相同形状 |
| Workspace Placement | `packages/domain/src/workspace.ts` 与 Server Workspace 记录区分 `(workspaceId, workerId)` 的独立落点 | dispatch 时锁定目标 Placement，不以逻辑 Workspace 推断路径同步 |
| wire 可靠投递 | `packages/wire-protocol/src/transport-v2.ts`、Server/Worker transport store 已有 durable frame、outbox/inbox、ACK cursor 与去重 | Delegation Command/Event 作为既有可靠 transport 的 payload，不把 transport 状态写入领域状态 |
| H4 六态 outbox | `packages/server-domain/src/channels.ts` 定义 `pending | sending | delivered | retry_wait | dead_letter | cancelled`，`channel-outbox.ts` 提供租约、退避、死信和重放 | 只借持久排队、租约、分类失败与人工重试模式；Delegation 仍是 Worker Command，不是 webhook delivery |
| 高危工具审批 | `apps/worker/src/connectors/tool-execution-gateway.ts` 对 write/destructive 调用失败关闭并请求 approval | 子 Invocation 不绕过既有工具审批 |
| G48 与 G49 | `docs/design/feature-suite-approvals-routines-architecture.md` 已冻结审批聚合与 Routine dispatch 边界 | 跨 Project Delegation 接 G48；Routine 与 Delegation 共享 dispatch/run 创建底座但不互相依赖 |

## 2. 术语与领域边界

### 2.1 Delegation 与 handoff

**Delegation** 是父 Invocation 向目标 Agent 发起的结构化子调用。父子拥有不同 Invocation，可拥有不同 Session、Worker 和 Placement。结果返回父调用，但子调用不继承父调用全部权限。

**handoff** 是 Delegation 的控制权转移变体。普通 Delegation 的父方仍是结果接收者，可继续工作；handoff 表示父方明确把某个意图的后续主责转移给目标方，并在目标接受后停止为该意图创建新的子执行。handoff 不迁移原 Session，不共享同一 Invocation，也不转移资源所有权。

首版 handoff 采用同一实体，通过 `mode: 'delegate' | 'handoff'` 区分：

- `delegate`：允许父与子并行，子结果回投父 Session。
- `handoff`：目标接受后，父 Journal 记录 `handoff.accepted`；原父 Invocation 若仍在运行则请求正常停止，但父 Session 仍可继续新的人工对话。

### 2.2 Invocation、Agent Run 与独立执行

领域术语保持如下边界：

- 每次委派接受后都创建一个 child Invocation。
- 委派携带 `taskRef` 时，通过现有 Task launch seam 创建 Agent Run，Run 引用 child Session。
- 委派仅携带内联意图时，创建独立 child Session 与 child Invocation，不创建无 Task 的 Agent Run。
- `RunAttachment` 只关联真实 Agent Run。独立 child Invocation 可拥有 Artifact Reference，但没有伪造的 `runId`。

这一裁定保持 `Agent Run` 是“一次 Task 执行尝试”的既有定义，同时满足直接对话无需任务看板。

### 2.3 权威源

| 事实 | 权威宿主 |
|---|---|
| Delegation 生命周期、审批引用、目标锁定、父子关系、审计 | Server |
| Workspace 文件、Provider 会话、child Invocation 执行、Session Journal | 对应 Worker |
| transport ACK、重放 cursor、socket epoch | transport 基础设施，不是领域事实 |
| 画布 Delegation 边 | Server 权威事实的只读投影 |
| Task、Agent Run、Review | 现有 Task 应用域 |
| Tool approval | 现有 Session/Connector 来源域，G48 只聚合 |

## 3. 领域模型

### 3.1 Delegation

建议在 `packages/domain/src/delegation.ts` 冻结零宿主依赖值对象：

```ts
export type DelegationStatus =
  | 'draft'
  | 'dispatched'
  | 'accepted'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'expired'

export type DelegationMode = 'delegate' | 'handoff'

export type DelegationApprovalStatus =
  | 'not_required'
  | 'pending'
  | 'approved'
  | 'denied'
  | 'expired'

export type DelegationOwnershipStatus =
  | 'not_started'
  | 'owned'
  | 'ownership_unverified'
  | 'released'

export interface DelegationTarget {
  readonly projectId: ProjectId
  readonly workspaceId: WorkspaceId
  readonly workerId: WorkerId
  readonly agentKey: AgentKey
  readonly modelId: string | null
  readonly reuseSessionId: SessionId | null
}

export type DelegationIntent =
  | {
      readonly kind: 'task'
      readonly taskId: string
      readonly prompt: string
    }
  | {
      readonly kind: 'inline'
      readonly title: string
      readonly prompt: string
      readonly acceptanceCriteria: string | null
    }

export interface DelegationReturnTarget {
  readonly parentSessionId: SessionId
  readonly parentInvocationId: string
  readonly parentToolCallId: string | null
  readonly journal: true
  readonly taskId: string | null
}

export interface DelegatedAuthoritySnapshot {
  readonly actualUserId: UserId
  readonly sourceProjectId: ProjectId
  readonly sourceSessionId: SessionId
  readonly allowedProjectIds: readonly ProjectId[]
  readonly allowedWorkerIds: readonly WorkerId[]
  readonly allowedWorkspaceIds: readonly WorkspaceId[]
  readonly allowedToolNames: readonly string[]
  readonly allowedConnectorIds: readonly string[]
  readonly secretBindingIds: readonly string[]
  readonly networkPolicyRef: string | null
  readonly expiresAt: Timestamp
}

export interface Delegation {
  readonly id: string
  readonly dispatchId: string
  readonly mode: DelegationMode
  readonly status: DelegationStatus
  readonly revision: number
  readonly parentDelegationId: string | null
  readonly rootDelegationId: string
  readonly supersedesDelegationId: string | null
  readonly depth: number
  readonly source: {
    readonly projectId: ProjectId
    readonly sessionId: SessionId
    readonly invocationId: string
    readonly agentKey: AgentKey
    readonly workerId: WorkerId
    readonly actualUserId: UserId
  }
  readonly target: DelegationTarget
  readonly intent: DelegationIntent
  readonly returnTarget: DelegationReturnTarget
  readonly authority: DelegatedAuthoritySnapshot
  readonly approvalStatus: DelegationApprovalStatus
  readonly approvalProjectionKey: string | null
  readonly ownershipStatus: DelegationOwnershipStatus
  readonly childSessionId: SessionId | null
  readonly childInvocationId: string | null
  readonly childRunId: string | null
  readonly resultId: string | null
  readonly expiresAt: Timestamp
  readonly acceptedAt: Timestamp | null
  readonly startedAt: Timestamp | null
  readonly finishedAt: Timestamp | null
  readonly createdAt: Timestamp
  readonly updatedAt: Timestamp
}
```

#### 核心不变量

1. `dispatchId` 是创建和投递的稳定领域身份。HTTP、Agent 工具重试、Server 重启和 wire 重放均不得生成新值。
2. `id` 是 Delegation 实体身份，`dispatchId` 是一次 dispatch 意图身份。首版二者可一一对应，但合同不依赖字符串相等。
3. 同一 `(source.sessionId, dispatchId)` 只允许一个 fingerprint。相同载荷返回原实体，异载荷返回 `idempotency_conflict`。
4. `revision` 从 1 开始。accept、reject、cancel、expire、result commit 均要求 `expectedRevision`，竞争失败返回当前安全投影。
5. `target.workerId + target.workspaceId` 必须对应 ready Placement。Placement 锁定后不因 Worker 离线自动改选。
6. `childInvocationId` 在接受事务中分配一次。重放 accept 不重复创建 Session、Run 或 Invocation。
7. `completed` 只表示子执行与结果回投已提交，不表示关联 Task 已 done。
8. `failed` 不自动重试到另一 Worker。显式 retry 创建新 Delegation，并记录 `supersedesDelegationId` 审计关联。
9. `ownership_unverified` 是恢复属性，不是成功或失败。处于该状态时禁止自动创建第二个 child Invocation。
10. Delegated Authority 必须是实际用户、父 Invocation、目标 Agent、目标 Worker、目标 Workspace 和 Project 授权的交集。

### 3.2 状态机

```text
draft
  ├─ dispatch, 审批无需等待或已批准 ─> dispatched
  ├─ 取消 ─> cancelled
  └─ 到期 ─> expired

dispatched
  ├─ accept ─> accepted
  ├─ reject ─> failed(reason=target_rejected)
  ├─ 取消 ─> cancelled
  └─ 到期 ─> expired
accepted
  ├─ child Invocation 出现执行事实 ─> running
  ├─ 启动失败 ─> failed
  ├─ 取消收敛 ─> cancelled
  └─ 接受后到期仅触发取消，不直接改 expired
running
  ├─ 结果提交并回投 ─> completed
  ├─ 子执行失败终态 ─> failed
  └─ 取消收敛 ─> cancelled
```

非法转换：

- 终态不可回退。
- `dispatched` 不得直接 `completed`。
- 未经 accept 不得创建 child Invocation。
- transport ACK 不得推动 `accepted`、`running` 或终态。
- `accepted` 后到期必须先发取消，不能在无法证明执行停止时标 `expired`。

跨 Project 审批不增加主状态。审批是 dispatch 前的正交 gate：`draft + approvalStatus=pending`。批准后 CAS 到 `dispatched`，拒绝后到 `cancelled` 并记录 `approval_denied`。

### 3.3 InboxMessage 兼容扩展

现有 `AgentInboxMessage` 是文本点对点消息。首版改为封闭判别联合，同时保留旧字段的读取兼容：

```ts
export type AgentInboxMessageKind =
  | 'direct_message'
  | 'delegation_request'
  | 'delegation_result'

export type AgentInboxMessagePayload =
  | {
      readonly kind: 'direct_message'
      readonly content: string
    }
  | {
      readonly kind: 'delegation_request'
      readonly delegationId: string
      readonly dispatchId: string
      readonly mode: 'delegate' | 'handoff'
      readonly sourceSessionId: SessionId
      readonly sourceInvocationId: string
      readonly intentSummary: string
      readonly expiresAt: Timestamp
    }
  | {
      readonly kind: 'delegation_result'
      readonly delegationId: string
      readonly resultId: string
      readonly outcome: 'completed' | 'failed' | 'cancelled'
      readonly summary: string
      readonly artifactReferenceIds: readonly string[]
    }
```

兼容规则：

1. 旧记录缺少 `kind` 时按 `direct_message` 解释，原 `content` 不变。
2. `wemux_agent_send` 只创建 `direct_message`。
3. `wemux_inbox_list/read` 返回公共 envelope 和类型化 payload，旧调用方仍可读顶层 `content`。
4. 新增 `wemux_delegation_accept`、`wemux_delegation_reject`、`wemux_delegation_result` 或等价的统一 `wemux_delegation_action` 工具，不让 Agent 通过普通消息伪造状态转换。
5. inbox 的 `read` 仅代表已读，不代表 accept。`AgentInboxMessageStatus` 不承载 Delegation 状态机。
6. 每个 `delegation_request` 以 `dispatchId` 唯一，每个 `delegation_result` 以 `resultId` 唯一。

### 3.4 Artifact Reference

首版只记录可授权解析的引用，不复制文件正文：

```ts
export interface ArtifactReference {
  readonly id: string
  readonly projectId: ProjectId
  readonly workspaceId: WorkspaceId
  readonly workerId: WorkerId
  readonly sessionId: SessionId
  readonly invocationId: string
  readonly runId: string | null
  readonly relativePath: string
  readonly mediaType: string | null
  readonly byteSize: number | null
  readonly contentHash: string | null
  readonly label: string
  readonly createdBy: { readonly kind: 'agent' | 'user'; readonly id: string }
  readonly createdAt: Timestamp
}
```

不变量：

- `relativePath` 必须相对目标 Workspace Placement 根目录，拒绝绝对路径和越界规范化。
- 文件内容仍由 `workerId + workspaceId` 对应 Placement 权威保存。
- 读取、预览和下载时重新检查 Project、Session、Worker 与文件权限。
- `contentHash` 与 `byteSize` 是观测值，不使 Server 成为文件权威。
- 跨 Worker 只传引用元数据，不暗示目标 Worker 能直接读取来源 Worker 文件。

### 3.5 Run Attachment

```ts
export interface RunAttachment {
  readonly id: string
  readonly projectId: ProjectId
  readonly runId: string
  readonly sessionId: SessionId
  readonly artifactReferenceId: string
  readonly role: 'input' | 'output' | 'evidence'
  readonly attachedBy: { readonly kind: 'agent' | 'user'; readonly id: string }
  readonly createdAt: Timestamp
}
```

不变量：

- RunAttachment 只引用现存 Agent Run、Session 与 Artifact Reference。
- 三者必须属于同一 Project，跨 Project 复制必须是新的显式 Artifact Reference，并经过授权和审计。
- Attachment 不拥有 Artifact 生命周期，删除 Task 或 Run 不自动删除 Worker 文件。
- 子 Run 成功和附加 output/evidence 均不自动完成 Task。

## 4. 协作协议

### 4.1 端到端握手

```text
父 Agent / 用户
  │ 1. dispatch(requestId, dispatchId, intent, target)
  ▼
Server Delegation Application
  │ A3 求交、循环/深度/背压检查、锁定 Placement、持久化
  │ 跨 Project时先进入 G48 approval gate
  │ 2. delegation.dispatch Command
  ▼
目标 Worker
  │ 持久去重、验证 Placement/Agent capability、写 delegation_request inbox
  │ 3. delegation.offer Event
  ▼
目标 Agent / 用户
  │ 4a. accept(expectedRevision) 或 4b. reject(expectedRevision)
  ▼
Server
  │ accept 事务：分配 childInvocationId，创建/复用 child Session
  │ task intent: 调用 Task launch seam 创建 Agent Run
  │ inline intent: 创建独立 Session + Invocation
  │ 5. child execution Command
  ▼
目标 Worker AgentRunner
  │ 6. AgentEvent → child Session Journal
  │ 7. delegation.result Event(resultId)
  ▼
Server
  │ 持久结果、更新 Delegation、路由到父 Worker
  │ 8. delegation.result.apply Command
  ▼
父 Worker
  │ resultId 去重，写父 Session Journal 的结构化结果
  ▼
父 Session / 父 Agent 后续 Turn
```

### 4.2 dispatch

建议 Application Interface：

```ts
export interface DelegationApplication {
  dispatch(input: DispatchDelegationInput, context: DelegationContext): Promise<DelegationMutationResult>
  accept(input: AcceptDelegationInput, context: DelegationContext): Promise<DelegationMutationResult>
  reject(input: RejectDelegationInput, context: DelegationContext): Promise<DelegationMutationResult>
  cancel(input: CancelDelegationInput, context: DelegationContext): Promise<DelegationMutationResult>
  recordResult(input: RecordDelegationResultInput, context: WorkerContext): Promise<DelegationMutationResult>
  get(id: string, context: DelegationContext): Promise<DelegationView>
  list(query: DelegationQuery, context: DelegationContext): Promise<DelegationPage>
}
```

`dispatch` 的事务顺序：

1. 验证实际用户仍可读写父 Session，并可在目标 Project、Worker、Workspace 执行。
2. 验证目标 Placement 为 ready，目标 Agent capability 可执行。
3. 计算 Delegated Authority 交集，保存不可变快照和可重新求交的资源引用。
4. 检查环路、深度、活动子项配额和 inbox 配额。
5. 计算 fingerprint，按 `(sourceSessionId, dispatchId)` 幂等。
6. 同 Project 时写 `dispatched` 和待发行 Command；跨 Project 时写 `draft + approvalStatus=pending` 和来源审批引用。
7. 提交后唤醒目标 Worker transport。领域记录与待送达 Command 必须在同一 Server 事务中建立。

### 4.3 accept、reject 与超时

#### accept

- 接受者必须是目标 Session 的实际 Agent capability，或拥有目标 Session control 权限的人。
- `expectedRevision` 必须匹配，重复 accept 在 child 身份相同的情况下返回原结果。
- 接受事务中一次性分配 `childSessionId`、`childInvocationId`，并在需要时创建 `childRunId`。
- child Session 固定绑定目标 Placement、Worker、Agent 与 Model。
- 执行前再次求交 A3 和 capability。授权已撤销则失败关闭，不因之前收到 inbox 就继续。

#### reject

- reject 写入结构化原因：`busy | unsupported | insufficient_context | policy_denied | user_rejected | other`。
- reject 是 Delegation 终态 `failed`，并以 `delegation_result` 回投父方。
- 文本说明有长度上限并进入审计摘要，不复制完整 prompt。

#### 超时

- `draft` 审批超时：`approvalStatus=expired`，Delegation 进入 `expired`。
- `dispatched` 未接受超时：进入 `expired`，撤销未领取 request Command，并回投超时结果。
- `accepted/running` 达到执行 deadline：先写 cancel intent 并下发停止。只有 Journal 或 Worker result 证明停止后才进入 `cancelled`；无法证明时保持活动状态并标 `ownership_unverified`。
- 超时绝不自动批准，也不把离线等同拒绝。

### 4.4 子执行创建

#### Task 路径

`intent.kind='task'` 时：

- Task 必须属于目标 Project。
- 使用 Task 当前 Assignment 或 dispatch 中经用户确认的目标 binding。
- 调用现有 Task launch 应用 seam，沿用 `requestId + fingerprint`、active Run 互斥、Session reuse/new 和 Run snapshot。
- `childRunId` 写回 Delegation，创建 `RunAttachment` 时引用该 Run。
- 子 Run 成功只推动 Delegation 结果，不推动 Task done。

#### 独立路径

`intent.kind='inline'` 时：

- 创建 Project 下的独立 child Session，默认共享范围取父权限与目标 Project 默认的更窄者。
- 创建 child Invocation 并向 Session 入队意图。
- 不创建 Task，不创建 Agent Run，不改变任务看板。
- 结果仍可创建 Artifact Reference 并回投父 Session。

### 4.5 结果回投

`DelegationResult` 建议形状：

```ts
export interface DelegationResult {
  readonly resultId: string
  readonly delegationId: string
  readonly dispatchId: string
  readonly childSessionId: SessionId
  readonly childInvocationId: string
  readonly childRunId: string | null
  readonly outcome: 'completed' | 'failed' | 'cancelled'
  readonly summary: string
  readonly structuredOutput: unknown | null
  readonly artifactReferences: readonly ArtifactReference[]
  readonly completedAt: Timestamp
}
```

规则：

1. `resultId` 由目标 Worker 在持久化 child 终态时分配并保存，重传保持不变。
2. Worker 先持久化 child Journal 终态和 result record，再向 Server 报告。
3. Server 按 `resultId` 去重，同 ID 异载荷返回 integrity error。
4. Server 把结果保存到 Delegation 后，向父 Worker 发行 `delegation.result.apply`。
5. 父 Worker 按 `resultId` 去重并写父 Session Journal。若原父 Invocation 已终结，结果作为异步 tool result 和 inbox message 进入 Journal，供下一 Turn 使用，不伪装注入已关闭的 Provider stream。
6. 若 Provider 未来支持可恢复的异步 tool continuation，可在 capability 协商后恢复同一父 Invocation；首版不假设 Pi/OpenCode 都支持该能力。
7. 父 Worker 离线时结果保持 `return_queued` 投影，Delegation 的 child outcome 可已终结，但对用户必须显示“结果待回投”，直到父 Journal 收到应用收据。

### 4.6 handoff 协议

handoff 复用 dispatch、accept、执行和结果协议，增加以下约束：

1. handoff 只能由父 Invocation 的实际用户或获权父 Agent 发起。
2. 目标 accept 前，父方仍拥有工作意图；目标 accept 后，Server 写权威 `handoff.accepted`。
3. 若父 Invocation 仍在 running，Server 向父 Worker 下发幂等 stop。stop accepted 仅代表受理，仍以父 Journal 终态收敛。
4. handoff 不转移父 Session、Task、Workspace 或文件所有权，只记录责任和执行血缘。
5. 目标 reject 或超时后，父方继续拥有意图，不自动选择第三个 Agent。
6. handoff 结果仍回投父 Session，以便人类看到最终交付和继续对话。

## 5. 跨 Worker 路由与离线语义

### 5.1 Placement 锁定

dispatch 时锁定：

```text
(projectId, workspaceId, workerId, agentKey, modelId)
```

规则：

- `workspaceId` 是逻辑环境，`workerId` 决定物理 Placement。
- 只有该 Placement 为 ready 且 A3 Worker use 有效时可 dispatch。
- dispatch 后 Placement 状态变化不触发透明迁移。
- Worker 上的绝对路径不进入 Server contract。
- 显式 retry 可选择另一 ready Placement，但必须创建新 Delegation，并确认旧执行终止或由人承担重复副作用风险。

### 5.2 协作投递状态

Delegation 主状态不承载网络细节。Server 维护可观察的 dispatch delivery 投影：

```ts
export type DelegationDeliveryState =
  | 'queued_for_worker'
  | 'sent'
  | 'worker_recorded'
  | 'retry_wait'
  | 'failed_closed'
  | 'expired'
```

这借鉴 H4 outbox 的持久排队、领取、退避、永久失败和过期思想，但含义不同：

- H4 的 `delivered` 表示外部 HTTP/IM 推送完成。
- Delegation 的 `worker_recorded` 只表示目标 Worker 已持久记录 Command，不表示 Agent accept 或执行完成。
- H4 可按响应码判断永久失败；Delegation 必须结合 Worker Command receipt、资源授权和领域状态。
- transport ACK 只推进 frame cursor，不直接推动 `worker_recorded`。后者需要应用层 Command receipt。

### 5.3 目标 Worker 离线

首版策略：

- 默认允许离线排队，前提是委派未携带禁止离线的高危预授权，且 `expiresAt` 未到。
- UI 和 API 明确显示 `dispatched + queued_for_worker`，不得显示已接受或运行。
- 恢复连接后使用原 `dispatchId` 和原 Command 领域身份重投，只允许 transport `directionSeq` 变化。
- 离线超过 `expiresAt` 后进入 `expired`，未领取 Command 不再发行。
- Worker revoked、Placement deleted/unhealthy、授权撤销、Agent capability 消失均进入 `failed_closed`，不无限重试。
- 运维人员可显式 cancel 或创建新 retry Delegation，不能直接修改目标字段。

### 5.4 背压

首版默认限制：

- 单父 Invocation 最多 4 个活动直接子 Delegation。
- 单根 Delegation 树最多 16 个活动节点。
- 单目标 Session 最多 32 个未处理 `delegation_request`。
- 单 Project 最多 500 个非终态 Delegation。
- intent prompt 最大 100 KiB，结构化 payload 最大 256 KiB，Artifact 文件正文不得进入 Command。
- 达到限制返回 `delegation_backpressure`，不静默丢弃、不自动合并不同 dispatch。

只有同一 `dispatchId + fingerprint` 的重试可收敛。首版不做语义 coalescing，避免把不同父调用错误合并。

## 6. 可靠性、恢复与幂等

### 6.1 身份分层

| 身份 | 用途 | 重试规则 |
|---|---|---|
| `requestId` | Web/CLI/SDK 写请求身份 | 同请求重试保持不变 |
| `dispatchId` | Delegation 创建与目标投递身份 | 整个委派生命周期不变 |
| `childInvocationId` | 子 Agent invocation 身份 | accept 后不变 |
| `childRunId` | 有 Task 时的 Agent Run 身份 | 不因 wire 重试改变 |
| `resultId` | 子结果与父回投去重身份 | 目标 Worker 生成一次并持久化 |
| `commandId` | 非对话管理 Command 身份 | 每个明确副作用一个稳定 ID |
| `messageId` | transport envelope 去重 | frame 重发保持不变 |
| `directionSeq` | transport 有序 cursor | 新 delivery epoch 可重分配 |

禁止用 transport `messageId` 代替 `dispatchId/resultId`，也禁止因重连创建新 child Invocation。

### 6.2 重复投递

#### Server 到目标 Worker

- Worker 在本地持久化 `dispatchId + fingerprint + command outcome`。
- 相同 dispatch 重放返回原 `accepted/rejected` receipt，不重复写 inbox。
- 同 dispatch 异 fingerprint 返回 `conflicting-command` 并告警。

#### 目标 Worker 到 Server

- Server 按 `resultId` 去重。
- 同 resultId 异结果属于完整性错误，Delegation 标记诊断并停止自动处理。
- result report 的 transport ACK 丢失时，Worker 重放原 resultId。

#### Server 到父 Worker

- 父 Worker 按 `resultId` 保存 applied receipt。
- 重放不重复追加 Journal。
- Server 收到应用层收据后才清理该结果的待发行身份。纯 transport ACK 驱动的 flush 只重放 outbox，不能重新入队同一结果。

### 6.3 原子领取

目标 Worker 对 `delegation.dispatch` 的处理：

1. 在 Worker SQLite 事务中检查 dedupe 与 Placement/Agent capability。
2. 条件写入 local delegation receipt 和 `delegation_request` inbox。
3. 提交后返回 Command receipt。
4. Agent accept 时用 `WHERE state='offered' AND revision=?` 的条件更新领取。
5. 零行表示输掉竞争，返回当前状态，不创建第二个 child Invocation。

当前单 Worker 进程可用 SQLite 串行事务和条件更新完成，不引入 PostgreSQL 或外部 Broker。

### 6.4 孤儿恢复与 ownership_unverified

借鉴 Paperclip heartbeat 的 fail-closed 所有权语义，但适配双宿主：

- Server 重启：扫描非终态 Delegation，依据 Worker receipt、child Session/Run 投影和 Journal freshness 恢复路由，不直接宣称 child 已停止。
- Worker 重启：扫描本地 `accepted/running` delegation receipt，并检查 RuntimeSession、原生 Provider owner、child Journal 终态和进程身份。
- 能证明 owner 仍活跃：恢复 `owned`，继续上报进度。
- 能证明 owner 已终止且 Journal 有终态：重放原 resultId。
- 不能证明 owner 活跃或终止：标 `ownership_unverified`，停止自动重跑、迁移和重复 accept。
- 运维动作只有“继续观察”“证明已停止后重试”“按重复副作用风险人工重试”。不得因 PID 不存在单独推断远端 Provider 已停止。
- `ownership_unverified` 仍接受 cancel intent。若后续 owner 恢复，Worker 必须优先执行已持久取消。

## 7. 取消传播与预算边界

### 7.1 首版取消传播

首版做以下能力：

1. 父 Delegation cancel 写入 Server 权威取消意图，操作使用 `requestId + fingerprint + expectedRevision`。
2. 尚未 accept：撤销 request，Delegation 收敛 `cancelled`。
3. 已 accept 但 child 消息未启动：有 Task 的子执行调用现有 Run cancel，使用 `session.cancel-queued(submissionCommandId)`；独立 child Invocation 调用同一 Session queue 取消 seam。
4. child 已启动：有 Task 的子执行复用现有 `cancelRun` 和 `turn.stop(turnId)`；独立 child Invocation 使用 `turn.stop`。
5. 排队取消与启动竞态继续由 Journal 识别并补发 stop。
6. stop Command 的 accepted 不等于停止完成。只有 `message.cancelled`、目标 `turn.finished` 或 child result 终态才能使 Delegation 进入 `cancelled`。
7. 根父 Invocation 被取消时，默认传播到其所有非终态直接子项；每个子项独立幂等。子项再向后代传播，形成有界树遍历。
8. 一个子项取消失败不回滚其他子项，根记录 `partial_cancel` 诊断和未收敛子项列表。
9. 子失败不自动取消兄弟。handoff 的父停止与子取消是不同意图。

### 7.2 预算首版

首版只做静态、有界预算，不做逐 token 扣减：

```ts
export interface DelegationBudgetEnvelope {
  readonly maxDepth: number
  readonly maxChildren: number
  readonly deadlineAt: Timestamp
  readonly maxWallClockSeconds: number
  readonly maxArtifactBytes: number
}
```

规则：

- 子预算必须小于或等于父剩余 envelope。
- deadline、深度、子项数和 Artifact 字节上限在 dispatch 与执行前检查。
- 超限失败关闭，并进入审计和父 Journal。
- Provider usage 仍照常记录，但不作为首版强一致扣减账本。

以下推迟到 M8 预算票据：

- token、金额、模型价格、缓存价格的实时累计。
- 跨并发子调用的原子余额预留与返还。
- Team/Project/Agent 多层预算策略和 hard-stop 恢复审批。
- 费用估算漂移、Provider 延迟 usage 和跨币种处理。

借鉴 Paperclip 的是“超过硬门槛则拒绝新工作并传播取消”的语义，不复制其 company/employee 中央预算管家。

## 8. 审批与授权

### 8.1 委派本身的审批

首版策略：

- 同 Project Delegation：通过 A3 权限交集、深度、预算和背压检查后自动 dispatch。
- 跨 Project Delegation：必须进入人工审批。审批来源域仍是 Delegation，G48 只做发现和决策路由。
- 跨 Team Delegation：首版禁止，即使用户同时属于两个 Team，也必须通过未来显式跨边界导出/导入合同。
- 审批超时或无人处理：失败关闭，不自动批准。

G48 增加来源类型：

```ts
| {
    readonly kind: 'delegation_cross_project'
    readonly delegationId: string
    readonly sourceProjectId: ProjectId
    readonly targetProjectId: ProjectId
  }
```

批准动作重新检查来源状态、revision、A3 和目标 Placement。聚合页面看到 pending 不保证写入时仍可批准。

### 8.2 子执行中的高危工具

- 子 Invocation 使用收窄后的 capability snapshot。
- Connector write/destructive 继续进入 `ToolExecutionGateway`。
- Agent Adapter 未声明 approval 能力时失败关闭，不静默免审。
- Channel 触发、无人交互或跨 Project 场景不自动批准工具调用。
- G48 可聚合 child Session 的工具审批，但决策仍路由回 Session/Connector 来源域。

### 8.3 Delegated Authority 计算

有效权限为以下集合交集：

```text
实际用户当前权限
∩ 父 Invocation launchContext
∩ 父 Delegation authority envelope
∩ 目标 Project 权限
∩ 目标 Worker use 权限
∩ 目标 Workspace/Placement 权限
∩ 目标 Session 分享范围
∩ 目标 Agent capability
∩ 实例级工具、Connector、网络和 Secret 策略
```

执行前必须重新求交可撤销资源。快照用于审计和最大上限，不允许覆盖后续撤权。子调用不得扩大 Workspace、Worker、Secret、网络、Shell、文件或 Connector 范围。

## 9. 多六边形与接口归属

### 9.1 共享合同六边形

建议文件：

```text
packages/domain/src/delegation.ts
packages/domain/src/artifact-reference.ts
packages/domain/src/session-lineage.ts
packages/server-domain/src/delegations.ts
packages/server-domain/src/delegation-authorization.ts
packages/web-contract/src/delegations.ts
packages/wire-protocol/src/delegations.ts
```

职责：

- `@wemux/domain`：纯值对象、状态机、身份、不变量。
- `@wemux/server-domain`：Application Interface、授权输入、仓储端口、审计意图。
- `@wemux/web-contract`：安全 DTO、游标、错误码，不暴露 Secret 或 Worker 路径。
- `@wemux/wire-protocol`：Worker 必须知道的 Command/Event payload。

禁止 `apps/worker` import `@wemux/server-domain`。Worker 只依赖 `@wemux/domain`、`@wemux/agent-interchange`、`@wemux/wire-protocol` 和 Worker 自有应用端口。

### 9.2 Server 六边形

Server 负责：

- Delegation 权威状态机、CAS、幂等、审计。
- A3 与 Delegated Authority 计算。
- G48 跨 Project 审批挂接。
- Placement 锁定和 Worker 路由。
- Task launch / Run cancel seam 编排。
- inbox 中转的集群权威记录。
- child result 持久化和父 Worker 回投。
- 查询、分页、超时扫描和恢复诊断。

建议端口：

```ts
export interface DelegationRepository {
  createOrReplay(input: CreateDelegationRecord): Promise<CreateDelegationResult>
  get(id: string): Promise<Delegation | null>
  transition(input: DelegationTransition): Promise<Delegation>
  listRecoverable(now: Timestamp, limit: number): Promise<readonly Delegation[]>
}

export interface DelegationAuthorizationPort {
  authorizeDispatch(input: DelegationAuthorizationInput): Promise<DelegatedAuthoritySnapshot>
  reauthorizeExecution(delegation: Delegation): Promise<DelegatedAuthoritySnapshot>
}

export interface DelegationDeliveryPort {
  dispatch(delegation: Delegation): Promise<void>
  cancel(delegation: Delegation): Promise<void>
  applyResult(result: DelegationResult, target: DelegationReturnTarget): Promise<void>
}
```

### 9.3 Worker 六边形

Worker 负责：

- Command 持久去重和应用层 receipt。
- 目标 Placement、Agent capability 和本地并发复检。
- 本地 delegation inbox、accept/reject 领取和 child Invocation 执行。
- AgentRunner 调用、child Journal、Artifact 文件引用观测。
- resultId 持久化、重放和父结果应用。
- Runtime owner 恢复与 `ownership_unverified` 判断。
- 取消 child queue/turn，复用现有 Session Runtime。

建议端口：

```ts
export interface WorkerDelegationExecutor {
  recordOffer(command: DelegationDispatchCommand): Promise<DelegationCommandReceipt>
  start(input: StartAcceptedDelegation): AsyncIterable<AgentEvent>
  cancel(input: CancelChildInvocation): Promise<void>
  recover(): Promise<readonly DelegationRecoveryReport[]>
}

export interface ParentResultAppender {
  apply(result: DelegationResult): Promise<'applied' | 'replayed'>
}
```

Provider Adapter 不知道 Delegation、Server、A3、transport 或 Task。它只执行已确定 Session 中的 Invocation。

### 9.4 wire 新消息

建议新增到既有 `ServerPayload` / `WorkerPayload`，继续由 transport v2 durable frame 承载：

```ts
export type DelegationWorkerCommand =
  | {
      readonly kind: 'delegation.dispatch'
      readonly delegationId: string
      readonly dispatchId: string
      readonly expectedTarget: DelegationTarget
      readonly request: DelegationRequestSnapshot
    }
  | {
      readonly kind: 'delegation.cancel'
      readonly delegationId: string
      readonly childSessionId: SessionId | null
      readonly childInvocationId: string | null
    }
  | {
      readonly kind: 'delegation.result.apply'
      readonly result: DelegationResult
      readonly parentSessionId: SessionId
      readonly parentInvocationId: string
      readonly parentToolCallId: string | null
    }

export type DelegationWorkerEvent =
  | { readonly kind: 'delegation.offer.recorded'; readonly delegationId: string; readonly dispatchId: string }
  | { readonly kind: 'delegation.accepted'; readonly delegationId: string; readonly childSessionId: SessionId; readonly childInvocationId: string; readonly childRunId: string | null }
  | { readonly kind: 'delegation.rejected'; readonly delegationId: string; readonly reasonCode: string; readonly message: string | null }
  | { readonly kind: 'delegation.result'; readonly result: DelegationResult }
  | { readonly kind: 'delegation.result.applied'; readonly delegationId: string; readonly resultId: string; readonly parentSessionId: SessionId }
  | { readonly kind: 'delegation.recovery'; readonly delegationId: string; readonly ownershipStatus: DelegationOwnershipStatus; readonly diagnostic: string | null }
```

关系规则：

- `delegation.dispatch` 是管理 Command，因为它创建目标 inbox 和后续执行意图；child Agent 对话本身仍使用 Wemux ADK Profile invocation/event。
- AgentEvent 不包含 transport cursor。
- Command receipt 的 accepted 只表示 Worker 持久记录，不表示目标 Agent accept。
- result 的应用收据是领域收据，与 transport ACK 分离。
- transport minor feature 必须协商 `delegation.v1`。未协商时 Server 返回结构化 `capability_unavailable`，不静默降级为普通文本消息。

## 10. 与 G48 Approvals、G49 Routines 和 C6 的接口

### 10.1 G48 Approvals

- 跨 Project Delegation 产生 `delegation_cross_project` 来源审批。
- G48 只聚合待处理项和路由决定，不复制 Delegation 状态机。
- Tool approval 仍来自 child Session/Connector 域，与委派审批是两个独立 gate。
- 同一 Delegation 可能先经过跨 Project 审批，运行中再经过高危工具审批，UI 必须分别展示来源和状态。

### 10.2 G49 Routines

边界：

- Routine 是“时间、API 或 Channel 触发的人到 Agent 自动执行”。
- Delegation 是“父 Agent 或父 Invocation 到目标 Agent 的结构化子调用”。
- Routine 可启动顶层 Task Run 或 Session Invocation，但不伪造 parent Invocation。
- Delegation 必须有 parent Invocation。
- 两者共享：Placement 选择校验、A3、Run/Session 创建、稳定 dispatch identity、取消、恢复和审计底座。
- 两者不共享：触发 receipt、cron/catch-up/concurrency policy、父子血缘、结果回投。
- 实现依赖方向是共同底座分别被 Routine 与 Delegation 消费，二者不得互相 import。

### 10.3 C6 与画布

- C6 `SessionRelation` 增加 `delegation`、`artifact_reference`、`run_attachment` 的封闭 payload。
- 画布查询只返回调用者获权可见的关系与安全摘要。
- 边创建来自 Delegation/Artifact/RunAttachment 权威事务，前端连线不能创建领域关系。
- handoff 可在 Delegation relation 上增加 mode 标签，不新造自由字符串关系。
- Ticket 21 只投影本合同，不负责 dispatch、审批、取消或恢复。

## 11. 分批实施

估时按一名熟悉仓库的工程师计，包含合同、迁移、单元与集成测试、真实 Pi Agent 端到端、浏览器或 API 验收脚本及验收摘要。外部模型费用需另行批准。

### 11.1 D1 委派核心，同 Worker 同主机，20 至 30 小时

**目标**：在一个 Worker 的两个真实 Pi Session 间完成结构化委派，不先引入跨主机恢复复杂度。

**路径级交付物**：

```text
packages/domain/src/delegation.ts
packages/domain/src/capabilities.ts
packages/server-domain/src/delegations.ts
packages/web-contract/src/delegations.ts
packages/wire-protocol/src/delegations.ts
apps/server/src/application/delegation-service.ts
apps/server/src/application/ports/delegation-repository.ts
apps/server/src/storage/sqlite/delegation-repository.ts
apps/server/src/http/routes/delegation-routes.ts
apps/server/src/application/capability-service.ts
apps/worker/src/application/delegation-executor.ts
apps/worker/src/capabilities/pi-tools.ts
apps/worker/src/storage/delegation-store.ts
apps/e2e/agent-delegation-same-worker.test.ts
docs/acceptance/agent-collaboration-d1.md
```

**实现内容**：

- Delegation 实体、状态机、`requestId + dispatchId + fingerprint`、revision CAS。
- inbox 判别联合和旧消息兼容。
- 同 Project 自动 dispatch。
- request、accept/reject、child Invocation、结果回投父 Journal。
- inline intent 与 Task intent 两条路径。
- 深度上限、简单环路检测、单目标 inbox 背压。
- 普通 `agent.send` 行为不变。

**验收标准**：

1. 启动一个 Worker、两个真实 Pi Session A/B；A 通过 capability tool 向 B 发出委派。
2. B 的 inbox 出现一次 `delegation_request`，重复 dispatch 不重复记录。
3. B accept 后创建唯一 child Invocation；B 完成一个可观察任务并产生结果。
4. A 的父 Session Journal 出现一次 `delegation_result`，包含 child Session/Invocation 和结果摘要。
5. 重新发送相同 dispatchId 返回原 Delegation；异载荷冲突。
6. B reject、请求超时、Agent 不可用均有结构化失败并回投。
7. 独立委派不创建 Task/Run；Task 委派创建真实 Agent Run，成功不自动 Task done。
8. 普通 `wemux_agent_send`、inbox list/read 回归通过。

### 11.2 D2 跨 Worker 路由与可靠性，16 至 24 小时

**目标**：把 D1 扩展到两个 Worker，覆盖离线排队、可靠重放和孤儿恢复。

**路径级交付物**：

```text
packages/wire-protocol/src/delegations.ts
apps/server/src/application/delegation-router.ts
apps/server/src/application/delegation-recovery.ts
apps/server/src/worker-ws/gateway.ts
apps/server/src/worker-ws/transport-store.ts
apps/worker/src/transport/transport-store.ts
apps/worker/src/application/delegation-recovery.ts
apps/worker/src/storage/delegation-store.ts
apps/e2e/agent-delegation-cross-worker.test.ts
apps/e2e/agent-delegation-recovery.test.ts
docs/acceptance/agent-collaboration-d2.md
```

**实现内容**：

- Placement 锁定和 `delegation.v1` feature 协商。
- `delegation.dispatch/cancel/result.apply` Command 与领域 Event。
- 目标 Worker 离线排队、过期、revoked 与 Placement 失效分类。
- dispatchId、resultId、应用层 receipt 与 transport messageId 分层去重。
- Server/Worker 重启恢复和 `ownership_unverified`。
- 父 Worker 离线时结果待回投。

**验收标准**：

1. 两个真实 Worker，各运行一个 Pi Agent，A 在 Worker 1 委派 B 在 Worker 2 完成任务并回投 A Journal。
2. 目标 Worker 离线时显示 queued，不显示 accepted/running；恢复后用原 dispatchId 执行一次。
3. dispatch Command、result Event、result apply Command 各重复投递至少两次，副作用和 Journal 均只有一次。
4. Server 在 dispatch 后、accept 后、result 保存后分别重启，状态可收敛。
5. 目标 Worker 在 child running 时重启：能证明终态则重放结果，不能证明则进入 `ownership_unverified` 且不自动重跑。
6. Placement unhealthy、Worker revoked、授权撤销均失败关闭。
7. 断线和 transport epoch 变化不改变 dispatchId、childInvocationId 或 resultId。

### 11.3 D3 取消传播、审批挂接与 Artifact 引用，12 至 18 小时

**目标**：补齐治理闭环和 C6 最小关系合同。

**路径级交付物**：

```text
packages/domain/src/artifact-reference.ts
packages/domain/src/session-lineage.ts
packages/server-domain/src/delegation-authorization.ts
packages/server-domain/src/artifacts.ts
packages/web-contract/src/delegations.ts
apps/server/src/application/delegation-cancellation.ts
apps/server/src/application/approval-decision-router.ts
apps/server/src/application/artifact-service.ts
apps/server/src/storage/sqlite/artifact-repository.ts
apps/worker/src/application/workspace-artifact-files.ts
apps/e2e/agent-delegation-governance.test.ts
docs/acceptance/agent-collaboration-d3.md
```

**实现内容**：

- 父取消对子树传播，复用 Run cancel 三态竞态处理。
- handoff accept 后父 Invocation stop。
- 跨 Project G48 approval source，跨 Team禁止。
- 子 ToolExecutionGateway 高危审批回归。
- Artifact Reference、Run Attachment 与 C6 SessionRelation payload。
- 静态 budget envelope、循环和深度负面测试。

**验收标准**：

1. 父取消发生在 child queued、刚启动、running、已终结四个时点，均确定收敛且不清空无关 Session 消息。
2. stop accepted 不提前显示 cancelled；启动竞态补发 stop。
3. 同 Project 自动 dispatch；跨 Project 未批准不投递，批准后执行一次，拒绝/超时失败关闭；跨 Team 返回禁止。
4. child 发起 write/destructive Connector 工具时继续需要既有审批，不能因 Delegation 绕过。
5. Artifact Reference 不复制文件正文，跨 Worker 下载重新授权；Run Attachment 只引用真实 Run。
6. A 委派 B、B 尝试委派 A 被环路规则拒绝；超过深度和配额时明确背压。
7. handoff 目标接受后父执行收到停止意图，父 Session 仍可继续人工对话。

### 11.4 总估时与穿插建议

| 批次 | 估时 | 累计 |
|---|---:|---:|
| D1 同 Worker 委派核心 | 20 至 30h | 20 至 30h |
| D2 跨 Worker 路由与可靠性 | 16 至 24h | 36 至 54h |
| D3 取消、审批、Artifact | 12 至 18h | 48 至 72h |

与七件套的建议穿插：

1. 七件套批次一先完成 F1 与 G48 来源路由 seam，避免 D3 再造审批聚合。
2. 七件套批次二完成 G52 Artifact 的基础引用语义后启动 D1。若 G52 仅完成文件引用合同，D1 可先落 Delegation，D3 再接完整 Artifact。
3. D1 建议在七件套批次二后实施，此时审批聚合和 Artifact 边界已稳定，但不等待 G49 Routines。
4. D2 与 D3 可和七件套批次三 G49 并行，因为两者共享 dispatch/run 底座但领域模块互不依赖。
5. 并行时先冻结 `packages/wire-protocol` 与共同 dispatch seam，避免两条线同时修改共享 wire union、迁移和 e2e fixture。
6. G49 不得成为 Delegation 的调度器，Delegation 也不得成为 Routine 的触发队列。

## 12. 调研机制对照

| 借用机制 | 来源 | Wemux 适配 | 双宿主差异 |
|---|---|---|---|
| durable receipt | Paperclip `agent_wakeup_requests`；`docs/research/paperclip-deep-dive.md` 4.1 | dispatch、accept、result 各有稳定领域身份和持久收据 | 收据分别落 Server 与 Worker，不能假设中央数据库同时拥有 Provider 执行事实 |
| coalesce/defer/proceed 的区分 | Paperclip heartbeat wake admission | 首版只借“不可把重复输入等同新执行”的判断框架；仅相同 dispatchId+fingerprint 收敛 | 不做语义 coalescing，避免跨 Session、跨 Worker 错误合并父调用 |
| queued 到 running 原子签出 | Paperclip `claimQueuedRun` 的条件更新与 scope lock | Worker accept 使用状态 CAS，Server child 创建事务绑定唯一身份 | 当前单 Server 与单 Worker SQLite 用 `BEGIN IMMEDIATE` 和条件更新，不搬 PostgreSQL 行锁实现 |
| ownership_unverified | Paperclip heartbeat 孤儿恢复 | 无法证明 Provider owner 终止时禁止重跑、迁移或创建第二 child | 所有权证据在 Worker，Server 只能看可靠报告和 Journal freshness，中央控制面不能猜测本机进程 |
| budget hard-stop | Paperclip `budgets.ts` 达阈值暂停 scope 并取消工作 | 首版采用深度、子项数、deadline、时长、Artifact 字节硬门槛 | 不复制 company/agent 中央费用管理；逐 token 与金额预算推迟 M8 |
| 审批聚合 | Paperclip Approvals 页面与服务；G48 设计 | 跨 Project Delegation 作为新来源投影，决策回 Delegation 来源域 | Wemux 已有多个权威审批域，G48 不建统一审批权威表 |
| 持久 outbox、租约、退避、死信 | H4 `ChannelOutbox` 和 `OutboundDeliveryStatus` 六态 | 借离线排队、领取、重试分类、诊断和人工恢复形状 | Delegation 是可靠 Worker Command，有 transport ACK 与应用 receipt 两层，不按 HTTP 状态码判断完成 |
| idempotent fail-closed connector execution | H4 `ToolExecutionGateway` | child Invocation 沿用 requestId/fingerprint、revision 和高危审批 | 工具执行在 Worker，本地 Secret 不进入 Server Delegation payload |
| Placement 与可靠 Command | Wemux 现有 Workspace Placement、transport v2 | 锁定 `(workspaceId, workerId)`，Command 至少一次投递，领域身份稳定 | Server 编排路由，Worker 执行并拥有 Journal，不引入 Worker 横向网络 |

### 12.1 明确不抄

- 不抄 org chart、上下级汇报链、Agent 员工、雇佣、CEO 或公司模拟隐喻。
- 不抄中央 budget 管家作为所有协作的前置条件。
- 不抄 Paperclip issue 作为每次执行的强制父实体，Wemux 保留直接 Session 路径。
- 不抄 2 万行 heartbeat 服务或其 PostgreSQL 特定锁实现。
- 不抄自动杀死或重跑所有权不明的执行。
- 不抄 Agent 自主扩大权限、跨 Project 默认委派或用组织关系推导资源权限。
- 不抄 H4 webhook 的 HTTP 响应码状态机作为 Delegation 领域状态。

## 13. 风险与威胁模型

### 13.1 Top 风险与控制

| 风险 | 影响 | 首版控制 |
|---|---|---|
| 委派循环和指数扩张 | A 委 B、B 委 A，资源和费用失控 | rootDelegationId、祖先链检查、最大深度 4、单父活动子项 4、树活动节点 16 |
| 权限扩大或跨 Project 数据泄漏 | 子 Agent 读取更多 Session、文件、Secret、Connector | Delegated Authority 求交、执行前复检、跨 Project人工审批、跨 Team禁止、Artifact 下载再授权 |
| 所有权不明时重复执行 | 重复写文件、外部 API 或支付副作用 | ownership_unverified 失败关闭、稳定 dispatch/result 身份、不得透明迁移、人工证明停止后再 retry |
| inbox 泛滥与持久队列耗尽 | Worker 存储、Agent 注意力和 Server outbox 被压垮 | 分层配额、payload 上限、过期、明确背压、按 Project/Session 限流，不静默丢弃 |
| 取消假成功 | UI 显示已停但 Provider 仍运行 | accepted 仅为受理，Journal/结果终态才收敛，复用 Run 三态竞态处理 |
| 结果伪造或重放 | 错误结果进入父 Journal | Worker credential、resultId+fingerprint、目标 binding 校验、应用层收据、同 ID 异载荷完整性告警 |
| Placement 误解为共享文件 | 子 Agent 在另一主机找不到来源文件 | Artifact 只存来源引用，跨 Worker不暗示共享路径，显式复制另立合同 |
| 跨 Project 审批与工具审批混淆 | 用户批准委派后误以为所有高危操作均批准 | 两个独立 approval source、分别展示、工具审批仍失败关闭 |

### 13.2 循环与深度

检测键为稳定 Agent 执行目标：

```text
(projectId, workspaceId, workerId, agentKey, reuseSessionId?)
```

规则：

- 若目标 Session 已出现在祖先链，拒绝 `delegation_cycle`。
- 无 reuse Session 时，若同一 target tuple 在最近祖先链重复且 intent fingerprint 相同，拒绝。
- 最大深度固定为 4，root 为 0。
- 人工显式创建的新顶层 Delegation 是新树，不继承旧链。
- 首版不允许 Agent 通过改写空白、标题或 requestId 绕过 intent fingerprint。

### 13.3 权限收窄传播

- 子 `allowedTools`、Connector、Secret、网络目标和 Workspace 集合必须是父集合子集。
- 父没有的能力，子不能通过目标 Agent 默认配置获得。
- Server 只下发 Secret reference 的允许集合，Secret 明文仍留在 Worker。
- 授权撤销后，未执行请求失败关闭，进行中执行按既有 A3 撤权策略停止并审计。
- Agent 身份不能替代实际用户，审计同时记录 actualUserId、source agent、target agent。

### 13.4 跨 Project 数据边界

- 审批详情默认显示意图摘要，不显示完整父 prompt、私有 Session 标题或 Artifact 内容。
- 目标 Project 只收到批准后的最小 intent 和显式 Artifact 引用。
- Artifact 从来源 Project 导出到目标 Project 需要新的显式复制或共享合同，首版只允许同 Project 引用。
- 跨 Team 一律拒绝，防止通过多 Team 成员身份绕过资源边界。
- 查询、搜索、SSE 和画布投影都先做 A3 过滤，不能靠 Web 隐藏。

## 14. 可观察性、审计与错误合同

### 14.1 审计动作

至少记录：

```text
delegation.created
delegation.approval_requested
delegation.approved
delegation.denied
delegation.dispatched
delegation.accepted
delegation.rejected
delegation.started
delegation.completed
delegation.failed
delegation.cancel_requested
delegation.cancelled
delegation.expired
delegation.ownership_unverified
delegation.result_applied
handoff.accepted
artifact.reference_created
run.attachment_created
```

审计 metadata 只放 ID、状态、Project/Worker/Workspace、原因码和 revision，不复制完整 prompt、模型输出、Secret 或文件正文。

### 14.2 稳定错误码

```text
invalid_request
not_found
forbidden
request_id_conflict
idempotency_conflict
revision_conflict
placement_not_ready
worker_unavailable
agent_unavailable
capability_unavailable
delegation_cycle
delegation_depth_exceeded
delegation_backpressure
approval_required
approval_denied
cross_team_forbidden
ownership_unverified
result_integrity_error
expired
invalid_transition
```

retryable 只表示相同领域身份可安全重试，不表示应创建新 Delegation。

### 14.3 关键指标

- 非终态 Delegation 数、按状态和 Project 分布。
- dispatch 排队时间、accept 延迟、执行时长、结果回投延迟。
- 重复 Command/Event 命中次数和完整性冲突数。
- ownership_unverified 数量和持续时间。
- cancel 未收敛数量。
- inbox 配额拒绝、Project 背压和过期数量。
- 跨 Project 审批等待时长。

## 15. 关键架构决策

1. **Server 是 Delegation 权威，Worker 是执行与 Journal 权威。** 因为 Wemux 是双宿主，不允许中央控制面假装拥有本机 Provider 进程和文件事实。
2. **Delegation 使用独立领域状态，不复用 inbox read 状态或 transport ACK。** 因为已读、持久接收、接受和完成是不同事实。
3. **独立委派创建 child Invocation，不创建无 Task Agent Run。** 因为 Agent Run 的既有领域定义是一次 Task 执行尝试，直接对话仍须一等可用。
4. **Placement 在 dispatch 时锁定，不透明迁移。** 因为不同 Worker 的文件和凭证不隐式同步，重复执行风险高。
5. **结果异步回投父 Journal，首版不假设 Provider 支持挂起的远程 tool call。** 因为 Pi/OpenCode 能力差异必须显式协商，不能伪造同步 Tool Result。
6. **跨 Project 委派需要人工批准，同 Project 自动。** 因为 A3 已能约束同 Project 协作，跨 Project 涉及新的数据边界和意图披露。
7. **取消复用现有 Run/Session 三态竞态处理。** 因为另造取消状态机会重新引入 accepted 等同 stopped 的历史缺陷。
8. **逐 token 与金额预算推迟 M8。** 因为 Provider usage 延迟、多子项原子预留和价格变化需要独立预算账本，不能在 P2 最小切片中伪装精确。
9. **G49 Routine 与 Delegation 共享底座，不互相依赖。** 因为前者是外部或时间触发，后者是父子 Invocation 协作，合并会形成浅而混乱的通用调度器。
10. **画布只投影权威关系。** 因为浏览器连线、节点位置和 React Flow 对象均不能承担授权、恢复或生命周期。
