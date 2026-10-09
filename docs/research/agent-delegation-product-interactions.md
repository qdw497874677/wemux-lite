# Agent 委托：Vibe Kanban 与 Paperclip 的实际操作

## 结论与核验边界

**没有确证任一产品提供“执行既有任务 / 自主推进目标”这两个互斥的授权按钮。** 两者都能承载明确任务；更高层委托依靠任务描述、工具、角色与唤醒配置组合，而不是由这两个概念自动决定权限。尤其 Paperclip 确实有 **Auto / Plan / Ask** 模式，不能漏报，也不能把 Auto 翻译成“无限持续推进项目”。[P2][P3][P4][V1][V3]

本轮仅静态阅读第一方仓库文档与源码；既有两份研究只作导航。未安装、启动或实测产品，未调用模型、付费服务或控制面写 API。下面的“操作”是资料描述的路径，不是浏览器验收结果。

- Vibe Kanban 固定提交：`d5cbb5380fa0b32e98ef9b8d987f63decce4be3a`。
- Paperclip 固定提交：`d6df12cef69fcaf2d2fe66a393168931d5b8b4e7`。
- 所有下列引用均绑定上述 SHA，包括 `docs/`；**固定提交不等于已发布版本**。官方线上文档是滚动文档，本轮不以其当前内容替代固定快照，也不把上轮滚动文档结论冒充本轮源码验证。固定树内仍可能共存旧、新入口；下文明确拆开。
- 文档证明官方操作说明，UI 源码证明入口定义，skill 证明 Agent 工作协议；它们都不单独证明端到端权限、安全隔离或运行可靠性。

## 1. Vibe Kanban

| 用户意图 | 实际操作与证据 | 不应推导的结论 |
| --- | --- | --- |
| 安排一个既有任务 | **旧 Task/Attempt 文档**：打开未执行 Task → attempts 的 **+** → 选择 Agent profile、Variant、Base branch。新建时 **Create Task** 只保存，**Create & Start** 创建并立即启动默认 Agent。[V1] | 两个创建按钮区分是否立即启动，不是“执行任务 / 授权自主推进”。 |
| 从新版看板开始工作 | **Issue/Workspace 文档**：打开 Issue → **Workspaces** 区域 **+** → 创建或关联 Workspace；新建 Issue 可勾 **Create draft workspace immediately**。Workspace 创建页选 Project、仓库、目标分支、任务描述和 Agent，点 **Create** 后开始工作。[V2][V3] | draft workspace 不等于已经执行；Issue 的 assignees 是团队成员，不能把选责任人解释为 Agent 自动唤醒。[V2] |
| 让 Agent 拆解目标并安排执行 | 官方 MCP 用法：在支持 MCP 的客户端向助手描述目标，要求拆成 Issues；助手调用 `create_issue`，再用 `start_workspace` 指定 executor、repositories、可选 issue_id/prompt 启动。还有 `run_session_prompt`、`get_execution` 可继续与检查。[V4] | 这是客户端 Agent 调用管理工具的路径，**不是已确证的内置持续项目经理、定时目标循环或“自主模式”开关**。 |
| 先看计划再执行 | 旧 Task 入口可选 `PLAN` 等 variant；Agent 配置文档有 Claude `PLAN: { plan: true }` 示例。Claude 源码的 `permission_mode()` 按 plan → approvals → BypassPermissions 分支选择模式。[V1][V5][V6] | 计划模式、工具许可与成果审查不是同一关卡；不能说所有 Agent、所有任务默认必须人工批准计划。 |
| 验收成果、要求修改 | 打开 **Toggle Changes Panel** → 查看 diff → 行内评论 → 在聊天中统一发送反馈，Agent 再修改；Git 区域另有 **Create Pull Request**。[V7][V8] | UI 代码审查循环不等于服务端强制独立审核人；也不等于 Agent 运行结束就自动通过成果验收。 |

**自主性与预算的证据缺口：** 在上述创建、配置、MCP、Review 文档及 Claude 模式源码范围，未确证“把目标交给平台后自动持续找下一件工作”的产品级调度合同，也未确证产品级月预算设置、超预算暂停与恢复入口。不是断言它绝无这些能力，更不能把底层模型供应商限额当作 Vibe Kanban 功能。[V1–V8]

## 2. Paperclip

### 2.1 安排既有任务：指派、工作模式、唤醒是三件事

1. **准备执行者**：在 **Agents** 页创建 Agent，设置角色、汇报关系、adapter/config；Agent 详情设置 heartbeat interval、cooldown、max concurrent runs、wake triggers 和预算。这是官方操作者指南描述的入口。[P1]
2. **指派工作**：创建 Issue 填要求、优先级、Project/Parent 与 Assignee；已有 Issue 设置 `assigneeAgentId`。指南明确只有 wake-on-assignment 启用才因指派触发 heartbeat。新建 UI 确有 Agent/User assignee、workMode 和 reviewer 状态，不是只能通过 API 委托。[P2][P3]
3. **选择这次提交要做什么**：任务 composer 定义 **Auto mode / Plan mode / Ask mode**；Auto 对应 `standard`，Plan 文案是整理 plan 文档、不改代码，Ask 文案是只读回答。新建 Issue 也把 `workMode` 送入创建请求。这是**真实可见模式**，但属于工作方式，不是“既有任务 vs 目标级自治”二选一，更不是已验证的 OS 只读隔离。[P3][P4]
4. **决定何时运行**：源码 `isHeartbeatWakeOnDemandEnabled()` 优先读取 `heartbeat.wakeOnDemand`，兼容 `wakeOnAssignment / wakeOnOnDemand / wakeOnAutomation`，缺省 `true`。它仅证明这项开关的判定，不能推出任何指派在暂停、预算耗尽等条件下都一定执行。[P5][P9]
5. **看进度与反馈**：Issue 评论、状态/活动记录、Dashboard 与 Agent 详情 Run history。官方 skill 规定普通 heartbeat 取已指派工作，原子 checkout；没有指派则退出，`@mention` 只给上下文，不是唤醒或接管授权。[P2][P6]

### 2.2 委托目标：通过任务/对话与后续调度组合，不是单独自治按钮

- **普通任务路径**：把一个目标及范围写成指派给经理/执行 Agent 的任务，用 Project、Goal、parent issue 提供上下文。官方协议允许为并行或长期委派工作创建 child issues，要求留下成果、状态与阻塞路径；Goal API 本身只提供目标层级与关联 CRUD，**没有证据表明新建 Goal 就自动启动 Agent 或自动判断目标达成**。[P2][P6][P7]
- **先讨论再交接的路径**：该快照有 **Agent Chat** 页面；关闭时页面明确要求去 **Experimental settings** 启用，不能写成全量默认功能。skill 规定在 Conversation Task 澄清、研究、修订 plan，获得授权后在合适 Project 创建普通已指派任务，创建时带 `initialPlan` 和幂等键，保留原对话计划并返回任务链接。这里的“获授权”是工作协议要求，不是已经核验某个“自主推进目标”按钮。[P8][P6]
- **持续推进依靠后续触发**：Agent heartbeat 设置支持间隔和 wake triggers；Routines 文档提供 schedule、webhook、API/manual run，并有并发及漏跑策略。它们支持反复唤醒做有界工作，但不是“无限循环直到公司目标成功”的保证。Routine 这项本轮核对的是 API 文档，未确证其具体 UI 配置入口。[P1][P10]

### 2.3 计划、成果、治理审批必须分开看

| 审批对象 | 用户实际可用路径 / 规则 | 证据限制 |
| --- | --- | --- |
| 计划 | 选择 Plan，或明确要求计划；skill 要求写 `plan` 文档、交付后设 `in_review`。**需要明确批准才实施时**，创建绑定最新 plan revision 的 `request_confirmation`，接受后才建实施子任务。[P4][P6] | 不是每个 Auto 任务都先过计划审批；普通确认卡不是能力授权令牌，skill 明说下游操作仍重新检查权限。[P6] |
| 成果审查 | 新建 Issue UI 有 reviewer 选择；执行协议中的 review/approval stages 可要求当前 participant 决策，更多阶段存在时继续 `in_review`。另有服务端 `reviewPolicy`：默认 `anyone`，`human_only` 限认证用户，`not_creator` 排除发起该审查的 writer。[P3][P6][P11] | 不能把 `in_review` 一概说成人工审核，更不能说所有任务默认执行者无法自行审查。 |
| 招聘、战略等治理 | 官方指南指向 **Approvals** 页；详情 UI 确有 **Approve / Reject / Request revision**。指南声称 CEO 初始战略需审批；但本轮未完整追查该全局执行门，不能将此表述提升为源码已证明的普遍强制条件。招聘审批也可配置，公司 schema 的 `requireBoardApprovalForNewAgents` 缺省为 `false`。[P12][P13][P14] | 专门审批种类与具体公司策略不等于“每次任务都经董事会”。 |

### 2.4 预算暂停与人工停止

- **用户入口**：Agent 详情的配置/预算；指南给出 company/agent `budgetMonthlyCents`，成本 Dashboard 展示消费；Agent 可人工 pause/resume。这些是与 Auto/Plan/Ask 正交的控制。[P1][P9]
- **官方指南口径**：80% 告警、100% 自动暂停，不再 heartbeat；可提高预算或等待下一 UTC 月恢复。该口径是文档说明，不把“跟踪每个 token”当作未经实测的完整计费保证。[P9]
- **源码限定**：预算服务更丰富，有 company/project/agent scope；硬停止受 active policy、`hardStopEnabled`、正额度等条件约束。`pauseScopeForBudget()` 持久化 budget pause；`resumeScopeFromBudget()` 先检查仍阻塞的 policies，且只清除预算原因暂停，不把人工暂停一起取消。[P15]
- **未确证**：本轮没有完整追踪所有 adapter 的费用上报、运行中取消与预留链路，不能保证“到阈值的瞬间杀掉一切进程”“绝不超支”或“预算刷新后一定立即继续原任务”。[P9][P15]

## 3. 对用户问题的直接回答

- **“我已经有任务，怎么交给 Agent？”** Vibe Kanban 选任务并启动关联 Workspace/Attempt；Paperclip 指派 Issue 给 Agent，选工作方式，并由允许的唤醒触发执行。[V1–V3][P2–P5]
- **“我只给目标，让它自己安排并推进呢？”** Vibe Kanban 的第一方证据是向 MCP 客户端 Agent 委托拆任务、启动 Workspace；Paperclip 是目标级任务或 Agent Chat 授权交接，加上管理工具、heartbeat/Routines、预算和治理策略组合。两者都不能简化为已经有我们提议的两个按钮。[V4][P6–P10]
- **“是否有授权模式选择？”** 有真实但不同维度的选择：Vibe Kanban 的 Agent variants/许可模式；Paperclip 的 Auto/Plan/Ask，以及独立的 review/approval、wake、budget 控制。**未确证存在题述二选一授权开关。** 本文不据此修改 Wemux 产品或 spec。[V5][V6][P4][P5][P11–P15]

## 第一方来源（全部固定提交）

- [V1] [docs/core-features/creating-tasks.mdx](https://github.com/BloopAI/vibe-kanban/blob/d5cbb5380fa0b32e98ef9b8d987f63decce4be3a/docs/core-features/creating-tasks.mdx)
- [V2] [docs/cloud/issues.mdx](https://github.com/BloopAI/vibe-kanban/blob/d5cbb5380fa0b32e98ef9b8d987f63decce4be3a/docs/cloud/issues.mdx)
- [V3] [docs/workspaces/creating-workspaces.mdx](https://github.com/BloopAI/vibe-kanban/blob/d5cbb5380fa0b32e98ef9b8d987f63decce4be3a/docs/workspaces/creating-workspaces.mdx)
- [V4] [docs/integrations/vibe-kanban-mcp-server.mdx](https://github.com/BloopAI/vibe-kanban/blob/d5cbb5380fa0b32e98ef9b8d987f63decce4be3a/docs/integrations/vibe-kanban-mcp-server.mdx)
- [V5] [docs/configuration-customisation/agent-configurations.mdx](https://github.com/BloopAI/vibe-kanban/blob/d5cbb5380fa0b32e98ef9b8d987f63decce4be3a/docs/configuration-customisation/agent-configurations.mdx)
- [V6] [crates/executors/src/executors/claude.rs](https://github.com/BloopAI/vibe-kanban/blob/d5cbb5380fa0b32e98ef9b8d987f63decce4be3a/crates/executors/src/executors/claude.rs)
- [V7] [docs/reviewing-code.mdx](https://github.com/BloopAI/vibe-kanban/blob/d5cbb5380fa0b32e98ef9b8d987f63decce4be3a/docs/reviewing-code.mdx)
- [V8] [docs/workspaces/git-operations.mdx](https://github.com/BloopAI/vibe-kanban/blob/d5cbb5380fa0b32e98ef9b8d987f63decce4be3a/docs/workspaces/git-operations.mdx)
- [P1] [docs/guides/board-operator/managing-agents.md](https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/docs/guides/board-operator/managing-agents.md)
- [P2] [docs/guides/board-operator/managing-tasks.md](https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/docs/guides/board-operator/managing-tasks.md)
- [P3] [ui/src/components/NewIssueDialog.tsx](https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/ui/src/components/NewIssueDialog.tsx)
- [P4] [ui/src/lib/work-mode-meta.ts](https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/ui/src/lib/work-mode-meta.ts)
- [P5] [server/src/services/heartbeat-policy.ts](https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/server/src/services/heartbeat-policy.ts)
- [P6] [skills/paperclip/SKILL.md](https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/skills/paperclip/SKILL.md)
- [P7] [docs/api/goals-and-projects.md](https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/docs/api/goals-and-projects.md)
- [P8] [ui/src/pages/AgentChat.tsx](https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/ui/src/pages/AgentChat.tsx)
- [P9] [docs/guides/board-operator/costs-and-budgets.md](https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/docs/guides/board-operator/costs-and-budgets.md)
- [P10] [docs/api/routines.md](https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/docs/api/routines.md)
- [P11] [server/src/services/issue-review-policy.ts](https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/server/src/services/issue-review-policy.ts)
- [P12] [docs/guides/board-operator/approvals.md](https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/docs/guides/board-operator/approvals.md)
- [P13] [ui/src/pages/ApprovalDetail.tsx](https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/ui/src/pages/ApprovalDetail.tsx)
- [P14] [packages/db/src/schema/companies.ts](https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/packages/db/src/schema/companies.ts)
- [P15] [server/src/services/budgets.ts](https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/server/src/services/budgets.ts)
- [P4 补充] [TaskChatComposer.tsx：模式菜单与输入提示](https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/ui/src/components/task-chat/TaskChatComposer.tsx)
