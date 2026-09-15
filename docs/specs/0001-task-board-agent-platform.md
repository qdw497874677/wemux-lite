---
title: 任务看板与 Agent 协作平台改造
spec-id: 0001
status: published
labels: [ready-for-agent]
date: 2026-02-24
references:
  - docs/design/frontend-interaction-architecture.md
  - docs/design/refactor-plan.md
  - CONTEXT.md（领域术语表）
---

# 任务看板与 Agent 协作平台改造 — Spec

## 修订记录

- **v1.1 · 2026-01-06**：按子代理审查修订全部 2 项 blocker、8 项 major、3 项 minor，并落实跨文档统一裁定；无跳过项。本条为 SPEC 修订版本，不代表下文产品 v1.1 能力已纳入首版。

## Problem Statement（问题陈述）

当前平台（Wemux Lite）只能以"项目 → 工作区 → 会话"的树形结构直接发起对话：用户要管理 Agent 的工作，必须在脑子里自己维护"要做什么、做到哪一步、结果如何"。缺少一个工作单元层面的管理流程——无法以任务为单位组织工作、无法追踪任务与外部跟踪对象（如 Git issue）的关系、无法把"任务"与"执行现场（Session）"清晰分开，也无法从任务一键分配 Agent 运行时并跟踪执行进度。同时前端为单屏应用（App.tsx 承载全部导航、会话执行与输入），无法承载多页面工作流；后端 server-service 混杂所有职责，缺少任务域的持久化与状态机。

## Solution（解决方案）

把平台升级为以 Task 为主工作流的 Agent 协作平台：

- **项目内新增任务看板**：Task Workflow 七状态映射到六列（固定顺序 backlog / todo / in_progress / in_review / done / blocked）；cancelled 不占列，通过列表状态筛选访问，支持拖拽流转（乐观更新 + 服务器版本校验 + 失败回滚），同时保留"卡片状态菜单"作为触屏与无障碍等价操作；看板只是视图，通过视图模式注册表支持列表视图并预留日历/时间线等扩展。
- **任务详情面板**：概览（标题/描述/验收标准/优先级/指派）、关联（外部跟踪对象）、工作区（任务绑定的工作区与创建入口）、运行（执行尝试列表与启动入口）、活动（系统事件时间线）五个页签。
- **Task Link 外部关联**：粘贴 GitHub issue/PR URL 即解析保存，卡片与详情显示标记并可跳转；第一版只读展示，同步能力留作按类型扩展的适配器接口。
- **任务 → 工作区创建**：任务详情内单屏表单（名称预填任务标题 → Worker → Git URL（可含 branch）或空白工作区 → Agent → 模型，级联过滤可用性），走标准 Workspace Provisioning，实时显示 pending → provisioning → ready/failed。
- **Agent Assignment 与 Agent Run**：任务上的指派（工作区 + Worker + Agent + 模型）可变且只影响后续运行；每次启动运行固化不可变快照并绑定一个 Session，一个任务同时至多一个活跃 Run；运行视图复用现有会话时间线；Run 完成仅"建议进入审查"，任务完成永远由人决策。
- **前端架构升级**：单屏应用重构为 App Shell + 路由（URL 拥有选择状态）+ features 模块 + 统一服务器状态缓存；仅引入 TanStack Router 与 TanStack Query 两个新依赖，后端零新依赖，wire-protocol 与 Worker 完全不动（任务执行复用现有命令管线与幂等 commandId）。

## User Stories（用户故事）

1. 作为平台用户，我想创建项目并在项目间切换，以便把不同产品或业务目标的工作分开组织。
2. 作为平台用户，我想在项目内看到"概览 / 任务 / 会话 / 工作区 / 设置"的固定导航，以便始终知道自己在哪、能去哪。
3. 作为平台用户，我想通过 URL 直接打开某个项目、任务或会话，以便把链接分享给他人或存成书签，刷新与前进后退都正确恢复现场。
4. 作为平台用户，我想访问不存在的资源 ID 时得到明确报错页，而不是被静默跳到别的资源，以便确认链接是否失效。
5. 作为平台用户，我想在项目内新建任务（标题、描述、验收标准、优先级），以便把工作以可管理的单元记录下来。
6. 作为平台用户，我想编辑任务的标题、描述与验收标准，以便任务信息随理解深化而更新。
7. 作为平台用户，我想在看板上按 backlog / todo / 进行中 / 审查中 / 已完成 / 阻塞 六列浏览任务，以便一眼掌握项目整体状态。
8. 作为平台用户，我想在看板卡片上看到运行状态徽章、指派摘要（Agent/模型）与外部关联标记，以便不点开卡片也能判断任务动向。
9. 作为平台用户，我想把任务卡片拖到另一列来流转状态，以便用最直接的手势推进工作流。
10. 作为平台用户，我想在拖拽失败时看到卡片回到原列并获得原因提示，以便知道流转被拒绝（如版本冲突、非法流转）。
11. 作为平台用户，我想通过卡片上的状态菜单完成同样的流转，以便在触屏设备或无法拖拽时操作。
12. 作为平台用户，我想在看板与列表两种视图间切换并让 URL 记住我的选择，以便按当前任务量选择合适的浏览方式。
13. 作为平台用户，我想按状态、指派、关键词筛选与搜索任务，以便在任务变多后快速定位。
14. 作为平台用户，我想在任务详情的概览页签修改状态与优先级，以便精细管理而不只靠拖拽。
15. 作为平台用户，我想给任务粘贴一个 GitHub issue 或 PR 的 URL 并自动识别类型，以便把任务和外部跟踪对象关联起来。
16. 作为平台用户，我想在任务详情看到关联列表（图标、外部编号、标题、跳转），并可移除关联，以便维护干净的引用。
17. 作为平台用户，我想在看板卡片上看到任务有关联的标记，以便快速识别哪些任务跟踪着外部对象。
18. 作为平台用户，我想在任务详情内一键"为任务创建工作区"，以便为执行准备隔离环境而不用离开任务上下文。
19. 作为平台用户，我想创建任务工作区时表单按 Worker → Agent → 模型级联过滤（只显示在线 Worker、available 状态的 Agent、该 Agent 支持的模型），以便不可能构造出无效组合。
20. 作为平台用户，我想只选择 worker capabilities 已上报的模型，以便指派能够实际执行；“自定义模型”延后至产品 v1.1，需 worker capabilities 更新 API，不在 v1 验收范围。
21. 作为平台用户，我想看到"仅检测、无执行适配器"的 Agent 置灰并标注，以便明白它们当前不能被指派执行。
22. 作为平台用户，我想在任务详情实时看到工作区 provisioning 进度（pending → provisioning → ready/failed），以便知道何时可以启动运行。
23. 作为平台用户，我想在 provisioning 失败时看到原因并能重试，以便从瞬时故障中恢复。
24. 作为平台用户，我想给任务设置或修改指派（工作区 + Worker + Agent + 模型），以便声明"接下来由谁、在哪、用什么执行"。
25. 作为平台用户，我想在修改指派时得到"只影响后续运行"的提示，以便理解已存在的会话不会被迁移。
26. 作为平台用户，我想从任务详情"启动运行"，表单预填当前指派并让我预览/编辑初始 Prompt（模板含标题、描述、验收标准），以便一次点击把任务交给 Agent。
27. 作为平台用户，我想显式选择"继续上次会话"或"新开尝试"来启动运行，以便控制上下文延续还是干净重来；reuse 必须与目标 Session binding 完全一致，否则提示改用 new。
28. 作为平台用户，我想在已有活跃运行时被禁止再次启动并提供"查看运行"入口，以便理解一个任务同时只有一个活跃运行的约束。
29. 作为平台用户，我想在运行视图顶部看到不可变快照（Worker/工作区/Agent/模型）与运行状态，以便明确这次执行的确切配置。
30. 作为平台用户，我想在运行视图复用会话时间线查看消息、工具调用与通知，以便用统一的对话界面监督任务执行。
31. 作为平台用户，我想在运行中继续向会话发送消息并理解它们会排队为下一个回合；这些是独立 Session 消息，不属于当前 Run，不延长其生命周期；若需按任务追踪下一次执行，应待当前 Run 结束且 Session 空闲后再 launch。
32. 作为平台用户，我想取消当前 Run 所属的执行，以便及时止损；界面区分“取消 Run”和“停止当前 Turn”，并明确其他独立排队消息不会因此取消，可逐条取消。
33. 作为平台用户，我想在运行结束后看到结果摘要（完成/失败/取消 + 用时），以便快速判断结果。
34. 作为平台用户，我想在运行完成后看到"建议进入审查"的一键流转而不是任务被自动标记完成，以便保留人做管理决策的权力。
35. 作为平台用户，我想人工把审查中的任务流转到 done 或退回进行中，以便表达最终判断；也能在无活跃 Run 时取消任务，并从列表 cancelled 筛选进入详情、恢复到取消前状态。
36. 作为平台用户，我想在任务活动页签看到状态流转、指派变更、运行开始/结束、关联变更的系统事件时间线，以便审计任务全历史。
37. 作为平台用户，我想状态与指派在多标签页编辑时由 CAS 保护，冲突后保留本地意图并提示重新确认；标题、描述等非冲突字段按提交字段最后写入生效，不承诺版本冲突保护。
38. 作为平台用户，我想重复点击"启动运行"不会产生重复执行（幂等），以便网络抖动下可以安全重试。
39. 作为平台用户，我想在浏览器与服务器断连、Worker 掉线、日志未同步时分别看到不同的连接状态提示，以便准确判断问题在哪一层。
40. 作为平台用户，我想断线重连后页面自动恢复最新任务、运行与会话数据而无需手动刷新，以便在差网络环境继续工作。
41. 作为平台用户，我想查看项目下所有工作区及其状态，以便管理执行环境。
42. 作为平台用户，我想在运行时页查看 Worker × Agent × 模型清单与在线状态，以便选择指派目标时心里有数。
43. 作为平台用户，我想在集群页管理 Worker 注册与注册令牌，以便控制哪些执行节点可以接入。
44. 作为平台用户，我想在空项目里被引导走"建任务 → 建工作区 → 启动运行"的路径，以便零配置快速跑通第一次。
45. 作为平台用户，我想看板在 100+ 任务时保持流畅滚动与拖拽，以便规模增长后仍可日常使用。
46. 作为管理员，我想用 bootstrap 令牌初始化平台并注册 Worker，以便安全地开通这套系统。
47. 作为管理员，我想所有任务域端点与现有资源端点一样走统一鉴权，以便不引入裸奔接口。
48. 作为平台用户，我想使用新增兼容输入格式 `/?project=&workspace=&session=` 时自动重定向到规范路由；这不是现有版本已支持的存量深链承诺。
49. 作为平台用户，我想窄屏（移动端）上任务详情与导航以抽屉/整页呈现，以便在手机上也能查看任务。
50. 作为平台用户，我想看板与列表的加载与流转操作本地即时响应（乐观更新），以便操作手感不受网络延迟拖累。

## Implementation Decisions（实现决策）

**总体策略**
- 三段式推进：行为保持迁移（测试基线升级 → 前端模块化拆分 → 数据层统一 → 路由化）→ 能力扩展（服务端任务域 → 看板与详情 → 工作区创建与运行闭环）→ 收尾（活动流、项目概览）。每阶段独立验收、打 git tag、可回滚。
- 前端仅新增两个依赖：TanStack Router 与 TanStack Query。后端零新依赖；wire-protocol 与 Worker 不做任何改动，任务执行完全复用现有命令投递管线（幂等 commandId）与 Journal 链路；回执仅确认接受/拒绝，不代表执行完成。v1 只能选 worker capabilities 已上报的模型；“自定义模型”改为 v1.1（需 worker capabilities 更新 API），不得再声称 worker 零改动支持自定义模型。

**领域模型（server-domain 新增，术语以 CONTEXT.md 为准）**
- Task：项目内可管理工作单元，承载标题、描述、验收标准、优先级、工作流状态、版本号（乐观锁）与可选指派；origin 仅 'manual'，预留 'import:*' 与 'agent-proposal' 扩展。
- Task Workflow 状态机（来自设计文档的类型形态）：
  `TaskStatus = 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'blocked' | 'done' | 'cancelled'`，以纯函数 `transition(task, to)` 校验合法流转；done/cancelled 只能由显式人工操作触发。

**Task 状态转移矩阵与乐观锁**

状态转移矩阵 todo→in_progress→in_review→done、任一→blocked、blocked→回原状态；CAS 仅覆盖 status 与 assignee；last_activity_at 等非冲突字段不参与版本；非法转移返回 409。

| 当前状态 | 允许目标 / 条件 |
|---|---|
| backlog | todo；blocked；人工 cancelled |
| todo | in_progress；blocked；人工 cancelled |
| in_progress | in_review；blocked；人工 cancelled |
| in_review | done；退回 in_progress；blocked；人工 cancelled |
| done | 人工重开 in_progress；blocked；人工 cancelled |
| cancelled | 人工恢复到取消前状态；blocked |
| blocked | 回到进入 blocked 前的状态；人工 cancelled |

- “任一→blocked”包括 done/cancelled，已 blocked 的重复请求不改写恢复目标；分别持久化 blocked/cancelled 的来源状态，恢复不猜测。未列出的跳转一律 409；同状态请求通过版本校验后无操作、不递增版本。
- pending/running/cancelling 均为活跃 Run；存在活跃 Run 时禁止任务进入 done/cancelled（409），先取消 Run 并等终态；人工 blocked 不停止执行，Run 成功只给审查建议、不自动流转。
- `Task.version` 初始为 1，仅 status 或 assignee 实际变化时递增；assignee 对应本 SPEC 的 Agent Assignment 整体（含工作区、Worker、Agent、模型），不另造用户指派字段。transition、指派 PUT/DELETE 及任何含这两个字段的 PATCH 必须带 version；缺失返回 400，不匹配返回 409（含当前 version 与权威值），以同事务 CAS 更新并写活动。
- 普通 PATCH 仅更新提交的标题/描述/验收标准/优先级等字段，不做整行覆盖、不递增 version；Run 投影、链接、绑定及 last_activity_at 更新也不参与该版本。混合 PATCH 若含 CAS 字段则整次原子成功或失败。冲突时回滚乐观缓存、重取权威值，保留本地编辑草稿/流转意图，经用户确认以新 version 重试，不自动覆盖。
- Agent Assignment：Task 上可变执行意图 `{ workspaceId, workerId, agentKey, modelId }`，修改不迁移已存在 Session；当前执行指派不等于 Task–Workspace 绑定关系。
- Task Link：`{ type: 'github-issue' | 'github-pr', externalId, url, title?, syncState: 'none' }`，第一版只读展示。
- Agent Run：每次执行尝试持有不可变快照 `{ workerId, workspaceId, agentKey, modelId }` + 绑定 sessionId + 独立执行状态（pending/running/cancelling/succeeded/failed/cancelled）+ 结果摘要；attempt 在新 Run 创建时递增，幂等重试不递增；“一个 Task 同时至多一个活跃 Run”在服务层与数据库约束共同强制。

**Run 状态 × 驱动事件**

task_runs.command_id 关联 commands.id；执行结果由 journal 事件驱动：turn.started → running；turn.finished(stop_reason=complete) → succeeded；turn.finished(stop_reason=error) → failed；用户 cancel → cancelling，收到停止回执或 turn.finished 后 → cancelled。turn.stop 只停当前 turn，不自动结束 Run。

| Run 当前状态 | 驱动事件 | 目标状态 / 处理 |
|---|---|---|
| 无 | launch 单事务提交 | pending |
| pending | 创建/入队命令 accepted | 保持 pending，仅表示 Worker 持久接受 |
| pending | 关联的 turn.started | running，记录 turnId/startedAt |
| pending/running | 关联的 turn.finished(stop_reason=complete) | succeeded，固化摘要/endedAt |
| pending/running | 关联的 turn.finished(stop_reason=error) | failed，固化失败原因/endedAt |
| pending/running | 用户 cancel | cancelling，持久化取消意图和停止/取消排队命令 |
| cancelling | 对应停止/取消排队命令的 accepted 回执，或关联 turn.finished | cancelled；回执确认后仍保留执行收敛跟踪 |
| pending | 创建/入队命令最终 rejected | failed（投递失败，不伪装成 turn 完成） |
| pending/running/cancelling | Worker 掉线、回执未到、日志滞后 | 保持状态，展示分层新鲜度并恢复投递/补传 |
| 终态 | 重复或迟到事件 | 不回退/重开；只补充执行收敛与诊断信息 |

- 表中的 `stop_reason` 是 application 投影归一化术语，不新增 wire 字段：现有 `turn.finished.outcome=completed/failed` 分别映射 complete/error；`outcome=cancelled` 在已有 Run 取消意图时收敛 cancelled，否则作为执行中断映射 error（failed）。单独发出 turn.stop 不直接改变 Run 状态。
- v1 一个 Run 只拥有 launch 的初始 `session.enqueue` 命令及其单个 Turn。`task_runs.command_id` 唯一关联此命令；持久化 session 创建命令 ID、messageId、turnId 与取消命令 ID。通过 `message.queued(commandId,messageId)` → `turn.started(messageId,turnId)` → `turn.finished(turnId)` 归属，禁止把同 Session 的任意完成事件当作本 Run 完成。独立追加消息仍在 Session 时间线展示并标注“不属于本 Run”，不等待整个队列清空才完成 Run。
- 取消范围仅为该 Run 的初始命令：未执行时发送现有 `session.cancel-queued(submissionCommandId)`，已开始则发送 `turn.stop(turnId)`；排队取消与启动竞态由后续 journal 识别并补发 stop。其他独立 Session 消息不清空。rejected 不是停止成功，保留 cancelling 并提示重试；accepted 不是执行已结束，在日志确认所属消息取消或 Turn 结束前，Session 仍不可 reuse，也不能宣称 Worker 已静止。
- Journal 按 `(sessionId, seq)` 去重、有序补传，Run 投影与已处理游标同事务提交；重启从持久映射与游标继续，缺少前序事件先补齐，不按当前 Assignment 推断归属。终态与取消竞态由同事务 CAS 串行决议：cancel 先提交则完成事件收敛 cancelled，完成先提交则后续 cancel 返回原终态。

**存储与 API**
- SQLite 迁移 v2 新增 tasks（含 CAS 版本、JSON 数据与内嵌指派）、task_links、task_runs、task_activity（`(task_id, seq)` 主键）、task_workspaces（`(task_id, workspace_id)` 唯一关系，workspace_id 另设唯一约束）五张表；迁移幂等可重放。task_runs 保存命令关联、请求指纹与结果映射，对 `(task_id, fingerprint)` 唯一，并对每任务活跃状态建立唯一约束。
- HTTP 端点（沿用既有 `/api` 前缀与鉴权）：项目任务 GET/POST、任务 GET/PATCH（创建/查询/更新，v1 不支持删除）、`POST /tasks/:id/transition`、指派 PUT/DELETE、links 增删、`GET/POST /tasks/:id/workspaces` 与绑定 `PUT/DELETE /tasks/:id/workspaces/:workspaceId`、`POST /tasks/:id/runs`（`mode: reuse/new + prompt + reuseSessionId?`）、`POST /runs/:id/cancel`、`GET /tasks/:id/activity?after=seq`。涉及 status/assignee 的写操作按上述 CAS 契约执行。路由从 if 链改为路由表分发，不引入 Web 框架。
- launch 事务：单一 application 入口（ServerService.launchTaskRun），内部通过 store 的单事务执行完成 task_runs 行创建 + Session 创建 + Run 快照固化 + 消息入队；事务边界在 application 层（一个入口、一个事务），而非在各步骤各自开事务。reuse 分支校验并绑定既有 Session，不创建新行。明确禁止嵌套 BEGIN（现有 createSession 与 enqueue 各自开事务并 notify，SQLite 串行 store 下嵌套会死锁）。拆出接受 `ServerStoreTx` 的事务内操作，不直接调用现有公共事务方法；命令和活动提交成功后才 notify，回滚不通知。
- launchTaskRun 以 task_id+内容指纹为幂等 key，重复提交返回已有 Run；active-run 冲突检查在幂等命中之后执行。LaunchRequest 同时携带确认过的 assignment 快照；指纹按固定字段序列规范化 mode、完整 prompt、显式 reuseSessionId（new 为 null）和确认的 assignment，以 SHA-256 计算并持久化请求内容、Run/Session/command ID 映射。同一事务内先鉴权及校验归属/请求格式，再查幂等结果；命中即返回已有 Run（终态也一样），不受当前指派变化、Worker 离线或活跃 Run 影响。未命中才校验确认指派与当前指派一致、工作区 ready、Worker 在线、capabilities、无活跃 Run；不满足返回明确冲突，未提交不留下 Session/Run/命令。相同内容不产生新尝试，要再次执行必须修改提交内容；网络重试保留原请求。
- reuse 仅允许目标 Session 属于该 Task 的历史 Run、同项目、与当前 Assignment 的 workspaceId/workerId/agentKey/modelId 完全一致，且未删除、无运行中 Turn、无排队消息、无未收敛取消、运行状态已同步并可接受消息；否则 409 并提示 new，不悄悄复用或改写 binding。new/reuse 均从实际 Session binding 固化快照。
- SQLite 原子性仅覆盖 Server 持久化，不保证 Worker 已建好 Session 或执行消息；创建命令先确认 accepted 再投递 enqueue（异步投递协调，不持有 SQLite 事务等待 Worker）。提交后掉线按原 commandId 恢复投递；最终 rejected 投影为 failed，记录错误与补偿状态，保留历史 Session/Run，不自动另建重复执行；用户明确发起不同内容的新尝试。
- Task–Workspace 绑定以 task_workspaces 为事实源，与当前 assignment 分离；workspace.boundTaskId 仅为可重建冗余，v1 一个 Workspace 至多绑定一个 Task，Task 可绑定多个 Workspace。A→B 改指派时保留 A 绑定，绑定 B 与更新 assignment 在单事务内；删除 assignment 不删绑定。绑定必须校验 Task 与 Workspace 同项目、Worker 匹配且未绑定其他任务，冲突返回 409。显式解绑不得解除活跃 Run 使用的 Workspace；解除当前指派的 Workspace 必须同时清除 assignment、带 Task.version 并原子 CAS。解绑只移除关系、不删除 Workspace、Session、Run 快照与审计历史。
- “创建任务工作区”同一事务创建 Workspace/内嵌 Repository 记录、绑定、provision 命令及活动（若同时设指派则做 CAS），提交后通知；绑定失败整体回滚，Worker provisioning 失败则保留绑定并提供幂等重试。冗余修复从 task_workspaces 重建 boundTaskId，绝不从 assignment 推断历史。v1 不提供 Task DELETE，无删任务双写清理；归档需求先用 cancelled，历史链接/活动保留。
- v1 不做仓库 API 拉取；workspace git URL 为内嵌字符串（可含 branch），worker 本地 clone；删除“调用 GitHub API 下拉”类表述。创建表单沿用 Git URL 或空白工作区输入，不要求 Repository 列表/创建 API 或 repositoryId 下拉；空项目可直接输入 URL 或选择空白工作区完成首次运行。
- web-contract 包新增任务视图 DTO（TaskSummary/TaskDetail/BoardColumn + 视图模式枚举）与执行视图 DTO（RunSummary/LaunchRequest）。

**前端架构**
- App Shell（全局栏：连接状态/刷新/设置；可折叠全局导航；项目内导航；可选右侧检查器）+ 薄壳路由组件 + features 模块（connection / projects / tasks / execution / sessions / infrastructure / capabilities），依赖方向单向：routes → features 公开接口 → shared。
- URL 拥有实体选择（路径）与展示状态（查询参数：view/tab/filter）；`/?project=&workspace=&session=` 是新增兼容输入格式，不宣称当前 App 已支持。仅根路径转换，校验存在性与归属后以 replace 导航至规范路径；规范路径实体参数优先，冲突查询参数报错而非静默选择。缺失上级可由授权资源推导，跨项目/工作区关系矛盾返回明确错误页，未知 ID/无权限不跳到首个资源。
- TanStack Query 统一服务器状态缓存：显式 staleTime/refetchInterval，SSE 事件到达做精确 key 失效；删除现有双份轮询定时器。会话 Journal 保持私有执行链路（useSessionExecution）不进 Query 缓存，避免双源。
- SSE：P6 增加全局/项目级频道 /api/projects/:id/events，任务看板资源失效走该频道；per-session journal SSE 不变。全局连接管理器按当前订阅项目管理连接，此处不另造全项目端点。统一 bootstrap 鉴权及项目归属校验，切换连接作用域时关闭旧连接并隔离缓存。
- 项目事件契约为 `{id, projectId, type, taskId?, workspaceId?, runId?}`，type 覆盖任务创建/编辑/流转、指派/绑定/链接变化、Run 变化、provisioning；只在持久化提交后发布。按实体精确失效 `['project', id, 'tasks', filters]` 的项目列表前缀、`['task', taskId]`、`['task', taskId, 'runs']`、`['project', id, 'workspaces']`、`['project', id, 'overview']` 等受影响 key，活动变化触发 `['task', taskId, 'activity']` 按 after=seq 补取。频道仅通知失效，不承载 Journal 或充当活动事实源。
- 项目 SSE 为失效通知而非可靠历史日志：重连/服务重启/事件缺口时无条件重新校验当前项目已订阅查询，并从持久 task_activity 的最后 seq 补取直到追平，按 `(taskId,seq)` 去重；项目事件 id 不代替活动 seq。P6 前及断线期间用 Query 显式 refetchInterval 兜底，per-session Journal 仍以自身游标补传。
- 看板组件只依赖 TaskWorkflow + Task 摘要 DTO；视图模式注册表（board/list 内置）与卡片字段插槽是正式扩展点。
- TaskLinkAdapter 接口（parse(url) → 草稿、describe(link) → 展示元数据）+ GitHub issue/PR 两个解析器；同步能力不在第一版接口承诺内。
- 运行视图复用现有会话时间线与 Composer（含排队语义），显示 Run 归属边界、独立 Session 消息标记与取消范围；快照徽章标示不可变。
- create-dialog 的 Worker→Agent→Model 级联抽为共享 hook，任务工作区创建表单与既有创建入口共用同一过滤逻辑（availability === 'available'，v1 仅允许 capabilities 已上报模型，不开放自定义模型输入）。
- 拖拽用原生 HTML5 DnD 不引库；卡片状态菜单为等价操作；乐观更新一律"意图表达 + 服务器权威 + 失败回滚并说明"。

## Testing Decisions（测试决策）

**测试基线**：P0 不引入 DOM 测试环境（无 RTL/jsdom/happy-dom），保持 node:test + tsx；web 行为测试 = features 模块纯函数/hook 测试 + source-contract 测试断言目标从 App.tsx 迁到 features/*（逐条保留映射）；浏览器 E2E 仍是 scripts/ 下独立脚本（需活服务，手动/CI 可选）。优先断言公开行为，但明确保留无法在 Node 下验证的源码契约，不把 source-contract 说成真实渲染测试。

**三条缝（沿用既有执行环境）**：
1. **后端主缝——真实服务器集成**：沿用 server.test.ts 模式，createWemuxServer + `:memory:` SQLite + 真实 HTTP fetch + 伪 Worker WebSocket（Peer 收发 wire 消息）。覆盖完整 Task 转移矩阵、所有 CAS 写入口与非冲突字段不增版本；launch 响应丢失后同内容重试、幂等先于活跃/在线校验、并发唯一性、事务中途失败无残留且不通知、无嵌套事务死锁；reuse 指派/归属/可用状态不匹配；绑定历史/原子回滚/冗余修复；accepted 不代表完成、Journal 状态表全分支、取消与排队启动竞态、独立消息不归属 Run、掉线补传及重启投影幂等；项目 SSE 鉴权/失效/重连补偿；迁移幂等。HTTP、存储、WS 全真，不 mock 服务层。
2. **前端行为缝——features 模块公开接口**：node:test + tsx 测纯函数与 hook 委托的公开状态转换/订阅控制接口，如乐观更新/冲突回滚、TaskLinkAdapter URL 解析、echo/pending 生命周期与重试 commandId 稳定性；不直接在 Node 中调用 React hook，不承诺 hook 真实挂载/DOM 清理。P0 先盘点并锁定既有断言、补现有接口测试；P1 每抽出最小可测接口即新增行为断言并原子迁移对应 source-contract，目标尚未存在时保留原测试，禁止先删安全网。真实 hook 挂载/路由/渲染由浏览器验收。
3. **验收缝——真实浏览器 E2E**：scripts/ 独立脚本是新增扩展工作，不是当前已具备的完整闭环。运行前启动真实 Server/Worker、配置鉴权、固定选择 test Agent（不可随机选可执行 Agent）、创建隔离项目/ready Workspace；缺前置条件明确失败或显式跳过，不报成功。黄金链路增加任务 → 指派 → Run → 独立排队消息 → 工具时间线 → Journal 确认 succeeded → 人工审查 → 完成断言，并覆盖重连、重复提交、改指派后 reuse 拒绝与取消范围。finally 清理本次消息、Session/Workspace 等可清理资源；Task 无 DELETE，使用隔离测试数据库整体销毁，禁止删除共享数据。手动/CI 可选执行，记录执行或跳过及原因，未执行不得声称浏览器验收通过。

**source-contract 逐条保留映射（P0 建清单，P1 随迁移更新）**：

| 现有测试 / 断言 | 迁移后目标与验收 |
|---|---|
| conversation-ux：进度标签“已发送/正在处理/完成” | features/sessions 的公开展示映射与时间线源码，保留三标签断言 |
| conversation-ux：禁止“已受理”及“消息已提交，等待工作节点确认” | features/sessions 时间线/Composer，保留两项否定断言 |
| conversation-ux：pending 时输入框仍可编辑 | features/sessions Composer，保留 Textarea 不因 pending disabled 的断言 |
| conversation-ux：发送按钮受 canSend/pending/空白 draft 约束 | features/sessions Composer，保留完整禁用条件，并测公开提交判定函数 |
| conversation-ux：E2E 不向持久 Session 发送时间戳标记 | 保留对 scripts/e2e-message.mjs 的原断言；此项原本不读 App.tsx，不迁入 features |
| navigation-hierarchy：项目 → Workspace → Session 文案，禁止插入 Worker 层 | features/sessions 导航配置/组件，保留正反断言；P3 路由改造仍保持此领域层级 |
| navigation-hierarchy：按 workspaceId 归组 Session | features/sessions 公开分组函数 + 导航组件契约 |
| navigation-hierarchy：Worker 显示为“执行节点”元数据 | features/sessions 导航展示契约，不把 Worker 变成实体选择层 |
| navigation-hierarchy：从 Workspace 分支创建 Session 携带 workspace.id | features/sessions 导航动作配置/组件契约 |
| navigation-hierarchy：defaultWorkspaceId 默认空串并查找目标 Workspace | features/infrastructure 创建表单/初始化接口，保留两项原断言语义 |
| navigation-hierarchy：预选 defaultWorkspace.workerId 与 defaultWorkspace.id | features/infrastructure 创建表单与 features/capabilities 选择接口，分别保留 Worker/Workspace 初值断言 |

已有 connection-storage/api/proxy/worker-enrollment 四类行为测试继续保留，不错误地全部归类为源码测试；P3 新增路由表、参数校验纯函数测试，不能替代上述原断言。

**先例**：server.test.ts 的 Peer 伪 Worker 与 eventually 轮询、现有浏览器 E2E 脚本、connection-storage/api/proxy/worker-enrollment 四个已是行为测试的模块测试。

**阶段验收**：每阶段跑全部 Node 测试 + typecheck + 手工回归清单；能力阶段提供对应独立 E2E，并按上述可选执行规则记录结果；出问题按阶段 tag 回滚。

## Out of Scope（不做范围）

- worktree / 目录模式选择、独立基线分支选择 UI、PR 交付与代码回写（wemux-slim 的 delivery 体系）；不限制内嵌 Git URL 携带 branch。
- v1 任务删除（以 cancelled 与恢复替代）、仓库 API 拉取/Repository 下拉、自定义模型；自定义模型为产品 v1.1，需 worker capabilities 更新 API。
- 外部跟踪对象的双向同步、状态轮询、导入即建任务（origin: import）。
- 评论、@mention、反应等协作功能（活动流第一版仅系统事件）。
- 可配置工作流引擎、自定义列的 UI（接口留好不实现）。
- 日历、甘特等额外看板视图。
- 多用户 / 团队 / PAT 管理界面（保持单 bootstrap 管理员 MVP；领域模型中的角色概念不删除但不外露）。
- TanStack Start、SSR、i18n、桌面/移动原生壳。
- 浏览器端编排：任务启动的持久编排归 Server，关闭浏览器不终止 Run（这是约束不是待办）。
- 虚拟滚动等性能专项（先实测再决定，不预引入）。
- Agent 自动提案任务（agent-proposal origin 仅预留枚举）。
- Composite Workspace 的实现（仅保留类型扩展口）。

## Further Notes（补充说明）

- 领域术语参照仓库根 CONTEXT.md（Task / Task Workflow / Task Link / Agent Assignment / Agent Run / Task Workspace 已定义并含 Anti-pattern 提示）；本轮跨文档统一裁定优先于旧稿冲突表述，其他文档由同步修订采用同一裁定，本次仅修改此 SPEC。
- 详细交互线框与扩展口清单见 `docs/design/frontend-interaction-architecture.md`；分阶段实施步骤、每阶段验收标准与风险见 `docs/design/refactor-plan.md`。跨文档阶段以本轮统一裁定为准，不沿用旧稿 P4 仅服务端/P5 才看板的时序：M2 前端 P1–P3 与 M3 服务端任务域并行，均完成后进入 P4 看板；P5 Run 时间线，P6 工作区/launch/项目 SSE 完整联调，P7 活动与收尾。M4 交付看板，M5 交付执行闭环与收尾。
- V0（token/组件状态，行为零变化）→ P0–P1 并行；V1（App Shell）→ P3；V2（看板）→ P4；V3（Run 时间线）→ P5；V4（视觉 QA）→ P7 后发布前。
- M1 末尾加“web-contract 契约冻结”检查点，M2/M3 并行期间 web-contract 变更须双端同步。冻结内容至少包含 Task/Assignment/绑定/Run DTO、LaunchRequest 指纹输入、状态与错误枚举、CAS 字段及项目事件契约；检查点须双端确认，后续变更同时更新生产端、消费端及契约测试，不允许单端先行破坏冻结契约。
- 关键领域不变量（交互层必须表达）：Task ≠ Session ≠ Run；任务完成是人的决策；指派可变只影响后续 Run；Run 快照不可变；一任务至多一个活跃 Run。
- 本 spec 发布于仓库内 `docs/specs/`（本地 spec 追踪），frontmatter 的 `labels: [ready-for-agent]` 即分派标记。
