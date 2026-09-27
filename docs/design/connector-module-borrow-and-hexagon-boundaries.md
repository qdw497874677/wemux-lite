# 连接器模块：借鉴决策、模块边界与实施计划（G42 设计输入）

日期：2026-09-27。上游调研见 [connector-module-selection-research.md](../research/connector-module-selection-research.md)。批次七票据以 [t3code-gap-plan.md](./t3code-gap-plan.md) 的 G42-G46 为准。

本文回答三个问题：

1. open-connector / Activepieces 的哪些机制可以搬代码、借模式或放弃。
2. 连接器模块在 Wemux Lite 双宿主形态下如何划分接口、实现和宿主责任。
3. G42-G46 如何拆成可独立验收、可逐段派发的实施阶段。

文中上游路径均相对于 `/opt/data/profiles/hacker/workspace/project/connector-upstream/open-connector/`。直接复制 Apache-2.0 代码时必须保留上游版权与许可证声明，并在仓库增加第三方来源记录。

## 一、借鉴与优化决策

决策分四档：**搬代码**指在遵守 Apache-2.0 的前提下复制并适配；**借模式**指按本仓接口重写；**借原则**指融入现有机制；**放弃**指明确不进入当前计划。

| # | 机制 | 已核对的上游位置 | 决策 | Wemux 落点 | 核对结论与改造要求 |
|---|---|---|---|---|---|
| 1 | `ActionDefinition` 与 `operationType: read \| write \| destructive` | `src/core/types.ts:214-248`，类型声明始于 `:222` | 借模式 | `packages/connector` | 上游三级操作类型属实。Wemux 只保留一个 `operationType` 事实源，审批策略由它派生，但不能预设 `read` 永远免审。实际决定还要与 A3 授权、Session/Turn grant、Agent 是否支持交互审批共同求交集。 |
| 2 | `ExecutionResult` 与结构化错误 | `src/core/types.ts:462-473`、`src/core/execution.ts` | 借模式，不原样搬 | `packages/connector` | 上游实际是含可选 `output`、`error` 的普通对象，不是严格判别联合，`error.code` 也是任意 `string`。Wemux 应收紧为 `ok: true` 与 `ok: false` 判别联合，并冻结有限错误码，如 `invalid_input`、`scope_denied`、`approval_denied`、`credential_unavailable`、`timeout`、`upstream_error`、`response_too_large`。 |
| 3 | `ExecutionContext.getCredential()` 凭证注入接口 | `src/core/types.ts:364-372` | 借模式 | Worker 的 H3 执行上下文 | 上游执行器通过上下文按需取得 `ResolvedCredential` 属实。Wemux 的工具调用参数、Journal、Agent 上下文和 wire-protocol 都不得出现凭证明文。 |
| 4 | 声明与执行分离 | `src/providers/<service>/definition.ts`、`actions.ts`、`executors.ts` | 借原则 | H1 保存声明，H3 保存执行实现 | 放弃为海量静态 provider 服务的生成式 catalog、懒加载 registry。当前只有 MCP 与 HTTP 两种真实变化，先用封闭联合类型和显式分派，不预建 provider 插件市场。 |
| 5 | AES-256-GCM secret codec | `src/server/secrets/secret-codec.ts:1-56`、`secret-codec-core.ts:1-17` | 搬代码并改名 | `packages/connector` 的 Node 安全实现 | 上游使用 `scryptSync(passphrase, 固定 salt, 32)`、12 字节随机 IV、GCM auth tag、base64url 与 `enc:v1:` 前缀，解码时兼容未加密旧值。WebCrypto 版本不搬。生产与已入群 Worker 不允许明文降级，明文 codec 只可用于显式测试配置。 |
| 6 | SSRF 守卫 fetch | `src/core/guarded-fetch.ts:1-481`、`src/core/request.ts:129-479` | 搬代码并裁剪 | `packages/connector` | 上游确有 URL 字面量校验、每跳重定向重校验、跨域重定向剥离凭证头、DNS 解析地址校验和失败关闭。IP/hostname 分类不在 guarded-fetch 单文件内，而在 `request.ts`。`allowPrivateNetwork` 只放行 private 类地址，链路本地、metadata 等 always-blocked 地址仍拒绝。需保留其已注明的 DNS 检查与实际连接之间 TOCTOU 限制，并增加部署级总开关作为上限，不能只信任连接器记录。 |
| 7 | `runProviderRequest` 超时与错误映射 | `src/providers/provider-runtime.ts:1014-1056` | 借模式 | H3 的 MCP/HTTP 执行器，H4 的飞书推送 | 默认 30 秒、内部 `ProviderRequestError` 原样透传、超时或 abort 映射 504、其余失败映射 502 属实。Wemux 对外返回自身 `ExecutionResult` 错误码，HTTP 状态只留在适配器层。 |
| 8 | deployment/runtime/token 三层动作策略 | `src/core/action-policy.ts:1-280` | 借映射关系，不搬策略引擎 | 现有 A3 与 capability grant | 当前 A3 已有 Project、Worker、Session 授权，但没有 connector 维度。首版不扩充 `ProjectGrant` 结构：管理权由 Project `manager` 派生，使用权由 Project/Worker/Session 权限与每 Turn capability snapshot 中的 `allowedConnectorIds` 求交集。只有出现真实的同 Project 内差异授权需求时才增加 connector grant。 |
| 9 | MCP 元工具模式 | `src/mcp.ts:41-172` | 借模式并裁剪 | Worker 的 Agent 工具面 | 上游实际有五个工具：`list_apps`、`list_connections`、`search_actions`、`get_action_guide`、`execute_action`。Wemux 面向外部 MCP server 首版只暴露 `mcp_list_tools` 与 `mcp_call`，工具描述不足时再增加 `mcp_inspect`。`operationType` 可参考 MCP `readOnlyHint`、`destructiveHint`，缺失或冲突时必须按更高风险处理，不能默认为只读。 |
| 10 | 幂等键哈希与请求指纹 | `src/server/actions/action-idempotency.ts:4-81` | 借原则 | Worker H3 与 Server H4 各自的幂等记录 | 上游限制 key 为 255 UTF-8 字节、SHA-256 哈希、请求语义指纹与 24 小时保留。Wemux 不复用 transport `messageId` 充当副作用身份。HTTP 写调用使用稳定 `requestId` 加载荷指纹；MCP 调用至少以稳定 Turn/Tool Call 身份生成请求身份；同身份换载荷必须冲突。是否需要独立表由 G42 契约冻结，不能假定现有 Server requestId 存储可直接覆盖 Worker 本地副作用。 |
| 11 | run-log 脱敏摘要器 | `src/server/actions/run-log-summary.ts:1-178` | 搬代码思路并扩展测试 | Worker 写 Journal 前的统一安全接口 | 上游限制 256 节点、16 KiB、深度 4、字符串 256 字符，并按敏感 key、Basic/Bearer、JWT 形态及敏感 URL 脱敏。它只适合审计摘要，不是完整工具响应策略。Wemux 必须分别限制给 Agent 的原始响应与写入 Journal 的摘要，不能先把秘密交给 Agent 再仅脱敏 Journal。 |
| 12 | OAuth 授权码流 | `src/oauth/oauth-flow-service.ts:1-546` | 推迟 | 当前无落点 | 上游包含 Authorization Code、state、PKCE 与 redirect URI 管理。飞书首发采用 `app_id` / `app_secret` 获取 tenant token，不需要用户 OAuth。等 HTTP 连接器出现真实 OAuth 需求再设计。 |
| 13 | 飞书 tenant token 获取与缓存 | `src/providers/feishu_app_bot/executors.ts:912-951` | 搬代码思路 | H4 飞书出站适配器 | 上游并非复用通用 OAuth refresh service，而是在飞书执行器内请求 `/auth/v3/tenant_access_token/internal`，按响应 `expire` 缓存并提前刷新。Wemux 应借此小机制，不应为飞书先建通用 OAuth 刷新框架。 |
| 14 | trigger 生命周期 | Activepieces piece 模型 | 借最小模式 | H4 内部通道适配器接口 | 首版只需要启用、停用、解析入站、推送回复。飞书和 generic webhook 两个实现出现后再抽出共同接口，不预建 polling、调度器或插件注册表。 |
| 15 | 飞书 API 请求与消息发送 | `src/providers/feishu/shared/client.ts`、`shared/im-runtime.ts:32-59`、`feishu_app_bot/executors.ts` | 选择性搬代码 | H4 飞书出站适配器 | 上游可复用的是 Bearer 请求封装、错误归一化、`/im/v1/messages` 发送和 tenant token 缓存。上游没有飞书事件订阅入站实现，不能声称可搬 webhook 验签、事件解密、URL verification 或重试处理代码。 |
| 16 | 开放 proxy 端点 | `src/server/proxy/proxy-runner.ts` | 放弃 | 无 | Wemux 提供受限 Agent 工具，不提供任意 REST 代理服务。其 SSRF、超时与错误处理由 #6、#7 吸收。 |
| 17 | hono、OpenAPI Console、marketplace | 上游 Server 与 Console | 放弃 | 无 | 与 `node:http`、`node:sqlite` 和必要依赖约束冲突，当前也没有市场需求。 |
| 18 | Composio 兼容、Cloudflare D1/R2 双运行时 | 上游平台兼容层 | 放弃 | 无 | 当前无真实变化点。Wemux 只支持 Node 运行时。 |

### 1.1 对现有 Wemux 机制的修正

1. **`ToolExecutionGateway` 不是现有实现。** 批次七原文把它作为 G43 的目标接口，但当前代码只有 Server 的 capability token/snapshot、Worker 的 `CapabilityGateway`、Pi 工具注入、Claude 的 MCP capability server，以及按 Agent 能力声明的 approval 事件。H3 必须先建立真实的工具执行网关，不能把“经现有审批链”误写成已经存在的统一执行器。
2. **审批能力必须失败关闭。** Pi 当前声明支持 approval，Claude Code 与 OpenCode 当前并非都支持可交互审批。需要审批但当前 Agent 无法完成交互审批时，工具调用必须拒绝，不能因 Provider 限制自动放行。
3. **A3 不新增平行权限系统。** H1 的 CRUD、H3 的调用、H4 的 binding 分别复用 Project、Worker、Session 的现有授权事实。连接器使用范围进入每 Turn capability snapshot，而不是把 Secret 或授权判定下发给 Agent。
4. **凭证管理入口与集群 Web 分离。** 集群浏览器只连接 Server，因此不能用普通 Server 表单把 Worker 凭证明文中转过去，同时又宣称“凭证不出 Worker”。首版由 Worker 本地工作台管理 Worker 凭证；集群 Web 只管理非秘密定义、显示 credential reference/状态并触发目标 Worker 测试。Server 侧飞书凭证可由 Server 管理页写入 Server 本地凭证库。
5. **Journal 脱敏不是唯一防线。** H3 在响应进入 Agent 上下文前先执行大小限制、内容类型限制和凭证泄漏检查，再生成给 Agent 的结果；写 Journal 时再生成更严格的有界摘要。

## 二、模块与接口划分

### 2.1 为什么不把所有能力放进一个模块

open-connector 是一个旁路网关进程，目录、凭证、策略和执行都在同一宿主。Wemux Lite 有两个不同的信任与生命周期边界：

- 出站工具必须在 Worker 执行，因为 Agent、Workspace、MCP stdio 子进程和执行凭证都位于 Worker。
- 入站 webhook 必须在 Server 接收，因为公网端点、集群账号授权、Project/Session 路由与回复审计位于 Server。

因此 H1、H3、H4 是三个有独立宿主和变化原因的应用模块。H2 不应被夸大成第四个业务限界上下文，它是一个安全基础模块及存储接口，在 Server、Worker 各有实例。本文保留 H1-H4 编号以对应既有讨论，但明确其深度不同：

- H1 连接器目录：Server 应用模块。
- H2 凭证库：共享安全接口与双宿主适配器，不拥有跨宿主业务流程。
- H3 出站工具桥：Worker 应用模块。
- H4 入站通道：Server 应用模块。

删除 H2 后，凭证加密、轮换、迁移、测试替身和两个 SQLite 适配器的复杂度会散落到 H3/H4，因此这个接口有价值。反之，H2 不应拥有通用“凭证业务域”、OAuth 类型预留或跨宿主同步协议。

### 2.2 总览

```text
┌──────────────────────────── Server 宿主 ────────────────────────────┐
│ H1 连接器目录                              H4 入站通道                │
│ 非秘密定义、Project 授权、版本、分发         webhook 持久接收、防重放、  │
│       │                                    binding、消息投递、回复推送 │
│       │ 定义快照，不含 Secret                       │                 │
└───────┼────────────────────────────────────────────┼─────────────────┘
        ▼ wire-protocol 可靠 Command                 │ 现有 Session 命令/事件
┌──────────────────────────── Worker 宿主 ───────────┼─────────────────┐
│ H3 出站工具桥                                      │                 │
│ capability grant → scope/审批/幂等 → MCP/HTTP       │ Session Runtime │
│       │                                             │                 │
│       ▼                                             ▼                 │
│ H2 Worker 凭证适配器                           回复事件回 Server       │
│ worker.sqlite + SecretCodec                                          │
└─────────────────────────────────────────────────────────────────────┘

Server 内另有 H2 Server 凭证适配器：server.sqlite + SecretCodec，仅供 H4。
共享内核 packages/connector：契约、guarded fetch、secret codec、摘要器。
```

### 2.3 跨模块铁律

1. **凭证永不上 wire-protocol。** wire 只携带 `credentialRef`、可用状态和非秘密定义。任何 `apiKey`、`appSecret`、Authorization header、MCP 环境变量值都不得进入 `packages/wire-protocol` 类型、Command、Event 或日志。
2. **Worker 不 import `@wemux/server-domain`。** 建议依赖方向为：

   ```text
   @wemux/domain ← @wemux/connector
   @wemux/domain + @wemux/connector ← @wemux/wire-protocol
   @wemux/domain + @wemux/connector ← @wemux/server-domain
   @wemux/connector + @wemux/wire-protocol ← apps/worker
   @wemux/server-domain + @wemux/connector + @wemux/wire-protocol ← apps/server
   @wemux/web-contract ← apps/web
   ```

   `packages/connector` 只依赖 `packages/domain` 中稳定的 ID 类型，不依赖 Server 存储、HTTP 或 Web DTO。
3. **H4 不直连 Worker。** 入站消息先持久化并完成 Server 授权/路由，再复用现有 Session enqueue 和可靠 Worker delivery。回复从 Session Journal/Event 投影进入 H4 outbox，H4 不解析 Provider 原生运行时事件。
4. **定义分发有版本和幂等身份。** H1 对 Worker 下发不可变 revision，Command 使用稳定 `commandId`/`requestId`，重连只重放同一领域身份。纯 transport ACK 不得触发重新发行新 Command。
5. **所有副作用都有稳定身份。** H1 写操作、H3 写/破坏性工具调用、H4 入站事件与回复推送分别持久化 request/event/delivery identity 及载荷指纹。同身份不同载荷返回冲突。
6. **只在真实变化点建立接口。** 首版 Connector `kind` 只有 `mcp | http`，Channel adapter 只有 `generic_webhook | feishu`。不预建第三种 connector、polling trigger、动态插件发现或 OAuth provider registry。

### 2.4 H1 连接器目录

H1 管理非秘密定义和 Project 范围内的使用投影：

```text
ConnectorDefinition
  id
  projectId
  kind: mcp | http
  name
  revision
  enabled
  allowedWorkerIds
  credentialRef
  riskDefaults
  config
```

`config` 是按 `kind` 判别的封闭联合：

- `mcp`：transport 为 `stdio | streamable_http`，stdio 只保存命令、参数和非秘密环境变量名，秘密环境变量由 Worker 的 `credentialRef` 解析；HTTP 保存 URL 与非秘密 header 模板。
- `http`：保存 `baseUrl`、允许的方法/路径模板、认证类型标识、非秘密 preset headers、响应限制与 `allowPrivateNetwork` 请求值。

H1 的接口应保持小而深：创建/更新、读取列表、启停、分发 revision、发起目标 Worker 测试。存储版本、授权、审计、幂等和分发细节都藏在实现中。

授权规则首版冻结为：Project `manager/owner` 可管理定义；拥有 Project 使用权、目标 Worker `use` 权限和目标 Session 写/执行权的用户，才可把连接器放入 Turn capability snapshot。`allowedWorkerIds` 只收窄，不扩大 Worker 权限。

“测试连接”不是 Server 自己访问 HTTP 或启动 MCP，而是向选定 Worker 发受控测试 Command。这样测试与真实执行使用同一 SSRF、凭证和网络环境。

### 2.5 H2 凭证库安全接口

H2 只暴露最小接口，例如保存、解析、删除、列出安全元数据，不暴露“列出全部明文”：

```text
CredentialRecord
  id
  ownerRef: connectorId | channelId
  authType: api_key | custom_credential
  ciphertext
  profile
  revision
  updatedAt
```

约束：

- 首版只有 `api_key` 与 `custom_credential` 两种真实类型，不为 `oauth2` 预留未实现字段。
- Worker 凭证只在 Worker 本地工作台写入 `worker.sqlite`；Server 只见 `credentialRef` 与健康状态。
- 飞书 Channel 凭证由 Server 管理端写入 `server.sqlite`，只供 H4 解析。
- 生产 Server 与已入群 Worker 必须配置 `WEMUX_CONNECTOR_ENCRYPTION_KEY` 或等价的宿主密钥来源。未配置时拒绝创建/更新凭证；测试可显式注入 plaintext fake，不能静默降级。
- 密钥轮换需要版本化迁移和失败恢复。旧密钥丢失不可恢复，必须在 UI 和运维文档中明确。

### 2.6 H3 出站工具桥

H3 复用现有 capability token/snapshot 和 Agent 工具注入入口，但建立新的统一执行网关：

```text
ToolCall
  identity: requestId + fingerprint
  projectId / workspaceId / sessionId / turnId
  connectorId / action
  operationType
  input

ToolExecutionGateway.execute(ToolCall, ExecutionContext): ExecutionResult
```

执行顺序固定为：验证 capability token 与 Turn 绑定，读取不可变 connector revision，求 A3/Worker/Session/connector scope 交集，解析操作风险，完成审批或失败关闭，声明幂等身份，解析 Worker 本地凭证，执行 SSRF/超时/响应上限守卫，生成 Agent 结果和 Journal 摘要，持久化终态。

MCP 约束：

- stdio 子进程由 Worker 负责启动、健康检查、取消、退出和 Worker shutdown 清理，不允许脱离 Worker 成为孤儿进程。
- 首版默认每个活跃 Session/connector 一个进程，设空闲回收、启动超时、并发上限和 stderr 尾部上限。常驻共享池只有在测得启动成本后再引入。
- HTTP transport 必须走与 `http_call` 相同的出站地址策略。若 SDK transport 无法复用 guarded fetch，必须在连接层实现等价的 DNS/地址校验，不能绕过。
- 外部 MCP 工具不平铺到 Agent 上下文，只暴露 `mcp_list_tools`、`mcp_call`。列表结果有数量、字节和 schema 深度上限。
- MCP 注解不可信。`destructiveHint: true` 一定是 destructive，`readOnlyHint: true` 只在没有冲突且连接器策略允许时判定 read，其余默认 write。

HTTP 约束：

- URL 必须由定义的 `baseUrl` 与受限相对路径组合，不能让 Agent 用参数替换 scheme/host。
- 方法、路径、header、请求体和 content type 均受定义限制。认证 header 由执行器最后注入，Agent 不得覆盖。
- 分别限制压缩前传输字节、解压后字节、文本/JSON 深度、给 Agent 的结果字节和 Journal 摘要字节。超限返回 `response_too_large`，不得先完整缓冲后再截断。
- redirect 每跳重做 SSRF 校验，跨 origin 删除认证与自定义敏感 header。

### 2.7 H4 入站通道

H4 的权威记录包括 `Channel`、`ChannelBinding`、`InboundDelivery` 和 `OutboundDelivery`：

```text
Channel
  id
  projectId
  kind: generic_webhook | feishu
  credentialRef
  enabled
  revision

ChannelBinding
  channelId
  externalConversationKey
  sessionId
  triggerPolicy
  revision
```

Channel binding 不是新的独立 Grant。创建/修改 binding 需要 Project `manager/owner`、目标 Session 控制权以及目标 Worker 使用权；投递时重新求值，权限撤销后旧 binding 不得继续扩大访问。外部发送者不是 Wemux User，所有入站消息以 Channel 身份和外部 sender metadata 审计，不能伪装为创建 binding 的管理员。

入站流程固定为：

1. HTTP 适配器执行请求体大小限制、鉴权或验签、时间窗检查。
2. 在返回平台 ACK 前，事务性持久化稳定 event/delivery identity 与载荷指纹。
3. 重复事件返回成功 ACK，但不重复 enqueue Session 消息。
4. 异步解析 `@bot`/触发策略和 binding，生成稳定 Session enqueue requestId。
5. Journal 中可公开的 Agent 回复进入 H4 outbox，按稳定 delivery identity 推送。
6. 平台 429/5xx 按有界退避重试；永久 4xx、权限撤销和 binding 失效进入可诊断终态，不无限重放。

`generic_webhook` 首版要求 bearer token，并建议支持调用方提供稳定 delivery id。若没有稳定 id，只能在短时间窗内按请求摘要降级去重，文档必须明确其保证较弱。不要为尚不存在的发送方强制设计 nonce 协议。

飞书入站必须独立实现并按飞书官方事件订阅文档验证：URL verification/challenge、verification token 或签名校验、可选 encrypt key 解密、event_id 去重、平台重试与 ACK 时限、机器人自身消息过滤、`@bot` 触发和 chat_id binding。open-connector 没有这些代码。

## 三、批次七票据对照

下表保持 `docs/design/t3code-gap-plan.md` 批次七的任务范围，不擅自改写票据目标：

| 票据 | 原目标摘要 | 本文模块 | 主要借用项 |
|---|---|---|---|
| G42 | 连接器域模型、出站安全通道、入站协议的先行设计 | H1-H4 | #1 #2 #3 #8 #10 |
| G43 | Worker MCP 客户端，stdio/HTTP transport，项目级清单，Agent 发现与调用，凭证本地存储 | H1 + H2 Worker + H3 | #7 #9 #10 #11 |
| G44 | Server HTTP 连接器定义、`http_call`、作用域/审批、Web CRUD/测试 | H1 + H2 Worker + H3 | #1 #3 #6 #7 #10 #11 |
| G45 | 飞书事件订阅、chat_id 到 Session、回复推送、`@bot` | H2 Server + H4 | #7 #13 #15 |
| G46 | Channel 抽象与 token 鉴权的通用 webhook | H4 | #10 #14 |

批次七原文给出的总估时是 58-80h，顺序是 G42 → G43 → G44 → G46 → G45，并注明 G45 依赖 G46、飞书实现可并行开发。本文在事实核对后增加了密钥生产策略、响应上限、MCP 生命周期、持久化防重放和真实浏览器验收，修订估时见第五节。

## 四、G42 必须冻结的决策

### 4.1 契约与授权

1. `ConnectorDefinition`、`Channel`、`ChannelBinding`、`ToolCall`、`ExecutionResult` 的判别联合、revision 和错误码。
2. H1 管理权限、Turn capability snapshot 的 `allowedConnectorIds`、Worker/Session/Project 权限求交规则，以及撤权后的在途调用处理。
3. operationType 风险推导和审批矩阵。必须覆盖 Agent 不支持交互审批、入站 Channel 无人在线审批、destructive 调用、管理员白名单是否允许收窄审批等情况。
4. H1/H4 所有写操作的 `requestId + fingerprint + CAS revision` 规则；H3 工具调用稳定身份与重试保留期。
5. wire-protocol 只允许非秘密定义快照、revision、credentialRef/状态和测试/分发 Command，建立源码扫描测试防止 secret 字段进入 wire。

### 4.2 凭证与网络

6. 加密密钥来源、启动策略、轮换格式、备份恢复和旧明文迁移。建议生产与已入群 Worker 缺 key 时允许 Worker 启动但禁用凭证创建和连接器执行，并明确上报 capability unavailable，避免连接器配置阻止基础 Worker 上线。
7. Worker 本地凭证配置入口与集群 Web 的职责分离。若未来要从集群 Web 配置 Worker Secret，必须另做端到端加密/Worker 直连设计，不能在本批次隐式经过 Server。
8. `allowPrivateNetwork` 采用“部署级允许上限 AND 连接器级显式允许”，metadata、loopback、link-local 等 always-blocked 范围不可放开。还需决定企业 split DNS trusted host 是否进入首版。
9. HTTP/MCP HTTP 的 connect、headers、request body、压缩前响应、解压后响应、JSON 深度、Agent 输出、Journal 摘要和 redirect 次数上限。
10. DNS 校验的 TOCTOU 风险接受标准。高风险部署是否要求地址 pinning transport，而不是只用 fetch 前解析。

### 4.3 MCP 生命周期

11. stdio 命令、参数、cwd、环境变量名的允许规则。MCP server 与用户自装 Agent CLI 同级信任，但不等于无限文件、网络或进程权限，UI 必须明确威胁模型。
12. 子进程按 Session 隔离还是 Worker 池化。首版建议 Session/connector 隔离，冻结启动超时、调用超时、空闲回收、最大进程数、stdout/stderr 上限、崩溃退避和 Worker shutdown 清理。
13. Streamable HTTP 的连接重用、认证注入、取消、重连和 SSRF 等价保护。
14. 工具列表/schema 的数量、字节、深度、刷新 revision 与恶意 MCP server 返回超大或变化 schema 的处理。

### 4.4 入站与飞书可靠性

15. webhook ACK 时限内的最小事务：必须先持久化 event id/fingerprint 再 ACK，业务投递异步完成。重复事件成功 ACK 且不重复 enqueue。
16. 飞书事件版本、event_id 保留期、乱序、重复、机器人自身消息、编辑/撤回、群聊 `@bot` 与私聊触发语义。首版不支持的事件要明确忽略并审计。
17. 飞书 URL verification、verification token/签名、encrypt key 解密和密钥轮换的官方测试向量。不能用出站 custom bot 签名代码替代事件订阅验证。
18. tenant_access_token 缓存的并发单飞、提前刷新、401 后单次强制刷新、Server 重启和飞书限流处理。
19. Agent 回复推送的范围：只推最终 assistant 消息还是包含工具状态；如何聚合 partial delta；飞书长度上限、富文本降级、回复引用与幂等 UUID。
20. Channel binding 创建/审批、外部 sender allowlist、首条消息未绑定时的行为，以及 Project/Session/Worker 撤权后的立即失效。
21. generic webhook 的稳定 delivery id、token 轮换、请求体上限、重放时间窗与来源 IP 是否仅作为附加信号。
22. H4 outbox 的重试状态、最大重试、死信诊断、管理员重放和删除/停用 Channel 时的在途消息处理。

## 五、实施计划

### 5.1 总体顺序与并行关系

修订后的关键路径为：

```text
阶段 0 G42 契约冻结
  → 阶段 1 packages/connector 共享内核
    → 阶段 2 G43 Worker 本地 MCP 纵向切片
      → 阶段 3 H1 + G44 集群 HTTP/目录纵向切片

阶段 1 完成后，阶段 4 H4 内核 + G46 generic webhook 可与阶段 2/3 并行
阶段 4 完成后，阶段 5 G45 飞书 + G46 最小适配器接口收口
```

阶段 0、1 必须串行先行。阶段 2 先证明 Worker 本地执行、凭证和 Agent 工具注入，不等待 Server 管理页。阶段 3 再加入 H1、可靠分发和真实集群 Web，避免同时调试 MCP 子进程、wire、权限和 UI。阶段 4 只依赖阶段 0、1，可由独立人员并行。阶段 5 必须建立在 H4 的持久防重放和 outbox 之上。

以下每阶段都是独立纵向切片，完成后均有可观察行为和测试，不需要等全计划完成才验收。路径是计划落点，实施时可以按现有模块命名微调，但不得改变依赖方向和安全铁律。

### 阶段 0：G42 契约冻结

**目标**：把第四节全部裁定为可测试契约，消除“现有审批链”“凭证不出 Worker”和集群 Web 管理之间的矛盾。

**交付物**：

- 更新本文件为最终 G42 决策记录。
- 新增 `docs/design/connector-module-contracts.md`，冻结实体、状态机、错误码、授权矩阵、幂等/CAS、wire allowlist、上限默认值和生命周期。
- 新增 `docs/acceptance/connector-module-g42.md`，列出后续阶段统一证据格式和安全反例。
- 如直接搬代码，新增仓库根或 `packages/connector/THIRD_PARTY_NOTICES.md` 的来源模板。

**验收标准**：

- 文档逐项回答第四节 22 个问题，无“以后再定”阻塞 G43-G46 的条目。
- 画出凭证从本地录入到执行的完整数据流，wire schema 中没有 Secret。
- 给出至少以下决策表：A3 权限求交、operationType/审批、同 requestId 同/异 fingerprint、入站重复事件、回复推送重试。
- 设计评审可用两个反例验证：Server 数据库泄露不能得到 Worker 执行凭证；Worker 代码不需要 import `@wemux/server-domain`。

**借用项**：#1 #2 #3 #8 #10。

**估时**：6-10h。必须最先完成，不可并行实施代码。

### 阶段 1：共享内核 `packages/connector`

**目标**：先交付无宿主业务依赖的安全底座，让 H3、H4 使用同一契约和实现，而不是复制安全代码。

**交付物**：

- `packages/connector/package.json`、`tsconfig.json`、`src/index.ts`。
- `packages/connector/src/contracts.ts`：`ConnectorDefinition` 判别联合、`OperationType`、严格 `ExecutionResult`、安全错误码。
- `packages/connector/src/guarded-fetch.ts`、`egress-address-policy.ts` 与测试：从上游 `guarded-fetch.ts`、`request.ts` 裁剪移植。
- `packages/connector/src/secret-codec.ts` 与测试：Node AES-256-GCM、版本前缀、错误处理。
- `packages/connector/src/safe-summary.ts` 与测试：Agent 结果和 Journal 摘要使用不同 profile。
- `packages/connector/THIRD_PARTY_NOTICES.md`：Apache-2.0 来源、原文件和改动说明。
- 根 `package.json` 构建顺序和下游 workspace 依赖声明。

**验收标准**：

- `npm run build:packages`、`npm run typecheck` 与 `npm test --workspace @wemux/connector` 通过。
- SSRF 测试覆盖 URL literal、IPv4/IPv6、DNS 指向私网、解析失败关闭、每跳 redirect、跨域认证头剥离、private 双开关、metadata 永久阻断和超限 redirect。
- codec 测试覆盖随机 IV、篡改 tag 失败、错 key 失败、空 key 拒绝、旧明文迁移只在显式迁移入口发生。
- 摘要测试覆盖 Authorization/cookie/token/JWT/带 userinfo URL、16 KiB/节点/深度限制和恶意 getter/prototype。
- 增加依赖扫描断言：`packages/connector` 不 import `server-domain`、Web 或 apps；生产代码不出现默认 plaintext codec。

**借用项**：#2 #5 #6 #11。

**估时**：10-16h。阶段 0 后串行；完成后阶段 2 与阶段 4 可并行。

### 阶段 2：G43 Worker 本地 MCP 纵向切片

**目标**：在单个 Worker 上完成“本地配置 MCP → Agent 列出工具 → 调用 → 审批/拒绝 → Journal 安全记录”的闭环，先不依赖 Server H1。

**交付物**：

- `apps/worker/src/connectors/tool-execution-gateway.ts`：统一 scope、风险、审批、幂等和结果限制。
- `apps/worker/src/connectors/mcp-client.ts`、`mcp-process-supervisor.ts`、`mcp-tool-adapter.ts`。
- `apps/worker/src/connectors/credential-store.ts` 与 `apps/worker/src/storage/sqlite-store.ts` 的 Worker 本地凭证记录。
- `apps/worker/src/local-control/` 下的 MCP 定义、凭证和测试连接端点及本地工作台 UI。
- `apps/worker/src/capabilities/pi-tools.ts` 与 `apps/worker/src/capabilities/mcp-server.ts` 扩展 `mcp_list_tools`、`mcp_call`，继续复用现有 capability token/Turn 绑定。
- `apps/worker/src/application/cluster-lifecycle.ts` 接入子进程 supervisor 的启动和 shutdown。
- `apps/worker/src/test/connector-mcp-*.test.ts`，测试 fixture MCP server 放 `apps/worker/test/fixtures/`。

**验收标准**：

- stdio 与 Streamable HTTP 两种 transport 都由 fixture 行为测试覆盖；缺 SDK、未配置、认证失败只使该连接器 unavailable，不阻止 Worker 上线。
- stdio 子进程启动超时、调用取消、崩溃、空闲回收、并发上限和 Worker shutdown 后无孤儿进程都有测试。
- 恶意工具列表超数量/字节/schema 深度被有界拒绝；未知注解按 write 处理。
- scope 不允许、需要审批但 Agent 无审批能力、审批拒绝、同身份异 fingerprint 均失败关闭。
- Agent 结果超过上限时返回 `response_too_large`；凭证和敏感响应不出现在 Journal、stdout/stderr 日志或工具列表。
- 真实行为验收：启动 Worker 本地工作台，在浏览器中配置 fixture MCP，使用至少一个真实支持工具注入的 Agent 或仓库 test Agent 完成 list/call；重启 Worker 后定义和凭证仍可用。涉及本地工作台 UI，因此必须保存可重复浏览器脚本与截图摘要。
- `npm run pack:check --workspace @wemux/worker` 通过，tgz 中包含所需 MCP 客户端依赖与实现，但不自动安装任何第三方 MCP server。

**借用项**：#3 #7 #9 #10 #11。

**估时**：20-30h。依赖阶段 1；可与阶段 4 并行。

### 阶段 3：H1 目录与 G44 HTTP 集群纵向切片

**目标**：完成 Server 非秘密目录、可靠分发、Worker `http_call`、集群 Web CRUD/测试连接，并把阶段 2 的本地 MCP 定义升级为 Project 级定义。

**交付物**：

- `packages/server-domain/src/connectors.ts`：H1 应用端口、授权输入、revision/CAS 与审计类型。
- `packages/wire-protocol/src/commands.ts`、`messages.ts`：不含 Secret 的 connector revision sync/test Command 与 receipt/report。
- `packages/web-contract/src/connectors.ts`：安全投影和 CRUD/test DTO。
- `apps/server/src/application/connector-service.ts`、`application/ports/connector-repository.ts`。
- `apps/server/src/storage/sqlite/connector-repository.ts` 与迁移。
- `apps/server/src/http/routes/connector-routes.ts`，接入现有 `node:http` 路由、Cookie/CSRF、requestId/CAS。
- `apps/server/src/worker-ws/` 的可靠定义分发和收据处理，遵守 outbox 有界入队规则。
- `apps/worker/src/connectors/http-executor.ts`、定义 revision 存储与集群/本地来源合并规则。
- `apps/web/src/features/connectors/` 管理页：非秘密定义 CRUD、目标 Worker credential 状态、测试连接、错误与重试。
- Server、Worker、Web、wire 的 connector 测试，以及 `apps/e2e/connector-http.test.ts`。

**验收标准**：

- 源码契约测试扫描 wire、Server DTO、审计和 Web 状态，禁止 `apiKey`、`appSecret`、Authorization 值及密文载荷字段。
- Project manager 可 CRUD，viewer/contributor 的管理操作被 Server 拒绝；调用权限还必须满足 Worker 与 Session 权限。成员撤权后新调用立即拒绝，在途 destructive 调用按阶段 0 决策停止或保留审计终态。
- CRUD 同 requestId 同 fingerprint 返回原结果，同 requestId 异 fingerprint 返回 409；update/delete 使用 revision CAS。
- Worker 离线时定义保持待分发；重连重放同一 Command，不因 transport ACK 形成重复入队循环；旧 revision 不覆盖新 revision。
- `http_call` 覆盖 SSRF、redirect、private 双开关、方法/路径/header 限制、超时、429/5xx、请求与响应上限、流式超限中止、Agent 结果与 Journal 双层摘要。
- 集群 Web 不能填写 Worker Secret，只能看到“未配置/可用/失效”安全状态和跳转到 Worker 本地配置的说明；Server 触发测试时由目标 Worker 使用本地 credentialRef。
- 真实浏览器验收使用动态端口：登录集群 Web，创建 HTTP 连接器，观察 Worker 收到 revision；未配置凭证测试失败；在 Worker 本地工作台配置凭证后再次测试成功；通过 Session 调用后 Web Journal 只显示安全摘要；撤权或禁用后再次调用被拒绝。
- `npm run build:packages`、相关 workspace typecheck/test、`apps/e2e/connector-http.test.ts` 和 Worker pack check 通过。

**借用项**：#1 #3 #6 #7 #8 #10 #11。

**估时**：24-34h。依赖阶段 2 的 H3 网关。Web 工作可在 Server/Worker 契约冻结后并行，但合并验收必须串行完成。

### 阶段 4：H4 内核与 G46 generic webhook 纵向切片

**目标**：先交付与 Channel kind 无关的 delivery/binding 状态机和第一个 generic webhook 实现。此阶段不发布通用 adapter registry；只有一个实现时，解析与推送接口保持 H4 内部。等阶段 5 出现飞书第二实现后，再提取最小 Channel adapter 接口。

**交付物**：

- `packages/server-domain/src/channels.ts`：Channel、Binding、Inbound/Outbound delivery 状态机。
- `packages/web-contract/src/channels.ts`：安全管理 DTO。
- `apps/server/src/application/channel-service.ts`、`channel-router.ts`、`channel-outbox.ts`。
- `apps/server/src/application/ports/channel-repository.ts` 与 `apps/server/src/storage/sqlite/channel-repository.ts`。
- `apps/server/src/channels/generic-webhook-adapter.ts`。
- `apps/server/src/http/routes/channel-routes.ts` 与公开 webhook 路由。
- `apps/web/src/features/channels/`：Channel/binding 管理、delivery 诊断与重放入口。
- `apps/server/src/test/channel-*.test.ts`、`apps/e2e/generic-webhook.test.ts`。

**验收标准**：

- bearer token 以 H2 Server codec 加密，API 只在创建时一次性返回或完全不回显，列表只显示安全元数据。
- 请求体上限、无 token/错 token、过期 token、稳定 delivery id 重复、同 id 异 fingerprint、无 id 降级去重均有测试。
- event 先持久化后 ACK；模拟 ACK 丢失重试只产生一条 Session message；Server 重启后重复事件仍不重复投递。
- binding 创建要求 Project manager、目标 Session control 与 Worker use；撤权、Session 删除、Channel disable 后投递失败关闭。
- Session enqueue 使用稳定 requestId；Worker 离线时显示 queued/unavailable，不伪装已执行。
- reply outbox 对 2xx、429、临时 5xx、永久 4xx、最大重试和管理员重放有可观察状态。
- 真实浏览器验收：创建 Channel/binding，使用 Node fetch fixture 发送 webhook，在 Web Session 中看到一条入站消息；test Agent 回复后 fixture 收到一次 outgoing；重复发送、禁用和撤权状态在 Channel 诊断页正确显示。保存可重复脚本与截图摘要。

**借用项**：#10 #14，并复用阶段 1 的 #5 #11。

**估时**：18-26h。依赖阶段 1，可与阶段 2/3 并行；必须先于阶段 5。

### 阶段 5：G45 飞书通道与 G46 接口收口纵向切片

**目标**：在 H4 状态机上增加飞书第二实现，完成事件订阅到 Session，再从 Agent 回复推送回飞书的真实闭环；此时才从 generic webhook 与飞书的真实差异中提取最小 Channel adapter 接口，完成 G46 的抽象层。

**交付物**：

- `apps/server/src/channels/feishu/verify.ts`：challenge、verification、可选解密和测试向量。
- `apps/server/src/channels/feishu/inbound.ts`：事件解析、event_id、chat/sender/message 归一化、`@bot` 规则。
- `apps/server/src/channels/feishu/token-provider.ts`：tenant token 单飞缓存、提前刷新、401 单次重取。
- `apps/server/src/channels/feishu/reply-pusher.ts`：文本/富文本降级、长度限制、幂等 UUID、错误映射。
- `apps/server/src/channels/channel-adapter.ts`：从 generic webhook 与飞书两个真实实现提取的最小内部接口。
- `apps/server/src/channels/feishu/adapter.ts`：飞书实现；generic webhook 同步改接该接口，不建立动态 registry。
- `apps/web/src/features/channels/` 增加飞书配置、binding、连接测试与诊断。
- `apps/server/src/test/feishu-channel-*.test.ts`、fixture server 和可选的 `apps/e2e/feishu-channel.test.ts`。
- `docs/operations/feishu-channel.md`：飞书开放平台配置、回调 URL、权限、密钥轮换、限流与故障排查。

**验收标准**：

- 官方格式 fixture 覆盖 challenge、合法/非法 verification、加密/非加密事件、event_id 重复、乱序、机器人自身消息、群聊无 `@bot`、群聊 `@bot` 与私聊。
- webhook 在 ACK 时限内只完成验证与持久化；慢 Session/Worker 不拖延 ACK。模拟飞书重复投递和 Server 重启不产生重复消息。
- tenant token 并发请求只发生一次获取；临近过期刷新；401 仅强制刷新一次；429/5xx 有界退避。
- 回复 partial delta 不逐片刷屏，只按阶段 0 决策推送聚合后的允许内容；长消息、富文本失败和永久权限错误可诊断。
- Channel Secret 不进入日志、Journal、wire、Web DTO 或 acceptance 证据。
- 浏览器行为验收使用本地飞书 fixture 完成全链路。真实飞书验收只有在部署者提供测试应用与公网 HTTPS 回调时执行；未提供时明确标记“协议 fixture 已验证，真实飞书阻塞”，不得写成已支持生产飞书。
- 真实飞书验收场景至少包括 URL verification、群聊 `@bot`、私聊、重复事件、Agent 回复、Server 重启后的重复投递和 token 刷新。

**借用项**：#7 #13 #15；入站部分为自研，不冒充上游搬运。

**估时**：24-34h。依赖阶段 4。token/reply 适配器可在阶段 4 后半段并行开发，但最终接入必须使用 H4 的持久 delivery/outbox。

### 5.2 修订估时

| 阶段 | 估时 |
|---|---:|
| 阶段 0 G42 契约冻结 | 6-10h |
| 阶段 1 共享内核 | 10-16h |
| 阶段 2 G43 Worker 本地 MCP | 20-30h |
| 阶段 3 H1 + G44 集群 HTTP/目录 | 24-34h |
| 阶段 4 H4 + G46 generic webhook | 18-26h |
| 阶段 5 G45 飞书 | 24-34h |
| **合计** | **102-150h** |

该估时高于批次七原 58-80h，原因不是增加平台化范围，而是把原计划隐含但不可省略的生产要求显式计入：统一工具执行网关尚不存在、Worker Secret 不能经 Server Web 中转、MCP 子进程完整生命周期、HTTP 流式响应上限、持久防重放/outbox、密钥轮换、A3 撤权，以及本仓要求的真实浏览器验收。若必须压缩首发工期，只能明确删减 transport 或 UI 范围，例如 G43 首发只做 stdio，不能删减凭证隔离、SSRF、防重放、幂等和生命周期清理。
