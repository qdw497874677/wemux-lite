# Wemux Lite

Wemux Lite 将团队现有的、能够运行 Agent 的机器汇聚为共享执行资源，并围绕 Project 让团队成员共同使用这些能力完成软件开发。它不是云端重新托管 Agent 的平台，而是集中管理分布在多台 Worker 上的 Agent、Workspace 和持续 Session 的团队开发控制系统。

## Language

**Worker**:
安装在一台执行机器上、主动向 Server 注册并保持连接的受管执行节点。Worker 负责发现、上报和调用本机 Agent；Agent 本身不向 Server 注册。
_Avoid_: Agent、智能体、客户端

**Agent**:
某个 Worker 上可供用户选择和执行对话的 Agent 程序类型，例如 Codex、Claude Code、Pi 或 OpenCode。Agent 不是网络注册主体、角色人格、会话，也不是一次运行中的进程；一个可选 Agent 由 `(Worker, Agent key)` 唯一确定。
_Avoid_: 智能体、AgentRuntime、角色智能体

**Project**:
围绕同一产品或业务目标组织 Repository、Workspace、Task 和 Session 的逻辑容器。一个 Project 可以关联零到多个 Repository，Task 是其主要管理工作流。
_Avoid_: 单个 Git 仓库、工作目录、Worker

**Task**:
Project 内一个可管理的工作单元，承载标题、描述、验收标准、工作流状态与执行指派；Task 是协作与追踪的锚点，本身不是一次执行，也不等于某个 Session。
_Avoid_: Session、Agent Run、Turn、对话

**Task Workflow**:
Task 的管理状态机：`backlog | todo | in_progress | in_review | blocked | done | cancelled`。状态流转是人的管理决策；Agent Run 完成最多建议进入审查，不得自动标记完成。看板只是该状态机的一种视图，不是独立数据模型。
_Avoid_: Agent 执行状态、Run 状态、可配置工作流引擎

**Task Link**:
Task 与外部跟踪对象（如 Git issue、Pull Request）的关联记录，由类型、外部标识与 URL 组成。第一版只做展示与跳转，不承诺双向同步或外部状态回写；同步能力留作按类型扩展的适配器接口。
_Avoid_: 双向同步、镜像、导入即接管

**Agent Assignment**:
Task 上可变的执行意图：目标 Workspace、Agent（由 Worker 与 agentKey 确定）与 Model。修改指派只影响后续 Agent Run，不改变也不迁移已存在的 Session。
_Avoid_: Agent 人格、Session 绑定、运行中的进程

**Agent Run**:
按某次 Assignment 发起的一次执行尝试，持有 Worker、Workspace、Agent、Model 的不可变快照，并引用一个 Session 承载对话与工具事件。Run 有独立执行状态与结果；第一版一个 Task 同时至多一个活跃 Run。
_Avoid_: Task、Session、Turn、Agent 本体

**Task Workspace**:
从 Task 入口创建并绑定到该 Task 的 Workspace；创建走标准 Workspace Provisioning，Task 只持有引用，不改变 Workspace 的生命周期规则，也不随任务删除自动清理。
_Avoid_: 任务专属文件副本、随任务删除的临时目录

**Repository**:
Project 所关联的一个版本库来源。Repository 描述可被 Workspace 采用的代码来源；同一个 Repository 可以出现在多个 Workspace 中。
_Avoid_: Workspace、Worker 上的本地目录、Repository Checkout

**Workspace**:
Project 在某个 Worker 上供 Agent 实际工作的固定执行环境，也是 Session 的执行位置。Workspace 分为 Repository Workspace 与 Composite Workspace；其所有本地路径只在所属 Worker 的文件系统命名空间内有意义。
_Avoid_: Project、Session、跨 Worker 的工作目录

**Repository Workspace**:
只承载一个 Repository 的 Workspace。其工作目录就是该 Repository 的本地根目录；它可以独立使用，也可以作为某个 Composite Workspace 专用拥有的成员。
_Avoid_: Repository 来源、多仓库组合环境、被多个 Composite Workspace 共享的成员

**Composite Workspace**:
在同一个 Worker 上组合多个专用 Repository Workspace 的多仓库执行环境。它拥有这些成员，不复用正在独立使用的 Workspace；成员必须属于同一 Project，且 Composite Workspace 之间不互相嵌套。其根目录不是 Git 仓库，只保存可重新生成的系统运行数据。
_Avoid_: 跨 Worker 编排、任意 Workspace 集合、单个 Git 仓库、Git 根目录

**Coordination Repository Workspace**:
Composite Workspace 中可选且最多一个的协调成员，用于版本化跨仓库文档、脚本、集成测试和环境配置。它仍是普通 Repository Workspace，与其他成员仓库同级，仅通过成员角色标明协调用途。
_Avoid_: Composite 根仓库、系统运行目录、Git Superproject

**Repository Checkout**:
某个 Repository 在特定 Workspace 中、位于该 Workspace 所属 Worker 上的本地工作副本。其本地路径由 Worker 在初始化时自动分配并上报，不作为 Project 或 Workspace 的预设配置；路径不能被解释为其他 Worker 上的路径。
_Avoid_: Repository 来源、用户配置的 checkoutPath、跨 Worker 的全局路径

**Workspace Provisioning**:
Server 先创建并持久化 Workspace 身份，再异步命令所属 Worker 初始化或清理实际目录；Worker 是文件系统操作和实际路径的权威，并向 Server 上报结果。Workspace 使用统一状态机：`pending → provisioning → ready | failed`，删除使用 `deleting → deleted | failed`；Worker 离线时保持 `pending`，重复初始化命令以 `workspaceId` 幂等。只有 `ready` 的 Workspace 可以创建 Session 或发送消息，第一版不在初始化期间排队聊天。当前不从 Worker 自主发现或导入已有目录作为 Workspace。
_Avoid_: 同步等待 Clone、Worker 自主注册 Workspace、Server 直接操作 Worker 文件系统、路径即 Workspace 身份、分散的 repoReady/runtimeStatus 初始化状态

**Session**:
用户可持续对话的产品级上下文。Session 创建后固定所属 Workspace、Agent 和 Model；Agent 在该 Workspace 中工作。同一 Workspace 可以同时运行任意数量的 Session，这些 Session 直接共享该 Workspace 的文件状态；需要文件隔离时创建新的 Workspace。需要更换 Workspace、Agent 或 Model 时也创建新的 Session。Session 可以拥有独立的访问权限，既可以私有，也可以共享。
_Avoid_: Native Session、Turn、Workspace 执行租约、Session 专属文件副本、可迁移聊天容器、所有 Session 强制继承完全相同的 Project 可见性

**Session Journal**:
由 Session 所属 Worker 持久化的标准化事件日志，是产品聊天历史的权威来源；Native Session 仅用于恢复 Agent 上下文。Worker 必须先将事件落盘，再向 Server 同步，并为每个 Session 分配单调递增的事件序号。Server 保留同一套 Agent 无关的通用事件模型及可重建的展示缓存，而不是直接缓存各 Agent 的私有事件格式。数据模型允许未来把 Worker 本地操作或 Agent 原生会话转换后写入同一份 Journal，并在重连后按序补传；但第一版不提供本地控制入口，也不保证自动发现或同步绕过 Worker 直接执行 Agent CLI 所产生的历史。
_Avoid_: Agent 私有会话文件作为产品历史、Server 缓存作为权威、未落盘即广播的事件、本地操作形成第二份会话历史、把未来兼容方向当作第一版保证

**Session Access Policy**:
每个 Session 记录一个所有者，并使用 `owner-only | selected-members | project` 三种共享范围。`owner-only` 只允许所有者访问；`selected-members` 允许所有者及拥有显式 Session Grant 的 Project 成员访问；`project` 允许所有具备 Project 查看权限的成员访问。Session 权限只能在 Project 的有效成员范围内收窄，不能向 Project 外部扩权；用户失去 Project 权限后，即使仍残留 Session Grant，也不能访问该 Session。未授权用户不能看到 Session 的标题、摘要、历史、事件、通知或搜索结果。Session 内容隔离不等于 Workspace 文件隔离，敏感执行结果需要独立 Workspace。
_Avoid_: Session Grant 绕过 Project 权限、把私有 Session 元数据显示给未授权成员、将聊天私密性误认为文件系统隔离、Session 向整个 Team 越级共享

**Session Cache Freshness**:
Server 必须记录每个 Session 已同步到的事件序号和同步状态。Worker 离线、Server 与 Worker 的末尾序号不一致、补传尚未完成或无法确认 Worker 末尾序号时，Web 和其他客户端必须明确提示历史可能不完整或不是最新；不得把缓存静默展示成已完全同步的权威历史。
_Avoid_: 无新鲜度信息的缓存、离线时假装历史完整、仅用最后连接时间推断已同步

**Session Control Surface**:
第一版所有 Session 创建、消息发送和管理操作统一通过 Server 授权后下发给 Worker，不提供 Worker 本地 Session CLI 或本地 Web 入口。架构上不排斥未来从 Agent 原生会话导入本地操作产生的历史，但第一版不承诺自动发现、转换或同步用户绕过 Worker 直接执行 Agent CLI 所产生的事件。
_Avoid_: 第一版本地控制面、绕过 Server 权限直接操作受管 Session、把未来兼容能力当作当前保证

**Access Control**:
Server 是所有远程操作的授权边界，必须提供团队隔离、资源可见性和操作权限机制。私有 Worker 不是只能由注册者永久独占；它可以在明确授权后供团队成员使用。Worker 只接受已认证 Server 下发的命令，不自行判断产品层团队权限。
_Avoid_: 仅靠前端隐藏资源、Worker 信任客户端自报身份、无授权的跨团队访问、注册者之外永远不可共享的 Worker

**Worker Access Policy**:
每个 Worker 属于一个 Team，并记录一个所有者；共享范围为 `owner-only | selected-members | team`。`owner-only` 只允许所有者使用，`selected-members` 允许所有者及拥有显式 Worker Grant 的团队成员使用，`team` 允许具备基本使用资格的活跃团队成员使用。Worker Grant 至少区分 `user` 与 `manager`，只授予同一 Team 内的成员。团队 Owner/Admin 可以查看 Worker 的存在和基本状态、审计授权关系及将其移出 Team，但不会仅凭团队管理角色自动获得私有 Worker 的执行权或 Session 历史读取权；使用和读取仍须符合 Worker Access Policy。
_Avoid_: 加入 Team 即自动访问所有私有 Worker、管理员天然读取私人会话、跨 Team Worker Grant、把资源治理权限等同于执行权限

**Project Access Policy**:
每个 Project 属于一个 Team，并记录一个所有者；共享范围与 Worker 一致，为 `owner-only | selected-members | team`，但 Project 授权和 Worker 授权相互独立。Project Grant 区分 `viewer | contributor | manager`：`viewer` 可查看 Project 及其被授权的 Session，`contributor` 还可创建 Session 和发送消息，`manager` 还可管理 Project、Repository、Workspace 和成员授权。Workspace 与 Repository 默认继承 Project 的内容可见性；Session 默认可继承 Project 权限，但允许通过自己的访问策略进一步收窄。执行操作必须同时满足 Project 操作权限、Session 操作权限与目标 Worker 使用权限。团队 Owner/Admin 可以治理或移除 Project，但不会仅凭团队管理角色自动读取私有 Project 或私有 Session 内容。
_Avoid_: Worker Grant 自动授予 Project 权限、Project Grant 自动授予 Worker 使用权、Team 管理员天然读取私有 Project 或 Session、用 Worker 在线或授权状态决定历史可见性

**Team Membership**:
一个 User 可以加入多个 Team。Team Membership 角色为 `owner | admin | member`：Owner 管理团队及管理员，Admin 管理成员和团队资源，Member 按资源授权使用；Owner/Admin 的治理能力不自动授予私有资源的内容读取权或执行权。最后一个 Owner 不得退出或被移除。成员离开 Team 后其 Membership 和全部资源 Grant 立即失效；离开前必须转移其拥有的 Project，私有 Worker 则移出 Team 或转移所有权。
_Avoid_: 单团队用户、最后一个 Owner 离开、离队后 Grant 继续生效、团队角色绕过资源权限

**Worker Enrollment**:
Worker 使用 Server 签发的一次性 Enrollment Token 加入指定 Team；Token 绑定 Team、发起人和有效期，且只能成功注册一台 Worker。注册完成后换取可撤销、可轮换的长期 Worker Credential，Server 只保存凭证哈希。Worker 主动建立连接，第一版一台 Worker 只绑定一个 Server 和一个 Team；本地持久化的 `workerId` 与身份凭证均保留时视为同一 Worker，否则必须重新注册。
_Avoid_: 可无限复用的注册码、Server 明文保存 Worker Credential、Worker 同时隶属多个 Team、客户端直接伪装 Worker

**Agent Capability**:
Worker 通过每种 Agent 的 Adapter 检测本地可执行文件、版本、认证状态、模型和协议能力，并向 Server 上报；可选 Agent 仍由 `(workerId, agentKey)` 唯一确定。第一版检测 Claude Code、Codex、Pi 和 OpenCode。模型列表由 Adapter 探测结果与管理员显式配置合并，允许在具体 Agent 下填写自定义模型 ID。Agent 凭证、API Key 和登录状态只保留在 Worker。Session 绑定的 Agent 或 Model 消失时进入 `unavailable`，不得静默切换。
_Avoid_: Server 保存 Agent 密钥、只靠硬编码模型列表、模型消失后自动换模型、把同名 Agent 当成跨 Worker 单例

**Turn Queue**:
一个 Session 同时最多执行一个 Turn；运行期间提交的新消息进入该 Session 的持久化 FIFO 队列，而不是被拒绝。每条排队消息都有独立 `commandId`，可在开始执行前取消；停止当前 Turn 只停止当前执行，默认继续处理后续队列。Worker 是实际队列和执行顺序的权威，Server 保存队列投影并向客户端展示 `queued` 状态。Worker 重启后恢复未开始的排队消息；中断中的 Turn 标记为 `failed/interrupted`。同一个 Native Session 同时只允许一个 Agent 进程操作。
_Avoid_: 同一 Session 并发运行多个 Turn、仅在浏览器内排队、重启后静默丢队列、停止当前 Turn 时隐式清空全部队列

**Session Runtime State**:
Session 运行状态至少包括 `idle | queued | running | stopping | unavailable | failed`。每个 Server 命令使用唯一 `commandId` 幂等执行；消息是否成功入队与 Turn 是否执行完成是不同状态。Worker 或 Agent 异常退出时必须产生明确的失败或中断事件，不能伪装成正常完成。
_Avoid_: 将命令接收等同于执行完成、无幂等键的重试、进程丢失后仍显示 running

**Worker Protocol**:
Worker 主动通过 WebSocket 与 Server 建立版本化 JSON 协议连接。协议消息分为 `hello | heartbeat | capability | command | ack | event | sync | error`；`commandId` 用于命令去重，`sessionId + seq` 用于事件排序和去重。重连时 Worker 上报各 Session 的末尾序号，Server 使用 `fromSeq` 请求缺失事件；存在中间缺口时标记 `gap`，不得跳过后宣称同步完成。第一版协议版本不兼容时拒绝连接，不实现复杂降级。
_Avoid_: Server 反向直连 Worker、无版本协议、仅靠时间戳排序、忽略历史缺口

**Persistence Ports**:
领域和服务层只依赖明确的 Store 接口，不直接依赖 SQLite API；Server 与 Worker 分别拥有存储端口和 SQLite Adapter，使未来可替换 PostgreSQL、其他嵌入式数据库或 Journal 后端而不改变领域规则和通信协议。第一版 Server 与 Worker 均使用 SQLite，并通过显式迁移管理 Schema；不引入 PostgreSQL、Redis、Kafka，也不以 JSONL 作为主数据库。
_Avoid_: SQL 散落在领域服务中、领域实体依赖 SQLite 类型、以 ORM 模型充当领域模型、为未来数据库提前引入分布式依赖

**Server Store**:
Server SQLite 保存 User、Team、Membership、资源授权、Project、Repository、Worker 元数据、Workspace、Session 元数据、Session 事件展示缓存、命令投影和审计日志。Worker 永久丢失后，Server 缓存只能进入 `orphaned/read-only`，不得升级为已验证的权威历史。
_Avoid_: 将展示缓存提升为历史权威、Server 保存 Worker 本地绝对路径的控制权、把 Agent 密钥同步到 Server

**Worker Store**:
Worker SQLite 保存 Workspace 本地路径、Session Journal、消息队列、Native Session 映射、Agent 检测结果、命令幂等记录和执行恢复信息。Worker 负责文件系统及 Journal 的真实状态，所有需同步的会话事件必须先本地提交再发送给 Server。
_Avoid_: 只在内存中保存队列或幂等记录、Server 直接写 Worker 数据库、事件未提交就广播

**Resource Deletion**:
Server 资源默认先软删除，软删除元数据与历史缓存默认保留 30 天并允许未来配置。Workspace 删除采用 `deleting` 状态并由 Worker 异步清理，Worker 离线时等待重连继续。删除 Project 不立即物理删除 Worker 文件。Worker 移出 Team 时立即撤销连接凭证和 Server 权限，但本地文件默认保留，只有显式“清理 Worker 数据”才删除。Project 和 Session 可在同一 Team 内转移所有权，Workspace 跟随 Project，不单独转移。
_Avoid_: 离线时假装 Workspace 已清理、移除 Worker 即远程擦盘、跨 Team 转移资源、无恢复期的级联物理删除

**Authentication and Audit**:
第一版 Server 使用本地账户、密码哈希和 HttpOnly 安全 Cookie；其他客户端使用 Personal Access Token，不实现 OAuth、SSO 或 LDAP。生产环境要求 TLS，长期凭证不得明文入库。登录与 Token、成员与 Grant、Worker 注册与共享、资源创建删除、消息提交、停止 Turn 和管理命令必须审计。审计记录操作者、动作和资源，不复制完整聊天正文。第一版聊天及工具输出按原内容同步，不内置自动脱敏，但客户端必须提示敏感信息风险。
_Avoid_: 明文密码或 Token、只审计 UI 操作、审计日志复制完整会话、宣称存在未实现的自动脱敏

**Git Credentials**:
第一版只支持 Git Repository。Server 保存 Git URL、默认分支等元数据，不保存 Git 私钥；Clone 与 Fetch 使用 Worker 本机的 SSH Agent、Git Credential Helper 或环境。Workspace 路径由 Worker 自动分配，Server 不得指定任意绝对路径。Clone 失败进入 Workspace `failed` 并允许显式重试；第一版不自动导入 Worker 已有目录。
_Avoid_: Server 下发私钥、跨 Worker 解释本地凭证或路径、Clone 失败后自动假装 ready、第一版导入任意已有目录

## MVP Scope

完整第一版目标是单 Server 实例和 Server/Worker 双 SQLite，支持多用户、多 Team、多 Worker、Worker 注册与心跳、离线检测、Worker/Project/Session 权限、Agent 与模型检测、Git Repository、Workspace 创建、Server 远程 Session 控制、持久化消息排队、流式回复、停止 Turn、Worker Session Journal、断线补传、Web 控制台、Personal Access Token API 和基础审计。

当前可运行 MVP 已进一步收窄为单 bootstrap 管理员、Repository Workspace、HTTP + SSE + Worker WebSocket、Server/Worker 双 SQLite、持久命令和 FIFO 消息队列，并以 `test` Agent 完成真实执行闭环。Pi、Claude Code、Codex、OpenCode 当前只检测；多用户/Team 授权界面、PAT、完整审计和 Composite Workspace 保留在领域模型与端口中，尚未作为已实现能力对外宣称。交互设计已定稿（见 docs/design/frontend-interaction-architecture.md）：Project 内以 Task 看板为主工作流（视图与卡片字段保留扩展口），Task 可关联 Git issue 等外部跟踪对象（第一版只读展示），可在 Task 中创建 Workspace 并以 Agent Assignment + Agent Run 完成任务执行，Run 完成不自动终结任务。

完整执行 Adapter 首先实现 Pi 与 Claude Code；Codex 与 OpenCode 第一版完成检测和展示，但不保证完整执行。第一版不实现 Worker 本地控制面、自动导入原生 Agent 历史、多 Server 高可用、PostgreSQL、Redis、消息中间件、Worker 自动升级、OAuth/SSO、容器沙箱、跨 Worker Workspace 或跨 Team 资源共享。

核心验收路径：创建 Team并邀请成员，注册至少两台 Worker，自动检测 Agent 与模型，创建 Project、Repository 和指定 Worker 上的 Workspace，选择 Agent 与 Model 创建 Session，通过 Web 连续提交含排队消息的对话并查看流式及工具事件；Worker 离线时明确显示缓存非最新，重连后补齐历史；私人 Session 可分享给指定 Project 成员，未授权成员无法发现、读取或操作该 Session。
