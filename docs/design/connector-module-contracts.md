# 连接器模块 G42 契约

状态：G42 冻结基线

日期：2026-09-27

适用阶段：G43、G44、G45、G46

本文把 [connector-module-borrow-and-hexagon-boundaries.md](./connector-module-borrow-and-hexagon-boundaries.md) 第四节的 22 个问题冻结为可测试契约。后续实现可以增加更严格的限制，但不得降低本文的授权、秘密隔离、失败关闭、幂等和资源上限要求。若实现需要改变本文契约，必须先修改本文并补充验收证据。

## 1. 来源标记

每项裁定使用以下来源标记：

| 标记 | 含义 |
|---|---|
| `[设计 §x]` | 来源于主设计文档对应章节 |
| `[现有 A3]` | 来源于 `packages/server-domain/src/access.ts`、`identity.ts` 及现有访问服务 |
| `[现有 wire]` | 来源于 `packages/wire-protocol/src/` 的 Command、Event、capability 与 transport v2 形态 |
| `[现有 Worker]` | 来源于 Worker 的 `CapabilityGateway`、capability token/snapshot 与 Agent approval 能力声明 |
| `[上游 types]` | 借鉴 open-connector `src/core/types.ts` |
| `[上游 policy]` | 借鉴 open-connector `src/core/action-policy.ts` 的多层求交与失败关闭形状 |
| `[新增裁定]` | G42 为 Wemux Lite 双宿主边界新增的冻结决定 |

## 2. 标识、时间与通用约束

1. `projectId` 必须使用 `@wemux/domain` 的 `ProjectId`，即现有 `Id<'ProjectId'>` 形态，不另造 Project 标识。[现有 A3]
2. `workspaceId`、`sessionId`、`turnId`、`toolCallId`、`workerId` 分别复用 `WorkspaceId`、`SessionId`、`TurnId`、`ToolCallId`、`WorkerId`。[现有 wire]
3. `ConnectorId`、`ChannelId`、`ChannelBindingId`、`ConnectorCredentialId` 在 `packages/connector` 中定义为 branded string。它们不进入 `packages/domain`，因为当前只有连接器模块消费这些标识。[新增裁定]
4. 时间均为 UTC ISO 8601 字符串，类型实现时可复用 `Timestamp`。[现有 wire]
5. `revision` 是从 1 开始的安全整数。每次语义变更恰好加 1；健康探测、最后使用时间等观测值不得推动定义 revision。[新增裁定]
6. 所有输入对象拒绝未知字段、NUL 字符、非有限数字和超过本文上限的值。JSON 指纹使用稳定键排序的 UTF-8 规范化 JSON，再计算 SHA-256 小写十六进制摘要。[设计 §2.3][新增裁定]

## 3. 实体契约

以下 TypeScript 是冻结的逻辑形状。实现可拆文件，但字段语义和判别条件不得漂移。

### 3.1 ConnectorDefinition

```ts
export type OperationType = 'read' | 'write' | 'destructive'
export type CredentialAvailability =
  | 'not_required'
  | 'unconfigured'
  | 'available'
  | 'unavailable'
  | 'invalid'

export interface ConnectorRiskDefaults {
  readonly requireApprovalForRead: boolean
  readonly allowMcpReadOnlyHint: boolean
}

export interface ConnectorDefinitionBase {
  readonly id: ConnectorId
  readonly projectId: ProjectId
  readonly name: string
  readonly description: string | null
  readonly revision: number
  readonly enabled: boolean
  readonly allowedWorkerIds: readonly WorkerId[]
  readonly credentialRef: ConnectorCredentialId | null
  readonly credentialAvailability: CredentialAvailability
  readonly riskDefaults: ConnectorRiskDefaults
  readonly createdAt: Timestamp
  readonly updatedAt: Timestamp
}

export type ConnectorDefinition =
  | McpConnectorDefinition
  | HttpConnectorDefinition

export interface McpConnectorDefinition extends ConnectorDefinitionBase {
  readonly kind: 'mcp'
  readonly config: McpConnectorConfig
}

export type McpConnectorConfig =
  | {
      readonly transport: 'stdio'
      readonly command: string
      readonly args: readonly string[]
      readonly cwd: string | null
      readonly publicEnvironment: Readonly<Record<string, string>>
      readonly secretEnvironmentNames: readonly string[]
    }
  | {
      readonly transport: 'streamable_http'
      readonly url: string
      readonly publicHeaders: Readonly<Record<string, string>>
      readonly authentication: 'none' | 'api_key' | 'custom_credential'
      readonly allowPrivateNetwork: boolean
    }

export interface HttpConnectorDefinition extends ConnectorDefinitionBase {
  readonly kind: 'http'
  readonly config: {
    readonly baseUrl: string
    readonly allowedOperations: readonly HttpOperationDefinition[]
    readonly authentication: 'none' | 'api_key' | 'custom_credential'
    readonly publicHeaders: Readonly<Record<string, string>>
    readonly allowPrivateNetwork: boolean
  }
}

export interface HttpOperationDefinition {
  readonly id: string
  readonly description: string
  readonly method: 'GET' | 'HEAD' | 'OPTIONS' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  readonly pathTemplate: string
  readonly allowedQueryNames: readonly string[]
  readonly allowedRequestHeaderNames: readonly string[]
  readonly requestContentTypes: readonly ('application/json' | 'text/plain' | 'application/x-www-form-urlencoded')[]
  readonly operationTypeOverride: OperationType | null
}
```

字段裁定：

1. `allowedWorkerIds` 是收窄条件。空数组表示 Project 可用的任意 Worker，但仍必须通过 Worker `use` 授权，不表示全实例开放。[设计 §2.4][上游 policy]
2. `credentialRef` 只是宿主本地引用。Worker 凭证引用只在目标 Worker 有意义，Server 不解析它。飞书 Channel 使用 Server 本地凭证引用。[设计 §2.3]
3. `credentialAvailability` 是安全状态投影，不保证下一次调用成功，不携带账户秘密。[新增裁定]
4. stdio `command` 必须是 Worker 本地管理员配置的绝对路径，或解析到 Worker 管理安装目录的固定命令。Agent 输入不得改变它。`cwd` 必须是空值或 Session Workspace 根目录及其子目录，规范化后不得越界。[设计 §4.3.11][新增裁定]
5. `publicEnvironment` 只允许明确的非秘密值。`secretEnvironmentNames` 只列变量名，变量值从本地 `CredentialRecord` 解析，二者键集合不得重叠。[设计 §2.4]
6. HTTP 路径模板只允许替换 path segment，不允许替换 scheme、host、port、userinfo 或片段。认证 header 在执行器最后注入，Agent 输入不得覆盖。[设计 §2.6]
7. 首版不包含 OAuth、动态 provider catalog、任意 proxy、插件注册表。[设计 §1 #12、#16、#17]

来源：[设计 §2.4、§2.6、§4.1.1][上游 types 的 `ActionOperationType` 与声明执行分离][新增裁定]

### 3.2 Channel

```ts
export type Channel = GenericWebhookChannel | FeishuChannel

export interface ChannelBase {
  readonly id: ChannelId
  readonly projectId: ProjectId
  readonly name: string
  readonly credentialRef: ConnectorCredentialId
  readonly credentialAvailability: Exclude<CredentialAvailability, 'not_required'>
  readonly enabled: boolean
  readonly revision: number
  readonly createdAt: Timestamp
  readonly updatedAt: Timestamp
}

export interface GenericWebhookChannel extends ChannelBase {
  readonly kind: 'generic_webhook'
  readonly config: {
    readonly tokenVersion: number
    readonly previousTokenValidUntil: Timestamp | null
    readonly replayWindowSeconds: 300
    readonly sourceCidrs: readonly string[]
  }
}

export interface FeishuChannel extends ChannelBase {
  readonly kind: 'feishu'
  readonly config: {
    readonly appIdHint: string
    readonly verificationMode: 'verification_token' | 'signature' | 'encrypted'
    readonly acceptEventSchema: '2.0'
    readonly tenantKey: string | null
  }
}
```

1. `appIdHint` 只允许脱敏展示，例如保留末 4 位，不得保存完整 `app_id`。完整 `app_id`、`app_secret`、verification token、encrypt key 均属于 Server 本地密文。[设计 §2.5][新增裁定]
2. `sourceCidrs` 只作附加信号，绝不能替代 bearer token、飞书验签或解密验证。空数组表示不做来源 IP 收窄。[设计 §4.4.21]
3. generic webhook token 轮换时新 token 立即生效，旧 token 最多保留 15 分钟；`previousTokenValidUntil` 是非秘密状态。[新增裁定]

### 3.3 ChannelBinding

```ts
export interface ChannelBinding {
  readonly id: ChannelBindingId
  readonly projectId: ProjectId
  readonly channelId: ChannelId
  readonly externalConversationKey: string
  readonly sessionId: SessionId
  readonly workerId: WorkerId
  readonly triggerPolicy: ChannelTriggerPolicy
  readonly senderAllowlist: readonly string[]
  readonly revision: number
  readonly enabled: boolean
  readonly createdAt: Timestamp
  readonly updatedAt: Timestamp
}

export type ChannelTriggerPolicy =
  | { readonly kind: 'always' }
  | { readonly kind: 'mention_only' }
  | { readonly kind: 'private_chat_or_mention' }
```

1. `workerId` 必须等于目标 Session 当前绑定的 Worker，只作为创建时和投递时的一致性检查，不赋予权限。[设计 §2.7][现有 A3]
2. `senderAllowlist` 使用平台稳定 sender id。空数组表示允许该 conversation 中任何已通过平台鉴权的 sender。它是收窄条件，不是 Wemux User Grant。[新增裁定]
3. 首条未绑定消息不自动创建 Session、不自动创建 binding、不调用 Agent。系统持久化为 `unbound` 诊断终态并成功 ACK，管理员可随后显式绑定并选择是否人工重放。[设计 §4.4.20][新增裁定]

### 3.4 CredentialRecord

```ts
export interface CredentialRecord {
  readonly id: ConnectorCredentialId
  readonly owner:
    | { readonly kind: 'connector'; readonly connectorId: ConnectorId }
    | { readonly kind: 'channel'; readonly channelId: ChannelId }
  readonly authType: 'api_key' | 'custom_credential'
  readonly ciphertext: string
  readonly profile: {
    readonly accountId: string | null
    readonly displayName: string | null
    readonly grantedScopes: readonly string[]
  }
  readonly revision: number
  readonly createdAt: Timestamp
  readonly updatedAt: Timestamp
}
```

1. 该实体只存在于对应宿主的 H2 存储端口，绝不进入 wire、Web DTO、Journal、审计 metadata 或 Agent 上下文。[设计 §2.5][上游 types 的 `ResolvedCredential`]
2. `profile` 只能保存提供方明确允许展示的非秘密账户标识和 scope。原始 token 响应、header、环境变量值不得进入 profile。[新增裁定]
3. 不提供“列出全部明文”接口。解析接口必须按 owner 与期望 revision 精确读取，并返回短生命周期内存对象。[设计 §2.5]

### 3.5 ToolCall

```ts
export interface ToolCall {
  readonly requestId: string
  readonly fingerprint: string
  readonly projectId: ProjectId
  readonly workspaceId: WorkspaceId
  readonly sessionId: SessionId
  readonly turnId: TurnId
  readonly toolCallId: ToolCallId
  readonly connectorId: ConnectorId
  readonly connectorRevision: number
  readonly action:
    | { readonly kind: 'mcp'; readonly toolName: string }
    | { readonly kind: 'http'; readonly operationId: string }
  readonly operationType: OperationType
  readonly input: unknown
  readonly actor: {
    readonly kind: 'agent'
    readonly agentId: SessionId
    readonly requestedByAccountId: UserId | null
    readonly channelDeliveryId: string | null
  }
  readonly createdAt: Timestamp
}
```

`operationType` 是 Worker 按第 5 节规则重新推导后的权威值，不信任 Agent 提交值。输入中的同名字段若存在必须拒绝。[设计 §2.6][新增裁定]

### 3.6 ExecutionResult

```ts
export type ConnectorExecutionErrorCode =
  | 'invalid_input'
  | 'scope_denied'
  | 'approval_required'
  | 'approval_denied'
  | 'credential_unavailable'
  | 'connector_unavailable'
  | 'revision_conflict'
  | 'idempotency_conflict'
  | 'timeout'
  | 'cancelled'
  | 'upstream_error'
  | 'rate_limited'
  | 'response_too_large'
  | 'unsafe_destination'
  | 'unsupported_content_type'
  | 'internal_error'

export type ExecutionResult<T = unknown> =
  | {
      readonly ok: true
      readonly output: T
      readonly requestId: string
      readonly connectorRevision: number
      readonly completedAt: Timestamp
    }
  | {
      readonly ok: false
      readonly error: {
        readonly code: ConnectorExecutionErrorCode
        readonly message: string
        readonly retryable: boolean
        readonly retryAfterMs: number | null
      }
      readonly requestId: string
      readonly connectorRevision: number | null
      readonly completedAt: Timestamp
    }
```

错误码语义：

| 错误码 | 语义与产生场景 | `retryable` 默认值 |
|---|---|---:|
| `invalid_input` | schema、字段白名单、路径模板、方法或 MCP 参数不合法 | false |
| `scope_denied` | A3 Project、Worker、Session、`allowedWorkerIds` 或 `allowedConnectorIds` 任一不满足；撤权后的新调用也使用此码 | false |
| `approval_required` | 调用需要审批，但尚未得到决策；只用于可交互的中间响应，不是最终成功 | true |
| `approval_denied` | 用户拒绝、等待超过 5 分钟、Agent 不支持审批、Channel 触发无法审批，或策略禁止豁免 | false |
| `credential_unavailable` | 缺 key、未配置、解密失败、凭证 revision 不匹配或凭证验证已失效 | false |
| `connector_unavailable` | 定义禁用、Worker 不允许、MCP 熔断、目标实现未安装或 Channel 已停用 | 视健康状态而定 |
| `revision_conflict` | 调用引用的 connector revision 已不是当前 revision | true |
| `idempotency_conflict` | 同一身份已绑定不同 fingerprint | false |
| `timeout` | 启动、连接、读取、总调用或审批超时 | 对 read 可为 true；write/destructive 默认为 false |
| `cancelled` | Turn 停止、Session 删除、Worker shutdown 或撤权检查在副作用发送前取消 | false |
| `upstream_error` | MCP server、HTTP 服务或飞书返回非限流临时/永久错误 | 由状态和 operationType 决定 |
| `rate_limited` | 上游 429 或明确限流响应 | true，附 `retryAfterMs` |
| `response_too_large` | 压缩前、解压后、JSON 深度、Agent 输出、工具列表或 schema 超限 | false |
| `unsafe_destination` | SSRF、DNS、redirect、私网双开关或地址分类失败关闭 | false |
| `unsupported_content_type` | 响应或请求 content type 不在定义白名单 | false |
| `internal_error` | 未分类内部错误；对外不得携带堆栈、路径、Secret | false |

写与 destructive 调用只有在执行器能证明副作用尚未发出时，`timeout`、`upstream_error` 才可标为可重试。否则必须 `retryable: false`，由同一 requestId 查询终态，不能生成新身份盲重试。[设计 §1 #2、#7、#10][上游 types][新增裁定]

## 4. A3 授权矩阵

### 4.1 复用的现有事实与最小新增字段

复用：

| 目的 | 现有事实 |
|---|---|
| Project 可见、可使用、可管理 | `Project.ownerId`、`ProjectGrant`、`ProjectGrantRole`、`ResourceShareScope` |
| Worker 可使用、可管理 | `Worker.ownerId`、`WorkerGrant`、`WorkerGrantRole`、`ResourceShareScope` |
| Session 可见、可写、可控制 | `Session.ownerId`、`SessionGrant`、`SessionShareScope`，以及现有 `SessionAccessService` 的 `canRead/canWrite/canControl` |
| Agent 是否支持审批 | `AgentRuntimeCapabilities.approvals` |
| Turn 与 capability 绑定 | `CapabilitySnapshot`、`CapabilityGrantClaims`、`sessionId`、`turnId` |

新增且只有以下字段：

1. `CapabilitySnapshot.allowedConnectorIds: readonly ConnectorId[]`。
2. `CapabilityGrantClaims.allowedConnectorIds: readonly ConnectorId[]`。
3. wire 的 `CapabilityGrantPayload.allowedConnectorIds: readonly ConnectorId[]`。
4. `ConnectorDefinition.allowedWorkerIds: readonly WorkerId[]`。

不得新增 `ConnectorGrant`、Connector share scope、Channel Grant 或平行的用户角色。[设计 §1 #8、§1.1.3][现有 A3]

### 4.2 H1 CRUD

| 操作 | Project owner | Project manager | contributor | viewer | 无 Project 权限 |
|---|---:|---:|---:|---:|---:|
| 列表、读取安全投影 | 允许 | 允许 | 允许 | 允许 | 隐藏为 404 |
| 创建、更新、启停、删除 | 允许 | 允许 | 拒绝 403 | 拒绝 403 | 隐藏为 404 |
| 分发 revision、触发目标 Worker 测试 | 允许 | 允许 | 拒绝 403 | 拒绝 403 | 隐藏为 404 |
| 查看 credential 安全状态 | 允许 | 允许 | 允许 | 允许 | 隐藏为 404 |
| 写入 Worker Secret | 集群 Web 不提供 | 集群 Web 不提供 | 集群 Web 不提供 | 集群 Web 不提供 | 集群 Web 不提供 |

Project owner 是 `Project.ownerId` 派生角色，不新增到 `ProjectGrantRole`。[现有 A3][新增裁定]

### 4.3 H3 调用求交

每次调用必须同时满足下列全部条件，任一失败返回 `scope_denied`：

1. capability token 签名、有效期、`sessionId`、`turnId`、`projectId`、`workspaceId` 与当前 Turn 完全匹配。
2. 发起该 Turn 的集群账号仍有 Project `contributor` 或更高权限。Worker 本地 Session 没有集群账号时，使用本地已认证管理员作为调用主体，并仍受本地 Session 边界约束。
3. 该账号对目标 Worker 具有 `use`、`manage` 或 owner 身份。
4. 该账号对 Session 具有 `canWrite`。仅 SessionGrant 带来的可读性不能产生调用权。
5. `connectorId` 同时出现在 snapshot 与 grant 的 `allowedConnectorIds` 中。
6. Connector 属于同一 `projectId`，处于 enabled，revision 匹配。
7. `allowedWorkerIds` 为空或包含 Session 绑定的 Worker。

`allowedConnectorIds` 在 Server 创建 Turn capability snapshot 时求值并签名，但 Worker 执行前仍要验证不可变 snapshot、当前本地 definition revision 和 Worker 范围。Server 侧撤权通知或后续命令不能把已有 snapshot 扩大。[设计 §2.6][上游 policy][现有 Worker]

### 4.4 撤权与在途调用

1. 新调用立即按最新授权拒绝。[新增裁定]
2. 已通过授权但尚未向上游写出任何字节的调用必须取消，终态为 `cancelled` 或 `scope_denied`。[新增裁定]
3. 已向上游发出 read 请求的调用可以完成，但撤权后结果不得再注入 Agent，只保留安全审计终态。[新增裁定]
4. 已发出 write/destructive 副作用无法承诺回滚。执行器必须停止后续分页或复合步骤，记录 `completed_after_revocation` 审计标记，并以原 requestId 固化结果，禁止自动换身份重试。[新增裁定]
5. Connector disable、Project/Worker/Session Grant 撤销、Session 删除、binding disable 均触发相同失败关闭规则。[设计 §4.1.2、§4.4.20]

### 4.5 H4 binding

创建、更新、启停、删除 binding 必须同时满足：

1. 操作者是 Project owner 或 manager。
2. 操作者对目标 Session 有 `canControl`。
3. 操作者对目标 Worker 有 `use` 或更高权限。
4. Channel、Session 位于同一 Project，`workerId` 与 Session 绑定一致。

每次入站投递都重新检查 Channel enabled、binding enabled、Project 存在、Session 未删除、Session 与 Worker 绑定一致，以及创建 binding 的权限条件仍可由当前资源事实满足。权限撤销后旧 binding 立即失效，不因历史创建者身份继续扩大访问。binding 不是 Grant。[设计 §2.7][现有 A3][新增裁定]

## 5. operationType 推导与审批

### 5.1 唯一推导顺序

风险只能上调，不能下调。风险排序为 `read < write < destructive`。[上游 types][新增裁定]

HTTP：

1. 基础风险：`GET`、`HEAD`、`OPTIONS` 为 read；`POST`、`PUT`、`PATCH` 为 write；`DELETE` 为 destructive。
2. `operationTypeOverride` 只能把基础风险调高。配置为更低风险时定义保存失败。
3. 最终值是基础风险与 override 的较高者。

MCP：

1. `destructiveHint: true` 时为 destructive。
2. `readOnlyHint: true` 且 `destructiveHint` 不为 true、没有其他冲突注解，并且 Connector 的 `allowMcpReadOnlyHint` 为 true时为 read。
3. 其余情况，包括注解缺失、未知、矛盾、动态变化，均为 write。
4. Worker 本地管理员可对具体工具配置更高风险覆盖，但不能配置更低风险。
5. 工具 schema 或注解相对已缓存 revision 发生变化时，旧 revision 调用返回 `revision_conflict`，刷新后重新推导。

来源：[设计 §1 #9、§2.6、§4.1.3][上游 types][新增裁定]

### 5.2 审批矩阵

首版策略：read 默认不需要审批；`requireApprovalForRead` 可把 read 收紧为需要审批；write 和 destructive 永远需要每次调用审批。Project manager/owner 白名单只能收窄可调用工具或把风险上调，不能豁免 write/destructive 审批。[设计 §1.1.2][新增裁定]

表中“通道触发”指该 Turn 的来源带 `channelDeliveryId`，无人在线审批是协议事实，不因后台恰好有管理员登录而改变。

| operationType | Agent 支持交互审批 | 通道触发 | 结果 |
|---|---:|---:|---|
| read，未强制审批 | 是 | 否 | 通过授权后执行 |
| read，未强制审批 | 否 | 否 | 通过授权后执行 |
| read，未强制审批 | 是 | 是 | 通过授权后执行 |
| read，未强制审批 | 否 | 是 | 通过授权后执行 |
| read，强制审批 | 是 | 否 | 发起审批，批准后执行，拒绝或 5 分钟超时为 `approval_denied` |
| read，强制审批 | 否 | 否 | 失败关闭为 `approval_denied` |
| read，强制审批 | 是 | 是 | 失败关闭为 `approval_denied`，不创建悬空审批 |
| read，强制审批 | 否 | 是 | 失败关闭为 `approval_denied` |
| write | 是 | 否 | 每次调用发起审批，批准后执行 |
| write | 否 | 否 | 失败关闭为 `approval_denied` |
| write | 任意 | 是 | 失败关闭为 `approval_denied` |
| destructive | 是 | 否 | 每次调用发起高风险审批，批准后执行 |
| destructive | 否 | 否 | 失败关闭为 `approval_denied` |
| destructive | 任意 | 是 | 失败关闭为 `approval_denied` |

审批绑定 `(sessionId, turnId, toolCallId, requestId, fingerprint, connectorRevision, operationType)`，任何字段变化都必须重新审批。Agent 原生 approval 事件可以承载 UI 交互，但 H3 网关保存的审批事实才是连接器执行依据。[现有 Worker][新增裁定]

## 6. 幂等、CAS 与身份保留

### 6.1 通用 requestId 与 fingerprint

| 情况 | 结果 |
|---|---|
| 首次 `requestId` | 原子保存 requestId、fingerprint 与进行中状态，然后执行 |
| 同 requestId、同 fingerprint、已完成 | 返回原终态，不重复副作用 |
| 同 requestId、同 fingerprint、进行中 | 返回同一进行中记录或等待同一 Promise，不启动第二次执行 |
| 同 requestId、不同 fingerprint | 返回 `idempotency_conflict`，HTTP 管理接口映射 409 |
| 同 requestId 的记录已过保留期 | 客户端不得重用；服务端可按新请求处理，但审计必须标记身份窗口已过 |

`requestId` 限 200 个 UTF-8 字节。fingerprint 覆盖全部语义输入，不覆盖时间戳、trace id、传输序号等非语义字段。[设计 §1 #10][现有幂等模式][新增裁定]

### 6.2 CAS revision

1. H1 Connector、H4 Channel、ChannelBinding 的 update、enable、disable、delete 请求必须携带 `expectedRevision`。
2. `expectedRevision` 不等于当前 revision 时返回 409 `revision_conflict`，不得部分写入。
3. create 使用 `expectedRevision: null`；同 requestId 重试返回已创建实体。
4. delete 是带 revision 的 tombstone 或终态写入，不能先删除幂等记录。
5. H1/H4 的 requestId 记录与实体变更、审计、outbox 入队必须在同一 SQLite 事务提交。[设计 §4.1.4][新增裁定]

### 6.3 H3 工具调用身份

H3 不直接采用 transport `messageId`。身份生成规则：

```text
requestId = "tool:" + sessionId + ":" + turnId + ":" + toolCallId
fingerprint = sha256(canonicalJson({
  projectId, workspaceId, sessionId, turnId, connectorId,
  connectorRevision, action, operationType, input
}))
```

1. Agent adapter 必须提供稳定 `toolCallId`。若上游 Agent 没有稳定 id，Worker 在首次观察该工具调用时生成并持久化映射，重放同一 Turn 复用该 id。
2. H3 记录保留 24 小时，从终态写入时计算。进行中记录不因到期删除。
3. write/destructive 的审计摘要保留期不受 24 小时幂等窗口影响。
4. 同 Turn 中内容相同但 toolCallId 不同，视为两次明确调用，分别审批和执行。

来源：[设计 §4.1.4][现有 wire 对 application identity 与 transport identity 的分离][新增裁定]

### 6.4 H4 event 与 delivery 身份

入站：

```text
inboundEventId = channelId + ":" + providerEventId
fingerprint = sha256(canonicalJson(normalizedAuthenticatedEnvelope))
sessionEnqueueRequestId = "channel-in:" + inboundEventId
```

出站：

```text
outboundDeliveryId = channelId + ":" + bindingId + ":" + journalEventIdentity
providerIdempotencyUuid = sha256(outboundDeliveryId) 的前 32 个十六进制字符
```

1. 飞书 `providerEventId` 使用官方 `event_id`。保留 7 天，重复同 fingerprint 成功 ACK 且不重复 enqueue；同 id 异 fingerprint 记录安全冲突并拒绝业务投递。
2. generic webhook 优先使用 `X-Wemux-Delivery-Id`，长度 1 至 200 字节。缺失时使用 `sha256(tokenVersion + receivedMinuteBucket + body)` 降级去重，只保证 5 分钟窗口，并在诊断中标为 `weak_identity`。
3. Inbound 终态记录保留 7 天；Outbound 终态与死信保留 30 天；未完成记录不得按期限删除。
4. 管理员重放复用原 `outboundDeliveryId` 并增加 attempt，不生成新业务身份。要有意再次发送，必须创建显式 `redeliveryId` 并审计原因。

来源：[设计 §2.7、§4.4.15、§4.4.21、§4.4.22][新增裁定]

## 7. wire allowlist 与秘密扫描

### 7.1 允许的 connector Command

Connector 相关 `WorkerCommand` 只允许增加以下三种形状：[设计 §2.3][现有 wire]

```ts
| {
    readonly kind: 'connector.definition.sync'
    readonly requestId: string
    readonly definition: ConnectorWireSnapshot
  }
| {
    readonly kind: 'connector.definition.revoke'
    readonly requestId: string
    readonly connectorId: ConnectorId
    readonly projectId: ProjectId
    readonly revision: number
  }
| {
    readonly kind: 'connector.test'
    readonly requestId: string
    readonly connectorId: ConnectorId
    readonly projectId: ProjectId
    readonly workerId: WorkerId
    readonly connectorRevision: number
  }
```

`ConnectorWireSnapshot` 只允许：

- `id`、`projectId`、`kind`、`name`、`description`
- `revision`、`enabled`、`allowedWorkerIds`
- `credentialRef`、`credentialAvailability`
- `riskDefaults`
- MCP 的 transport、command、args、cwd、`publicEnvironment`、`secretEnvironmentNames`、url、`publicHeaders`、authentication、`allowPrivateNetwork`
- HTTP 的 baseUrl、allowedOperations、authentication、`publicHeaders`、`allowPrivateNetwork`
- `createdAt`、`updatedAt`

### 7.2 允许的 connector Event/receipt

Worker 到 Server 只允许：

```ts
| {
    readonly type: 'event'
    readonly scope: 'connector'
    readonly report: ConnectorRevisionReport
  }
```

`ConnectorRevisionReport` 只允许：

- `requestId`、`connectorId`、`projectId`、`workerId`
- `revision`
- `status: 'applied' | 'revoked' | 'unavailable' | 'test_succeeded' | 'test_failed'`
- `credentialAvailability`
- `errorCode: ConnectorExecutionErrorCode | null`
- `message`，最多 512 字符且必须过安全摘要器
- `occurredAt`

不在 wire 传 ToolCall 的 input/output。H3 工具调用发生在 Worker 本地 capability endpoint 内。Channel、binding、飞书事件和 Server 凭证也不进入 Worker wire。[设计 §2.2、§2.3][新增裁定]

### 7.3 源码扫描测试规则

阶段 1 起增加 AST 或 TypeScript compiler API 扫描测试，扫描：

1. `packages/wire-protocol/src/` 中名称或判别值含 `connector` 的 type、interface、对象属性。
2. `ConnectorWireSnapshot`、connector Command、connector Event 的完整可达类型图。
3. connector fixture 的序列化 JSON 键。

禁止字段名清单的规范写法为：`apiKey`、`appSecret`、`authorization`、`accessToken`、`refreshToken`、`clientSecret`、`verificationToken`、`encryptKey`、`secretValue`、`password`、`passphrase`、`cookie`、`setCookie`、`ciphertext`、`plaintext`、`privateKey`、`bearerToken`。

扫描时把属性名转小写并移除 `_`、`-`，再拒绝等于或包含以下规范化片段：

```text
apikey
appsecret
authorization
accesstoken
refreshtoken
clientsecret
verificationtoken
encryptkey
secretvalue
password
passphrase
cookie
setcookie
ciphertext
plaintext
privatekey
bearertoken
```

例外只允许精确安全元数据名：`credentialRef`、`credentialAvailability`、`secretEnvironmentNames`、`authentication`。例外列表本身必须在测试中固定，新增例外需修改本文。

测试还必须序列化每种 connector Command/Event fixture，并断言其中不出现测试用 sentinel Secret。仅字符串 grep 不足以替代可达类型扫描。[设计 §4.1.5][新增裁定]

## 8. 资源上限默认值

所有限制均可由宿主配置调低。调高属于部署风险选择，必须有启动日志与诊断页可见的非秘密配置快照。metadata、loopback、link-local 等永久阻断规则不可通过调参放开。[设计 §4.2.9]

| 项目 | 首版默认 | 理由 |
|---|---:|---|
| TCP/TLS connect 超时 | 5 秒 | 局域网与公网均可诊断，同时避免连接悬挂占满 Worker |
| 单次读取空闲超时 | 15 秒 | 流在 15 秒无字节时视为失活，早于总调用超时暴露故障 |
| HTTP/MCP HTTP 总调用超时 | 30 秒 | 对齐上游 provider 默认，并给 Agent 可预期等待边界 |
| 请求 header 总字节 | 32 KiB | 足够常见 API，同时限制 header 放大 |
| 请求体 | 1 MiB | 覆盖 JSON 工具参数，不允许 Agent 借连接器传大文件 |
| 压缩前响应体 | 4 MiB | 限制网络与内存占用，必须流式计数 |
| 解压后响应体 | 16 MiB | 允许常见压缩比，同时防解压炸弹 |
| JSON 深度 | 32 层 | 高于常见 API 数据，低于可造成递归资源风险的深度 |
| JSON 节点数 | 100,000 | 深度限制之外再约束宽对象与大数组 |
| 给 Agent 的结构化输出 | 256 KiB | 保留有效工具结果，同时控制上下文膨胀 |
| Journal 摘要 | 16 KiB | 对齐上游摘要经验，避免审计记录无限增长 |
| Journal 摘要节点 | 256 | 对齐上游安全摘要器的有界遍历 |
| Journal 摘要深度 | 4 层 | 审计只保留概要，不复制完整响应 |
| Journal 单字符串 | 256 字符 | 足够诊断且降低 Secret 与大文本泄露面 |
| redirect 次数 | 5 次 | 覆盖常见跳转，又限制 SSRF 重检与循环成本 |
| MCP 工具列表数量 | 128 个 | 避免恶意 server 将海量工具注入 Agent |
| MCP 工具列表序列化字节 | 1 MiB | 给 128 个中等 schema 留空间，同时可流式拒绝超大目录 |
| 单个 MCP 工具 schema 字节 | 64 KiB | 足够复杂输入，避免单工具挤占全部预算 |
| MCP schema 深度 | 16 层 | 覆盖常见 JSON Schema，限制递归与恶意嵌套 |
| MCP 单次 stdout 协议消息 | 16 MiB | 与解压后响应上限一致，超限立即终止对应进程 |
| capability endpoint 请求体 | 1 MiB | 保持现有 `CapabilityGateway` 上限，不扩大攻击面 |

响应超限必须在流式读取时中止，不得完整缓冲后截断。Agent 输出只从已经通过 content type、大小、深度和凭证泄漏检测的响应生成。[设计 §1.1.5、§2.6][新增裁定]

## 9. 网络与 DNS 安全

1. `allowPrivateNetwork` 的有效值是部署级 `WEMUX_CONNECTOR_ALLOW_PRIVATE_NETWORK=true` 与 Connector 定义值同时为 true。[设计 §4.2.8]
2. loopback、link-local、unspecified、multicast、broadcast、常见云 metadata 地址和带 userinfo URL 永久阻断。私网开关不能放开这些范围。[设计 §1 #6]
3. URL 字面量、DNS 每个 A/AAAA 结果、每跳 redirect 都必须检查。解析失败、多地址中任一地址被阻断、地址分类未知时失败关闭。[设计 §1 #6]
4. 跨 origin redirect 删除认证 header 与自定义敏感 header，再由目标定义决定是否允许继续。Agent 不能要求保留。[设计 §2.6]
5. 首版不支持 split DNS trusted-host 例外。企业内网应使用私网双开关并让所有解析地址都属于允许的 private 分类。[新增裁定]
6. 接受普通 fetch 在 DNS 检查与实际连接间存在 TOCTOU。默认部署必须记录此残余风险；面向不可信 DNS 或多租户高风险环境时，部署者必须禁用连接器出站，直至实现地址 pinning transport。[设计 §4.2.10][新增裁定]

OPEN-1，非 G43-G46 阻塞项：是否在后续版本提供 Node 自定义 dispatcher 的地址 pinning。推荐在出现多租户或敌对 DNS 部署需求时实施，首版不承诺该模式。

## 10. MCP 生命周期契约

### 10.1 stdio 允许规则

1. `command` 由 Worker 本地管理员选择，集群定义只能引用 Worker 已批准的 executable identity。集群 Web 不能下发任意绝对命令。[新增裁定]
2. `args` 每项最多 4 KiB，总计最多 32 KiB，拒绝 NUL。Agent 不得拼接或替换参数。[新增裁定]
3. `cwd` 只能是 Session Workspace 根或其子目录。不存在、符号链接解析后越界、无权限均失败关闭。[新增裁定]
4. 环境变量采用最小环境基线。只注入 Worker 明确允许的系统变量、`publicEnvironment` 与凭证解析后的指定 Secret。不得继承完整 Worker 进程环境。[新增裁定]
5. MCP server 与用户自装 Agent CLI 同级信任：能按 Worker 进程账户访问文件和网络，不构成操作系统沙箱。UI 必须在启用前展示此威胁模型。[设计 §4.3.11]

### 10.2 隔离、超时与容量

| 参数 | 首版默认 | 行为与理由 |
|---|---:|---|
| 进程隔离 | 每个活跃 Session/connector 一个进程 | 防止跨 Session 状态与 Secret 串用 |
| 启动超时 | 10 秒 | 足够本地 CLI 初始化，超时后终止进程 |
| 单次调用超时 | 30 秒 | 与 HTTP 总调用超时一致，便于统一错误语义 |
| 空闲回收 | 5 分钟 | 对齐现有 RuntimeSessionManager 默认，兼顾冷启动与资源回收 |
| Worker 最大 MCP 进程数 | 16 | 自托管单机的保守初值，超限排队最多 30 秒后 unavailable |
| 单 Session 最大 MCP 进程数 | 2 | 防止一个 Session 垄断 Worker |
| stderr 尾部内存 | 每进程 64 KiB | 足够诊断，只保留环形尾部并先脱敏 |
| 启动期 stdout/stderr 合计 | 1 MiB | 防止错误进程在握手前刷屏耗尽内存 |
| 崩溃退避 | 1、2、4、8、16、30 秒 | 指数退避且有上限，避免崩溃忙循环 |
| 熔断条件 | 10 分钟内 5 次崩溃 | 进入 10 分钟 unavailable，需健康探测或管理员重置 |
| 稳定期重置 | 连续运行 5 分钟 | 稳定后清零退避计数 |
| shutdown 优雅等待 | 5 秒 | 先取消 in-flight 并发送 SIGTERM |
| shutdown 强杀等待 | 再 2 秒 | 超时 SIGKILL，Worker 退出前不得遗留孤儿进程 |

调用取消必须传播到 MCP request；取消后晚到结果丢弃但要消费协议帧，避免污染下一次 request。进程崩溃时所有 in-flight 调用终态化为 `upstream_error`，write/destructive 不自动重试。[设计 §2.6、§4.3.12][现有 Worker 生命周期模式][新增裁定]

### 10.3 Streamable HTTP

1. 每个 `(connectorId, revision, credentialRevision)` 可复用一个连接池，最大 4 个并发连接，空闲 60 秒回收。[新增裁定]
2. 认证由执行器最后注入；redirect 跨 origin 时剥离；Agent 参数不能覆盖。[设计 §2.6]
3. Turn cancel、Session delete、revision change、credential revision change、Worker shutdown 都中止相关请求并关闭不可复用连接。[新增裁定]
4. 重连只重放协议允许的无副作用握手。工具调用不因连接断开自动换 requestId 重发。[设计 §2.3]
5. 必须使用与 `http_call` 等价的 SSRF、DNS、redirect 和大小保护。SDK 无法注入 guarded fetch 时不得启用该 transport。[设计 §4.3.13]

### 10.4 工具列表与 revision

1. 首次启用、MCP 进程重启、管理员刷新时获取工具列表。每次列表计算 `toolCatalogRevision = sha256(canonicalJson(safeToolCatalog))`。[新增裁定]
2. 列表超数量、总字节、单 schema 字节或深度时，整个 Connector 标记 unavailable，不做部分截断，因为截断会使 Agent 对能力产生错误假设。[新增裁定]
3. 同一进程返回变化 schema 时创建新 catalog revision。已开始的 Turn 固定旧 revision，新调用要求刷新 capability snapshot。[新增裁定]
4. 工具描述和 schema 均是不可信文本，进入 Agent 前移除控制字符、限制字符串长度，并不得作为系统指令执行。[新增裁定]

## 11. 凭证、密钥与数据流

### 11.1 数据流

```text
Worker 本地管理员
  → Worker 本地工作台 HTTPS/loopback 鉴权
  → H2 Worker CredentialStore
  → AES-256-GCM 密文写 worker.sqlite
  → H3 按 credentialRef 与 revision 在内存解析
  → 最后时刻注入 MCP env 或 HTTP auth header
  → 响应先做上限、类型和 Secret 泄漏检测
  → 安全 Agent 结果与更严格 Journal 摘要

集群 Web
  → Server 只保存 ConnectorDefinition 非秘密字段
  → wire 只下发 definition revision、credentialRef 与状态
  → 永不接收或转发 Worker Secret

Server 管理员
  → Server 管理页
  → H2 Server CredentialStore
  → AES-256-GCM 密文写 server.sqlite
  → H4 仅在飞书验证、token 获取与回复推送时解析
```

来源：[设计 §1.1.4、§2.2、§2.5、§4.2.7][新增裁定]

### 11.2 缺 key 行为

1. 宿主密钥环境变量为 `WEMUX_CONNECTOR_ENCRYPTION_KEY`。[设计 §4.2.6]
2. 缺失或空字符串时 Server 与 Worker 均可启动，基础 Session、Agent 和集群连接不受影响。[新增裁定]
3. H2 capability 报告 `unavailable`，创建、更新、测试、解析凭证均返回 `credential_unavailable`。已有密文保持原样，不删除、不尝试明文解释。[新增裁定]
4. 不含凭证的 Connector 可保存和分发，但需要凭证的执行失败关闭。`authentication: 'none'` 的 Connector 可执行。[新增裁定]
5. 测试只能通过依赖注入显式提供 in-memory fake codec。生产配置不存在 plaintext codec 开关。[设计 §2.5]

### 11.3 `enc:v2` 格式与轮换

冻结格式：

```text
enc:v2:<keyId>:<saltBase64url>:<ivBase64url>:<ciphertextBase64url>:<tagBase64url>
```

1. AES-256-GCM，IV 12 字节随机，tag 16 字节，salt 16 字节随机。[设计 §1 #5][新增裁定]
2. `keyId` 是派生 key 的 SHA-256 前 12 个十六进制字符，只用于查找，不泄露 passphrase。[新增裁定]
3. 每条记录用 scrypt 从宿主 passphrase 与记录 salt 派生 32 字节 key。首版参数固定为 `N=16384, r=8, p=1`。[上游 secret codec 思路][新增裁定]
4. GCM additional authenticated data 固定包含 `owner.kind`、owner id、credential id、authType、revision，防止密文跨记录替换。[新增裁定]
5. 当前写 key 来自 `WEMUX_CONNECTOR_ENCRYPTION_KEY`。读取旧 key 来自 `WEMUX_CONNECTOR_ENCRYPTION_PREVIOUS_KEYS`，格式为逗号分隔 passphrase，最多 3 个。[新增裁定]
6. 轮换采用先备份数据库与旧 key，再配置新 current key 和 previous keys，再运行显式 re-encrypt 命令，逐条事务更新，最后验证全部 keyId 后移除旧 key。失败记录不覆盖原密文。[新增裁定]
7. 备份必须将数据库与 key 分开保存。恢复时必须同时恢复能匹配密文 keyId 的 key；旧 key 丢失不可恢复。[设计 §4.2.6]

### 11.4 旧格式与明文迁移

1. `enc:v1:` 只能由显式迁移入口读取并转换为 `enc:v2`，正常执行路径不得自动迁移。[新增裁定]
2. 无 `enc:` 前缀的旧明文只在显式 `connector credential migrate-plaintext` 入口转换。入口必须要求本地主机管理员确认、先备份、逐条审计，并在成功写入 v2 后清除明文。[设计 §1 #5、§4.2.6]
3. 正常解析遇到旧明文返回 `credential_unavailable`，绝不静默降级。[设计 §2.5]

## 12. 飞书与 H4 可靠性

### 12.1 ACK 内最小事务

公开 webhook 的目标 ACK 时间为接收完整请求后 1 秒内，硬上限 2.5 秒，确保留在飞书 3 秒级重试边界内。ACK 前只允许：[设计 §4.4.15][新增裁定]

1. 按 1 MiB 请求体上限流式读取。
2. 验证 URL verification、verification token/签名，必要时解密。
3. 解析 envelope 版本和 `event_id`。
4. 在一个 SQLite 事务中写入 inbound event identity、fingerprint、认证后的有界原始载荷引用或安全归一化载荷、状态 `accepted`。
5. 同 event id 同 fingerprint 返回成功 ACK；同 id 异 fingerprint 返回 409 并记录安全审计。

binding 查询、sender allowlist、`@bot` 判断、Session enqueue、Agent 执行和回复推送全部异步，不得阻塞 ACK。

### 12.2 飞书事件语义

1. 首版只接受飞书事件 schema `2.0`。[新增裁定]
2. 处理文本消息创建事件。图片、文件、reaction、编辑、撤回和未知事件均成功 ACK，记录 `ignored_unsupported_event`，不投递 Session。[新增裁定]
3. 事件乱序按到达顺序独立处理，不重排。重复由 `event_id` 去重。[新增裁定]
4. 机器人自身消息成功 ACK 并记录 `ignored_self_message`，避免回复环。[新增裁定]
5. 群聊只在明确 `@bot` 且 binding policy 允许时触发；私聊按 `private_chat_or_mention` 或 `always` 触发。mention 从结构化 mention 列表判定，不用纯文本搜索。[新增裁定]
6. `event_id` 与终态保留 7 天，理由是覆盖平台重试、Server 重启和短期故障恢复窗口，同时控制 SQLite 增长。[新增裁定]
7. URL verification challenge 只在完整验证通过后原样返回 challenge，不创建业务事件。[新增裁定]
8. verification token、签名模式与 encrypt key 解密必须使用飞书官方文档格式和官方或由官方样例派生的测试向量。出站 custom bot 签名实现不能复用为入站验证。[设计 §4.4.17]

OPEN-2，非 G43-G46 阻塞项：仓库当前未保存飞书官方测试向量的版本化副本。推荐 G45 实施时在 `apps/server/src/test/fixtures/` 保存来源 URL、抓取日期和脱敏向量，并在验收记录中固定官方文档版本。协议已冻结为 schema 2.0，不影响 H4 内核和 G46 实施。

### 12.3 tenant_access_token 缓存

| 参数 | 冻结值 | 行为 |
|---|---:|---|
| 缓存键 | `(channelId, credentialRevision)` | 凭证轮换立即隔离旧 token |
| 并发 | 单飞 | 同一缓存键并发 miss 只发一个 token 请求 |
| 提前刷新 | `max(5 分钟, expire 的 10%)` | 降低临界过期失败 |
| 401 | 强制丢弃并重取一次 | 原请求最多重放一次，第二次 401 终态失败 |
| Server 重启 | 不持久化 token | 重启后重新获取，避免 bearer token 落盘 |
| token 请求超时 | 10 秒 | 比普通调用更短，防止回复队列长期占用 |
| 429/5xx | 1、2、4、8、16 秒，最多 5 次 | 有界退避，尊重更大的 `Retry-After`，但单次不超过 60 秒 |

来源：[设计 §1 #13、§4.4.18][新增裁定]

### 12.4 回复内容与聚合

1. 只推送最终、可公开的 assistant 文本，不推送 reasoning、工具 input/output、审批状态、partial delta 或内部错误堆栈。[设计 §4.4.19][新增裁定]
2. partial delta 在 Turn 内聚合，收到成功 `turn.finished` 后生成一次或按长度分片的 outbound delivery。失败 Turn 可推送一条不含内部细节的固定错误提示，由 Channel 配置决定是否启用。[新增裁定]
3. 单条飞书文本按 4,000 个 Unicode code point 分片，最多 10 片。超过 40,000 code point 时只发送前 10 片并附截断提示，原文仍只留在 Wemux Journal 权限边界内。[新增裁定]
4. 首版输出纯文本。富文本输入降级为安全纯文本，不发送 HTML。回复引用只在入站 message id 可验证且 API 支持时使用，失败后降级为普通消息一次。[新增裁定]
5. 每片使用稳定 `providerIdempotencyUuid = sha256(outboundDeliveryId + ':' + partIndex)` 前 32 位。[新增裁定]

### 12.5 Outbox 重试、死信与停用

| 项目 | 冻结值或行为 |
|---|---|
| 状态 | `pending | sending | delivered | retry_wait | dead_letter | cancelled` |
| 临时失败 | 网络错误、429、飞书 5xx，按 1、2、4、8、16、32 秒退避，加 0 至 20% jitter |
| 最大尝试 | 总计 6 次，首次加 5 次重试 |
| 永久失败 | 鉴权 4xx、binding 失效、权限撤销、内容非法直接 `dead_letter` |
| sending 租约 | 60 秒，Server 崩溃后可回收为 retry_wait |
| 管理员重放 | Project owner/manager 且 binding 仍有效；复用 delivery identity，增加 attempt 与审计原因 |
| Channel disable | 尚未 sending 的记录转 `cancelled`；正在发送的请求尽力取消，晚到成功按 delivered 记录 |
| Channel delete | 先 disable，再等待 60 秒 sending 租约，保留 30 天诊断记录，删除凭证前确认无进行中投递 |

纯 transport ACK、SSE 刷新或定时查询不得重新创建 outbox 项。只有新 Journal 终态事件、租约回收和管理员显式重放能推进投递。[设计 §4.4.22][现有可靠投递约束][新增裁定]

### 12.6 generic webhook

1. 请求体上限 1 MiB。[新增裁定]
2. bearer token 32 字节随机值，只保存密文。Authorization header 必须是单一 `Bearer` 值。[新增裁定]
3. token 轮换旧 token 最长并存 15 分钟，入站记录保存命中的 `tokenVersion`，不保存 token。[新增裁定]
4. 若发送方提供 `X-Wemux-Timestamp`，允许偏差为正负 5 分钟；缺失不拒绝，但诊断标记较弱防重放。稳定 delivery id 仍是主要身份。[设计 §4.4.21][新增裁定]
5. 来源 IP/CIDR 仅作可选附加收窄。代理链只信任部署显式配置的 trusted proxy 数量，默认 0。[新增裁定]

### 12.7 G47 钉钉 Stream 记录

G47 未偏离 H4 六态投递、入站幂等持久化与 7 天保留契约。主动型入站源仅为 `ChannelAdapter` 增加可选 `start/stop` 生命周期：HTTP 型 adapter 不实现；Server 启停、Channel 启停与凭证 revision 驱动钉钉单 Channel 单连接。钉钉 Stream 无本地 HTTP 入站 route，回复仅使用会话级 `sessionWebhook`；缺失地址按不可恢复错误进入死信。ACK 在耗时领域处理前发出，领域幂等由持久化事件身份承担。

## 13. 22 问逐项冻结索引

| 问题 | 冻结结论 | 主要章节 |
|---:|---|---|
| 1 | 五类实体、revision 和有限错误码已冻结为判别联合 | §3 |
| 2 | H1/H3/H4 复用 A3，H3 采用 Project×Worker×Session×allowedConnectorIds 求交，撤权失败关闭 | §4 |
| 3 | 风险只能上调，write/destructive 每次审批，无审批能力或 Channel 触发时拒绝，管理员不得豁免 | §5 |
| 4 | H1/H4 使用 requestId+fingerprint+CAS，H3 稳定 ToolCall 身份保留 24 小时 | §6 |
| 5 | wire 只传非秘密定义、状态、测试和分发，禁止字段由可达类型扫描锁定 | §7 |
| 6 | 缺 key 不阻止宿主启动但禁用凭证能力，采用 enc:v2、previous keys 和显式迁移 | §11 |
| 7 | Worker Secret 只由 Worker 本地工作台管理，集群 Web 永不转发 | §11.1 |
| 8 | 私网采用部署与 Connector 双开关，永久阻断地址不可放开，首版无 split DNS 例外 | §9 |
| 9 | connect、read、请求/响应、JSON、Agent、Journal、redirect、工具列表均有具体默认上限 | §8 |
| 10 | 接受普通 fetch 的 DNS TOCTOU 残余风险，高风险部署在 pinning 前禁用出站 | §9 |
| 11 | stdio 命令由本地管理员批准，cwd 限 Workspace，最小环境，明确无 OS 沙箱 | §10.1 |
| 12 | 每 Session/connector 隔离，冻结超时、回收、进程数、输出、退避与 shutdown | §10.2 |
| 13 | Streamable HTTP 限定连接池、认证注入、取消、重连和等价 SSRF 保护 | §10.3 |
| 14 | 工具列表限 128 个/1 MiB，单 schema 64 KiB/16 层，变化生成新 catalog revision | §8、§10.4 |
| 15 | ACK 前只验证并事务保存 event identity/fingerprint，目标 1 秒，业务异步 | §12.1 |
| 16 | 飞书 schema 2.0，event 保留 7 天，乱序独立处理，重复、自消息和不支持事件安全忽略 | §12.2 |
| 17 | challenge、验签、token、解密按官方协议与版本化测试向量验证，不复用出站签名 | §12.2 |
| 18 | tenant token 按 channel+credential revision 单飞缓存，提前刷新，401 只重取一次 | §12.3 |
| 19 | 只推最终 assistant 文本，partial 聚合，4,000 字分片，纯文本降级与稳定 UUID | §12.4 |
| 20 | binding 创建需 Project manager/owner、Session control、Worker use，未绑定不自动创建，撤权立即失效 | §3.3、§4.5 |
| 21 | generic webhook 稳定 delivery id 优先，token 可短时轮换，1 MiB、5 分钟窗口，IP 仅附加 | §6.4、§12.6 |
| 22 | outbox 六态、最多 6 次、死信可诊断、管理员显式重放，停用取消未发送项 | §12.5 |

## 14. OPEN 项

OPEN 项不得被解释为 G43-G46 可跳过的安全要求。

1. **OPEN-1 地址 pinning transport**：首版接受普通 fetch 的 DNS TOCTOU，并要求高风险部署禁用出站。推荐在出现多租户或敌对 DNS 需求时增加自定义 dispatcher。
2. **OPEN-2 飞书官方测试向量归档版本**：G45 实施时固定来源 URL、抓取日期和脱敏向量。协议形态、schema 版本与验证要求已经冻结。

除上述两个后续增强/证据归档事项外，第四节 22 问没有阻塞 G43-G46 的未决项。
