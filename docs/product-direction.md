# Wemux Lite 产品定位与方向

状态：当前产品方向。适用于后续设计、开发、验收与对外描述，不代表下述目标全部已实现。

## 1. 产品定位

Wemux Lite 是面向个人与团队、自托管的 AI 集群工作台，也是运行时无关的 Agent Network 控制层。目标是让 AI 在授权内自主完成项目工作，人处理关键决策并能随时介入。Worker 通过 Adapter Bridge 把 Pi、OpenCode、Claude Code 及后续 Agent 统一到 Wemux ADK Profile，再通过主动长连接加入网络；Server 负责授权、路由、协作关系和治理，不要求 Agent 原生实现 Wemux 网络协议。它以 Project 为组织中心，统一管理分布在不同 Worker 上的 Agent、模型能力、工作环境和持续 Session，支持从直接对话、会话 Fork 与空间化协作，到任务指派、执行监督与结果审查的完整工作过程。

“Lite”表示轻量部署、必要依赖和可理解的架构，不表示演示版、功能残缺或降低可靠性。目标不是做 MVP，也不是复制 Wemux Slim 的全部技术栈；参考其产品能力，根据本产品边界选择实现。

这里的集群是受管的分布式 Agent 执行资源，不是 GPU 训练集群、模型推理服务集群或通用容器调度平台。Agent 使用的模型可以来自远程服务，Worker 不必拥有 GPU。这里利用的是 Agent loop、工具和构建测试占用的 CPU/内存及环境能力：通过任务机器范围、申领或指定派发，把执行交给有资格且有剩余容量的远程机器。多用户团队共同使用同一套项目与任务。

平台支持两种目标形态：loop-in 使用 Worker 本机 Agent Runtime，loop-out 使用平台 Runtime 驱动 loop 并调用 Worker 工具。平台 Runtime 是 loop-out 的组成部分，不等同于项目管理角色；首个 loop-out 场景已确认是单 Worker 的完整任务执行，共用看板、分配、权限、容量及会话/成果视图；部署位置与实现选型仍待设计。容量初始化值及持续授权规则也尚待确认，见[需求基线 D1–D6](specs/ai-workbench-requirements-alignment.md)。现有 Worker 执行架构不代表这些形态均已实现，也不要求 Server 本身变成 Runtime。

## 2. 用户与核心问题

- 个人开发者：从浏览器或其他客户端使用多台机器上的不同 Agent，不再逐台登录、寻找会话或猜测执行状态。
- 团队成员：围绕项目组织代码、工作环境、持续对话与任务，在授权范围内共享执行资源和成果。
- 集群管理员：管理节点接入、身份、能力、健康、维护与故障恢复，不靠直接读取私人聊天内容来治理资源。

核心价值是“统一管理且执行可信”，不是把若干 Agent CLI 包装成多个聊天窗口。

## 3. Task 承载的讨论与实施路径

最新确认的方向与实施门槛见 [新版前端与项目级 Agent 能力规格](specs/web-next-project-agent-platform.md) 和 [ADR 0007](adr/0007-task-bound-conversation-direction.md)。以下为目标规则，不代表现有代码已完成迁移。

```text
集群资源：Worker → Agent → 模型与运行能力

Project
  ├── Repository
  ├── Workspace（逻辑工作环境）
  │     ├── Placement @ Worker A
  │     └── Placement @ Worker B
  └── 普通 Task → Assignment → Run → Session（固定 Task，模型可切换）

Team → 协调对话 Task → Session → 经授权交接 Project 内普通 Task
```

### 协调讨论与测试对话

所有 Session 必须绑定 Task。平台协调入口自动提供 Team 级专用 Task，用于讨论、研究、计划和受权交接；项目内测试也自动提供专用 Task，不要求用户先填任务表单。协调执行者可以位于任意获授权 Worker，不要求 Server 本机执行。协调入口现已提供 Team Task/Session 首次发送、同任务会话复用、历史恢复与普通 Agent 对话；浏览器桌面/手机 Test Agent 链路通过，但显式在原 Task 下重开新 Session 已通过 Test Agent 双视口验证；有效非付费 Runtime、上传/审批等功能仍待逐项验收，NEXT-05 未签收。用户已决定协调 Agent 按普通 Agent 的获权范围运行，不额外限制文件、终端或网络，隔离需求后续单列，且不要求书面残余风险接受才能启用。账号、Team、Worker、Workspace 和 Project/Task 授权及既有审批照常生效；见[ADR 0008](adr/0008-coordination-chat-ordinary-runtime-permissions.md)与[协调 spec](../.scratch/web-next-coordination-closure/spec.md)。

### 任务协作

Project → Task（目标与验收标准）→ Assignment → Run → Session → 显式提交完成及配置的审查流程。

Vibe Kanban 式 Task 看板是主要管理视图，但不是手工会话的必经页面。任务组织多个 Session 以完成项目；项目管理 Agent 与人共用任务管理工具，获权后可以组织和持续推进，只有用户或策略要求先审计划时才批准 revision。Run 成功不等于 Task 完成；新项目默认不强制审查，管理者可配置 Agent、人工或多阶段审查，执行者不得自行取消要求。

两条集群路径共享同一套执行、历史、权限与故障恢复机制，不建设两套会话系统。

### 会话协作画布与血缘

Project 提供可交互的会话协作画布，展示用户获权可见的 Session、Fork 来源及后续 Delegation、Artifact Reference、Run Attachment 等关系。画布节点是同一 Session 的真实交互表面，不是静态缩略图：用户可直接阅读和发送消息，并在画布形态与专注对话形态间连续展开和缩回，保持草稿、滚动、队列、流式输出和执行状态。

Fork 是后端持久化的领域事实，必须记录来源 Session 和固定事件 cursor；来源后续消息不自动进入目标上下文。画布只投影 Session、血缘、权限与运行状态，不成为数据权威，也不替代会话列表、搜索、任务看板或移动端可达路径。详细模块边界、依赖选择和实施线见 [会话协作画布与血缘模块设计](design/session-collaboration-canvas.md)。

### Worker 独立工作台与可选集群接入

Worker 可独立安装，不注册 Server 也可通过自身鉴权的 Web/API 使用本机 Agent。用户可在 Worker Web 的“集群连接”页主动加入，或选择暂不加入。支持显式配置的局域网和公网 HTTPS 访问，不要求浏览器在执行机器上，也不承诺自动 NAT 穿透。

独立与集群两种宿主复用运行时内核、会话协议和会话 Web 模块，身份与资源授权各自负责。加入集群不自动上传本地会话或发布目录，断线或退出不破坏独立使用。具体交互、安全边界和实施切片见 [Worker 独立 Web 工作台](design/worker-web-workbench.md)；这是待实施目标，不是现有能力声明。

集群连接与 Agent 对话协议保持分层：Worker 到 Server 的一条主动出站连接负责认证、版本协商、多路复用、可靠投递、重连和补传；Wemux ADK Profile 继续独立定义 Session、Invocation、Event、Content、Action、Approval、Cancel 与终态。`@wemux/agent-interchange` 的 `AgentEvent` 是唯一公共执行 Event；Worker 内部 Provider signal、Session Journal 投影与 transport frame 都不是第二套 Agent 协议。升级 transport 不得改写对话身份。具体技术基线见 [Agent 互操作模块设计](design/agent-interchange-module.md) 与 [Worker 可靠长连接模块设计](design/worker-reliable-connection.md)。

协议、Adapter、协作和运行形态按功能票据依赖推进，不再使用 P0/P1/P2 或 C0–C6 作为执行层级。现有有效 Runtime 的真实验收范围见[项目管理 spec](../.scratch/web-next-plan-handoff/spec.md)；新增运行形态单独跟踪，不以历史适配验收代替。

## 4. 必须完整建设的能力

| 能力域 | 目标 |
| --- | --- |
| 集群与节点 | 接入、身份、在线状态、能力与版本、维护、撤销、故障诊断和可控升级 |
| Agent 与模型 | 真实检测安装/认证/执行能力，可信的模型目录，明确的不可用原因与能力差异 |
| 项目与环境 | Repository、逻辑 Workspace、各 Worker Placement 的完整生命周期与清理边界 |
| 持续会话 | 创建、流式与工具事件、排队、停止、恢复、历史、检索、用量与同步新鲜度 |
| 协作画布与血缘 | 可交互 Session 节点、Fork cursor、关系图、画布/专注连续切换、布局和授权过滤 |
| 任务与交付 | 指派、尝试追踪、可配置审查、结果证据及外部关联；平台 API 支持 Agent 创建任务、查询关联会话与受权交接 |
| 权限与安全 | 邮箱注册、验证与找回、Google OAuth/OIDC 登录及账号绑定、团队、资源共享、撤权、客户端凭证、执行权限与审计 |
| 运维 | 安装、升级、迁移、备份、恢复、诊断、容量边界与可复查发布验收 |
| 客户端 | 集群 Web 与 Worker 独立 Web 复用会话交互；公共 API 与事件契约支持 CLI 和其他客户端 |
| 受控自动化 | 在可信执行与授权之上逐步提供能力匹配、批量分派和多 Agent 协作 |

每个能力都必须考虑正常、空数据、等待、失败、重试、取消、断线、重启与删除；不以按钮出现或成功路径跑通作为完成标准。

## 5. 不变量与架构边界

1. Server 是集群授权和控制面；Worker 是本机文件、进程、Agent 调用和 Session Journal 的执行权威，也负责独立 Web/API 的本地身份授权。集群注册凭据不作为 Web 登录凭据；直接访问不能绕过集群会话权限。浏览器关闭不应中断已持久接受的执行。
2. 加入集群时由 Worker 主动连接 Server；独立使用不要求注册，Agent 不是注册主体。Agent 与模型凭据、Git 凭据保留在 Worker，不为统一管理而集中复制到 Server。
3. Workspace 是 Project 内逻辑环境，Placement 是它在某个 Worker 上的物理落点。跨 Worker 管理不代表自动同步文件、共享绝对路径、故障转移或迁移原生会话。
4. Session 固定 Task、执行位置和 Agent，不换绑 Task。同一 Session 可切换当前 Agent 的模型，对下一 Turn 生效，保留每次执行的实际模型；不支持时明确拒绝，不隐式替换。
5. 同一 Placement 的 Session 共享文件；私有聊天不等于文件隔离。隔离工作必须使用独立环境，Worker 也不是容器安全沙箱。
6. Worker Journal 是会话历史权威；Server 投影必须展示新鲜度。Worker 永久丢失后的缓存保持只读且标明无法验证，不升级为权威。
7. 命令接收、实际执行、执行终结、日志同步、任务验收是不同事实。超时或离线不等于失败或成功；恢复和重试不得隐式重复执行。
8. Project、Worker、Session 权限独立约束执行；管理资源不自动授予私人内容读取权。安全能力未完整验收前，不得宣称可供不互信用户共享使用。
9. 默认保留单 Server、Server/Worker 本地持久化和直接通信的轻量部署形态。现有 Node HTTP、SQLite、WebSocket 是合理正式产品选择，不因去掉 MVP 标签而更换技术栈。
10. 不为假设规模预引入 Redis、消息队列、外部数据库或 Kubernetes。新增依赖须说明已测量的问题、替代方案、部署与维护成本；轻量也不能成为省略测试和恢复机制的理由。
11. Worker 长连接的 transport envelope、ACK、cursor 和重放状态不进入 Wemux ADK Profile。网络重试必须保留原 `messageId`、`invocationId`、Event `id` 与管理 `commandId`，不能通过生成新领域身份掩盖重复投递。
12. 领域事实、应用编排、宿主端口、基础设施 Adapter 与 UI 投影按层依赖。Agent Adapter 不处理 Team 权限或网络重连；画布不直接读 Provider 原生事件、数据库表或 transport frame。
13. Module 采用小 Interface 隐藏复杂实现，调用方和测试走同一 Seam。只有已经存在多个真实 Adapter 或确定变化的能力才设可插拔 Seam；不提前建设通用插件市场、任意关系类型或抽象画布引擎。
14. Session Fork、Delegation 和其他关系是后端权威事实，React Flow node/edge 与节点位置只是前端或布局投影。关系创建必须幂等、可审计并经过权限收窄，不能由前端连线反推领域状态。

## 6. 当前基础与目标严格分开

以下为历史基础记录，不能当作当前完整实现盘点或发布验收结果；当前缺口按 spec/ticket 及操作登记核验：

- 仓库已有 Server、Worker、Web、共享协议与领域包。
- `packages/domain/src/workspace.ts` 与 `packages/server-domain/src/resources.ts` 已包含逻辑 Workspace 与 placements；旧单 Placement 投影仍存在，端到端契约尚需逐项核验。
- `apps/worker/src/agents/` 已有 Pi、Claude Code、OpenCode 适配代码；能力以运行时上报及真实验收为准，不从目录名推断。历史阶段编号不再定义当前验收范围。
- 已有任务、会话、命令、日志投影与部分管理入口；入口存在不代表所有异常路径已闭环。
- 账号入口已按 Ticket 04/05/07/06/08 换成独立登录会话与完整自助身份：实例管理员由部署声明 `WEMUX_ADMIN_EMAILS` 决定（命中即管理员，声明邮箱不受邀请制/关闭限制），`POST /auth/login` 建 Cookie 会话、`GET /auth/me` 与 `GET /auth/sessions` 管账号；邮箱注册/验证/找回与密码、邮箱安全管理已交付，Google OIDC 注册/登录及已有账号显式绑定/解绑已交付，并保护最后一种登录方式。引导令牌与首次认领（`POST /auth/setup`）已移除，旧 `POST /auth/session` 已退役（410）。但集群控制面仍只对实例管理员开放（非管理员请求返回 403 `admin_required`），不能因此宣称团队邀请、完整资源授权或 PAT 管理已完成。

根据用户反馈，现有基本流程可跑通，当前优先补功能与交互。工作按 [spec 与 ticket 索引](specs/web-next-index.md)及各 ticket 的功能依赖推进，测试证据随功能切片积累，不以全面基线核验阻挡开发。历史回复、旧票据勾选和旧测试数字不直接作为新增能力已交付依据。

## 7. 暂不纳入近期交付的方向

- GPU 训练/推理资源编排和通用容器平台。
- 多 Server 高可用与跨 Team 资源共享。
- 隐式跨 Worker 文件同步、原生会话无损迁移与透明故障转移。
- 未获授权的自主执行、无限自动重试或绕过验收策略自动完成；已授权目标内自主推进属于产品目标，不强制每一步人工批准。
- 通用企业 SSO/SAML、其他社交登录与原生桌面/移动客户端先保留方向。邮箱注册和 Google OAuth/OIDC 登录已纳入近期账号系统，不受本条延期；设计与验收见 [账号系统设计](design/account-identity-system.md)。

这些是当前投资顺序，不是通过“MVP 不做”永久排除产品能力。调整时必须更新范围和验收计划。

## 8. 文档职责与冲突处理

- 本文：产品定位、价值、主路径与产品级边界。
- [CONTEXT.md](../CONTEXT.md)：规范领域术语，不承载实现清单。
- [spec 与 ticket 索引](specs/web-next-index.md)：当前工作入口和需求追溯；具体依赖、状态与验收在各票维护。[旧路线图](roadmap.md)仅供历史追溯。
- `docs/specs/`、`docs/design/`：具体功能及技术契约；新功能开工前细化对应规格。
- `README.md`、`apps/*/README.md`：使用与运行指南，不以历史阶段限制定义产品上限。
- `docs/research/` 与标为历史的文档：研究或阶段记录，不直接作为当前状态声明。

冲突时，产品定位与术语遵循本文和 CONTEXT；任务域细节仍遵循 `docs/design/task-platform-contract-decisions.md` 中未被后续规格替代的契约。本文不暗中修改幂等、取消、权限等已存在的接口规则。旧规格中的“Task 唯一主线”“单 Worker Workspace”“MVP 永久范围”已失效；旧 M/P/V 编号只在历史原文内有意义，当前不再以阶段编号跟踪工作。
