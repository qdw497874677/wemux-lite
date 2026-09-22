# 会话协作画布与血缘模块设计

状态：已确认产品方向，待按切片实施。本文定义会话画布、Fork 血缘、画布/专注连续切换及模块化边界，不表示能力已经交付。

依据：[产品方向](../product-direction.md)、[路线图](../roadmap.md)、[领域术语](../../CONTEXT.md)、[Agent 互操作模块](agent-interchange-module.md)、[Worker 独立 Web 工作台](worker-web-workbench.md)。

## 1. 目标与产品判断

Wemux 的目标是成为运行时无关的 Agent 协作与编排层：Worker 把 Pi、OpenCode、Claude Code 及后续 Agent 适配到统一 Wemux ADK Profile，再通过主动长连接加入受管 Agent Network。团队围绕 Project、Workspace 和持续 Session 使用这些异构能力。

会话画布不是自由白板，也不是静态流程图，而是 **Session 协作网络的可交互投影**：

- 每个节点代表一个真实 Session，可直接查看状态、阅读最近消息和发送消息。
- 节点之间展示明确的 Fork、Delegation、Artifact Reference、Run Attachment 等关系。
- Session 可以从画布形态连续展开为专注对话，再缩回原位置；底层 Session、Journal、草稿和流式执行不切换身份。
- 画布只投影后端领域事实，不成为 Session、权限或血缘关系的数据权威。
- 直接对话仍不要求先建 Task；Task 与 Run 是可选的计划、执行追踪和审查锚点。

## 2. 设计原则

### 2.1 分层和依赖方向

```text
Presentation
  Canvas / Focus / Task Run / Worker local shell
                    │
                    ▼
Application
  fork coordinator / graph query / authorization / orchestration
                    │
                    ▼
Domain
  Session / SessionFork / SessionRelation / Invocation lineage
                    │
                    ▼
Execution
  AgentRunner / Session Journal / Queue / Approval / Cancel
                    │
                    ▼
Adapters
  Pi / OpenCode / Claude Code / future Agent adapters
                    │
                    ▼
Infrastructure
  SQLite / WebSocket transport / HTTP / @xyflow rendering adapter
```

依赖只能朝下；下层不得 import 上层 UI、路由或宿主概念。Server Web 与 Worker Web 通过各自宿主 Adapter 组合同一会话模块，不复制会话状态机。

### 2.2 深模块而不是接口碎片

- 每个 Module 只暴露一个小 Interface，隐藏事务、恢复、排序、缓存、权限过滤和 Provider 差异。
- 测试与调用方走同一 Interface；禁止测试绕过 Interface 直接依赖内部表或内部事件。
- 只有真实存在变化时建立 Seam。Pi/OpenCode、Server/Worker 宿主是已经存在的真实 Seam。
- 第一版只有 React Flow 一种画布实现，不建立通用“画布插件市场”或渲染器注册框架。
- 自动布局未引入前，不提前暴露复杂 `LayoutEngine` 公共接口；当手动布局和 ELK 两种实现同时存在时，再把布局策略提升为内部 Seam。
- 关系类型使用明确领域联合类型，不用任意字符串插件绕过权限、审计和生命周期规则。

### 2.3 高内聚边界

一个能力的规则、错误模式、恢复和测试应集中在同一 Module。禁止以下耦合：

- React Flow node/edge 直接作为 HTTP DTO 或数据库记录。
- UI 根据边的颜色推断关系类型或权限。
- Fork 由前端先创建节点、后端随后“补写”领域事实。
- Agent Adapter 读取 Team/Project Grant，或处理 WebSocket 重连。
- transport frame、ACK、cursor 进入 Session Fork 或 Agent Event 语义。
- Server 和 Worker 各自维护一套 Composer、Journal 或 Session 状态机。

## 3. 领域模型

### 3.1 Session Fork

Fork 是后端持久事实，而不是前端连线。建议领域记录：

```ts
interface SessionFork {
  id: SessionForkId
  sourceSessionId: SessionId
  sourceEventCursor: number
  targetSessionId: SessionId
  createdBy: UserId
  createdAt: string
  contextPolicy: 'through_cursor' | 'summary' | 'explicit_selection'
}
```

不变量：

1. source 与 target 是不同 Session；target 创建后拥有独立 Journal 和队列。
2. `sourceEventCursor` 固定 Fork 时的上下文边界；来源 Session 后续消息不会自动进入目标 Session。
3. 创建目标 Session 时必须显式确定 Workspace Placement、Worker、Agent 和 Model；默认值可以继承，但不得静默迁移或替换不可用能力。
4. Fork 创建、目标 Session 创建、绑定快照和血缘写入处于一个应用事务；失败不得留下无来源目标或悬空边。
5. 权限不会沿 Fork 自动扩大。目标 Session 的有效访问取 Project、目标 Workspace/Worker 与显式 Session 策略交集。
6. 删除或归档来源 Session 不删除目标 Session；关系保留为受权限过滤的历史事实。

### 3.2 Session Relation

第一版关系集合保持有限：

```ts
type SessionRelation =
  | { type: 'fork'; forkId: SessionForkId }
  | { type: 'delegation'; parentInvocationId: InvocationId; childInvocationId: InvocationId }
  | { type: 'artifact_reference'; artifactId: ArtifactId }
  | { type: 'run_attachment'; runId: RunId }
```

`fork` 是 Session 到 Session 的血缘；`delegation` 是 Invocation 执行链，可投影到承载它们的 Session；`artifact_reference` 和 `run_attachment` 是关联关系，不冒充血缘。第一版 UI 可以只交付 Fork，但 DTO 和命名不得把所有边都叫 Fork。

### 3.3 图查询结果

领域实体不直接返回 React Flow 类型。应用层提供稳定读模型：

```ts
interface SessionGraphSnapshot {
  revision: string
  nodes: SessionGraphNode[]
  edges: SessionGraphEdge[]
  hiddenRelationCount: number
}
```

节点只包含当前用户获权可见的摘要和状态；没有内容读取权时，要么完全省略，要么按策略返回不泄露标题/成员/摘要的受限占位。边只有在两端和关系本身均可见时才返回。`hiddenRelationCount` 只在不会形成侧信道时提供。

## 4. Module 划分

### 4.1 Agent Interchange Module

现有 `AgentRunner` 外部 Interface 保持不变，负责统一异构 Agent 的 invocation 与 `AgentEvent`。画布不认识 Pi RPC、OpenCode event 或 Claude stream-json。

真实 Adapter：Pi、OpenCode、Claude Code。未来 Agent 通过同一 Provider seam 接入，不新增第二套公共对话协议。

### 4.2 Session Runtime Module

职责：队列、当前 Turn、Journal、流式订阅、停止、批准和恢复。它输出宿主无关的 `SessionViewModel`，不关心该 Session 显示在画布、专注页还是 Task Run。

建议外部 Interface 保持操作导向：

```ts
interface SessionRuntime {
  observe(sessionId: SessionId): SessionObservation
  submit(command: SubmitMessage): Promise<SubmissionReceipt>
  cancelQueued(command: CancelQueuedMessage): Promise<ControlReceipt>
  stopTurn(command: StopTurn): Promise<ControlReceipt>
}
```

具体 React hook、HTTP client 和 Worker local client 是 Adapter，不把网络细节暴露给会话 UI。

### 4.3 Session Lineage Module

职责：创建 Fork、验证来源 cursor、保存血缘、查询祖先/后代与处理生命周期。应用调用方不自行拼装目标 Session 和边。

```ts
interface SessionLineage {
  fork(command: ForkSessionCommand): Promise<ForkSessionResult>
  getGraph(query: SessionGraphQuery): Promise<SessionGraphSnapshot>
  getForkPoint(forkId: SessionForkId): Promise<SessionForkPoint>
}
```

复杂度包括事务、幂等、绑定验证、权限收窄、cursor 校验与审计，因此集中在该深 Module 内。

### 4.4 Authorization Module

负责对图查询、节点摘要、关系、Fork 命令和实时订阅进行统一授权。调用方提交操作者和目标，不复制 Grant 交集算法。

画布权限不是“页面可见即可加载全部数据”。列表、搜索、图快照、单节点详情、Journal、边详情和实时增量分别校验，撤权后关闭或重新鉴权订阅。

### 4.5 Canvas Projection Module

前端纯投影 Module，把 `SessionGraphSnapshot + CanvasLayout` 转为画布节点/边和分级详情，不发领域写命令：

```ts
interface SessionCanvasProjection {
  project(input: SessionCanvasInput): SessionCanvasView
}
```

它负责：

- 关系线型、箭头、标签和折叠策略。
- zoom/选择状态到 `summary | interactive` 详情层级的映射。
- 不可见节点降载和局部展开。
- 将 React Flow 事件翻译成领域无关的视口/布局意图。

它不负责发送消息、Fork 事务、权限判断或保存 Journal。

### 4.6 Session Surface Module

同一会话交互表面支持：

```ts
type SessionPresentation = 'canvas-summary' | 'canvas-interactive' | 'focus' | 'run'
```

所有形态共享同一 `SessionViewModel`、草稿存储、流订阅和控制器。Presentation 只决定显示密度，不创建第二份 Session state。最大化时优先保持 Module 挂载，通过共享布局/portal 改变容器；如果虚拟化要求重挂载，连续状态必须提升到该 Module，而不是留在具体聊天组件内部。

Ticket 19 已按此约束落地共享 `SessionSurface`：Canvas 交互节点与 focus 复用 `useSession`、`SubmissionController`、Composer 和控制面；URL 保存 active Session，本地偏好只保存 summary/interactive 呈现态，同时最多一个完整交互节点。

### 4.7 Canvas Viewport Module

第一版由 `@xyflow/react` 实现，封装平移、缩放、选择、拖动、可见区域和 MiniMap。业务 feature 不直接散落 React Flow 类型；依赖集中在前端基础设施 Adapter 中，以便升级或替换时保持 Locality。

`framer-motion` 继续负责画布节点与专注态之间的共享布局动画。React Flow 不负责会话业务状态，Motion 不负责图数据。

### 4.8 Layout Persistence Module

第一版只保存用户或项目范围内的节点位置、折叠状态和视口：

```ts
interface CanvasLayout {
  graphRevision: string
  nodePositions: Record<SessionId, { x: number; y: number }>
  collapsedGroups: string[]
  viewport: { x: number; y: number; zoom: number }
}
```

领域血缘变化和布局变化分开持久化。布局写入带 revision/CAS，冲突时不能覆盖别人新建的血缘关系。第一版提供确定性的 Fork 默认放置和手动拖动；大型图出现真实需求后再引入 `elkjs`，并采用动态加载。ELK 只计算位置，不改变边、权限或领域关系。

### 4.9 Orchestration Module

P2 阶段负责人工或 Agent 发起的结构化 Delegation、handoff、预算、审批和取消传播。它消费 Agent Capability 与 Authorization Module，通过 AgentRunner 执行，不要求画布存在。画布只订阅并展示其执行关系。

外部系统、CLI、自动化和将来的 MCP/SDK 入口调用同一应用 Interface；不允许通过 UI 插件直接绕过权限或创建 Provider 原生调用。

## 5. 建议代码落点与依赖规则

下面是实施起点，不要求一次性创建所有目录；只有对应 Module 开工时才落盘。名称用于约束依赖和所有权，不是要求增加大量一文件抽象层。

```text
packages/domain/src/
  session-lineage.ts             # SessionFork/Relation 值对象与不变量

packages/server-domain/src/
  session-lineage.ts             # Server 持久记录和授权关联类型

packages/web-contract/src/
  session-graph.ts               # 图查询/命令 DTO，不含 React Flow 类型

apps/server/src/application/
  session-lineage-service.ts     # Fork 事务与图查询应用 Module
  ports/session-lineage-store.ts # 持久化 Interface
  ports/authorization.ts         # 资源决策 Interface，若已有门面则扩展而非并存

apps/server/src/storage/sqlite/
  session-lineage-store.ts       # SQLite Adapter

apps/web/src/features/session-canvas/
  model/                         # projection、detail level、layout 意图
  application/                   # graph query/fork/layout controllers
  adapters/react-flow/           # 唯一允许 import @xyflow/react 的位置
  ui/                            # canvas shell、nodes、edges

apps/web/src/features/sessions/
  session-surface.tsx            # 复用现有 conversation/controller，逐步深化
```

实施前先检查并复用现有 `ServerStore`、authorization、Session controller 和 query 模块，避免新旧门面并存。`packages/domain` 与 `packages/web-contract` 当前存在双向包依赖，C0 必须避免让新增 lineage 类型加深该环：优先把无 UI 依赖的不变量放 `@wemux/domain`，Web DTO 只引用或映射领域类型；如果构建图不能安全引用，则使用无环的叶子契约包或调整现有依赖，而不是复制同名类型。

建议增加静态依赖测试或 lint 脚本：

- `packages/**`、`apps/server/**`、`apps/worker/**` 禁止 import `@xyflow/react`。
- `features/session-canvas/model` 与 `application` 禁止 import React Flow；只有 `adapters/react-flow` 和相邻 UI 壳允许。
- Agent Adapter 禁止 import Server authorization、HTTP handler 或 Worker transport。
- Web feature 不允许直接 import Server/Worker 内部源码。

## 6. 开源依赖决策

### 6.1 第一阶段新增 `@xyflow/react`

用途：自定义 React 节点、边、viewport、选择、拖动、可见元素优化和 MiniMap。它使用 DOM/SVG，适合在节点内放输入框、Markdown、工具状态和无障碍交互。

引入规则：

- 只在 Canvas Viewport Adapter 中引用。
- React Flow `Node`/`Edge` 不进入 `packages/domain`、`packages/web-contract` 或 Server DTO。
- 输入、滚动和按钮使用 `nodrag`/`nopan`/`nowheel` 等交互隔离。
- 许可证与实际版本在实现票据中锁定和记录；本设计不提前修改依赖锁文件。

### 6.2 复用现有 `framer-motion`

用于共享布局、最大化/缩回、其他节点淡出和新分支出现。不得以动画阻塞消息输入或让流式状态重新订阅。

### 6.3 后续可选 `elkjs`

仅当真实图规模和自动排列需求通过测量确认后引入，用于分层 DAG、复合图和正交边路由。应动态加载、可取消、可回退手动布局；布局失败不影响对话和血缘数据。

### 6.4 暂不采用 `tldraw`

当前产品需要结构化会话网络，不需要任意绘图、手写、便签或通用白板工具。引入 tldraw 会扩大数据模型和交互面，降低领域约束的 Locality。未来若自由白板成为独立产品能力，应作为单独 Module 和规格评估，而不是替换会话图。

## 7. 画布与专注模式连续性

进入专注态前记录：

- graph revision、active session、selection；
- viewport 的 x/y/zoom；
- 来源节点可见矩形；
- 消息滚动锚点；
- Composer 草稿、附件草稿和光标；
- 当前工具详情或产物选择。

切换时更新 URL，但不把路由变化当作销毁 Session Runtime 的信号。建议 URL：

```text
/projects/:projectId/canvas?session=:sessionId
/projects/:projectId/sessions/:sessionId
```

或同一路由通过 `view=canvas|focus` 表达 Presentation。具体路由在实施票据冻结；浏览器返回必须恢复原画布视口。刷新专注链接可以直接恢复 Session，但若没有历史画布返回点则使用确定性定位，不伪造旧 viewport。

## 8. 性能与可访问性

节点详情分三级：

1. `summary`：标题、Agent、状态、最近活动、分支数量；不加载完整 Journal。
2. `interactive`：仅少量选中/邻近节点，加载最近消息、Composer 和流式状态。
3. `focus`：完整历史、工具、产物、成员、权限和 Fork 管理。

必须限制同时 interactive 的节点数，虚拟化或分页长历史，只渲染可见节点，并通过统一缓存/订阅分发事件，不能为每个节点创建独立 Worker 长连接。键盘可完成节点遍历、打开、返回、Fork 和关系查看；缩放不能成为唯一发现方式。手机端可降级为纵向血缘树/卡片流，但仍使用同一图快照和 Session Surface。

## 9. 协作、实时与冲突

- 血缘与 Session 事件通过 Server 权威 revision/cursor 增量同步；浏览器不做权威合并。
- 第一版多人能力只展示低敏、短 TTL Presence：获权成员正在查看哪个可见 Session、是否在输入，以及 Agent 是否正在执行；不广播草稿、指针轨迹、私有标题或无权成员身份，不先做 Google Docs 式同一输入框共同编辑。
- 节点位置属于布局数据。项目共享布局需要 CAS 或操作日志；个人布局与团队默认布局分开，不让成员拖动覆盖他人私人视图。布局持久化与大型图性能独立于授权实时同步验收。
- 撤权后图增量、Session Journal 和 Presence 同时停止；已缓存内容按现有安全策略清除或锁定。
- 离线时允许查看已缓存图和写本地草稿；Fork、拖动共享布局和发送消息的离线语义分别定义，不能统一显示“已保存”。

## 10. 分阶段实施

### C0：架构合同与依赖门

冻结 Domain、Application、Host Adapter、Presentation 的依赖方向；定义 `SessionFork`、图读模型、Session Surface 状态所有权与 React Flow 隔离规则。无 UI 假实现。

### C1：Fork 与血缘权威

交付 Fork 应用事务、cursor 边界、幂等、权限收窄、审计和图查询；先通过 API/测试验证，不依赖画布。

### C2：基础协作画布

引入 `@xyflow/react` Adapter；交付摘要节点、Fork 边、选择、平移缩放、确定性默认位置、手动布局和 URL 深链。节点点击可打开既有专注会话。

### C3：交互 Session Surface 与连续变形

画布节点中直接对话；共享草稿、流式输出、队列和停止；使用现有 Motion 完成最大化/缩回并恢复 viewport/scroll/focus。

### C4：授权实时同步与撤权

交付 Server 权威图增量、最小 Presence、cursor 缺口恢复和现有流撤权。不互信团队协作必须通过账号线 A3；本阶段不被团队布局或自动布局阻塞。

### C5：布局持久化与大型图性能

交付个人/团队布局、冲突保护、折叠、局部布局和经基线确认的性能预算。只有测量证明现有策略不足后才动态引入 `elkjs`；过期布局结果不得落地或修改血缘。

### C6：编排关系与开放接口

将 Delegation、handoff、Artifact Reference、Run Attachment 投影到图；CLI/SDK/外部自动化调用相同应用 Interface。首版可先交付获权快照/只读投影，实时关系更新依赖 C4。Agent 自动委托继续受预算、审批、能力和取消传播约束。

## 11. 验收门槛

- Pi 与 OpenCode 的 Session 可出现在同一图中，通过同一 Session Surface 操作，UI 不读取 Provider 原生事件。
- 从来源 Session 的确定 cursor Fork 后，两条 Session 独立执行，来源后续消息不进入目标上下文。
- Fork 响应丢失重试不重复创建 Session；事务失败不留下孤立节点或边。
- 画布直接发送、流式生成期间最大化、浏览器返回和缩回均不丢草稿、滚动、队列或执行状态。
- 两端无权限的关系不出现在图、搜索、增量和边详情中；撤权终止实时订阅。
- Ticket 22 先记录测试数据集与当前基线，再冻结大型图交互预算；性能结果基于真实浏览器记录，不用静态渲染推断或凭空指定阈值。
- 桌面、窄屏、键盘和局域网 HTTP 均通过真实浏览器验收；不依赖 secure-context-only API。
- React Flow/ELK 故障或禁用不影响通过列表/专注路由继续访问 Session。

## 12. 明确不做

- 不把画布做成自由绘图白板或插件市场。
- 不允许任意第三方关系类型绕过领域校验。
- 不在浏览器中编排或持久调度 Agent。
- 不因图上相邻就共享 Workspace、文件、Secret 或权限。
- 不把拖动节点、打开节点或最大化视为 Fork。
- 不自动合并两个 Session Journal；未来 Merge 需要独立领域规格。
- 不用画布替代列表、搜索、任务看板或移动端可达路径。
