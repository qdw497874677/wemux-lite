# 连接器模块开源调研（openconnector 类，批次七 G42 输入）

日期：2026-09-27。方法：GitHub API 元数据 + open-connector 全量源码本地审读（14MB tarball，见 `~/workspace/project/connector-upstream/open-connector`）+ 各候选官网/文档/许可证页核对。所有源码结论均有本地文件路径可复查。

## 一、消歧与全景

### 1.1 名字消歧（"open connector" 至少有四个不同项目）

| 项目 | 作者/组织 | 定位 | Stars | License | 判定 |
|---|---|---|---|---|---|
| **oomol-lab/open-connector**（"OpenConnector"） | OOMOL Lab | AI Agent 的连接器网关：连接一次 SaaS 账号，向 agent 暴露 1500+ provider / 10000+ Action 目录，替代 Pipedream/Composio 的自托管方案 | 5,904（2026-06-29 创建，日活推送，增速极快） | Apache-2.0 | **本次主对象** |
| openconnector-dev/openconnector（"Open Connector"，openconnector.dev） | 英国独立团队 | 同类定位（Composio 兼容、AGPL-3.0、AES-256-GCM vault、哈希链审计） | 少 | AGPL-3.0（宣称） | **源码 "coming soon"，尚无代码**，只有官网与 waitlist；不可选型，只能当概念参照 |
| openconnector/open-connector | 个人 | Java 遗留项目 | 个位数 | - | 无关 |
| keoy7am/open-connector 等 | fork | oomol 项目的镜像/fork | - | - | 同 oomol |

### 1.2 连接器领域全景（三类形态）

| 形态 | 代表 | 本质 | License 关键事实 | 对我们的价值 |
|---|---|---|---|---|
| **框架型**（auth/凭证网关库） | **Nango**（12.4k）、Ampersand connectors（74，Go） | 只解决 OAuth/API key 白标认证与 token 刷新，集成是"你仓库里的函数" | Nango：Elastic License 2.0（非 OSI，禁止作为服务提供）；Ampersand：MIT | 借鉴 OAuth provider 配置模型；ELv2 对内部自托管无碍但与我们的开源倾向不匹配 |
| **集成型**（连接器目录平台） | **oomol open-connector**（5.9k）、**Composio**（30.3k） | 中央 catalog：连接账号 → 加密 vault → agent 经 SDK/CLI/MCP/HTTP 调 Action，凭证不出边界 | open-connector：Apache-2.0（全平台开源）；Composio：仅 SDK MIT，**执行平台闭源 SaaS**（self-host 需付费企业版） | 与 G44（HTTP 服务连接器）+ G43（MCP）的抽象直接同构；open-connector 可整体自托管 |
| **工作流型**（自动化平台，含触发器） | **n8n**（206k）、**Activepieces**（24.7k）、Pipedream（闭源） | 可视化工作流：触发器（入站 webhook/轮询）+ 步骤（出站 Action），pieces 即插件 | n8n：fair-code（Sustainable Use License，**非开源**）；Activepieces：核心 MIT + `packages/ee` 商业双许可；Pipedream：源码可见许可（禁竞品用途） | **入站通道（G45/G46）的唯一成熟参照**：Activepieces 的 piece = trigger + actions 同体、pieces 自动变 MCP server |
| 附：MCP 治理网关 | agentic-community/mcp-gateway-registry（944，Apache-2.0，Python）、microsoft/mcp-gateway（810，MIT） | MCP 服务器的反向代理/注册表（服务端聚合治理） | 均宽松 | 我们是 MCP **客户端**（G43），方向相反；仅在未来"对外暴露工具目录"时有参考价值 |

结论要点：**出站（工具调用）看集成型，入站（IM/webhook 触发）看工作流型**。没有一个开源项目同时把两个方向都做对了。

## 二、open-connector 核心机制（源码审读）

仓库形态：TypeScript + hono，27 个生产依赖（含 @modelcontextprotocol/client+server v2、@aws-sdk/client-s3、aliyun-oss、busboy）；可跑 Node/Docker（SQLite 或 Postgres）、Fly.io、Cloudflare Workers（D1/R2）；Node 22+。

### 2.1 连接器抽象：目录数据与运行时分离

- **三文件契约**：每个 provider 目录 `src/providers/<service>/` = `definition.ts`（ProviderDefinition 元数据）+ `actions.ts`（ActionDefinition 目录数据）+ `executors.ts`（运行时实现，**懒加载**）。
- **ProviderDefinition**（`src/core/types.ts:257`）：`{ service, displayName, categories, authTypes, auth: ProviderAuthDefinition[], actions }`。auth 数组按 `api_key | custom_credential | oauth2 | no_auth` 声明凭证字段。
- **ActionDefinition**（`types.ts:222`）：`id = "<service>.<name>"`、`operationType: "read" | "write" | "destructive"`（**给审批分级的现成枚举**）、`requiredScopes`（provider 原生 scope）、`inputSchema/outputSchema`（JSON Schema，调前校验）、`asyncLifecycle`（start/status/cancel 三段式异步动作）。
- **ActionExecutor**（`types.ts:484`）：`(input, context: ExecutionContext) => ExecutionResult`，`ExecutionResult = { ok, output?, error?: { code, message, details? } }`（`src/core/execution.ts` 只做 schema 校验 + 执行，无 executor 时返回稳定 `executor_unavailable`）。
- **ExecutionContext**（`types.ts:364`）：`getCredential(service)`（凭证在调用时由运行时注入，executor 拿 `ResolvedCredential` 但 agent/调用方永远拿不到）+ `transitFiles`（临时文件）+ `signal` + `logger`。
- **懒加载与目录生成**：生成式 registry 把每个 service 映射为 `import("./<service>/executors.ts")`，ProviderLoader 仅在实际执行/proxy/凭证校验时才 import（见其 `AGENTS.md` 架构节 + `scripts/generate-catalog.ts`、`scripts/generate-provider-registry.ts`）。1500+ provider 不拖慢启动。

### 2.2 凭证管理与鉴权流

- **ConnectionService**（`src/connection-service.ts`，909 行）：连接 = `(service, authType, values)`，`PUT /api/connections/:service` 直接落库；支持命名连接（default connection name 规则）。
- **加密**：AES-256-GCM（`src/server/secrets/secret-codec.ts` node 实现 / `worker-secret-codec.ts` WebCrypto 实现，双运行时同一格式）；`OOMOL_CONNECT_ENCRYPTION_KEY` 环境变量，丢失不可恢复；未配置时明文+启动警告（本地开发体验）。加密覆盖凭证、OAuth client 配置、pending OAuth state、幂等响应体。
- **OAuth**（`src/oauth/oauth-flow-service.ts` 546 行 + `oauth-credential-refresh-service.ts`）：Authorization Code + PKCE、自动刷新、state 存储接口化（`IOAuthStateStore`）；**BYO OAuth App**——自托管必须自己注册各 provider 的 OAuth 应用（这正是我们 BYOK 原则的同款约束）。
- **凭证校验器**：provider 可声明 `credentialValidators`，连接时调 provider 的 current-user 端点，返回 `CredentialProfile`（账号身份）+ `grantedScopes`——"连接后能看到这是谁的账号"，UI 可信度关键。
- **Agent 侧鉴权**：runtime token（`src/server/storage/runtime-token-service.ts`）——token 只存哈希，grant = `{ allowedActions, blockedActions, allowedProxies, allowedConnections }`（TokenPolicy），即**每个 agent/项目发独立最小权限 token**。
- **未知字段拒绝**：凭证提交的未知字段直接拒绝而非静默存储（fail-fast，`docs/credentials.md`）。

### 2.3 调用隔离（这是全仓最值得抄的部分）

- **SSRF 守卫 fetch**（`src/core/guarded-fetch.ts`，481 行）：所有 provider 出站必须走 `providerFetch`/`context.fetcher`，禁止全局 fetch——URL 字面量校验（`assertPublicHttpUrl`）+ **每跳 redirect Location 重校验**（手动跟随重定向）+ **DNS 解析后 IP 校验**（默认开，一次请求一次）：私网/回环/链路本地/云 metadata（169.254）全阻断；`allowPrivateNetwork` 为部署级开关（`OOMOL_CONNECT_ALLOW_PRIVATE_NETWORK`），仅放行 RFC1918，metadata 永久阻断；WebSocket 同策略（`guarded-websocket.ts`，`ws/wss→http/https` 复用同一校验）。
- **三层动作策略**（`src/core/action-policy.ts`，280 行）：`deployment | runtime | token` 三层 allow/block 规则编译为快照（请求级不可变），支持 `*` 与 `prefix.*` 模式；block 优先于 allow；token 层额外约束可用连接。决策带 `{ source, outcome, rule }` 审计轨迹。
- **统一请求包装**：`runProviderRequest` 默认 30s 超时、abort/timeout→504、其他→502 的稳定错误映射；`ProviderRequestError(status)` 结构化错误。
- **Proxy 通道**：`POST /v1/proxy/:service`（`src/server/proxy/proxy-runner.ts`）——不经预定义 Action 的裸 HTTP 代理（仍过策略+SSRF 守卫），等价于我们 G44 的 `http_call` 工具的"托管版"。

### 2.4 MCP 支持

- 形态：**MCP Server**（不是客户端），`src/mcp.ts`（512 行）在 `/mcp` 暴露 Streamable HTTP、无状态（每请求建 server 实例）。
- **五个元工具**而非一万裸工具：`list_apps` / `list_connections` / `search_actions` / `get_action_guide` / `execute_action`。即 agent 通过"搜索→看指南→执行"的元协议使用目录，而不是把 10k 工具塞进上下文。`get_action_guide` 会内联该 action 的输入 schema 与 curl 示例。
- 对 G43 的启示：我们 worker 侧是 **MCP 客户端**（stdio/HTTP transport 用官方 `@modelcontextprotocol` SDK，open-connector 也依赖它），但"把外部工具目录收敛为少量元工具再经审批链暴露给 agent"的模式可直接借用。

### 2.5 入站通道：没有

源码确认：`src/server/` 只有 actions/api/cloudflare/files/proxy/secrets/storage，**无 trigger/webhook/轮询基础设施**；`grep -ri trigger` 在 server 路由、types、runtime-api 文档中零命中。slack/telegram/discord/line/whatsapp/feishu 等 provider 全部是**出站 Action**（发消息、读文档等）。即 open-connector 是纯出站连接器平台，G45（飞书入站）/G46（通道抽象）帮不上。

附带收获：`src/providers/feishu`（oauth2）、`feishu_app_bot`（custom_credential，即 app token 凭证）、`feishu_custom_bot` 三个 provider 的飞书 API 封装（文档/bitable/消息发送，`runtime.ts` 含签名细节）**可复用于 G45 的出站半边**（agent 回复推送），Apache-2.0 允许直接搬代码。

## 三、与 wemux-mini 的匹配度

| 维度 | open-connector | 判定 |
|---|---|---|
| 直接引入为依赖 | hono + 27 个生产依赖（含 AWS SDK、aliyun-oss、busboy、scalar），与 node:http/node:sqlite 零框架约束冲突；自带完整 server/console/catalog | ❌ 违反轻量部署约定（AGENTS.md：新增中间件需说明真实问题与运维成本） |
| 借用抽象 | Connector/Action/ExecutionContext/ResolvedCredential 分层、目录-运行时分离、三层策略、guarded egress——全部是可平移的模式，核心文件均 <600 行 | ✅ 主要价值 |
| 作为 sidecar 服务引入 | 它本来就是网关设计：独立进程跑 Docker 镜像，worker/agent 经 `/mcp` 或 `/v1/actions/*` 调用，凭证/SSRF/审计全在 sidecar 内闭环；Apache-2.0 无再许可摩擦 | ✅ 备选架构 B（若要 1500 provider 立即可用） |
| BYOK / 自托管 | 自托管第一性：SQLite 默认、加密 key 自持、BYO OAuth app、凭证不出进程 | ✅ 完全同向 |
| 入站 IM/webhook | 无 | ❌ 看 Activepieces（MIT 核心双许可，注意 `packages/ee` 不可抄）+ multica 通道架构（G42 计划已引用） |
| MCP 客户端（G43） | 它是 server 端；客户端用官方 SDK | ✅ 借元工具模式，依赖用官方包 |

其他候选匹配度速判：Composio 平台闭源（SDK MIT），排除；n8n fair-code 非开源，排除；Nango ELv2 + 只做 auth 面，不合；Activepieces 整体是自动化平台非嵌入库，只借 piece/trigger 模式。

## 四、可借鉴清单（给 G42 架构设计）

1. **目录-运行时分离 + 三文件契约**（`src/core/types.ts` + `src/providers/github/` 样例）：我们的 Connector 也应把"声明（schema/权限/描述）"与"执行器"分开，声明可序列化入库（G44 的连接器定义 CRUD 就是声明数据），执行器按 kind 注册并懒加载。ActionDefinition 的 `operationType: read|write|destructive` 直接映射我们的审批分级（read 免审、write 过审批链、destructive 强审批或禁用）。
2. **凭证注入边界**（`ExecutionContext.getCredential` + `ResolvedCredential`，`types.ts:281/364`）：executor 通过 context 取凭证而非参数传递，天然保证"凭证不出 worker"这一 G42 安全边界；配套 AES-256-GCM secret codec（`src/server/secrets/secret-codec.ts`，node:crypto scrypt→key + createCipheriv，双实现含 WebCrypto 版）可近乎照抄进我们的 server-domain。
3. **SSRF 守卫出站通道**（`src/core/guarded-fetch.ts` + `guarded-websocket.ts`）：G44 的 `http_call` 工具必须走的形态——URL 校验 + 逐跳 redirect 校验 + DNS 解析 IP 校验（含 169.254 metadata 阻断）+ 部署级私网开关。481 行自包含，测试齐全（`guarded-fetch.test.ts`）。
4. **三层策略快照**（`src/core/action-policy.ts`）：deployment（实例级）→ runtime（运行时级）→ token（会话/项目级）allow/block 编译为请求级不可变快照，决策带审计轨迹。映射到我们：实例级黑名单（.env/管理端配置）→ 项目级 scope（G42 的"作用域"）→ Session/PAT 级 grant，正好接到现有 A3 授权体系。
5. **MCP 元工具模式**（`src/mcp.ts` 的 list/search/guide/execute 四段式）：G43 把外部 MCP 服务器的工具收敛为 `mcp_list_tools/mcp_search/mcp_call` 元工具经 ToolExecutionGateway 暴露，避免上下文爆炸，且审批门禁只拦 `mcp_call` 一处。

## 五、选型结论：混合（自研骨架 + 借用模式 + 最小依赖）

- **自研**连接器域模型与通道抽象：G42 的 Connector 实体、G46 的 Channel 接口必须自研——没有开源项目同时覆盖我们的双宿主（Server 控制面 + Worker 执行面）形态与入站路由（chat_id↔session 映射）；且 node:http/node:sqlite 轻量约束排除整体引入任何候选。入站参照 Activepieces piece 模式与 multica 通道架构，飞书 API 出站封装可直接搬 open-connector 的 feishu provider 代码（Apache-2.0，保留声明）。
- **借用** open-connector 的机制设计（上述五点），这是本次调研最高密度的收获：它 3 个月 5.9k star 的原因正是把"凭证 vault + 策略 + SSRF 守卫 + 目录"做成了干净独立的小模块，每个都 <600 行、可直接平移。
- **引入**最小依赖：`@modelcontextprotocol` 官方 SDK（G43 的 stdio/HTTP 客户端 transport），不用引入任何连接器平台。
- **备选架构 B**（记录进 G42 设计文档，不默认采用）：需要"长尾 SaaS 立即可用"时，把 open-connector 作为 worker 可选 sidecar（独立 Docker 进程，经 MCP 接入，凭证隔离在 sidecar），Apache-2.0 允许；触发条件是用户真实提出 10+ provider 需求，否则不增加一个常驻进程的运维面。

风险与开放问题：open-connector 极年轻（2026-06 创建），API/契约仍在快速变动（版本 v1.x，wire shape 兼容性靠其 AGENTS.md 约束），借模式优于接代码；飞书 provider 的 oauth2 流依赖自建 OAuth app，G45 首发建议走 app token（custom_credential）路线与其 `feishu_app_bot` 对齐。

## 附：本地留存

- 源码：`~/workspace/project/connector-upstream/open-connector/`（tarball 14MB < 30MB 预算）
- 关键文件索引：`src/core/types.ts`（全部契约）、`src/core/{action-policy,guarded-fetch,execution,provider-definition}.ts`、`src/connection-service.ts`、`src/oauth/oauth-flow-service.ts`、`src/server/secrets/secret-codec.ts`、`src/mcp.ts`、`src/providers/feishu*/`
