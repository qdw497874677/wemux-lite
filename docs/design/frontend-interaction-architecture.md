# Wemux Lite 前端交互架构设计：Agent 协作平台

> 状态：v1.1 修订设计，已结合子代理审查，尚未实施；开工受 M1 契约冻结门约束。

## 修订记录

- **v1.1，2026-01-06，按子代理审查修订**：落实 #1–#14 的交互与架构约束；事务/DDL/测试逐项映射详见重构方案 P0/P1/P4。三条 minor 均采纳（首次 URL 化、唯一详情路由、分层回滚），无拒绝项；§9 与重构方案 §2 的七个 features 及 app/routes/shared 清单一致。
- 以下为跨文档统一裁定协议，实施细节不得覆盖该协议：

1. launch 事务：单一 application 入口 ServerService.launchTaskRun，内部 store 单事务完成 task_runs 行创建 + Session 创建 + Run 快照固化 + 消息入队；事务边界在 application 层；禁止嵌套 BEGIN（现有 createSession/enqueue 各自开事务，SQLite 串行 store 嵌套死锁）。
2. Run 生命周期：task_runs.command_id 关联 commands.id；turn.started→running；turn.finished(complete)→succeeded；turn.finished(error)→failed；cancel→cancelling→（停止回执或 turn.finished 后）cancelled；turn.stop 只停当前 turn。
3. 测试基线：P0 不引入 DOM 测试环境（无 RTL/jsdom/happy-dom）；node:test + tsx 不变；web 行为测试 = features 模块纯函数/hook 测试；source-contract 断言从 App.tsx 迁到 features/* 并逐条列出保留映射；浏览器 E2E 仍是 scripts/ 独立脚本。
4. V*/P* 对齐：V0→P0–P1 并行；V1→P3；V2→P4；V3→P5；V4→P7 后。
5. 契约冻结门：M1 末尾加 web-contract 契约冻结检查点。
6. launch 幂等：task_id+内容指纹，幂等命中先于 active-run 检查。
7. 乐观锁：转移矩阵 todo→in_progress→in_review→done、任一→blocked、blocked→回原状态；CAS 仅 status+assignee。
8. 自定义模型 v1 限 worker capabilities 已上报模型；自定义模型为 v1.1。
9. Repository v1 为内嵌 git URL，无 API 拉取。
10. SSE：P6 加 /api/projects/:id/events 项目级频道。

> 产品定位：Agent 协作平台——Project 提供管理流程，Task 是主工作流（看板形态、保留扩展口），Task 可关联 Git issue 等外部跟踪对象，可在 Task 中创建 Workspace 并分配 Agent 运行时执行任务。
> 参考：`/opt/data/profiles/scribe/workspace/wemux-slim` 看板（`apps/web/src/components/kanban/`）、任务工作区创建（`apps/web/src/components/kanban/task-workspace-create-panel.tsx`）、planner 架构报告（`/tmp/acp-delegate/del_mu10hnlu_vh13.out`）。
> 领域术语以 `CONTEXT.md` 为准：Task / Task Workflow / Task Link / Agent Assignment / Agent Run / Task Workspace 已定义。

## 0. 核心结论

1. **OS 隐喻的正确用法**：体现在稳定的应用框架（全局导航）、资源管理器（Project/Task/Workspace/Session）、进程监视器（Agent Run 实时视图）、通知中心（活动流）；不做桌面窗口管理器、不做浏览器端调度器、不做插件系统。
2. **Task 是主工作流，Session 是执行现场**。看板是 Task Workflow 的一种视图（第一种，不是唯一一种），扩展口从第一天就设计好。
3. **Task → Workspace 创建参考 wemux**：单屏表单（名称 + 节点 + 仓库 + Agent + 模型），创建后异步 provisioning，ready 后可启动 Run。
4. **外部关联第一版只读**：Task Link 只存类型 + 外部 ID + URL，展示与跳转；同步是按类型扩展的适配器接口，不预先承诺。
5. **任务完成是管理决策**：Agent Run 完成最多建议进入 in_review，由人确认 done。这是交互层必须表达的领域不变量。
6. **一次架构升级，不换技术栈**：保留 React + Vite + Tailwind + 少量 Radix；引入 TanStack Router + TanStack Query（仅这两个），App.tsx 拆为 features 模块。

## 1. 信息架构与路由

### 1.1 导航层级

```text
全局导航（应用级，跨项目）
├── 项目 Projects        ← 默认入口
├── 活动 Activity        ← 跨项目注意力流（后置实现）
├── 运行时 Runtimes      ← Worker × Agent × 模型清单（现集群页的目录部分）
├── 集群 Cluster         ← 现有 ClusterPage 演进：Worker、注册、命令投递
└── 设置 Settings        ← 连接配置；未来身份/团队

项目内导航（进入某个 Project 后）
├── 概览 Overview        ← 需要关注的事，不是指标堆砌
├── 任务 Tasks           ← 主工作流：看板 + 任务详情
├── 会话 Sessions        ← 现有 Project → Workspace → Session 树（保留）
├── 工作区 Workspaces    ← 项目下 Workspace 列表与 provisioning 状态
└── 设置                 ← 仓库、成员（未来）
```

### 1.2 路由结构

与重构方案 P3 使用同一矩阵：

| 路径 | 查询参数/呈现 | 交付 |
|---|---|---|
| `/`、`/projects` | 根路径客户端 replace 到项目列表 | P3 |
| `/projects/:projectId` | 项目布局；索引 replace 到 tasks，不自动选首个 Session | P3 |
| `/projects/:projectId/tasks` | `view=board\|list`、`filter` | P3 占位，P5 实装 |
| `/projects/:projectId/tasks/:taskId` | `tab=overview\|links\|workspaces\|runs\|activity`，保留 view/filter；宽屏右栏、窄屏整页 | P3 注册占位，P5 实装 |
| `/projects/:projectId/sessions`、`/projects/:projectId/sessions/:sessionId` | 列表/会话，详情 `turnId`、`toolCallId` | P3 |
| `/projects/:projectId/workspaces`、`/projects/:projectId/workspaces/:workspaceId` | 列表/详情 | P3 |
| `/projects/:projectId/settings` | 项目设置 | P3 |
| `/projects/:projectId/overview` | 聚合概览 | P3 占位，P7 实装 |
| `/runtimes`、`/cluster`、`/settings` | 全局页面 | P3 |

规则：

- **实体身份进路径，展示状态进查询参数**（view、tab、filter、选中的 timeline 条目）。
- URL 拥有 project/task/session 选择，不用全局 Context 镜像这些 ID。
- 任务详情唯一身份入口为 `/projects/:projectId/tasks/:taskId`，不支持 `?taskId=`；宽屏右侧面板、窄屏整页，同组件两种壳，返回保留 view/filter。
- 直接访问不存在/无权限或跨项目归属不一致的 task/session/workspace ID 时明确报错，不静默替换成“第一个可用资源”。
- 当前选择来自 useState，本次是首次 URL 化与根路径默认跳转，不存在已证实的旧 query URL 迁移；移除首选逻辑覆盖直链，仅有外部链接证据才追加可选兼容。客户端 replace 不是 HTTP 301。
- 路由库用 TanStack Router，手写小路由树；不引入 TanStack Start / SSR。

## 2. 全局应用框架（App Shell）

```text
┌──────────────────────────────────────────────────────────────┐
│ W  Wemux Lite │ 项目 活动 运行时 集群 │   连接状态 · 刷新 · ⚙ │  ← 全局栏
├────────────┬─────────────────────────────────────────────────┤
│ 全局导航    │ 项目内导航：概览 | 任务 | 会话 | 工作区 | 设置     │
│ (Projects  │ ┌───────────────────────────────────────────┐   │
│  列表)     │ │                                           │   │
│            │ │              主内容区                      │   │
│  + 新建项目 │ │                                           │   │
│            │ └───────────────────────────────────────────┘   │
│            │                          ┌─────────────────┐   │
│            │                          │ 检查器(可选右栏)  │   │
│            │                          │ 指派/运行/详情    │   │
└────────────┴──────────────────────────┴─────────────────┴───┘
```

- 全局导航可折叠（移动端抽屉），显示项目列表 + 在线 Worker 概要。
- 连接状态条沿用现有分层：浏览器离线 / Server 连接 / 令牌无效 / Worker 在线数（`App.tsx` 现有 connectionState 迁入 shell）。
- 右侧检查器（Inspector）是可选栏：运行详情、会话上下文宽屏常驻、窄屏可用 Sheet；**任务详情例外：窄屏必须整页**，遵循唯一详情路径。

## 3. 任务看板（主工作流，含扩展口）

### 3.1 布局

```text
/projects/:projectId/tasks?view=board
┌────────────────────────────────────────────────────────────────┐
│ 任务  [看板|列表]  筛选▾  搜索   + 新建任务                       │
├──────────┬──────────┬──────────┬──────────┬──────────┬─────────┤
│ 待办 (3) │ 进行中(1) │ 审查中(0)│ 已完成(2)│ 阻塞 (0) │ 积压 (5)│
├──────────┼──────────┼──────────┼──────────┼──────────┼─────────┤
│ ┌──────┐ │ ┌──────┐ │          │          │          │ ┌─────┐ │
│ │标题   │ │ │标题   │ │          │          │          │ │标题  │ │
│ │⚡运行中│ │ │⧉ #42 │ │          │          │          │ │      │ │
│ │pi/gpt │ │ │codex  │ │          │          │          │ │      │ │
│ └──────┘ │ └──────┘ │          │          │          │ └─────┘ │
└──────────┴──────────┴──────────┴──────────┴──────────┴─────────┘
   点击卡片 → 右侧任务详情面板（不离开看板）
```

- 列 = Task Workflow 状态：`todo | in_progress | in_review | done | blocked | backlog`（`cancelled` 不占列，列表视图可筛）。
- 卡片信息（第一版）：标题、工作流状态、运行状态徽章（活跃 Run：agent 图标 + running/failed）、Assignment 摘要（agent/model）、关联标记（issue 图标 + 外部编号）。
- 拖拽 = 状态流转意图：仅开放 `todo→in_progress→in_review→done`、任一非 blocked 状态→blocked、blocked→记录的原状态；进入 blocked 保存 blockedFrom。backlog/cancelled 保留展示/历史值，不因此允许任意边；未列边拒绝，done 只由人确认。触屏/键盘提供同等状态菜单。
- CAS 仅 status+assignee：流转/指派携带 version，冲突回滚并 toast；内容/优先级/links 不使用此 version 锁。Assignment 在 DTO 写字段统一为 assignee，版本由这两类变更原子递增。

### 3.2 扩展口设计（第一天就留好）

| 扩展口 | 形态 | 第一版实现 | 未来方向 |
|---|---|---|---|
| **视图模式注册表** | `TaskViewModeRegistry`: `board` / `list` 两个内置项 | 看板 + 简单列表 | 日历、时间线、按指派分组、自定义列 |
| **卡片字段插槽** | `TaskCardSlots`：卡片渲染管线允许注册附加段 | 标题/状态/运行/关联/指派 | PR 徽章、token 用量、截止日期、外部同步状态 |
| **工作流定义** | `TaskWorkflowDefinition`：列集合与允许流转固化接口 | 固定 7 状态 | 列可配置、项目级自定义流程（不引入引擎） |
| **任务来源** | `origin: 'manual' | 'import:<adapter>' | 'agent-proposal'` | 仅 manual | 从 issue 导入、Agent 提案任务 |
| **列聚合** | 每列渲染器接受聚合器参数 | 计数 | 汇总工时、运行成功率 |

原则：**看板组件只依赖 TaskWorkflow + Task 摘要 DTO**，不依赖未来任何一种视图的私有状态；新增视图模式不改任务契约。

### 3.3 新建任务

单屏紧凑表单（对比 wemux 826 行的 create-task-modal，Mini 不做向导）：

- 标题（必填）、描述、验收标准（可折叠）
- 状态（默认 todo）、优先级（none/low/medium/high）
- 可选：初始关联（粘贴 issue URL，见 §6）
- 可选：初始指派（Workspace + Agent + Model，也可创建后再指派）

## 4. 任务详情

宽屏 = 看板右侧滑出面板（约 480–560px）；窄屏 = 整页。五个 Tab：

```text
┌──────────────────────────────────────────────┐
│ ← 返回   [in_review ▾]  优先级  ···           │
│ 任务标题（可编辑）                              │
│ [概览] [关联] [工作区] [运行] [活动]            │
├──────────────────────────────────────────────┤
│ （Tab 内容区）                                 │
└──────────────────────────────────────────────┘
```

- **概览**：描述、验收标准、当前 Assignment（Workspace/Agent/Model，可修改，提示"只影响后续运行"）、创建/更新时间。
- **关联**：外部对象列表 + 添加/移除（见 §6）。
- **工作区**：此任务绑定的 Workspace 列表（状态徽章：pending/provisioning/ready/failed）+ **"为任务创建工作区"** 主按钮（见 §5）+ 绑定已有 Workspace（未来）。
- **运行**：Run 列表（每次尝试：编号、agent/model 快照、状态、起止时间、结果摘要）+ **"启动运行"** 主按钮（见 §7）+ 活跃 Run 的实时摘要（当前步骤、最近工具调用）。
- **活动**：状态流转、指派变更、Run 开始/结束、关联变更——系统事件时间线（第一版无评论；评论是独立扩展口，不与活动混排）。

## 5. 任务 → 工作区创建流（参考 wemux）

wemux 的 `task-workspace-create-panel` 是单屏 composer：名称 + 节点 + Agent + 模型 + 目录模式 + 基线分支。Mini 对齐自己领域模型后：

### 5.1 表单（单屏，无向导）

```text
为任务创建工作区
┌────────────────────────────────────────────┐
│ 名称：[任务标题预填，可改]                     │
│ 执行节点：[Worker 下拉 · 在线状态 · Agent 数] │
│ 仓库：[内嵌 git URL · 无目录 API 拉取]         │
│ Agent：[该 Worker 可用 Agent（仅 available）]│
│ 模型：[该 Worker 已上报的 Agent 模型列表]     │
│                                            │
│ ⚠ 未实现为执行 Adapter 的 Agent 只展示不可选   │
│            [取消]  [创建工作区]               │
└────────────────────────────────────────────┘
```

级联约束（沿用现有 create-dialog 逻辑，抽出为 `useExecutionTargets`）：

1. 选 Worker → 过滤该 Worker capabilities 中 `availability.status === 'available'` 的 Agent；
2. 选 Agent → 从该 Worker 已上报 capabilities 读取 `models`，v1 禁止手输未上报 ID，Server 同样校验；自定义模型是产品 v1.1，不因本文档修订号 v1.1 就视为已支持；
3. Agent 只有检测无执行（当前 Pi/Claude Code 之外的 codex/opencode）→ 显示"仅检测"标记，禁止选中。

### 5.2 创建后行为

```text
提交 → Workspace(pending) 绑定到 Task → 异步 provisioning
     → 任务详情"工作区"Tab 实时显示 pending → provisioning → ready/failed
     → ready 后：① 直接"启动运行" ② 跳到工作区创建 Session
     → failed：显示 failureReason + 重试
```

- 与 wemux 的差异：第一版无 worktree/目录模式选择、无基线分支选择；Repository 为内嵌 git URL，提交现有 workspace API 的 repository 输入，使用默认分支，无 Repository 目录 API 拉取。表单按 WorkspaceSpec kind 分支渲染，未来模式不改变骨架。
- Task.assignee 为绑定权威，workspace.boundTaskId 为导航冗余；P6 在同一应用事务创建 workspace/命令并 CAS 更新 assignee，失败不留半绑定。Task 只持有引用，删除任务不自动清理工作区。
- P6 前依赖 Query 轮询；P6 才新增 `/api/projects/:id/events` 项目频道，提交后通知 provisioning/task/Run/activity 资源变化，精确 invalidate。无 Session 打开也须更新；重连核对当前项目查询并保留 5s 轮询，不把 Session SSE 当全局资源通道。

## 6. 外部关联（Task Link，第一版只读）

### 6.1 交互

```text
关联 Tab → [添加关联] → 粘贴 URL（如 github.com/org/repo/issues/42）
        → 前端按注册的 LinkAdapter.parse(url) 识别类型
        → 保存 { type, externalId, url, title? }
        → 列表显示：⧉ GitHub Issue #42 · 状态徽章（未同步） · 打开 ↗ · 移除
```

### 6.2 适配器接口（扩展口本体）

```ts
interface TaskLinkAdapter {
  type: string                        // 'github-issue' 第一版
  parse(url: string): TaskLinkDraft | null
  describe(link: TaskLink): LinkDisplay   // 图标、标题、外部状态（可选）
  // 未来可选：sync(link) → SyncResult；第一版不实现，接口不承诺
}
```

- 第一版只注册 GitHub Issue + Pull Request 两个 parser，纯前端 URL 解析 + 手填标题。
- 卡片与详情显示关联标记；不做双向同步、不轮询外部状态（`syncState: 'none'` 占位，未来按类型加同步任务）。
- 明确边界：关联不是导入——`origin: import:` 才表示任务由外部对象创建（扩展口，第一版不实现）。

## 7. Agent Run：启动与执行视图

### 7.1 启动运行流

```text
任务详情 → 运行 Tab → [启动运行]
  → 确认 Assignment（预填当前指派；Workspace 必须 ready，Worker 必须 online）
  → 初始 Prompt 预览（模板：任务标题 + 描述 + 验收标准，可编辑）
  → 提交：
      ServerService.launchTaskRun 接收冻结的 LaunchRequest
      → 同一 store 写事务：幂等命中优先，否则检查 active-run/绑定/attempt
      → 创建 Session（或校验显式指定的 reuse Session）
      → 固定快照 + task_runs + 初始消息入队，提交后才通知 Worker
  → 跳转运行视图
```

规则：

- 一个 Task 同时至多一个活跃 Run（UI 在活跃 Run 存在时禁用"启动运行"，提供"查看运行"）。
- 与重构方案 P4 统一 `LaunchRequest { mode: 'new'|'reuse', sessionId?: string, prompt: string, assignee: AgentAssignment, attempt: number }`，响应 `LaunchResult { runId, sessionId, commandId, messageId, attempt }`。new 不传 sessionId；reuse 必须指定本 Task 最近 Run 的 Session，同项目、可读写且未删除，固定 binding 四字段等于请求及当前 Task assignee，否则 409 要求显式 new，禁止静默换绑。快照取经校验的 Session binding。
- 两种 mode 的新运行均取下一 attempt（max+1）；客户端在提交前冻结全部请求，结果未确认时 attempt/prompt/绑定均不变。内容指纹为稳定规范化请求（trim prompt）的 SHA-256，持久唯一键 `(task_id, fingerprint)`；没有额外随机 launch 键。相同 attempt 异内容 409，用户明确新建尝试才取新 attempt。鉴权后先查历史命中，再查 active-run，原运行结束/指派改变后重试仍返回原 Run 身份，不重复创建。
- 单一 application 编排事务：`createSessionInTx` / `enqueueInTx` 共享 ServerStoreTx，禁止调用原有各开事务的 createSession/enqueue 包装器；capability preparation 接收未提交的内存 Session/Workspace/资产，不能要求先提交 Session。全部持久写成功后统一通知 Worker，无网络/文件 I/O 进入事务。正式外键/attempt/活跃 Run 唯一索引及端口定义见重构方案 P4。
- 现有 `api.send()` 是后续 Composer 消息链路，不是 launch 幂等入口；Run 由初始 enqueue 的 commandId/messageId 关联，turn.started 再绑定 turnId。后续排队消息属于 Session，不自动算入此 Run。

### 7.2 运行视图（复用会话时间线）

```text
┌──────────────────────────────────────────────┐
│ Run #2 · pi / gpt-5 · workspace-1 · ●running │
│ [查看任务] [停止]                快照不可变 ⚠ │
├──────────────────────────────────────────────┤
│ （现有 Session Timeline：消息/工具/通知）        │
│ Journal projector 原样复用                     │
├──────────────────────────────────────────────┤
│ [输入框：运行中发送 → 排队提示（Turn Queue）]    │
└──────────────────────────────────────────────┘
```

- Timeline、Composer、freshness 提示保持交互，迁到 `features/sessions`；切会话 attempt 重置与 receipt controller 清理由 P1 独立缺陷修复提交补齐，不把旧缺陷“原样复用”。
- accepted 仅为 Worker 持久受理，不表示开始/完成。`task_runs.command_id` 关联初始 enqueue 的 `commands.id`；连续 Journal 以 commandId/messageId/turnId 关联幂等投影：turn.started→running，turn.finished(complete)→succeeded，turn.finished(error)→failed；线协议现有 outcome completed/failed 映射 complete/error，不改 wire。初始命令明确 rejected 记 failed 并处理依赖入队，不能无限 pending。
- 停止先持久记 cancelling：排队用 `session.cancel-queued(submissionCommandId)`，已开始用 `turn.stop(turnId)`，启动竞态补发目标 turn.stop。现有停止命令 accepted 仍只是受理，须等连续 message.cancelled 或目标 turn.finished 才 cancelled；只有明确“已停止”的完成回执才可作停止确认。rejected 显示原因并核对/重试，不伪报已取消。turn.stop 只停当前 turn，不清空其他排队消息；取消先提交时目标 finish 归 cancelled，终态不被迟到事件回退。
- Run 结束摘要写回；任务状态**不自动流转**，仅给“建议进入审查”操作。Run 状态与活动投影在 Server Journal 连续缓存事务中推进游标，乱序补传、重复回执不重复终结/记活动。
- Artifact 扩展口：Run 结果第一版只有 Journal 引用；`RunArtifact` 类型预留（commit/PR/文件摘要，未来由 Worker 上报）。

## 8. 交互状态模型（三条铁律）

1. **URL 拥有选择，Query 拥有服务器状态，Journal 模块拥有会话执行**。P1 先登记下方所有权再搬迁，P3 才移交 URL；echo、提交 controller、Session SSE/补页协调归 useSessionExecution，Journal 不复制进 Query。
2. **乐观更新只表达意图**：失败必须回滚并说明；status/assignee 才做 CAS。消息重试沿用 commandId/messageId，launch 重试则按 task_id+内容指纹匹配原 Run，不能拿 commandId 去重冒充 Session/Run 创建幂等。
3. **新鲜度分层显示**：浏览器离线 / Server 连接 / Worker 在线 / Journal 同步状态，四层各自独立呈现，绝不合并成一个"在线"灯（沿用现有 freshnessLabels 与 connectionState 设计）。

### 8.1 状态与连接作用域（P1 拆分前确认）

详细逐项矩阵及回归条件以重构方案 P1 为同一实施清单：

| 状态/副作用 | 归属与迁移去向 | 重置与清理 |
|---|---|---|
| config/generation、在线监听、连接错误 | features/connection → app 连接边界 | 切连接递增代数、移除监听/abort |
| project/session 选中、workspace 推导 | features/sessions/navigation → P3 routes | 项目切换清旧选择，直链不自动首选，校验资源归属 |
| 搜索、折叠、抽屉/弹窗、创建预选与回调 | sessions/navigation + 各资源 feature → app 组合 | 切项目/连接关弹窗；移除快捷键；P2 invalidate、P3 导航 |
| workers/projects 10s 轮询 | infrastructure/projects → P2 queries | 切连接 abort/clearInterval；删除组件定时器 |
| workspaces/sessions 5s 轮询 | infrastructure/sessions → P2 queries | 切项目/连接 abort/clearInterval，拒绝迟到结果 |
| 按 Session drafts | sessions 连接级容器，路由外存活 | 切会话/离开路由保留，切连接清空 |
| echo 去重、canSend、pending/error/receipt、attempt/busy ref | sessions 执行 controller → hook 包装 | 切会话清 attempt/busy/echo；messageId 确认去重；旧 finally 不解锁新提交 |
| receipt 轮询 controller/send 请求/等待 timer | sessions 执行 controller | 切会话/连接/离路由 abort 全部 controller、clearTimeout、代数防迟到更新 |
| Session SSE、cursor、dirty/syncing、5s 兜底 | sessions Journal 私有链路 | 切会话/连接/离路由 closeStream+abort+clearInterval |
| 滚动 refs/动画帧 | sessions/timeline | 切会话重置；卸载 cancelAnimationFrame |
| P6 项目资源 SSE | projects 公开订阅接口 → routes 消费 | 切项目/连接关闭；重连核对 Query，5s 轮询兜底 |

P2 **选择保留连接代数 remount（`key={generation}`）**，app 边界内每代新建 QueryClient；不采用跨连接共享 client 的 clear()+重连 invalidate 方案。切服务器/团队/身份时先 cancelQueries（queryFn 消费 signal）、关闭 SSE/执行 controller，再清理释放旧 client，清空执行状态；新代数首次加载，同代数网络重连才 invalidate。keys 在代数内可为 `['workers']` 等，不含原始 token；测试相同 ID 跨服务器/身份不可串缓存。

## 9. 模块架构映射

```text
apps/web/src/
├── app/                     # App Shell、路由、QueryClient、Providers
├── routes/                  # 路由组件（薄壳，只做参数校验与组合）
├── features/
│   ├── connection/          # 连接作用域（现 connection-storage + ConnectionDialog）
│   ├── projects/            # 项目查询/表单（现 CreateDialog 的 project 分支）
│   ├── tasks/               # ★ 新增：api/queries/workflow/task-board/task-detail/task-links
│   ├── execution/           # ★ 新增：launch-task/run-queries/run-inspector
│   ├── sessions/            # 现有会话屏迁入：use-session-execution/timeline/composer
│   ├── infrastructure/      # 现有 cluster-page、worker 注册、workspaces
│   └── capabilities/        # Agent/模型目录查询 + runtime-picker（create-dialog 级联逻辑抽出）
├── shared/api/              # http-client、errors（现 api/client.ts 拆分）
└── shared/ui/               # 现有 Radix 封装组件
```

依赖方向：`routes → features 公开接口 → feature 内部逻辑 → shared`；features 之间不互相 import 内部文件；共享 DTO 放 `packages/web-contract`（新增 `task-view.ts`、`execution-view.ts`）。

一致性核对：与重构方案 §2 的 app/routes、connection/projects/tasks/execution/sessions/infrastructure/capabilities 七模块、shared/api（http-client/errors）、shared/ui 逐项一致，无须另设目录。`task-workspace-create` 放 tasks，通过 infrastructure 工作区 API 与 capabilities runtime-picker 的公开接口组合；会话表单放 sessions。Server 唯一 launch 入口与存储端口/正式 DDL 以重构方案 P4 为准。

## 10. 实施顺序（每步可独立验收）

1. **记录领域决策**（✅ 已完成：CONTEXT.md 增补 Task/Workflow/Link/Assignment/Run/Task Workspace 六术语）。
2. **P0 行为回归基线**：先保留现有六组覆盖；node:test + tsx 不变，无 RTL/jsdom/happy-dom。P1 才迁移 source-contract 到 features 并补注入式纯函数/controller 测试，hook 仅作委托包装，不直接调用 React Hook、不称 DOM 渲染测试；P3 才加路由测试，打破阶段循环。逐项保留表见重构方案 P0（标签、可编辑、E2E 安全、资源层级、创建预选、api/proxy import/导出、连接与注册）。
3. **会话屏原样迁出 App.tsx** → `features/sessions/`；create-dialog 拆为 project/workspace/session 三个表单共享 runtime-picker。不改产品行为。
4. **连接作用域 + 单一 Query 缓存**：worker/project/workspace/session 载入迁入共享 queries，删掉 Workbench/ClusterPage 双份轮询定时器。
5. **引入路由与 App Shell**：project/session/workspace 选择 URL 化；验证刷新、前进后退、未知 ID、跨项目 URL。
6. **P4 任务契约 + P5 看板/详情**：Server 新表与旧 records 并存，权威数据与 Run/Journal 投影分开；完整主外键、索引、attempt 唯一性及一活跃 Run 约束、tx 存储端口见重构方案 P4。CAS 仅 status/assignee。前端按唯一详情路径实现 board/list/detail，Workspace 详情 P3、项目概览 P7。
7. **任务 → 工作区创建流**：级联选择器 + provisioning 进度 + ready 后启动运行。
8. **Run 启动与跟踪**：幂等 launch 端点 + TaskRun 记录；运行视图复用会话时间线；"建议进入审查"回写任务。
9. **活动投影与优化**：任务/项目活动流（独立游标，不混排 Journal）；性能优化按实测再做。

**M1 末尾加 web-contract 契约冻结检查点**：冻结 DTO/LaunchRequest/错误与资源归属语义、CAS、事务原语、Journal Run 投影和 P6 项目通知格式，契约 fixture/兼容测试通过并双方确认后才允许 M2/M3 条件并行。M2 拥有 Web，M3 拥有 Server/domain，web-contract 由单一负责人串行合并、只做兼容增量；P1 不删旧导出，P3 任务占位用 fixture，P2 不依赖未上线通知；契约变化须重开冻结门。不是“互不依赖”，规模区间与新增事务/取消/测试工作见重构方案 §6。

视觉/工程阶段严格对齐：V0→P0–P1 并行；V1→P3；V2→P4；V3→P5；V4→P7 后。

每步验收：前端 test/typecheck + Server 逻辑测试 + 浏览器人工回归。P3 导航/直链、P5 真实拖拽与双标签冲突、P6 隔离在线 Worker/ready Workspace 闭环目前明确为**人工验收，非自动 CI 门禁**；E2E 仍是 scripts 独立脚本，不能称现成自动栈。脚本转门禁前必须固定外部 Playwright/浏览器版本与安装执行命令、隔离 Server 数据库/身份/Worker/可执行 Agent，并记录清理步骤，详见重构方案 §4。

最终链路：`项目 → 任务 → 指派 → 运行 → 排队消息 → 工具时间线 → 审查 → 完成`，外加断线重连、重复启动、权限丢失、运行中改指派、取消竞态。回滚区分代码 tag/revert、停写一致性数据库备份恢复、Worker/文件/git 外部副作用对账补偿；迁移仅向前，必须验证旧代码打开 v2 兼容及恢复演练，git tag 不是业务数据回滚。

## 11. 明确不做（当前阶段）

- wemux 式 worktree/PR 交付/多渠道聊天/群聊 mention/评论协作/反应——评论作为任务详情的独立扩展口后置。
- 双向 issue 同步、外部状态轮询。
- 可配置工作流引擎、自定义列（接口留好，不实现 UI）。
- 多看板视图（日历/甘特）——视图注册表留口。
- TanStack Start、SSR、i18n、桌面/移动端壳。
- 浏览器端编排：任务启动的持久编排归 Server，浏览器关闭不终止 Run。
