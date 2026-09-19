# 会话画布模块合同冻结记录（C0）

状态：已冻结，代码契约与依赖门已落地。本文是 [会话协作画布与血缘模块设计](session-collaboration-canvas.md) 的 C0 执行记录，不引入该设计之外的新范围。

对应票据：`.scratch/product-convergence/issues/16-freeze-session-canvas-module-contracts.md`。

## 1. 冻结范围

C0 只冻结接口、依赖方向、错误模式与事务/恢复规则，不交付画布 UI、不交付 Fork 事务、不新增运行时依赖。C1（Ticket 17）与 C2（Ticket 18）必须按本文落点实现，不得在调用方复制规则。

## 2. 模块所有权与落点

| Module | 唯一落点 | 公开 Interface | 禁止依赖 |
| --- | --- | --- | --- |
| Agent Interchange | `packages/agent-interchange`、`apps/worker/src/agents` | `AgentAdapter`（现有）、`AgentEvent` | Server Grant、HTTP handler、transport、Session 状态机 |
| Session Runtime | `apps/web/src/features/sessions`、`apps/worker/src/application` | `SessionRuntime`（observe/submit/cancelQueued/stopTurn） | 渲染器类型、Canvas 投影、宿主路由 |
| Session Lineage | `packages/domain/src/session-lineage.ts`、`packages/domain/src/session-graph.ts`、`packages/server-domain/src/session-lineage.ts`、`apps/server/src/application/session-lineage-service.ts`（C1） | `SessionLineage`（fork/getGraph/getForkPoint） | 渲染器、HTTP 传输细节、transport frame |
| Authorization | `packages/server-domain/src/access.ts`、Server 现有授权门面 | 现有决策门面（不新增并存门面） | 渲染器、UI 状态 |
| Canvas Projection | `apps/web/src/features/session-canvas/model` | `SessionCanvasProjection.project` | React Flow、Server/Worker 内部源码、领域写命令 |
| Session Surface | `apps/web/src/features/sessions/session-surface.tsx` | 共享 `SessionViewModel` + 控制器 | 第二份 Composer/Journal/Queue 状态机 |
| Canvas Viewport | `apps/web/src/features/session-canvas/adapters/react-flow` | 视口/布局意图 | 领域事实、权限判断 |
| Layout Persistence | `apps/web/src/features/session-canvas/application` + Server 布局端口（C5） | `CanvasLayout` 读写带 revision CAS | 血缘写入、Session 状态 |

`packages/domain` 是叶子包：`canvas-layout.ts`、`session-graph.ts`、`session-lineage.ts` 只依赖同包内类型，不依赖 `@wemux/web-contract`。

## 3. 已落地的代码契约

- `packages/domain/src/session-lineage.ts`：`SessionFork`、`SessionForkPoint`、`SessionRelation`、`SessionForkContextPolicy`、`sessionRelationKinds`，以及不变量 `assertForkTargetsAnotherSession`、`assertForkCursorIsDurable`。
- `packages/domain/src/session-graph.ts`：`SessionGraphSnapshot`、`SessionGraphNode`、`SessionGraphEdge`、`SessionGraphQuery`、`ForkSessionCommand`、`ForkSessionResult`，以及 `assertNodeVisibilityIsHonest`、`assertEdgesReferenceReturnedNodes`。C1 修订：`SessionGraphNodeSummary.lastActivityAt` 改为 `Timestamp | null`（null = 该 Session 还没有已持久事件）。理由是 Session 不携带创建时间，编造活动时间会让图说谎；渲染方在 null 时必须省略相对时间。
- `packages/domain/src/canvas-layout.ts`：`CanvasLayout`、`CanvasLayoutScope`、`CanvasNodePosition`、`CanvasViewport`、`isCanvasLayout`。
- `packages/server-domain/src/session-lineage.ts`：`SessionForkRecord`（含 `projectId` 授权关联与 `creation.requestId/fingerprint` 幂等身份）、`SessionLineageAuthorizationTarget`、`SessionLineageNodeDecision`、`narrowForkAccess`。
- `packages/web-contract/src/session-graph.ts`：图查询/Fork/布局的 HTTP DTO，类型从 `@wemux/domain` 复用而非复制。
- `packages/domain/src/task.ts`：任务状态词表与流转规则移到领域包；`web-contract` 改为再导出，`@wemux/domain` 因此不再依赖 `web-contract`（包循环已解除，构建顺序调整为 domain → web-contract）。

## 4. 依赖门（可执行）

- `apps/web/tests/canvas-module-contract.test.mjs` 强制：`@xyflow/react` 只允许出现在 `apps/web/src/features/session-canvas/adapters/react-flow/`；画布 model/application 层不得引用渲染器或该适配器；`packages/domain` 不得 import `@wemux/web-contract`；Web 不得 import `@wemux/server`、`@wemux/worker`；`apps/worker/src/agents` 不得 import server-domain/authorization/http/transport。
- `packages/server-domain/src/session-lineage.test.ts` 锁定血缘、可见性、边完整性与布局校验不变量。
- 依赖门已做反向验证：故意在 `session-canvas/model` 写入 `@xyflow/react` 引用、在 `packages/domain` 写入 `@wemux/web-contract` 引用后测试确实失败，移除后恢复全绿。

## 5. 错误模式

| 情形 | 结果 | 不得出现的行为 |
| --- | --- | --- |
| Fork 目标等于来源 | `invalid_transition` 语义的领域错误 | 创建自环边 |
| Fork cursor 超出已持久序列 | 校验错误，不落盘 | 截断或猜测 cursor |
| 同 `requestId` 但绑定指纹不同 | 拒绝并返回冲突 | 静默复用第一个目标 |
| 图查询缺少对某节点内容读取权 | `placeholder` 或 `omitted` | 返回部分标题/成员/摘要 |
| 边一端不可见 | 整条边不返回 | 返回半边或用计数泄露结构 |
| 布局 revision 过期 | `stale_revision` 拒绝写入 | 覆盖更新后的血缘 |
| `CanvasLayout` 结构不合法 | `invalid_layout` 拒绝写入 | 落盘 NaN/零缩放/未知 scope |

## 6. 事务与恢复规则

- Fork 创建、目标 Session 创建、绑定快照与血缘写入在同一应用事务；失败不得留下无来源目标或悬空边。
- `sourceEventCursor` 是固定边界；来源 Session 之后的消息不进入目标上下文。
- 目标 Session 的 Workspace Placement、Worker、Agent 与 Model 必须显式确定；可继承默认值，但不得静默迁移或替换不可用能力。
- 权限只收窄不放大：目标有效访问取 Project、目标 Workspace、目标 Worker 与显式 Session 策略交集（`narrowForkAccess`）。
- 归档或删除来源 Session 不删除目标；关系保留为受权限过滤的历史事实。
- 布局与血缘分开持久化；布局写入带 revision CAS，冲突时保留血缘。
- 图画布不是访问 Session 的唯一通道：React Flow 故障或被禁用时，列表与专注路由仍可访问同一 Session Surface。

## 7. 真实可插拔点

- Agent Adapter：Pi、OpenCode、Claude Code 已通过同一 `AgentAdapter` seam 接入；未来 Agent 复用该 Provider seam，不新增第二套公共对话协议。
- Host Adapter：Server Web 与 Worker Web 通过各自宿主 Adapter 组合同一 Session Runtime/Surface，不复制 Composer、Journal、Queue 与控制状态机。
- 不建立通用画布插件市场或渲染器注册框架：第一版只有 `@xyflow/react` 一种实现。
- 自动布局在手写布局与 ELK 两种实现同时存在前只是内部策略，不提前暴露公共 `LayoutEngine`。
- 关系类型是封闭联合类型，第三方不得注入自定义关系类型绕过授权、审计与生命周期规则。

## 8. Non-goals

- 不实现画布 UI、节点组件、边渲染或偏好设置。
- 不实现 Fork 事务、图查询端点或布局持久化端点（分别为 Ticket 17、18、22）。
- 不引入 `@xyflow/react`、`elkjs` 或任何新运行时依赖；本阶段不修改依赖锁文件。
- 不实现实时图增量、Presence 或撤权推送（Ticket 20）。
- 不实现编排关系投影（Ticket 21、23）。

## 9. C1 补充冻结：会话权威与运行时适配（Ticket 17）

Ticket 17 实现 Fork 事务时确认了“通用会话模型”的边界。以下三条是合同，不是实现细节：后续切片（C2/C5/C6、Worker Web 工作台、编排）不得绕开。

1. **原生会话引用只是 Worker 内部状态**：`NativeSessionRef`（Pi `--session`、OpenCode `--session`、Claude `--resume`）只能存在于 Worker 本地存储、Agent Adapter 内部与 `AgentEvent` metadata。禁止进入 Server DTO、`packages/domain` / `packages/server-domain` 类型、Web 状态或数据库血缘记录。
2. **血缘只引用规范事实**：每条边只引用 `SessionId` + `sourceEventCursor`。任何用原生 session id、Provider 事件 id 或 transport frame id 充当血缘键的实现视为违规；跨 runtime、跨 Worker 的 Fork 必须仍然成立。
3. **上下文物化是适配器职责**：给定 `(sourceSessionId, cursor, contextPolicy)`，由 Worker 侧 AgentRunner/Provider Agent 输出一次新的原生会话；runtime 若自带原生分支能力，只能作为内部优化，不得反推平台事实。

`contextPolicy` 当前语义（`apps/server/src/application/session-lineage-service.ts`）：

| 取值 | 当前行为 | 理由 |
| --- | --- | --- |
| `through_cursor` | 接受：记录固定 cursor 边界，目标 Session 不复制任何事件 | 边界即是事实，目标永不因来源后续事件而增长 |
| `summary` | 拒绝：`unsupported_context_policy` | 需要摘要装配与来源内容读取授权，尚不存在 |
| `explicit_selection` | 拒绝：`unsupported_context_policy` | 冻结命令没有选择载荷，接受即等于静默降级为 `through_cursor` |

图 revision 是 Project 内节点与血缘集合的哈希指纹：只在真实变化时改变，客户端只用于比较新旧，不反推分支数量。
