# AI 集群工作台：产品方向对齐与参考研究

状态：需求讨论记录与静态调研，不是实施规格或已交付能力声明。本文不修改现有执行资格门、授权策略或 ticket 状态。

## 1. 本轮已确认的方向

来自本轮用户需求澄清，不从参考产品反推需求：

- 产品往 **AI 集群工作台** 发展，管理用户的 Agent 资源，资源管理形态参考 AgentsMesh。
- 用户进一步明确：**loop-in 与 loop-out 都支持，平台自己的 Runtime 也作为一种可选能力**。此前只支持 loop-in、不建设自身 Runtime 的表述不再作为产品边界。
- 经用户后续澄清：loop-in 使用 Worker 本机 Agent Runtime 运行完整 loop；loop-out 使用平台 Runtime 驱动 loop，经受控接口使用 Worker 工具与资源。此前将 loop-out 泛化为任意外部 Runtime 的解释已被纠正。模型服务位置不决定此分类，loop-in 也不等于操作系统安全隔离。
- 平台 Runtime 是 loop-out 的组成部分，不必绑定 Server 进程，也不能直接等同于项目管理角色。其部署位置、首批执行接口和实现优先级尚待设计。
- 任务驱动建立在手工会话工作之上：从 Project → Task 视角管理众多 Session，核心目的是完成项目，不是强制增加审批步骤。
- 应用级 Agent 的核心职责是项目管理，既能整理建议，也能按授权安排执行和持续推进；不是二选一。
- 协作是核心组成，产品结合多个参考对象的相关特性，但需要自身的特点和必要性，不能仅做功能拼盘。
- 主要参考：Vibe Kanban 的任务与会话工作体验、Paperclip 的 Agent 项目管理能力、AgentsMesh 的 Worker/Agent 资源管理。
- 当前先对齐需求、特点、方向和愿景；不以现有 7 份 spec、18 张 ticket 作为不可变答案。

“项目管家（Project Steward）”是助手提出的角色命名，**用户尚未明确确认名称**。当前使用“项目管理角色”描述职责，不改变 CONTEXT.md 中 Agent 代表 Worker 上程序类型的定义。

## 2. 已确认的产品定位

> Wemux 是面向个人与团队、自托管的 AI 集群工作台，统一管理分布式执行资源，既接入用户已有的 Agent，也提供可选的 Runtime，以项目和任务组织会话，让人与 Agent 协作完成项目。

用户已确认上述定位以及同时支持 loop-in、loop-out 的方向。后续已明确 loop-out 使用平台 Runtime，但不据此确定其物理部署位置或项目管理职责；不同路径进入同一套项目、任务、会话、权限、成果与协作视图，但保留真实能力差异。这是产品目标确认，不代表相关能力已实现，也不确定具体架构与实施优先级。

这里的集群是异构 Agent 执行与协作网络，不是 GPU 训练集群、模型推理集群或通用容器编排平台。

必要性假设：当用户拥有多个机器、Agent 与持续会话后，启动程序不是唯一问题；还需要知道资源是否可用、会话为哪个目标服务、不同参与者如何接续工作，以及成果是否满足要求。该假设应以用户工作流程验证，不作为市场调研已经证明的结论。

拟形成的特点：

1. 手工使用和 Agent 辅助管理共用同一套项目、任务、会话与成果。
2. 会话是持续工作的现场，任务组织目标与进度，协作贯穿研究、实施、反馈和验收。
3. 跨机器统一使用，既接入用户自带的完整 Runtime，也支持平台自有 Runtime 和 loop-out 执行路径；不强迫外部 Runtime 拆环，保留真实能力差异，不静默降级。
4. 单 Worker 独立使用与加入集群衔接，本地身份、内容共享与集群身份仍有明确边界。
5. 从资源可用性贯通到可追踪成果，人工介入、断线恢复和失败处理属于正常流程。

以上是产品取向，不宣称任何单项能力在竞品中不存在。

### 已确认的愿景

**让 AI 利用异构环境中的工具与 Agent loop 执行资源，自主完成任务、持续推进项目，让人专注于关键决策。**

用户明确：这里的“集群算力”指工具与 Agent loop 消耗的 CPU、内存等执行资源，**不是模型训练或推理算力**。平台汇聚异构环境中的这些执行能力；模型服务是另一个维度，不纳入本处“集群算力”的含义。此前“算力不只指 GPU 或模型推理”的表述过宽，应以此为准。

产品应以 AI 在授权范围内自主组织、执行、验证和推进任务为目标，而不止于给人提供更方便的手工操作界面。手工会话与干预能力作为可用路径保留，但不要求用户逐步调度每次执行。

关键决策的候选范围包括目标与优先级、重要方案取舍、权限与预算边界，以及超范围或高风险事项；具体触发条件与授权策略仍待用户故事对齐。自主执行不等于无限权限、无限重试，也不意味着每项计划、工具调用或成果都必须人工审批。任务是否完成仍依据明确的验收要求与配置策略，不以 Agent 自报成功替代。

这项愿景确认不等于对当前环境开放执行入口、付费调用或破坏性操作的即时授权。

### 看板、跨机执行与团队使用：进一步确认

用户进一步明确了日常工作形态和集群管理目的：

- 工作台以 Vibe Kanban 式项目看板呈现任务状态，在任务下组织 Agent 会话；不是让用户围绕机器列表组织全部工作。
- 接入的不同机器是运行 Agent Runtime 的执行环境。集群管理的目的，是把任务派发到符合条件的空闲远程机器上，利用执行资源，并统一管理任务与执行过程。
- 任务可以限制可派发的机器，支持符合范围的机器申领，也支持指定机器执行。具体申领主体、竞争处理与调度策略尚待设计。
- 多用户、团队共享使用是明确需求，不以单操作者管理自己的多台机器作为完整产品前提。
- 项目管理 Agent 与用户使用同一套任务管理能力；自动推进仍须遵守任务的执行机器范围、团队权限与授权条件。

由此形成的待验证端到端故事：团队成员或获授权的项目管理 Agent 创建任务、设置机器范围与分配方式；平台将可执行工作交给符合条件且有可用容量的远程 Worker，在任务下运行并追踪 Agent 会话；团队在同一看板查看进展、处理阻塞、协作审查成果。

以下是需要调研和对齐的设计问题，不是用户已经确认的实现规则：

1. “空闲”如何定义：是否允许同机并行，如何结合执行槽位、CPU/内存余量、Runtime 能力和工作区准备状态判断可接单。
2. 团队共享机器时，谁可以派发、申领、查看会话与成果、停止他人的执行；如何避免某个用户长期占满资源。
3. 申领竞争、机器断线和重试如何避免重复执行；原会话绑定与新的重试执行如何区分，不隐式迁移会话或同步文件。
4. 指定机器不可用时如何排队或请求调整，是否允许自动选择其他候选机器，需明确而非静默改变用户指定。

跨产品核验另记于 `docs/research/kanban-remote-agent-team-story-validation.md`（调研中）。本节只记录需求和开放问题，不声明资源调度、多用户授权或恢复机制已经实现。

## 3. 调研方法与证据边界

- Vibe Kanban 官方仓库固定提交：`d5cbb5380fa0b32e98ef9b8d987f63decce4be3a`。
- Paperclip 官方仓库固定提交：`d6df12cef69fcaf2d2fe66a393168931d5b8b4e7`。
- 两项研究均为官方文档、schema、迁移与代码静态核验，没有安装或运行产品，也未调用付费模型。
- AgentsMesh 本轮参考用户提供的本地研究及此前本地源码阅读；未冻结源码版本，不把研究笔记中的商业状态、性能数字和安全概括作为已核实事实。
- 产品文档、Agent skill、数据库关系和服务端强制规则是不同证据层次。文档描述不能代替权限与安全机制验收。

## 4. Vibe Kanban：借鉴工作体验，不照搬领域关系

### 可核验的事实

- 创建任务和创建并启动是不同入口；新版源码也有 `create_workspace` 与 `create_and_start_workspace`。这支持一次操作完成创建并启动，不代表必须让用户确认两遍。[V1][V2]
- 计划审批属于部分执行器与模式的可配置能力。Claude adapter 中 plan、approval 与 bypass 是不同配置分支，不能归纳为所有任务必须先批准计划。[V3]
- 存在 Task Attempt → Workspace + Session 的数据库迁移。Session 必须归属 Workspace，但 Workspace 的 Task 关联可空，后续还移除了相应外键。**这不等于 Wemux 所有 Session 固定绑定 Task 的规则。**[V4][V5]
- 同 Workspace 的多个 Session 共享文件和 Git 状态，但聊天上下文独立。[V6]
- Worktree 创建与本地进程 spawn 证明的是工作副本组织，不是操作系统隔离；源码类型名 Container 也不能证明使用 Docker 或 VM。[V7]
- Diff 反馈与显式合并值得借鉴。当前 `/merge` 将工作分支变更合到目标分支，检查 open PR、remote target 等条件并记录 Merge。[V8]

### 冲突与限制

- 旧 Task/Attempt 文档与新版 Issue/Workspace 模型并存，不能拼成一个没有演进过的模型。
- `docs/workspaces/git-operations.mdx` 对 Merge 方向的描述与核验的 `/merge` 实现方向相反，描述该 API 时以源码为准。[V8][V9]
- 有审批 UI 不代表已经核实审批者身份分离、完整授权链或执行 Agent 无法自行批准。

### 对 Wemux 的启发

- 手工创建任务、创建并开始、继续会话应该是自然工作流，不能被统一的计划审批挡住。
- 多会话、共享环境、独立文件副本需要明确呈现，不能让用户把聊天隔离理解成文件隔离。
- 执行结果、成果审查、任务完成应分别表达；不复制“每次执行结束都进入审查”的旧状态映射。

## 5. Paperclip：借鉴项目管理能力，不照搬公司模拟

### 可核验的事实

- Issue、Run、Session 生命周期不同。Issue 的 Project/Goal/parent 可空；Run 可为 company 或 issue scope；task session 按 company、agent、adapter、taskKey 维护恢复上下文。这些不能直接映射成 Wemux 的 Task/Run/Session 约束。[P1]
- 官方 skill 区分协调 Conversation Task 与普通实施任务；协调会话用于澄清和计划，授权后创建 Project 中的实施任务，协调讨论不必等待实施完成。这是官方工作协议证据，不单独证明服务端完整强制该流程。[P2]
- 人的 Web 操作与 Agent 的管理 API 互补。官方协议要求读取上下文、原子 checkout、记录进展、创建有责任人的工作、维护阻塞与请求决策。[P3]
- 指派是否唤醒执行取决于 wake 策略。当前 skill 说明 `@mention` 仅提供上下文，不等于指派或唤醒。[P2][P4]
- 成果可以追溯到任务和 Run；Run liveness 不取代 Task 状态。未查到“任务完成数自动决定项目目标达成”的证据。[P5]
- 审批按种类和策略启用：招聘、计划确认、工具审批、任务审查不应混成统一必经流程；公司创建 Agent 的审批开关缺省为 false。[P6]
- Heartbeat 是有界执行窗口；Routines 具有显式触发、并发与漏跑策略。不是后台无限重试直到成功。[P7]

### 对 Wemux 的启发

- 项目管理角色需要完整管理能力：了解目标、查询任务和会话、组织依赖、安排工作、发现阻塞、记录成果、请求决定。
- 人与 Agent 操作同一套可见数据；授权边界、变更审计和执行者不能自行放宽约束，比绑定某个工具协议更重要。
- 定时/事件驱动可以作为持续推进的设计参考，**是否采用及其默认策略仍待确认**，不因 Paperclip 支持就自动纳入需求。
- Company、CEO、招聘和汇报链不是 Wemux 必需的产品隐喻。Paperclip Agent 的角色含义也不等于 Wemux 的 Runtime 程序类型。

## 6. AgentsMesh 与本地形态研究：选对参考前提

参考文件：

- `/home/qdw/Projects/research/sandbox/docs/05-产品形态总谱.md`
- `/home/qdw/Projects/research/sandbox/docs/06-本平台选型与产品形态.md`
- 既往本地源码阅读：`/home/qdw/Projects/research/sandbox/agentsmesh/runner/internal/agentkit/home.go`、`/home/qdw/Projects/research/sandbox/agentsmesh/runner/internal/runner/pod_builder_agent_home.go`、`/home/qdw/Projects/research/sandbox/agentsmesh/runner/internal/envfilter/envfilter.go`。

《05》的 G 自带集群分类贴近用户自带 Runtime 的 loop-in 路径，但不能覆盖本轮进一步明确的全部产品形态：平台还支持自有 Runtime 与 loop-out。可用“入口在哪里、loop 在哪里、执行环境在哪里”三项澄清各条路径，但这些研究分类不是必须进入产品 UI 的术语。

《06》的“本平台”前提是已有 K8s、多租户托管用户 Agent 镜像，不能把其 OpenSandbox/K8s/Vault 选型直接继承为 Wemux 决策。用户指定参考研究，不意味着授权改造基础设施。

先前源码阅读显示每会话 Agent home、worktree/tempdir 与进程生命周期管理可供借鉴，但环境 denylist 保留用户和云凭据的做法不能作为我们的安全模板。L1 配置作用域不阻止绝对路径访问和任意网络出口。

还需逐项核验的借鉴点：节点注册撤销、反向连接和重连、能力与版本发现、配置/Skill/MCP 按 Runtime 物化、并发容量、会话进程恢复。它们是调研清单，不是本轮已经验证的 AgentsMesh 全量能力。

## 7. 下一轮需求对齐的用户故事

下列为供讨论的候选故事，不新建票据：

1. **接入并使用资源**：接入自己的机器，看到真实可用的 Agent 与环境，能从工作台开始工作并理解不可用原因。
2. **手工推进项目**：在项目中创建或选择任务，开启多个会话，分别研究、实施和验证；不强制先写正式计划。
3. **委托项目管理**：让项目管理角色了解已有工作，整理任务、安排执行、跟踪阻塞和汇总成果；实际动作受用户授权限制。
4. **共同工作与接手**：团队成员在权限范围内共享任务、会话和成果，能够反馈、交接及介入；不同 Agent 交换必要上下文而非默认共享全部权限。
5. **判断成果与继续推进**：从任务看到结果、证据和待解决问题，不把执行成功当成项目完成；据此安排下一步。
6. **处理中断**：浏览器关闭、Worker 离线或 Runtime 失败后，能分清实际执行、历史同步和任务状态，避免重复执行。

尚待明确：首要用户与代表性项目场景、项目管理角色命名及作用范围、持续推进的触发/停止条件、协作的首要交互路径。现有 spec 的需求来源应在这些故事对齐后重新核对；尤其不能将按需计划确认写成所有实施的前置审批。

## 8. 固定版本来源

### Vibe Kanban

- [V1 创建任务](https://github.com/BloopAI/vibe-kanban/blob/d5cbb5380fa0b32e98ef9b8d987f63decce4be3a/docs/core-features/creating-tasks.mdx)
- [V2 Workspace 创建与启动](https://github.com/BloopAI/vibe-kanban/blob/d5cbb5380fa0b32e98ef9b8d987f63decce4be3a/crates/server/src/routes/workspaces/create.rs)
- [V3 Claude 执行模式](https://github.com/BloopAI/vibe-kanban/blob/d5cbb5380fa0b32e98ef9b8d987f63decce4be3a/crates/executors/src/executors/claude.rs#L199-L238)
- [V4 Attempt 迁移](https://github.com/BloopAI/vibe-kanban/blob/d5cbb5380fa0b32e98ef9b8d987f63decce4be3a/crates/db/migrations/20251216142123_refactor_task_attempts_to_workspaces_sessions.sql)
- [V5 Task 外键移除](https://github.com/BloopAI/vibe-kanban/blob/d5cbb5380fa0b32e98ef9b8d987f63decce4be3a/crates/db/migrations/20260217120312_remove_task_fk_from_workspaces.sql)
- [V6 Session 工作环境](https://github.com/BloopAI/vibe-kanban/blob/d5cbb5380fa0b32e98ef9b8d987f63decce4be3a/docs/workspaces/sessions.mdx)
- [V7 本地执行 spawn](https://github.com/BloopAI/vibe-kanban/blob/d5cbb5380fa0b32e98ef9b8d987f63decce4be3a/crates/local-deployment/src/container.rs#L1369-L1399)
- [V8 Git 合并路由](https://github.com/BloopAI/vibe-kanban/blob/d5cbb5380fa0b32e98ef9b8d987f63decce4be3a/crates/server/src/routes/workspaces/git.rs#L179-L253)
- [V9 Git 操作文档](https://github.com/BloopAI/vibe-kanban/blob/d5cbb5380fa0b32e98ef9b8d987f63decce4be3a/docs/workspaces/git-operations.mdx)

### Paperclip

- [P1 Issue schema](https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/packages/db/src/schema/issues.ts)、[Run schema](https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/packages/db/src/schema/heartbeat_runs.ts)、[Session schema](https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/packages/db/src/schema/agent_task_sessions.ts)
- [P2 官方 Agent 工作协议](https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/skills/paperclip/SKILL.md)
- [P3 用户任务指南](https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/docs/guides/board-operator/managing-tasks.md)
- [P4 唤醒策略](https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/server/src/services/heartbeat-policy.ts)
- [P5 成果 schema](https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/packages/db/src/schema/issue_work_products.ts)
- [P6 公司策略](https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/packages/db/src/schema/companies.ts)、[任务审查规则](https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/server/src/services/issue-review-policy.ts)
- [P7 Heartbeat 协议](https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/docs/guides/agent-developer/heartbeat-protocol.md)、[Routines API](https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/docs/api/routines.md)
