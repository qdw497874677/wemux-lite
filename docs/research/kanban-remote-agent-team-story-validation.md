# 项目看板、远程 Agent 执行与团队协作：用户故事核验

日期：2026-10-08。状态：研究与推荐修正，不是实施规格或现有能力声明。

## 1. 结论

**用户故事合理，且三个参考产品分别提供了有用的局部证据；但不能把三者拼接理解为已经验证了一套完整的跨机器任务申领系统。**

- Vibe Kanban 主要证明：任务看板可以组织多个工作区与会话，会话上下文和文件环境必须分开理解。
- Paperclip 主要证明：人和 Agent 可以操作同一套任务对象；任务申领、运行并发、权限和恢复需要明确的协议。
- AgentsMesh 主要证明：可以按组织、用户可见性、Agent 能力和剩余并发槽位选择远程 Runner；但本轮发现的容量预留实现并不能直接作为严格防超卖模板，恢复也明确限制在原 Runner。
- **“空闲机器”建议修正为“有可用执行容量且满足资格的机器”**。CPU、内存用于 Agent loop、工具、构建、测试等，不是模型推理算力。已有一个会话不代表机器不可再用，Agent 等待用户也不必然意味着进程和内存已经释放。
- **派发的是一次执行意图，不是把整个 Task 或既有 Session 搬到另一台机器。** Task 是目标与协作单位；机器选择在执行前确定；运行后固定执行落点并记录不可变快照。
- “任意符合条件的机器申领”是合理的产品目标，但 Server 主动选机和 Worker 主动拉取申领是两种实现。三个项目的证据不要求现在选定其中一种。

## 2. 方法、版本与证据等级

本轮阅读指定的三份既有研究作导航，重要判断追到官方资料；不将旧研究当作新增核验依据。没有启动服务、调用 Agent/模型、执行产品测试或提交代码。

| 对象 | 本轮版本和获取方式 | 证据边界 |
| --- | --- | --- |
| AgentsMesh | 官方仓库 `https://github.com/agentsmesh/agentsmesh`；本地 `/home/qdw/Projects/research/sandbox/agentsmesh`，HEAD `d38e3932df436fadd814a8871b8c6b7be52281d5`；工作树干净 | 下文 A 引用均为本轮逐行静态源码核验，可按固定提交复核；未实测 |
| Vibe Kanban | `BloopAI/vibe-kanban` 固定提交 `d5cbb5380fa0b32e98ef9b8d987f63decce4be3a` 的 `docs/cloud/issues.mdx` 已取得并逐行核对；其余使用官方站点文档 | 官方站点为 2026-10-08 查询到的滚动文档，页面未标版本，**不保证与固定提交相同** |
| Paperclip | `https://docs.paperclip.ing/` 官方站点，2026-10-08 查询到的滚动文档 | 导航研究引用的 `d6df12cef69fcaf2d2fe66a393168931d5b8b4e7` 源码本轮下载超时，不能声称已重新核验该提交；以下 P 引用仅证明官方文档承诺，不证明实现或发布版本一致 |

等级：**源码静态核验**是检查代码表达的行为；**官方文档静态核验**是核对官方说明；**推荐目标**是 Wemux 应补的合同。**实测：本轮无。** 官方网页通过搜索工具返回的第一方页面正文/摘录核对，非第三方总结；滚动文档没有可核验的发布号，这是版本证据限制，不以旧研究 SHA 冒充它的版本。网络超时后停止大范围抓取，以时间盒返回核心证据。

## 3. Vibe Kanban：任务组织会话成立，不等于集群调度

### 3.1 Task / Session / 环境

**官方文档静态核验：** Issue 有状态、优先级、团队成员 assignees；Issue 的 Workspaces 区域允许创建、关联已有 Workspace，并解除关联。固定源码文档 `docs/cloud/issues.mdx:14–22,125,138–165` [V1]。因此任务责任人不是机器，Task 也不应被简化成一个进程。

Workspace 内可以有多个 Session；Session 是独立对话历史，**共享同一 Workspace 文件**。多仓库也可位于同一 Workspace [V2][V3]。因此用户的“以任务看板管理多个会话”有直接产品依据，但“开新会话”不能被描述成自动隔离文件。

### 3.2 派发、申领、容量

**官方文档静态核验：** 多 Session 可以并行；当前 Agent 执行时可排队一条后续消息 [V3][V4]。这些是会话/消息并发，不是 CPU/内存资源调度。Remote Access 要先配对某个 host，再访问它的工作区 [V5]。它证明远程操作宿主，不证明“机器池抢任务”。

**未确证：** 本轮资料未提供候选机器集合、跨主机容量预留、Worker 拉取申领或自动故障转移合同。不能据此断言产品绝无这些能力，也不能把它作为 Wemux 调度实现已被验证的依据。

### 3.3 多用户与执行归属

**官方文档静态核验：** Organisation 的 Member 可以访问项目并工作，Admin 管理成员和组织设置 [V6]；Issue assignee 是团队成员 [V1]。但是这些协作权限不自动证明成员能使用所有 host 的终端、Agent 登录和 Git 凭据。远程 host 配对是另一条访问路径 [V5]。

**推荐目标：** 分开任务负责人、发起执行者、获授权的自动化身份、Worker 所有者、实际 Runtime/Git 凭据主体。不能用一个 assignee 字段同时承载它们。

### 3.4 恢复与跨机文件

**官方文档静态核验：** Chat 支持 Stop、排队、编辑消息重新尝试；审批超时可能需要新消息重启执行 [V4]。Workspace 的仓库使用本地 Git worktree，各工作副本有自己的分支 [V7]。这支持人介入继续，不证明远端进程可被无损迁移。

**推荐目标：** 另一台机器需要可访问的代码版本、凭据、依赖和必要产物；未提交文件和 Runtime 会话状态不会因为关联同一 Task 自动出现。官方“工作区隔离”的产品表述不当作 OS 沙箱安全保证。

## 4. Paperclip：同一套任务工具成立，Agent 申领不等于机器申领

### 4.1 Issue / Run / Session / Workspace

**官方文档静态核验：** 一个 Issue 可查询多个 heartbeat runs，区分 queued/running 和单一 active run [P1]。Execution Workspace 随工作解析、创建或复用，运行结束后可继续保留；支持独立 worktree、复用现有环境和项目主目录 [P2]。Claude adapter 保存 CLI session ID，并在工作目录匹配时跨 heartbeat 恢复；不匹配或恢复失败可开启新会话 [P3]。

这证明任务、执行窗口、对话上下文和文件环境不是同一对象。Paperclip 的 Agent 是受管理的执行身份，不应直接等同于 Wemux 的 Agent Runtime 程序类型。

### 4.2 申领和并发的准确含义

**官方文档静态核验：** `POST /api/issues/{issueId}/checkout` 原子申领 Issue 并进入 `in_progress`；输入 `agentId`、非空 `expectedStatuses`。Agent 只能以自己身份 checkout，Agent 请求须带 `X-Paperclip-Run-Id`；状态冲突或项目暂停等返回 409；相同 Agent 已持有时提供幂等语义，旧 run 已不活跃时可以按规则接续旧锁 [P4]。

Heartbeat 的 `Max concurrent runs` 是**每 Agent 的并行任务数**；Routines 另有合并、跳过、入队及有界补跑策略 [P5]。这些不能当成远端机器 CPU/内存的空闲检测，也不能将 checkout 原样解释成 Worker 抢占机器槽位。取得任务所有权与取得执行资源是两个条件。

### 4.3 人和项目管理 Agent 共用工具，但不共用无限权限

**官方文档静态核验：** 人的 board session/key 与 Agent token 是不同认证入口；Agent 被限定到自己的 company，JWT 带 agent/company/adapter/run 身份；board actor 按公司成员关系授权 [P6]。人和 Agent 在同一 permission engine 下解析 company、principal type、principal ID、permission key；角色与显式 grants 叠加 [P7]。

这直接支持“AI 项目管理 Agent 操作用户同一套项目管理工具”。**同工具指共用领域动作和数据，不是复制用户全部凭据或管理员权限。** 项目管理 Agent 可在授权下整理、创建、分解、指派、追踪任务；Worker 使用权、密钥可用范围和危险执行权限仍应独立检查。

### 4.4 恢复和远端文件是显式策略

**官方文档静态核验：** checkout 允许在确认旧 run 不活跃后接续 stale lock，而不是见超时就抢走 [P4]；Claude session 恢复依赖 cwd，失败可新开，因此 UI 应区分“恢复原会话”和“新会话接手” [P3]。

较新的官方实验功能文档明确区分远程环境 `copy`（复制执行后带回结果）和 `in_place`（环境目录是权威来源、不回传），并有共享目录并发策略 Auto / Serialize / Allow。Auto 对 local/SSH 与云 sandbox 的行为不同；隔离工作区还受实例和项目开关控制 [P8]。**不能把 Paperclip 一概描述为没有远端环境或文件同步，也不能把实验功能当成所有部署的默认能力。**

这对 Wemux 最关键的启发是先声明文件权威位置、复制/交付策略和恢复条件，而不是承诺“有空闲节点即可无缝继续”。本轮未重新核验 heartbeat 源码的行锁、孤儿回收和跨进程租约实现，旧研究中相关行号不作为本轮实现证明。

## 5. AgentsMesh：最贴近远程选机，但有两个重要边界

以下均为固定提交源码静态核验，不是压力测试、安全审计或故障注入结果。

### 5.1 Ticket / Pod / Session / 文件环境

`backend/internal/domain/agentpod/pod.go:47–96` [A1]：Pod 固定 `OrganizationID`、`RunnerID`、`CreatedByID`，可选 `TicketID` 和 `RepositoryID`；保存 `SandboxPath`、Agent 状态、SessionID、SourcePodKey。因此它是可关联 Ticket 的执行实例，并不强制每个 Pod 都绑定任务；不是 Wemux “所有 Session 绑定 Task”的直接同构模型。

`backend/internal/service/agentpod/pod_orchestrator_create.go:138–165` [A2] 把 Ticket、Runner、Agent、User、Session 等写到 Pod。`runner/internal/workspace/worktree_create.go:22–26,61–72` [A3] 在节点上建立 `sandboxes/{podKey}/workspace`，先保证仓库可 clone/fetch，并按仓库加锁。目录/worktree 的分离本身不是 OS 级多租户隔离。

### 5.2 自动选机、指定机器和“空闲”

`backend/internal/service/agentpod/pod_orchestrator_create.go:34–56` [A2]：未传 RunnerID 才调用 `SelectRunnerWithAffinity`，否则沿用指定 Runner。这是 **Server 选择并派发**，不是 Worker 拉取 Ticket。

`backend/internal/service/runner/query_eligible.go:13–49` [A4]：候选必须同组织、online、enabled、有剩余槽位、最后 ping 距今小于 90 秒、支持指定 Agent，并对当前用户可见。可见性包括组织共享、注册者本人和显式 grant。

`backend/internal/service/runner/affinity.go:48–100` [A5]：负载分数是 `1.0 - PodCount/MaxConcurrentPods`，另加创建者、仓库历史、标签匹配的权重。**标签在这个函数中是软评分，不是必须满足的硬条件；负载是 Pod 槽位，不是 CPU/内存实测余量。** 因此不能照搬标签 affinity 来实现用户要求的“符合条件”。

**重要静态风险：选机不等于原子容量预留。**

- `backend/internal/infra/runner_repo.go:121–136` [A6] 先按 `current_pods < max_concurrent_pods` 查询；`IncrementPods` 的 SQL 是 `UPDATE runners SET current_pods = current_pods + 1 WHERE id = ?`，没有容量谓词。
- `backend/internal/service/runner/pod_coordinator.go:135–145` [A7] 先递增，再发命令，发送失败递减回滚。此链路本身不能证明两个并发选择不会超过上限。
- `runner/internal/runner/runner_capacity.go:23–42` [A8] 另有 draining 和本机 active Pod count 限制，但不能据此把前述 Server 链路宣称为原子预留；本轮未验证所有调用者、锁和多实例竞态。

结论是**已发现保证缺口，而非实测已超卖**。Wemux 应把候选筛选、容量保留、执行所有权和 Worker 最后拒绝能力明确分层。

### 5.3 多用户和实际执行归属

组织、用户可见性和 grant 进入候选筛选 [A4]；Pod 的 `CreatedByID` 与 `RunnerID` 分别保存 [A1][A2]。`backend/internal/service/agentpod/pod_orchestrator_resume.go:67–89` [A9] 按用户取 Git 凭据，`runner_local` 则使用节点本地 Git 配置；`runner/internal/runner/pod_builder_agent_home.go:12–39` [A10] 可从 Runner 用户 home 复制 Agent 配置到 per-pod 目录。

所以 Web 登录用户不必然是操作系统用户，也不必然是模型/Git 账号。**允许团队用一台机器，可能意味着成员的任务能接触该机器现有凭据和文件。** 本轮只证明上述归属和筛选路径，不证明指定 Runner 的全部 REST/MCP 路径或终端访问已完成越权审计。

### 5.4 恢复不是自动跨机迁移

`backend/internal/service/runner/pod_disconnect_handler.go:10–59` [A11]：断线将 Runner 标为 offline；initializing Pod 按状态条件更新为 error 并释放计数，running Pod 留待重连对账，而不是立即到别机重跑。

`backend/internal/service/runner/pod_reconcile_handler.go:12–75,78–104` [A12]：按 Runner 报告核对 Pod，未知 Pod 经累计证据后发终止命令，orphaned/initializing 可按状态 CAS 恢复；`backend/internal/service/runner/pod_coordinator.go:15–24` [A7] 定义 orphan miss 阈值 3、初始化恢复阈值 2。是状态对账，不是文件迁移。

**关键硬限制：** `backend/internal/service/agentpod/pod_orchestrator_resume.go:19–62` [A9] 要求同组织、源 Pod 已终止/完成/orphaned，拒绝已有 active resume；未指定 Runner 时沿用原 Runner，指定不同 Runner 返回 `ErrResumeRunnerMismatch`，不同 Agent 返回 `ErrResumeAgentMismatch`。因此不能用其 resume 证明“任意空闲机器接着同一 Session 跑”。

## 6. 推荐修正后的用户故事（目标，尚未实施）

### 故事 A：用任务组织多个会话

> 作为项目成员，我在项目看板中管理目标、任务和结果，一个任务可以包含研究、实施、验证等多个会话；我能看清各会话使用哪台机器、哪个 Runtime、哪个文件环境，以及它们是否共享文件。

补充：任务状态与执行状态分开；执行成功不自动等于任务完成。一个 Task 有多个 Session 不代表必须支持同一 Task 多个并行写入；并行策略需要另行明确。

### 故事 B：利用远程机器的剩余执行容量

> 我可以为任务的下一次执行选择一个指定 Worker、一组候选 Worker，或授权范围内任意满足硬条件的 Worker。系统只在有可用容量且环境准备成功时开始；没有合适机器时排队并显示原因，不静默放宽约束。

硬条件建议包括：团队和项目授权、机器使用权、Runtime 可用及认证、OS/架构/工具链、仓库或数据可达、所需凭据、Workspace Placement 可准备、资源/并发限额。偏好另列：优先本机、低负载、已有仓库缓存等。**指定机器是硬约束，候选集合不得被负载优化悄悄扩大。**

“申领”应对外表达为有唯一执行所有者的排队工作，对内可用推送或拉取。认领成功必须同时处理任务执行排他、容量保留及版本/租约；失败释放，重投幂等。CPU/内存指标用于执行准入和可观测性，不宣称模型推理加速。

### 故事 C：团队与 AI 共用项目管理能力

> 团队成员和获授权的项目管理 Agent 操作同一套项目、任务、依赖、会话关联和成果工具。每个动作记录实际操作者、代表谁执行、权限范围和执行结果；项目管理 Agent 可以安排工作，但不能自行扩张机器、密钥、预算或审查权限。

不得把所有团队成员默认为机器管理员；节点共享、任务可见、会话可读、可发送消息、可中断执行、可使用凭据需要分别定义。

### 故事 D：中断可解释，换机有明确交接

> 断线后我能区分“暂时不可达”“已确认进程丢失”“执行已结束但事件未同步”。系统先对账，不把网络超时直接当作可以重复执行。换机时检查代码/产物/凭据与 Runtime 恢复条件，不能恢复原会话就明确新建会话接手。

同 Worker 重连、同 Worker 进程重启、同任务新 Run、跨 Worker 接手是四件事。跨机至少确定输入版本、未提交变更处理、依赖初始化、成果传输、密钥授权、会话上下文交接，以及旧执行失效/隔离措施。Git 仓库 URL 和分支名不等于完整工作现场。

## 7. 仍需用户/设计确认的问题

1. **任务并行单位：** 一个任务允许多个同时执行的 Run，还是多个历史/辅助 Session、单个主执行？研究和验证能否只读并行？
2. **容量定义：** 首先用管理员配置的并发槽位，还是必须有 CPU/内存请求与硬限制？等待人回复的常驻进程算多少容量？仅采集指标不能证明不会 OOM。
3. **执行条件层次：** 候选机器限制属于 Task 默认值还是每次执行快照？约束修改是否影响已排队项？指定机器离线是否一直等、超时失败，还是由用户批准降级？
4. **申领协议与公平性：** Server 派发或 Worker 拉取是否只是实现选择？是否需要跨用户配额、优先级、避免饥饿、取消排队和最大等待时间？
5. **共享信任边界：** 是可信同事共享机器，还是不互信租户？后者不能仅靠 worktree、per-session home、应用 RBAC，必须另有 OS/容器/VM 级约束。
6. **凭据和归属：** 默认使用发起者、项目服务身份还是机器本地 Agent 登录？谁承担模型费用？这虽不是 CPU 调度，仍限制某台机器是否可执行。
7. **文件权威来源：** Git-only、共享文件系统、受控快照还是显式复制？非 Git 项目、数据库和本地大文件如何准备？执行成果何时算已持久化、可供其他机器接手？
8. **故障所有权：** 断线超过多久允许接手？如何阻止旧 Worker 恢复后继续产生副作用？需要租约/代际令牌与幂等边界，不能只设置一个超时。
9. **AI 管理闭环：** 何种事件唤醒、何时停止、最多重试多少次、哪些越界动作需确认？“操作同一工具”不自动定义无限后台调度。

这些是把已确认故事变成可靠合同的必要澄清，不是要求用户重新确认产品方向，也不意味着引入 Kubernetes 或替换现有轻量架构。

## 8. 第一方来源索引

### Vibe Kanban

- [V1 固定版本 Issue 文档](https://github.com/BloopAI/vibe-kanban/blob/d5cbb5380fa0b32e98ef9b8d987f63decce4be3a/docs/cloud/issues.mdx#L138-L165)，另见同文件 L14–22、L125。
- [V2 Sessions](https://vibekanban.com/docs/workspaces/sessions)
- [V3 Multi-Repo & Sessions](https://vibekanban.com/docs/workspaces/multi-repo-sessions)
- [V4 Chat Interface](https://vibekanban.com/docs/workspaces/chat-interface)
- [V5 Remote Access](https://vibekanban.com/docs/remote-access)
- [V6 Organisations](https://vibekanban.com/docs/cloud/organizations)、[Team Members](https://vibekanban.com/docs/cloud/team-members)
- [V7 Repositories](https://vibekanban.com/docs/workspaces/repositories)

V2–V7 均为上述日期的滚动官方文档，不标发布号。

### Paperclip

- [P1 Issue CLI 的 runs / live-runs / active-run](https://docs.paperclip.ing/reference/cli/issue/)
- [P2 Execution Workspaces](https://docs.paperclip.ing/guides/projects-workflow/workspaces/)
- [P3 Claude Code Adapter](https://docs.paperclip.ing/reference/adapters/claude-code/)
- [P4 Issues API / Checkout a Task](https://docs.paperclip.ing/reference/api/issues/)
- [P5 Heartbeats & Routines](https://docs.paperclip.ing/guides/projects-workflow/routines/)
- [P6 Authentication](https://docs.paperclip.ing/reference/api/authentication/)
- [P7 Members and Access](https://docs.paperclip.ing/guides/org/members-and-access/)、[Roles & Permissions](https://docs.paperclip.ing/administration/roles-and-permissions/)
- [P8 Isolated Workspaces，含远程 copy / in_place 与共享目录并发策略](https://docs.paperclip.ing/experimental/isolated-workspaces/)

P1–P8 均为上述日期的滚动官方文档，不标发布号；不将其映射到未重新取得的源码 SHA。

### AgentsMesh

全部链接固定于 `d38e3932df436fadd814a8871b8c6b7be52281d5`，行号与本地逐行核验一致。

- [A1 Pod 模型](https://github.com/agentsmesh/agentsmesh/blob/d38e3932df436fadd814a8871b8c6b7be52281d5/backend/internal/domain/agentpod/pod.go#L47-L96)
- [A2 创建和选机](https://github.com/agentsmesh/agentsmesh/blob/d38e3932df436fadd814a8871b8c6b7be52281d5/backend/internal/service/agentpod/pod_orchestrator_create.go#L34-L56)，同文件 L138–165。
- [A3 Worktree 准备](https://github.com/agentsmesh/agentsmesh/blob/d38e3932df436fadd814a8871b8c6b7be52281d5/runner/internal/workspace/worktree_create.go#L22-L72)
- [A4 候选资格和可见性](https://github.com/agentsmesh/agentsmesh/blob/d38e3932df436fadd814a8871b8c6b7be52281d5/backend/internal/service/runner/query_eligible.go#L13-L49)
- [A5 亲和性评分](https://github.com/agentsmesh/agentsmesh/blob/d38e3932df436fadd814a8871b8c6b7be52281d5/backend/internal/service/runner/affinity.go#L48-L100)
- [A6 数据库候选与计数更新](https://github.com/agentsmesh/agentsmesh/blob/d38e3932df436fadd814a8871b8c6b7be52281d5/backend/internal/infra/runner_repo.go#L121-L142)
- [A7 派发与阈值](https://github.com/agentsmesh/agentsmesh/blob/d38e3932df436fadd814a8871b8c6b7be52281d5/backend/internal/service/runner/pod_coordinator.go#L135-L145)，同文件 L15–24。
- [A8 本机容量判断](https://github.com/agentsmesh/agentsmesh/blob/d38e3932df436fadd814a8871b8c6b7be52281d5/runner/internal/runner/runner_capacity.go#L23-L42)
- [A9 恢复约束和 Git 凭据](https://github.com/agentsmesh/agentsmesh/blob/d38e3932df436fadd814a8871b8c6b7be52281d5/backend/internal/service/agentpod/pod_orchestrator_resume.go#L19-L89)
- [A10 Agent home 准备](https://github.com/agentsmesh/agentsmesh/blob/d38e3932df436fadd814a8871b8c6b7be52281d5/runner/internal/runner/pod_builder_agent_home.go#L12-L39)
- [A11 断线处理](https://github.com/agentsmesh/agentsmesh/blob/d38e3932df436fadd814a8871b8c6b7be52281d5/backend/internal/service/runner/pod_disconnect_handler.go#L10-L59)
- [A12 重连对账](https://github.com/agentsmesh/agentsmesh/blob/d38e3932df436fadd814a8871b8c6b7be52281d5/backend/internal/service/runner/pod_reconcile_handler.go#L12-L104)
