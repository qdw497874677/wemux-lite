# Paperclip UI 交互形式研究

> 研究目标：从 Paperclip UI 源码提炼可平移到 Wemux Lite 的交互结构，为正在进行的七件套架构设计提供页面层输入。本文只讨论信息组织、操作路径、状态反馈和响应式降级，不复制 Paperclip 的视觉样式。

## 0. 研究边界与视觉层原则

### 源码范围

Paperclip 源码根目录：`/opt/data/profiles/hacker/workspace/project/paperclip-upstream/paperclip/`

重点阅读：

- `DESIGN.md`
- `ui/src/pages/Issues.tsx`
- `ui/src/components/KanbanBoard.tsx`
- `ui/src/pages/Agents.tsx`
- `ui/src/pages/AgentDetail.tsx`
- `ui/src/pages/Timeline.tsx`
- `ui/src/pages/WhatNeedsMe.tsx`
- `ui/src/pages/Search.tsx`
- `ui/src/pages/Approvals.tsx`
- `ui/src/components/ApprovalCard.tsx`
- `ui/src/components/FilterBar.tsx`
- `ui/src/components/Sidebar.tsx`
- `ui/src/components/SidebarShell.tsx`
- `ui/src/components/onboarding/FooterNav.tsx`
- `ui/src/components/onboarding/Stepper.tsx`
- `ui/src/components/search/SearchFilterBar.tsx`
- `ui/src/components/search/SearchFilterChips.tsx`
- `ui/src/components/search/SearchFilterSheet.tsx`
- `ui/src/lib/live-log-buffer.ts`
- `ui/src/lib/live-runs-cache.ts`

Wemux Lite 对照范围：

- `apps/web/src/App.tsx`
- `apps/web/src/app/shell.tsx`
- `apps/web/src/styles.css`
- `apps/web/src/features/tasks/board.tsx`
- `apps/web/src/features/tasks/runs.tsx`
- `apps/web/src/features/sessions/conversation.tsx`
- `apps/web/src/features/sessions/pending-approval-panel.tsx`
- `apps/web/src/features/sessions/navigation.tsx`
- `apps/web/src/features/command-palette/command-palette.tsx`
- `apps/web/src/features/panels/right-panel-sheet.tsx`
- `apps/web/src/features/panels/right-panel-tabs.tsx`
- `apps/web/src/features/agents/agents-panel.tsx`
- `apps/web/src/features/channels/channel-page.tsx`
- `apps/web/src/features/connectors/connector-page.tsx`
- `apps/web/src/components/ui/confirm-dialog.tsx`

### 视觉层差异

Paperclip 的 `DESIGN.md` 明确要求组件只消费语义 token，不在页面内直接发明颜色，并规定对话框页脚采用左侧取消、右侧主操作。这个约束值得继承，但不能把 Paperclip 的颜色、圆角、阴影或英文信息层级直接复制到 Wemux Lite。

Wemux Lite 的落地原则：

1. 颜色、间距、圆角、玻璃效果和状态色继续以 `apps/web/src/styles.css` 的 Tailwind v4 CSS 变量为准。
2. 深色优先，自动亮色，状态色使用现有 `warning`、`error`、`success`、`info` 语义变量。
3. 所有用户文案以中文为准，领域术语使用 Worker、Agent、Project、Workspace、Session、Task、Run 的既有定义。
4. 可以直接借鉴组件树和状态机，不复制 Paperclip 的 className 组合。
5. 七件套架构中的同一资源应共享加载、空状态、错误、详情面板和危险确认协议，避免每个 feature 自行发明交互。

---

## 1. 信息密度与布局骨架

### Paperclip 的做法

#### Board：宽画布承载高密度状态，详情通过路由继续深入

`ui/src/pages/Issues.tsx` 负责页面级项目上下文、视图切换、筛选与导航关系。它在看板模式下组合 `ui/src/components/KanbanBoard.tsx`，由后者提供按状态分列的横向画布、卡片拖放区和内部 `KanbanCard`。卡片只保留标题、状态、负责人、优先级等快速判断信息，复杂内容通过点击进入详情路径。

其核心不是把完整字段堆在卡片上，而是让用户先在全局状态面定位对象，再进入对象详情。

#### Agents：表格负责比较，操作区保持窄而稳定

`ui/src/pages/Agents.tsx` 使用高密度列表或表格表达 Agent 集合。页面头部承担标题、计数和新建入口，行内展示身份、角色、状态、预算或活动等可比较字段，行尾保留主要操作与更多菜单。筛选和搜索位于列表上方，不混入每一行。

这种结构适合需要横向比较多个同类实体的页面，不适合把每个实体做成大卡片。表格行点击进入 `ui/src/pages/AgentDetail.tsx`，集合页和详情页职责清楚。

#### AgentDetail：详情头、页签、局部双栏

`ui/src/pages/AgentDetail.tsx` 的详情页先用稳定头部呈现 Agent 身份、状态和关键操作，再用页签切换 Overview、Runs、Instructions 等内容。运行历史在桌面端采用列表与详情并排，左侧是窄运行列表，右侧是选中 Run 的详细日志。Instructions 区也采用文件列表与编辑区并排，并允许按可用宽度调整布局。

全局侧栏由 `ui/src/components/Sidebar.tsx` 与 `ui/src/components/SidebarShell.tsx` 提供，主区负责当前资源，右侧或局部第二列只在确有选择上下文时出现。三级结构可以概括为：

1. 侧栏定位业务域。
2. 集合页负责扫描和比较。
3. 详情页负责状态、历史与编辑，局部主从布局负责连续浏览。

### Wemux Lite 的现状

- `apps/web/src/App.tsx` 已形成左侧项目导航、中央主画布、右侧面板的工作台骨架。
- `apps/web/src/features/sessions/navigation.tsx` 在侧栏中放项目导航和最近 Session，支持折叠、搜索、行内重命名和行尾菜单。
- `apps/web/src/features/panels/right-panel-tabs.tsx` 已有可保活的右侧多页签面板，`apps/web/src/features/panels/right-panel-sheet.tsx` 提供窄屏抽屉降级。
- `apps/web/src/features/tasks/board.tsx` 已有看板与列表切换、搜索、状态筛选、计数、拖放迁移和任务详情 Inspector。
- `apps/web/src/app/shell.tsx` 的 `InspectorHost` 已实现宽屏侧栏、窄屏模态侧板、宽度调整、焦点恢复和内容不因响应式切换而重挂。
- `apps/web/src/features/agents/agents-panel.tsx` 目前是按 Worker 分组的右侧面板，适合快速开始对话，但不是完整的 Agent 集合管理页。
- `apps/web/src/features/channels/channel-page.tsx` 与 `apps/web/src/features/connectors/connector-page.tsx` 仍把创建表单、列表、诊断和详情堆在单页，信息密度随数据量增长会迅速失控。

### 借鉴判定

**判定：改样式后搬。**

直接借鉴 Paperclip 的集合页、详情页、局部主从三层结构，但全部使用 Wemux Lite 的现有 AppShell、InspectorHost、RightPanelTabs 和 token。

优先落点：

- `apps/web/src/features/agents/`：从仅右侧快捷面板扩展为可比较的 Agent 集合页，保留面板作为快捷入口。
- `apps/web/src/features/connectors/`：列表作为主区，创建和编辑进入 Inspector，Worker 分发状态进入详情页签。
- `apps/web/src/features/channels/`：Channel 列表作为主区，Binding 与 Delivery 诊断进入详情页签。
- `apps/web/src/features/tasks/`：继续强化看板主区加 Inspector，不把更多字段塞回卡片。

理由是 Wemux Lite 已具备更成熟的三栏和响应式 Inspector 基础，缺的不是新容器，而是统一资源页面的密度分层规则。

**本类一句话结论：用“侧栏定位、集合扫描、详情深挖、局部主从”统一七件套页面，不再让配置表单、列表和诊断长期挤在一个页面。**

---

## 2. 实时状态呈现

### Paperclip 的做法

#### AgentDetail.liveRun：把进行态提升为详情页的首要状态

`ui/src/pages/AgentDetail.tsx` 会从运行列表中优先选出 `running` 或 `queued` 的 Run，而不是机械展示最新一条。进行中的 Run 在详情中集中呈现：

- 运行状态和持续时间。
- 流式日志正文。
- token 与成本等用量信息。
- 停止运行按钮。
- 运行结束后的状态、输出和错误。

`ui/src/lib/live-log-buffer.ts` 将高频日志增量缓冲后再刷新 UI，避免每个片段都触发整棵详情树更新。`ui/src/lib/live-runs-cache.ts` 保存活动 Run 的局部实时状态，使路由切换或查询刷新不会立即丢失正在看的运行反馈。

值得借鉴的不是某个进度条，而是“活动对象优先、稳定日志容器、控制动作贴近状态、历史对象仍可切换”的组合。

#### Timeline：筛选置于顶部，事件按时间语义组织

`ui/src/pages/Timeline.tsx` 使用 `ui/src/components/FilterBar.tsx` 将事件类型、主体等筛选集中到页面顶部，再按日期或时间段组织事件列表。事件摘要先给出主体、动作、目标和时间，附加数据通过展开查看，避免默认展示原始 payload。

时间线是审计视图，不是聊天视图。其交互重点是筛选、快速扫描、逐项展开和回到相关资源。

#### WhatNeedsMe：把跨资源注意事项聚合成行动入口

`ui/src/pages/WhatNeedsMe.tsx` 将需要当前用户处理的事项聚合为注意力卡片，用原因标签、资源摘要、时间和直接操作表达“为什么现在需要我”。它不是另一份完整列表，而是从多个业务域抽取待处理切片。

### Wemux Lite 的现状

- `apps/web/src/features/sessions/conversation.tsx` 已把消息、推理、工具调用、用量和错误统一投影为时间线条目。工具条目默认在运行时展开，完成后可折叠，已具备良好的实时对话基础。
- 同一文件中的 Composer 已支持运行时停止按钮、排队提示、上下文用量和 `/stop`、`/compact` 等操作。
- `apps/web/src/features/sessions/work-log.ts` 已把工具调用归一化为命令、读取、编辑、浏览、搜索等可读动作。
- `apps/web/src/features/tasks/runs.tsx` 的 Run Inspector 能展示不可变快照、状态、Journal freshness、会话记录、取消和人工审查，但运行列表、活动 Run 摘要和详细日志仍是纵向堆叠，扫描效率较低。
- `apps/web/src/features/tasks/board.tsx` 的活动页签目前直接展示事件类型、JSON payload 和 requestId，更接近调试视图，不是面向日常使用的时间线。
- 当前没有跨 Task、Run、Session、审批、Worker 异常的统一“需要我处理”聚合入口。

### 借鉴判定

**判定：直接搬组件结构。**

将 Paperclip 的 Run 列表加详情、活动 Run 优先、摘要加流式日志结构直接映射到 `apps/web/src/features/tasks/runs.tsx`，但复用 Wemux Lite 现有 `TimelineEntry`、Composer、LayerStatus 和服务端权威状态，不另造一套日志组件。

时间线部分为 **只学模式**：将 Task Activity 从原始 JSON 列表改为“筛选条、日期分组、摘要行、按需展开原始信息”，同时保留 requestId 和 payload 作为诊断层。

WhatNeedsMe 为 **只学模式**：未来可在七件套顶层新增“待处理”投影，聚合待审批命令、待审查 Run、失败重试、离线 Worker、配置未完成项，但必须由服务端能力和权限数据驱动，不能由前端猜测任务状态。

理由是对话时间线本身已优于简单日志流，真正缺口是 Run 主从浏览、审计时间线可读性和跨域注意力聚合。

**本类一句话结论：保留现有 Session 时间线，把 Paperclip 的“活动 Run 优先、左列历史、右侧实时详情”和“跨域待处理聚合”补到 Run 与工作台层。**

---

## 3. 表单与向导模式

### Paperclip 的做法

#### 稳定页脚与多步向导

`DESIGN.md` 规定对话框和向导页脚保持一致：取消在左，保存或继续在右。`ui/src/components/onboarding/FooterNav.tsx` 将返回、取消、继续或完成集中在固定页脚，`ui/src/components/onboarding/Stepper.tsx` 负责显示当前步骤和总进度。正文只承载当前决策，不重复放置主操作。

这种模式适用于有依赖顺序、需要验证和可以中途放弃的设置流程。它把“当前在哪一步”“下一步是什么”“退出会损失什么”明确分开。

#### 行内编辑、弹窗和侧板的取舍

Paperclip 源码体现出清晰分工：

- 行内编辑：只用于名称、短文本或单一状态等低风险、低字段量修改。
- 弹窗：用于创建、确认和短表单，操作完成后回到原上下文。
- 详情页或侧板：用于字段多、需要参考上下文、需要反复保存或包含子资源的编辑。
- 多步向导：用于首次配置、模型接入、Agent 创建等存在顺序依赖的任务。

`ui/src/pages/AgentDetail.tsx` 中 Instructions 编辑保留列表上下文和编辑区，不使用小弹窗承载长文本。保存成功后仍保留当前资源上下文，完成整个创建流程时才退出向导或关闭对话框。

### Wemux Lite 的现状

- `apps/web/src/features/tasks/board.tsx` 的新建任务已经使用弹窗，并通过固定 footer 提供取消和创建；任务详情则在 Inspector 中持续编辑。
- `apps/web/src/features/sessions/navigation.tsx` 使用行内重命名，符合短文本低风险场景。
- `apps/web/src/features/connectors/connector-page.tsx` 将多字段创建与编辑表单永久放在列表上方，随着操作、认证、Worker 范围和风险策略增加，会越来越难维护。
- `apps/web/src/features/channels/channel-page.tsx` 同时承载 Channel 创建、Binding 创建、一次性令牌、列表和 Delivery 诊断，用户必须理解全部概念才能完成首次接入。
- `apps/web/src/features/tasks/runs.tsx` 的启动 Run 实际已是一个有步骤依赖的流程：选会话模式、核对 Assignment、编辑 Prompt、冻结请求身份、确认启动，但当前以单个 fieldset 呈现。
- `apps/web/src/components/ui/confirm-dialog.tsx` 已统一危险确认弹窗。

### 借鉴判定

**判定：改样式后搬。**

建议在七件套中定义统一的表单容器协议：

1. 短创建表单继续使用 Dialog。
2. 可持续编辑和含子资源的配置使用 Inspector。
3. 首次接入 Channel、Connector 和 Worker 时使用 3 至 5 步向导。
4. 向导 footer 固定为左侧取消或返回、右侧继续或保存。
5. 最后一步明确使用“保存并退出”或“保存并打开详情”，不要用含义模糊的“完成”。
6. 离开脏表单统一走 `ConfirmDialogProvider`，不要各页面自行调用浏览器确认。

优先落点：

- `apps/web/src/features/channels/`：类型选择、凭证配置、Session Binding、连接验证、完成。
- `apps/web/src/features/connectors/`：基础定义、允许操作、Worker 范围、风险策略、测试与保存。
- `apps/web/src/features/tasks/`：把首次 Run 启动整理为分段确认，而不是把所有幂等语义同时暴露在一块表单里。

理由是这些流程不是单字段编辑，向导能降低首次使用的概念负担，同时保留高级用户从详情页直接修改的路径。

**本类一句话结论：用行内编辑处理短字段，用 Dialog 处理短任务，用 Inspector 处理持续编辑，用固定 footer 向导处理 Channel、Connector 和首次 Run 的顺序决策。**

---

## 4. 命令面板与快捷操作

### Paperclip 的做法

`ui/src/pages/Search.tsx` 不是简单的命令弹窗，而是可分享、可恢复的全局搜索页：

- 查询、scope、排序和筛选写入 URL。
- scope 用页签切换任务、评论、文档、产物、Agent、项目等结果域。
- 支持查询操作符建议与最近搜索。
- 桌面端使用完整 `ui/src/components/search/SearchFilterBar.tsx`。
- 已生效条件用 `ui/src/components/search/SearchFilterChips.tsx` 显示并可逐项移除。
- 移动端把复杂筛选放入 `ui/src/components/search/SearchFilterSheet.tsx`，应用前保留草稿并展示预览计数。
- 加载、错误、无查询、无结果分别有独立状态。

它与命令入口的职责不同：命令入口负责“做什么”，搜索页负责“找到什么”。

### Wemux Lite 的现状

`apps/web/src/features/command-palette/command-palette.tsx` 已有成熟的命令面板：

- 搜索工作台命令和当前 Project 的 Session 标题。
- 键盘上下选择、Enter 执行、Esc 关闭。
- 命令与 Session 分组。
- 最近命令置顶。
- 匹配文本高亮。
- 明确提示“时间线文本搜索尚未接入”。

当前缺口是资源与内容搜索，不是命令面板本身。若继续把 Task、Workspace、Agent、日志和文件都塞进同一个弹窗，结果会变得难以筛选、不可分享，也无法承载复杂过滤。

### 借鉴判定

**判定：只学模式。**

保留现有 command palette 作为快速执行层，并新增独立搜索路由作为检索层。命令面板只需增加“打开全局搜索”命令和少量直接命中结果，不应复制完整 Search.tsx 到弹窗。

建议搜索页分阶段覆盖：

1. Project 内 Task、Workspace、Session、Agent、Channel、Connector。
2. Session 标题与消息文本。
3. 工具调用、文件变更和 Run 结果。
4. URL 持久化 scope、筛选、排序和查询词。

移动端沿用“顶部搜索框加筛选 Sheet”，桌面端使用完整筛选条。落点可先新建 apps/web/src/features/search 目录，命令入口继续留在 `apps/web/src/features/command-palette/`。

理由是 Paperclip 最有价值的补充是搜索状态可链接和桌面、移动双形态筛选，而不是再做一个快捷键弹窗。

**本类一句话结论：命令面板继续负责执行，新增可链接的全局搜索页负责检索，二者通过“打开搜索”命令连接而不混成一个超载弹窗。**

---

## 5. 审批与确认交互

### Paperclip 的做法

`ui/src/pages/Approvals.tsx` 使用 Pending 与 All 页签划分待处理和历史记录，并通过 `ui/src/components/ApprovalCard.tsx` 展示每项审批的请求内容、发起主体、状态、时间和操作。审批动作就近放在卡片内，处理后刷新列表。

需要特别说明：当前源码中没有成熟的多选批量审批工具条，也没有独立的审批详情右侧板。它提供的是“状态页签加逐卡审批”，不能把不存在的批量能力当成可直接搬运的实现。

Paperclip 对高风险操作多采用页面内的 AlertDialog 结构，例如 `ui/src/pages/CompanySettings.tsx` 的删除公司确认要求输入公司名称后才允许继续，`ui/src/pages/AgentDetail.tsx` 也用 AlertDialog 承载 Agent 删除确认。危险主按钮保持独立语义，这种做法把普通二次确认和高风险强确认区分开。

### Wemux Lite 的现状

- `apps/web/src/features/sessions/pending-approval-panel.tsx` 将待审批命令、文件和摘要直接插在 Session 对话流与 Composer 之间，用户能在执行上下文中批准或拒绝。
- 它维护 sending、pending、accepted、rejected、error 状态，并轮询 Worker receipt，能表达“请求已提交但最终结果尚未确认”。
- `apps/web/src/components/ui/confirm-dialog.tsx` 已统一危险按钮、处理中状态和 Promise 式调用。
- `apps/web/src/features/tasks/review.tsx` 承载 Run 的人工审查，符合 Run 成功不自动完成 Task 的领域规则。
- 当前没有跨 Session 的审批队列，也没有批量决策的安全边界。

### 借鉴判定

**判定：只学模式。**

保留 Session 内联审批，因为它比跳转到独立页面更贴近执行上下文。另建跨 Session 的审批聚合页时，可借鉴 Pending 与 All 页签和审批卡片，但详情应使用 Wemux Lite 的 InspectorHost，展示完整命令、cwd、文件列表、来源 Session、Worker、Agent、权限原因和 receipt 状态。

批量审批暂不搬。只有满足以下条件时才考虑：

- 同类操作。
- 同一 Worker 与同一权限边界。
- 每项风险摘要均可见。
- 服务端提供逐项幂等身份与部分失败结果。
- 默认不允许把命令执行和文件写入混为一个批次。

高危确认建议分级：

1. 可恢复操作使用普通确认。
2. 删除历史、撤销身份、轮换密钥等高危操作使用危险确认。
3. 影响范围大且不可逆的操作增加输入资源名或确认短语。

优先落点为 `apps/web/src/features/sessions/` 的聚合审批页面，以及 `apps/web/src/components/ui/confirm-dialog.tsx` 的可选强确认能力。

理由是 Paperclip 的审批列表结构可用，但 Wemux Lite 的 receipt、不确定投递和权限边界更复杂，不能直接引入乐观批量批准。

**本类一句话结论：保留 Session 内联审批，补一个跨 Session 的 Pending 与 All 聚合页，批量审批必须等待服务端逐项幂等和部分失败协议。**

---

## 6. 空状态、加载态与错误态

### Paperclip 的做法

Paperclip 根据页面骨架是否已知选择反馈形式：

- 表格、卡片列表和详情占位使用 skeleton，避免加载完成后大幅跳动。
- 局部即时动作使用 spinner 或按钮内 pending 状态。
- 错误态保留当前页面结构，并提供明确 Retry。
- 空状态区分“尚无数据”和“筛选后无结果”。前者提供创建或接入入口，后者提供清除筛选。
- `ui/src/pages/Search.tsx` 还区分初始无查询、查询中、请求错误、零结果和有结果，避免所有情况只显示空白列表。
- onboarding 空状态以一个主行动为中心，不同时抛出多个配置概念。

### Wemux Lite 的现状

- `apps/web/src/features/tasks/board.tsx` 已使用列级 skeleton，且区分空看板与筛选无结果。
- `apps/web/src/features/sessions/navigation.tsx` 使用 Session 行 skeleton，并给出连接、项目为空和搜索无结果等不同文案。
- `apps/web/src/features/sessions/conversation.tsx` 区分正在加载历史、暂无消息、无发送权限和错误通知。
- `apps/web/src/features/connectors/connector-page.tsx` 与 `apps/web/src/features/channels/channel-page.tsx` 多数加载过程没有稳定骨架，错误和重试也较依赖页面顶部通用提示。
- `apps/web/src/App.tsx` 对懒加载 chunk 失败提供重新加载入口，这是正确的可恢复错误模式。

### 借鉴判定

**判定：直接搬组件结构。**

在七件套中统一四类页面状态组件协议：

1. `ResourceSkeleton`：页面骨架可预知时使用，尺寸与最终列表或详情接近。
2. `InlinePending`：按钮、保存、测试连接、停止和重放等局部动作使用。
3. `RecoverableError`：说明失败对象，保留现有数据，提供重试，并在可能时说明数据是否陈旧。
4. `EmptyState`：至少区分首次为空、筛选为空、权限为空、离线缓存为空。

每个空状态只给一个主要行动，次要说明放正文或链接。Channel、Connector、Agent、Workspace 的空状态应指向相应向导，而不是直接展示完整高级表单。

优先落点可抽到 `apps/web/src/components/`，再由 `apps/web/src/features/channels/`、`apps/web/src/features/connectors/`、`apps/web/src/features/agents/` 和 `apps/web/src/features/tasks/` 复用。

理由是 Wemux Lite 已有零散的正确案例，缺的是跨 feature 的命名、状态分类和一致恢复入口。

**本类一句话结论：骨架可预知就用 skeleton，局部动作才用 spinner，空状态必须区分首次为空与筛选为空，错误态必须保留上下文并提供明确重试。**

---

## 7. 移动端适配

### Paperclip 的做法

Paperclip 采用同一套 React 页面做响应式降级，没有发现独立的移动端页面树。移动开发命令更像是以移动设备可访问的 host 和端口启动同一应用，不代表维护第二套 UI。

关键策略包括：

- `ui/src/components/SidebarShell.tsx` 配合 `ui/src/components/Sidebar.tsx` 在窄屏将侧栏转为覆盖式抽屉。
- `ui/src/pages/AgentDetail.tsx` 的 Run 历史在桌面端为列表加详情双栏，在移动端改为列表页与详情页二选一，并提供返回按钮。
- 同一文件的 Instructions 在移动端在文件列表和编辑器之间切换，不强行保留并排双栏。
- `ui/src/pages/Search.tsx` 在桌面显示完整筛选条，在移动端改用 `ui/src/components/search/SearchFilterSheet.tsx`，筛选草稿在点击应用后才生效。
- 看板保留横向语义，通过滚动访问列，而不是把所有列压成不可读的窄卡片。
- 页签、工具条和行操作优先缩短标签或收进菜单，不简单隐藏关键动作。

### Wemux Lite 的现状

- `apps/web/src/App.tsx` 与现有 Sidebar 组件已支持侧栏折叠和工作台响应式布局。
- `apps/web/src/features/panels/right-panel-sheet.tsx` 已把右侧面板在窄屏降级为最大 28rem 的右侧 Sheet。
- `apps/web/src/app/shell.tsx` 的 InspectorHost 在 1280px 以下切换为模态侧板，且保持同一子树，避免表单状态和焦点丢失。
- `apps/web/src/features/tasks/board.tsx` 有响应式列数，但看板、详情 Inspector 和复杂 Run 表单在手机上的任务切换路径仍偏长。
- `apps/web/src/features/channels/channel-page.tsx` 和 `apps/web/src/features/connectors/connector-page.tsx` 虽使用响应式 grid，却仍可能在手机上形成很长的单页表单。
- 命令面板可在窄屏使用，但尚无独立搜索页的移动筛选策略。

### 借鉴判定

**判定：直接搬组件结构。**

七件套的移动端不另建独立页面，统一采用以下降级规则：

1. 三栏变为单主区加 Sheet。
2. 主从双栏变为列表与详情二选一，并提供明确返回。
3. 完整筛选条变为带已选数量的筛选 Sheet。
4. 固定页脚保留取消、返回和主操作，避免主按钮滚出屏幕。
5. 看板保留横向滚动或提供列表视图，不把多列压缩成窄列。
6. 行尾多操作收进菜单，批准、停止、保存等当前关键动作仍直接可见。
7. 响应式切换尽量不重挂内容，延续 InspectorHost 的状态保留原则。

优先落点：

- `apps/web/src/features/tasks/`：Run 列表与详情移动端切换。
- 新建 apps/web/src/features/search 目录：筛选 Sheet。
- `apps/web/src/features/channels/` 与 `apps/web/src/features/connectors/`：向导固定 footer。
- `apps/web/src/features/panels/`：统一详情 Sheet 与返回语义。

理由是同构响应式能复用查询、权限和表单状态，维护成本远低于独立移动端实现，同时符合 Wemux Lite 的轻量部署目标。

**本类一句话结论：移动端采用同一页面树的结构降级，双栏改列表与详情切换，复杂筛选进 Sheet，关键操作和草稿状态不能因变窄而消失。**

---

## 8. 对七件套架构设计的统一输入

从上述七类交互可以抽出一组不依赖具体资源的页面协议，建议作为七件套架构的 UI 层约束：

### 8.1 资源集合页协议

- 页面头：名称、说明、数量、唯一主操作。
- 工具条：搜索、筛选、视图切换、结果计数。
- 内容区：表格、列表或看板三选一，不在同页并列多个完整形态。
- 状态区：skeleton、可恢复错误、首次空状态、筛选空状态。
- 选择资源后进入路由化详情或 Inspector，刷新可恢复选择。

### 8.2 资源详情协议

- 稳定详情头：身份、状态、关键操作。
- 页签：概览、活动、配置、关联资源或运行历史。
- 活动对象优先，但历史对象始终可选。
- 高密度原始数据默认折叠，摘要先表达用户可判断的信息。
- 宽屏并排，窄屏列表与详情切换，切换不丢草稿。

### 8.3 操作反馈协议

- 请求已发送与权威结果已确认必须分开表达。
- 高风险动作显示影响范围和不可逆性。
- 错误后保留输入、requestId 和可重试路径。
- 乐观更新失败必须回滚并给出重新核对入口。
- 跨域“待处理”只聚合服务端能证明需要当前用户行动的事项。

### 8.4 表单协议

- 短字段行内编辑。
- 短创建使用 Dialog。
- 长期配置使用 Inspector。
- 有顺序依赖的首次配置使用 Stepper 和固定 Footer。
- footer 左侧为取消或返回，右侧为继续、保存或保存并退出。
- 脏状态离开统一确认，保存中禁止重复提交。

---

## 9. Top 5 交互形式优先级

### 1. Run 历史列表加实时详情主从布局

**落点：** `apps/web/src/features/tasks/runs.tsx`、`apps/web/src/features/sessions/conversation.tsx`

把活动 Run 置顶，左侧扫描历史，右侧复用现有时间线、用量、状态、停止和审查能力。移动端改为列表与详情切换。这一项能直接改善 Task 到 Run 到 Session 的核心执行链路。

### 2. Channel 与 Connector 的向导加 Inspector 架构

**落点：** `apps/web/src/features/channels/`、`apps/web/src/features/connectors/`、`apps/web/src/app/shell.tsx`

首次接入使用分步向导，日常列表与编辑使用主区加 Inspector，Binding、Worker 分发和 Delivery 诊断进入详情页签。优先解决当前单页信息持续膨胀的问题。

### 3. 可链接的全局搜索页

**落点：** 新建 apps/web/src/features/search 目录，入口接入 `apps/web/src/features/command-palette/`

保留命令面板的执行职责，新增 URL 驱动的 scope、筛选、排序和结果页。桌面使用筛选条，移动端使用筛选 Sheet。

### 4. 跨 Session 待审批与待审查聚合

**落点：** `apps/web/src/features/sessions/`、`apps/web/src/features/tasks/review.tsx`

建立 Pending 与 All 聚合页，卡片显示风险摘要，Inspector 展示完整上下文。继续保留 Session 内联审批，不先做批量批准。

### 5. 统一页面状态组件

**落点：** `apps/web/src/components/`，由 `apps/web/src/features/tasks/`、`apps/web/src/features/agents/`、`apps/web/src/features/channels/`、`apps/web/src/features/connectors/` 复用

统一 skeleton、局部 pending、可恢复错误、首次空状态和筛选空状态。它是七件套体验一致性的低风险基础设施，也能减少后续页面各自发明状态文案和恢复逻辑。

---

## 10. 总结

Paperclip 最值得借鉴的是清晰的交互分层：集合页用于比较，详情页用于深挖，活动运行优先呈现，复杂首次配置进入向导，搜索状态写入 URL，移动端通过结构切换而不是压缩桌面布局。Wemux Lite 已经拥有 AppShell、InspectorHost、右侧保活面板、Session 时间线、命令面板和统一确认弹窗等良好基础，因此不需要复制 Paperclip 组件外观。下一步应把这些基础收敛为七件套共享的页面协议，再优先改造 Run、Channel、Connector、搜索和聚合审批五条高价值链路。
