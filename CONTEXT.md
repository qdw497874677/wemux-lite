# Wemux Lite

Wemux Lite 是以 Project 为组织中心、自托管的 AI Agent 集群管理与协作平台，统一管理分布在不同 Worker 上的执行能力、工作环境与持续 Session。直接对话与任务协作均是一等使用路径。

本文只定义领域语言。产品方向见 [docs/product-direction.md](docs/product-direction.md)，建设安排见 [docs/roadmap.md](docs/roadmap.md)。

## 集群与能力

**Server**:
面向集群 Web 和其他客户端的统一控制、授权与对话中转边界，管理集群资源和执行请求，并呈现 Worker 上报的状态与历史投影。集群客户端只连接 Server，由 Server 校验权限后通过 Worker 主动建立的长连接转发 Wemux ADK Profile；Server 不成为 Agent Runtime，也不是 Worker 本地独立 Session 的必经入口。
_Avoid_: Agent 执行机器、集群浏览器直连 Worker、第二套对话模型、Worker 文件系统权威、浏览器内调度器

**Cluster**:
由一个 Server 统一管理的一组 Worker 及其可授权使用的 Agent 执行能力。
_Avoid_: GPU 训练集群、模型 API 网关、共享文件系统

**Agent Network**:
由 Wemux Server 统一管理和编排的 Agent 执行能力网络：不同 Worker 通过 Adapter Bridge 把异构 Agent 统一到 Wemux ADK Profile，并以主动长连接加入网络；团队成员通过受控的 Project、Workspace、Session 和协作画布访问这些能力，Agent 也可在用户授权范围内经 Server 发起结构化委托。Agent 与 Worker 不直接横向互连。
_Avoid_: P2P Agent 网络、Agent 自主扩大权限或组队、公共 Agent 市场、Worker 互联网络、要求 Agent 原生实现 Server transport

**Agent Delegation**:
父 Invocation 经 Server 鉴权、路由和审计后向目标 Agent 发起的结构化子调用；子调用拥有独立 Session 或 Invocation，并以 Tool Result 返回父调用。执行链记录 `parentInvocationId`、发起 Agent、目标 Agent 与实际用户身份；首版可以先提供人工编排，再演进自动委托。
_Avoid_: Agent 直连、共享同一 Invocation、跨 Project 默认委托、子调用继承父调用全部权限

**Delegated Authority**:
子 Invocation 的有效权限是发起用户、父 Invocation 授权、目标 Agent、目标 Worker 和目标 Workspace 权限的交集；委托只能收窄权限，不能扩大 Workspace、Secret、网络、Shell 或文件能力。
_Avoid_: Agent 自授予权限、自动继承所有 Secret、用父 Agent 身份替代实际用户、跨 Project 隐式授权

**Worker**:
安装在执行机器上的唯一 Agent 网络执行节点，负责发现和调用本机 Agent；可独立提供经自身鉴权的 Web/API，也可主动通过长连接加入 Server 管理的集群。独立安装身份不等于集群注册身份。
_Avoid_: Agent、智能体、客户端、Agent 直接入网、必然等同于一台物理机器

**Agent**:
某个 Worker 上可选择并由 Adapter 桥接的 Agent 程序类型，如 Pi、Claude Code、Codex 或 OpenCode；其选择身份由 `(Worker, Agent key)` 确定，不直接注册或连接 Server。
_Avoid_: 网络节点、注册主体、角色人格、Session、一次运行的进程、跨 Worker 单例

**Model**:
由特定 Agent 使用、通过提供方与模型标识区分的模型选择，其可用性属于该 Worker 上该 Agent 的能力上下文。
_Avoid_: Agent、Worker、跨所有 Agent 通用的裸模型名称

**Agent Capability**:
Worker 对某个 Agent 的版本、安装、认证、健康状态、可用模型、最大并发，以及 streaming、resume、tool events、approval、steering、cancellation、artifacts 和 structured output 等能力的声明，区分可发现与可实际执行。Server 只使用已声明能力，不静默降级。
_Avoid_: 只上报 Agent 名称、检测到即能执行、硬编码模型即真实可用、未声明能力仍下发、模型不可用时静默替换

**Worker Enrollment**:
Worker 经授权加入受管集群、取得可撤销身份凭据的过程。
_Avoid_: Agent 注册、可无限复用的注册码、身份丢失后仍视作原 Worker

**Worker Connection**:
一个 Worker 到一个 Server 维持的一条可重建逻辑长连接，在其中多路复用 Worker 控制消息、能力状态、Workspace 操作以及所有 Session 和 Invocation 的 Wemux ADK Profile 消息。握手协商 transport major、Wemux ADK Profile 版本和可选 feature；不兼容的 transport major 拒绝连接，未声明能力不得下发。Session 是连接内逻辑流，不拥有独立网络连接；传输实现可演进而不改变对话契约。
_Avoid_: 每个 Session 一条长连接、控制与对话各自建立身份、假定双方版本永远一致、把 transport envelope 当成 ADK Event、物理 socket 永久不断即逻辑连接连续

**Reliable Worker Delivery**:
Server 持久化后向 Worker 至少一次投递消息。对话执行直接使用 Wemux ADK Profile 的稳定 `invocationId` 作为调用身份与幂等键，Event 使用自身 `id` 并关联该 `invocationId`；网络 envelope 的 `messageId` 只负责传输去重与 ACK。非对话管理操作才使用独立 `commandId`。Worker 持久化接收状态与结果，重连重发不重复产生副作用；`accepted | rejected` 不替代 ADK 终态或管理操作结果。
_Avoid_: 为同一次对话调用再创造第二个 command 身份、宣称分布式 exactly-once、重连时生成新 invocationId、ACK accepted 等同 completed、仅靠内存去重、断线后让用户猜测是否执行

## 项目与工作环境

**Team Collaboration**:
登录 Server 的团队成员依照资源权限，在不同 Project、Task、Workspace 中发现并操作可访问的 Session，与这些 Session 中绑定的 Agent 持续对话。它首先描述人与受管 Agent 能力的共享使用，不以自动 Agent 委托为使用前提。
_Avoid_: Agent 自主组队、把 Agent 委托作为基础协作前置条件、共享 Worker 即自动共享全部 Session

**Project**:
围绕同一产品或业务目标组织 Repository、Workspace、Session 和 Task 的逻辑容器。
_Avoid_: 单个 Git 仓库、工作目录、Worker、必须先建 Task 的容器

**Repository**:
Project 关联的版本库来源，可供多个 Workspace 采用。
_Avoid_: Workspace、Worker 本地目录、Repository Checkout

**Workspace**:
Project 内具有统一身份与环境定义的逻辑工作环境，可在零个或多个 Worker 上拥有独立 Placement。
_Avoid_: 单 Worker 物理目录、Session、自动同步的跨机器文件夹

**Workspace Placement**:
一个 Workspace 在某个 Worker 上的物理落点，以 `(workspaceId, workerId)` 区分，拥有独立路径、物化状态和失败信息。同一 Placement 中的 Session 可以并发执行且共享文件状态；需要文件隔离时使用不同 Placement。
_Avoid_: 新 Project、跨 Worker 共享路径、隐式副本同步、Session 隔离即文件隔离、会话迁移

**Repository Workspace**:
仅承载一个 Repository 的逻辑 Workspace，可以独立使用或作为 Composite Workspace 专用成员。
_Avoid_: Repository 来源、多个组合环境共享的成员

**Composite Workspace**:
组合多个同 Project 的专用 Repository Workspace 的逻辑环境；它在某 Worker 上的 Placement 将这些成员的本地副本组合为执行环境，不互相嵌套。
_Avoid_: 跨机器挂载、任意 Workspace 集合、根目录必为 Git 仓库、类型存在即已实现

**Coordination Repository Workspace**:
Composite Workspace 中可选且至多一个、用于存放跨仓库文档和集成配置的协调成员，与其他成员仓库同级。
_Avoid_: Composite 根仓库、系统运行目录、Git Superproject

**Repository Checkout**:
Repository 在某个 Workspace Placement 内的本地工作副本，其路径只在对应 Worker 的文件系统中有意义。
_Avoid_: Repository 来源、跨 Worker 全局路径、预设服务器绝对路径

**Workspace Provisioning**:
将逻辑 Workspace 在指定 Worker 上物化为可执行 Placement 的过程，结果由执行节点确认。
_Avoid_: 逻辑身份创建即目录已就绪、其他 Placement 成功即当前可用、Server 操作远程本地路径

## 对话与执行

**Agent Adapter Bridge**:
Worker 内将 Pi、Claude Code、Codex 等 Agent 的原生 SDK、CLI 或流式协议适配为统一 Wemux ADK Profile 的边界；桥接器只处理 Agent 能力与原生执行语义差异。
_Avoid_: Agent 直接实现 Server 协议、Adapter 处理网络重连或产品权限、向外暴露 Provider 原生事件

**Wemux ADK Profile**:
Worker 对本地 Web 与 Server 提供的唯一、版本化对话执行契约，统一 Session、Invocation、Content、Event、Actions、Command、Approval、Cancel 与终态语义。它与 Google ADK 核心语义和结构可无损映射，但 wire schema 由 Wemux 独立演进；Wemux 与 Provider 扩展分别置于 `customMetadata.wemux` 和 `customMetadata.provider`。HTTP、WebSocket 或长连接消息只是其传输和可靠性封装，不形成第二套对话模型。
_Avoid_: 直接把某版 Google ADK SDK 类型或序列化格式作为网络协议、本地 Web 与 Server 各自定义对话协议、把网络 envelope 当成领域事件、只借用 ADK 名词却不能映射、宣称 Pi 或 Claude 原生实现 ADK

**Management API**:
对 Project、Workspace、Worker、Task、权限和治理资源进行查询或管理的非对话 API，与 Wemux ADK Profile 分离。
_Avoid_: 将资源 CRUD 塞进对话 Event、为复用 endpoint 而混合控制面与执行语义

**Worker Web Workbench**:
Worker 自带的独立 Web 工作台，使用本机身份直接调用本 Worker 的 Wemux ADK Profile；可经安全配置远程访问并主动加入集群。加入集群只共享执行能力，不自动共享本地 Session；集群 Web 必须经 Server 中转，不复用此直连入口。
_Avoid_: 必须先注册的集群页面、无需认证的调试页、集群浏览器直连 Worker、Worker Credential 充当集群浏览器登录凭据

**Session Publication**:
将 Worker 本地 Session 显式发布为集群 Session 的过程，发布时选择目标 Project、Workspace、Placement、历史同步范围与共享策略；发布前的本地 Session 默认不被 Server 或团队发现。
_Avoid_: Worker 入网即上传全部会话、后台自动纳管、仅凭本地路径推断 Project 归属

**Local Work Environment**:
经 Worker 本地授权、用于独立 Session 执行的工作环境，不要求集群 Project 或 Workspace 身份。
_Avoid_: 自动发布的集群 Workspace、任意目录即授权、文件系统沙箱

**Session**:
可持续对话的产品上下文，固定绑定执行环境、执行节点、Agent 与 Model。集群会话固定归属 Project 和 Workspace Placement，可被 Task 或 Agent Run 关联但不以 Task 为强制父级；获权成员共同使用同一上下文和 Journal，需要独立探索时显式 Fork。本地会话归属 Worker 本地工作环境，不要求加入集群。Worker 离线时 Session 变为 unavailable，Server 不将其隐式迁移到其他 Worker；等待、Fork 或迁移都必须显式发生。
_Avoid_: Native Session、Task 的子资源、Turn、按成员隐式复制的对话、私有聊天即文件隔离、跨 Worker 透明故障转移

**Session Fork**:
从现有 Session 的固定 `sourceEventCursor` 显式创建的独立 Session，用于在不改变原对话的情况下继续探索；Fork 拥有自己的后续上下文和 Journal，来源 Session 在 cursor 之后的消息不会自动进入目标，是否沿用原 Workspace Placement、Worker、Agent 与 Model 由创建时明确选择。Fork 与目标 Session 创建是后端幂等、可审计的领域操作。
_Avoid_: 打开共享 Session 时自动复制、同一 Session 的私人视图、修改原 Session、前端画一条边即完成 Fork、隐式继承后续消息或扩大权限

**Session Lineage**:
Session 之间由显式 Fork 形成的可追溯来源关系，以及从 Invocation Delegation 投影出的执行派生关系。血缘记录来源身份、固定分支点、操作者和目标身份；归档或删除来源不把后代改写为无来源 Session。
_Avoid_: UI 节点位置、消息时间相近即推断来源、所有关系都称 Fork、删除来源级联删除后代

**Session Collaboration Canvas**:
Project 内对获权 Session、Session Lineage 与其他受控关系的可交互空间投影；节点可直接对话并展开为专注 Session Surface，边展示后端权威关系。画布位置、缩放和折叠是布局状态，不改变 Session、Journal、权限或执行绑定。
_Avoid_: 自由白板、领域数据权威、浏览器端编排器、打开或拖动节点即 Fork、无列表/移动端替代路径

**Session Surface**:
同一 Session 在画布摘要、画布交互、专注对话和 Run 视图中的共享交互表面；各形态复用同一草稿、Journal 订阅、队列与控制状态，只改变信息密度和容器。
_Avoid_: 四套聊天实现、最大化时创建新 Session、切换视图重新生成 invocation、组件局部状态成为历史权威

**Canvas Layout**:
用户或团队对 Session Collaboration Canvas 的节点位置、折叠和 viewport 偏好，带图 revision 持久化并与 Session Lineage 分离。自动布局只计算位置，不创建、删除或重写关系。
_Avoid_: React Flow node/edge 作为领域记录、拖动节点改变 Fork 来源、布局冲突覆盖血缘、布局失败阻断会话

**Native Session**:
Agent 自身维护的上下文恢复身份或记录，由 Worker 关联到产品 Session。
_Avoid_: 产品历史权威、可跨 Agent 通用的恢复凭据

**Session Journal**:
Session 所属 Worker 持久保存的标准化事件历史，是产品聊天与工具事件的权威来源。Worker 为每个持久化 Event 分配 Session 内单调递增的 `sessionSequence`，持久化后才同步；Server 以最后连续 cursor 检测缺口并请求补传。partial delta 只服务实时展示，可以合并、限速或丢弃，不进入可靠历史；每个 Invocation 恰好一个持久化终态。
_Avoid_: Agent 私有文件直接作为产品历史、Server 展示缓存即权威、未持久化就上报为事实、依赖到达顺序、将 partial delta 当作可重放历史

**Session Cache Freshness**:
Server 历史投影相对 Worker 权威历史的同步新鲜程度，包括未确认、缺口、离线或无法恢复等情况。
_Avoid_: 没有新事件即完全同步、连接在线即历史完整、Worker 永久丢失后缓存自动变权威

**Session Control Surface**:
客户端创建、发送和管理 Session 的授权入口；集群入口由 Server 授权，Worker 独立入口由自身授权。Project 角色决定基本操作能力，消息或 Turn 发起者可取消自己的待执行消息或停止自己的 Turn，Session Owner 或 Project Manager 才能干预他人的执行；所有操作保留实际操作者身份。
_Avoid_: 能读取即能操作、普通参与者取消他人工作、绕过所属资源权限、登录 Worker 自动获得集群 Session 权限

**Turn**:
Session 内处理一条已提交消息的一次执行回合，与命令接收和任务验收分别记录。需要人工授权时，Agent 通过 Wemux ADK Profile 发出结构化 Approval Request，Turn 进入 `waiting_for_approval`；决定关联 `invocationId + approvalId`，超时、断线或无人处理均不得自动批准。
_Avoid_: Task、完整 Session、命令 accepted 即执行完成、把审批放在协议外、超时默认同意

**Turn Queue**:
Session 内等待执行的消息队列，同一 Session 一次只执行一个 Turn，停止当前 Turn 不隐式清空后续消息。
_Avoid_: 浏览器临时队列、同 Session 并行执行多个 Turn

**Session Runtime State**:
Session 的当前执行状态，用于区分 `idle | queued | running | waiting_for_approval | stopping | unavailable | failed`，不替代连接状态、Invocation 状态和历史新鲜度。
_Avoid_: 离线即执行失败、Invocation 完成即 Session completed、进程丢失仍显示 running

**Invocation Delivery State**:
一次 Invocation 从提交到终止的可观察状态：`queued_for_worker | delivered | accepted | running | waiting_for_approval | completed | failed | cancelled | expired`。Worker 离线时允许用户明确创建可取消、可过期的队列项，恢复后仍使用原 `invocationId` 投递；危险操作可以禁止离线排队。
_Avoid_: 离线排队伪装成已运行、queued 或 accepted 等同 running、重投生成新 invocationId、用 Session 状态代替调用状态

## 任务与审查

**Task**:
Project 内承载目标、验收标准、管理状态和执行意图的工作单元，是可选的协作追踪锚点；它可以关联 Workspace、Session 和 Agent Run，但不拥有其生命周期。
_Avoid_: Session、Turn、Session 的强制父级、所有对话的前置条件

**Task Workflow**:
Task 的管理状态机：`backlog | todo | in_progress | in_review | blocked | done | cancelled`；任务完成由人决策，看板只是其视图。
_Avoid_: Run 执行状态、Run 成功自动 done、可配置工作流引擎

**Task Link**:
Task 与外部跟踪对象（如 Git issue、Pull Request）的关联。
_Avoid_: 建立关联即双向同步、导入即接管

**Agent Assignment**:
Task 上可变的执行意图，指定 Workspace、Worker、Agent 和 Model，只影响后续 Run。
_Avoid_: 用户指派、角色人格、迁移现有 Session

**Agent Run**:
一次 Task 执行尝试，持有不可变执行绑定快照并引用 Session，具有独立状态与结果。
_Avoid_: Task、整个 Session、Agent 本体、独立追加消息自动属于当前 Run

**Task Workspace**:
与 Task 关联的 Workspace，关联不改变环境生命周期，也不因任务删除而隐式清理文件。
_Avoid_: 必然专属文件副本、随任务销毁的临时目录

**Review**:
人对任务执行结果及验收证据的判断，可以批准完成或要求修改，与 Agent 自报成功分开。
_Avoid_: Turn 终态、模型自评等同于人工验收

## 共享与治理

**User**:
Server 内稳定的人类账号主体，可关联多种登录身份并加入多个 Team；资源所有权、授权与审计归属该主体，而非邮箱或某次登录。
_Avoid_: Google 账号即 Team 成员、邮箱即永久身份、Worker 注册身份、共享管理员账号

**Login Identity**:
User 证明自身身份的一种登录方式，如本地密码或外部身份提供方账号；关联新方式不改变 User 的资源归属，也不扩大权限。
_Avoid_: 同邮箱自动合并账号、登录方式即资源授权、Google 登录即 Agent Provider 授权

**Team Invitation**:
邀请特定接收者加入指定 Team 的有限时效授权，接受后建立 Team Membership；账号注册与接受邀请是不同过程。
_Avoid_: 持有邀请即已有资源权限、注册自动加入已有团队、邀请即 Worker Enrollment

**Team Membership**:
User 与 Team 的成员关系，团队治理角色为 `owner | admin | member`，不自动授予私人资源读取权或执行权。
_Avoid_: 单团队用户、团队管理员天然可读全部私人会话、离队后授权仍有效

**Access Control**:
决定资源可见性和操作权的规则；执行同时受 Project、Session 与目标 Worker 授权约束。
_Avoid_: 仅前端隐藏、Worker 信任客户端自报身份、治理权限等于执行权限

**Worker Access Policy**:
Worker 的所有者及 `owner-only | selected-members | team` 共享范围，显式授权区分使用与管理。
_Avoid_: 加入 Team 即可使用全部 Worker、跨 Team Worker Grant

**Project Access Policy**:
Project 的所有者与共享范围，以及 `viewer | contributor | manager` 资源授权；与 Worker 使用授权独立。
_Avoid_: Project Grant 自动授予 Worker 权限、用 Worker 在线状态决定历史可见性

**Session Access Policy**:
Session 的所有者与 `owner-only | selected-members | project` 内容共享范围，只能在有效 Project 成员权限内收窄。默认范围由创建入口决定：普通 Workspace 入口默认 `owner-only`，共享 Task 或团队协作入口默认 `project`，并在创建前明确展示且允许修改。
_Avoid_: 全局固定默认范围、Session Grant 绕过 Project 权限、未授权成员可见标题和搜索结果、内容私有等于文件隔离

**Resource Deletion**:
资源退出可用状态并按明确保留与清理规则处理元数据、历史及物理文件的生命周期操作。
_Avoid_: 删除 Project 即擦除 Worker 文件、撤销 Worker 即远程擦盘、离线即宣称物理清理成功

**Authentication and Audit**:
远程访问者身份确认与关键操作的可追溯记录，审计记录操作者、动作和资源而不复制完整对话。
_Avoid_: Bootstrap Token 等同于完整多用户授权、审计保存聊天全文、治理即私人内容访问

**Execution Credentials**:
Agent Provider 登录态、模型密钥、Git 凭证及其他执行 Secret 保存在 Worker；Server 只保存 capability、credential reference 与可用状态，不读取或下发用户私钥。Adapter 在 Provider 原始输出进入 Journal 前执行脱敏，Project 权限不推导出 Secret 读取权。
_Avoid_: Server 保存或分发执行 Secret、跨 Worker 默认共享登录态、把 Secret 写入 Event 或 Journal、Project manager 自动获得凭证内容

**Git Credentials**:
Worker 获取版本库内容时使用的本地 Execution Credentials，不属于 Project 的可共享代码来源元数据。
_Avoid_: Server 下发私钥、跨 Worker 默认共享 Git 登录态
