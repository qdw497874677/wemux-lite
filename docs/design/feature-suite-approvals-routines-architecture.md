# Paperclip 功能借鉴七件套架构设计（G48-G54）

日期：2026-09-28

本文是 G48-G54 的共同架构依据，覆盖统一审批中心、Routines 定时例程、WhatNeedsMe 收件箱、Skill Studio、Artifacts 交付物、Activity Timeline 与 Evals。功能选择依据 [Paperclip 功能层借鉴清单](../research/paperclip-feature-borrowing.md)，调度与低信任机制依据 [Paperclip 基础设施机制深挖](../research/paperclip-deep-dive.md)，模块划分沿用 [连接器模块的多六边形方法](./connector-module-borrow-and-hexagon-boundaries.md)。

路径引用除特别说明外，Paperclip 路径均相对于 `/opt/data/profiles/hacker/workspace/project/paperclip-upstream/paperclip/`，Wemux 路径均相对于本仓库根目录。

## 0. 设计摘要

七件套以 Server 聚合投影、Run 执行事实和 Worker Agent 执行面为三条共用底座。审批、收件箱、时间线只聚合各域权威事实；例程复用 H4 Channel 入站与现有 Run；交付物只引用 Worker 文件；Skill 和 Eval 由 Server 管理、Worker 注入和执行。全套按四批交付，预计 304-440 小时，约 38-55 人日。

## 一、共同底座、依赖图与六边形归属

### 1.1 不变约束

1. 继续使用 `node:http`、`node:sqlite` 和 npm workspaces，不引入 Web 框架、外部队列或独立调度中间件。
2. 依赖方向固定为：领域事实 → 应用编排 → 宿主端口 → 基础设施 Adapter → Web 投影。Worker 不依赖 `@wemux/server-domain`，Web 不持有领域权威。
3. 写操作统一采用稳定 `requestId + fingerprint`，同身份异载荷返回 409；可变实体更新另带 `expectedRevision` 做 CAS。HTTP、调度重试和 Worker 重连不得换副作用身份。
4. 授权只复用 A3：Project、Worker、Session 的现有权限求交。七件套不增加平行 Grant 体系。
5. 所有治理写操作进入现有 `AuditEntry` 通道；时间线是审计与领域活动的安全投影，不是第二套审计源。
6. Worker 执行仍经 `AgentRunner`、Session Runtime、可靠 Worker delivery 和 Workspace Placement。Server 不执行 Agent，也不读取 Worker 文件系统权威。
7. Web 源码继续遵守 `randomId()`、`copyText()` 非安全上下文降级、本地值导入带 `.ts`、中文文案、零装饰性圆点和零 em dash。
8. 可插拔接口只放在已有真实变化点：Server/Worker 双宿主、Pi/OpenCode 等 Agent Adapter、H4 的 generic webhook/飞书/钉钉 Channel Adapter。七件套不新建通用插件市场。

### 1.2 三个共同底座

#### F1 跨实体只读投影层

服务 Approvals、WhatNeedsMe、Timeline，并为 Artifacts 列表提供统一游标规则。它位于 `packages/server-domain` 的应用查询接口与 `apps/server` 的组合查询实现，不产生新的领域权威。

建议外部接口保持小而深：

```ts
export interface CrossEntityProjectionPort {
  approvals(actorId: UserId, query: ApprovalQuery): Promise<ApprovalPage>
  attention(actorId: UserId, query: AttentionQuery): Promise<AttentionPage>
  timeline(actorId: UserId, query: TimelineQuery): Promise<TimelinePage>
}
```

内部 Adapter 可分别读取任务 Review、Session Journal 审批、Connector 审批、Channel delivery、Task Activity 与 Audit。调用方不接触表名、跨表 union、去重、脱敏或权限过滤。首版查询时聚合，不维护通用事件总线或物化视图。确有性能证据后，只为具体查询增加窄索引或专用投影表。

共同分页契约：

```ts
export interface CursorPage<T> {
  readonly items: readonly T[]
  readonly nextCursor: string | null
}
```

游标编码 `(occurredAt, sourceKind, sourceId)`，排序为时间倒序、来源种类、稳定 ID。默认 `limit=50`，最大 `100`，所有列表响应保持 `{ items: [...], nextCursor }`。

#### F2 Run 执行事实与文件引用层

Routines 和 Artifacts 共享现有 `Task → Run → Session` 执行事实：

- Routine dispatch 创建或复用 Task，再通过现有 Task launch 应用接口创建 Run，不直接伪造 `task_runs`、Session 或 Worker Command。
- Artifact 记录来源 `runId/sessionId/workspaceId/workerId`，文件内容仍由 Workspace Placement 上的 Worker 权威保存。
- Run 成功不自动完成 Task；Artifact 通过审查也不隐式把 Task 置为 done。
- `run_attachment` 与 `artifact_reference` 可在 C6 血缘合同落地后投影，首版不把未实现的 `SessionRelation` 变体当作权威。

#### F3 Agent 执行资产层

Skill Studio 和 Evals 共享以下事实：

- Server 保存 Project 级 Skill/Eval 定义、版本、授权选择和结果摘要。
- Worker 保存不可变 Skill 内容缓存，在 launch 前准备注入目录；Agent 原生 skills 仍由 Pi/OpenCode/Claude 自己解释。
- Eval 使用 `AgentRunner.run()` 和独立 Session/Workspace，不绕过 Adapter Bridge，不直接调用 Provider SDK。
- Skill 版本与 Eval candidate 都以不可变 revision 固定，运行中更新不影响已启动执行。

### 1.3 包与宿主依赖

```text
@wemux/domain
  ├─ 基础 ID、状态机、Artifact/Skill/Eval/Routine 值对象
  ▼
@wemux/server-domain
  ├─ F1 聚合查询 Interface
  ├─ Routine/Artifact/Skill/Eval 应用端口
  └─ A3 授权输入与审计意图
  ▼
@wemux/web-contract
  └─ 安全 DTO、游标、错误码、表单契约

@wemux/domain + @wemux/connector
  ▼
@wemux/wire-protocol
  ├─ Skill revision sync/report
  ├─ Routine/Eval 执行 Command 或现有 Session Command 引用
  └─ Artifact stat/verify 请求，绝不携带文件正文或 Secret

apps/server
  ├─ node:http routes
  ├─ application orchestration
  ├─ SQLite Adapter
  └─ Worker delivery Adapter

apps/worker
  ├─ Skill cache/injection Adapter
  ├─ AgentRunner Eval execution Adapter
  ├─ Workspace file stat/read Adapter
  └─ 本地 SQLite 状态

apps/web
  └─ 七个 feature projection，仅调用 web-contract
```

`packages/connector` 不因七件套而扩大为自动化包。Routine webhook 直接消费 H4 `InboundDelivery` 和 Channel binding 机制；Connector 只在 Routine 或 Agent 工具调用确实使用 MCP/HTTP 时参与。

### 1.4 依赖 DAG 与并行性

```text
                    ┌──────────────┐
                    │ F1 聚合契约  │
                    └──────┬───────┘
              ┌────────────┼────────────┐
              ▼            ▼            ▼
        G48 Approvals  G53 Timeline  G50 WhatNeedsMe
              │            │            ▲
              └────────────┴────────────┘
                     聚合模式验证

现有 Task/Run/Review ───────┬───────────────┐
现有 session-files ─────────┤               │
                            ▼               ▼
                      G52 Artifacts     G49 Routines
                                           ▲
现有 H4 Channel ────────────────────────────┤
可靠投递与 A3 ──────────────────────────────┘

                    ┌──────────────┐
                    │ F3 Skill 合同│
                    └──────┬───────┘
                           ▼
                     G51 Skill Studio
                           │
现有 AgentRunner ──────────┼──────────────┐
                           ▼              │
                        G54 Evals ◄────────┘
```

依赖裁定：

- 必须先做：F1 契约与最小 SQLite 查询索引。G48 与 G53 用它证明跨实体聚合模式。
- 可在 F1 完成后并行：G48、G53；两者稳定后 G50 只增加个人化规则，不重建聚合框架。
- G52 依赖现有 Run、Review 与 session-files，不依赖 G48/G53，可与批次一后半段并行设计。
- G49 依赖已交付 H4、现有 Task/Run 和调度内核合同，是关键路径中最重的一项。
- G51 与 G49/G52 独立，可在类型合同冻结后由另一条线并行。
- G54 依赖 G51 的不可变 Skill revision 和成熟 `AgentRunner`，但无 Skill candidate 的基础 Agent Eval 可先实现内核测试。

### 1.5 七功能六边形总览

| 功能 | 领域权威 | Server 六边形 | Worker 六边形 | Web |
|---|---|---|---|---|
| G48 Approvals | 各域自己的审批/Review 状态 | 聚合查询端口、决策路由端口、SQLite 查询 Adapter | 仅 Session/Tool 审批沿现有 Worker runtime 解析 | 统一收件箱与详情投影 |
| G49 Routines | Server 的 Routine/Trigger/Receipt/Dispatch | 调度应用端口、H4 receipt Adapter、SQLite scheduler Adapter、Run launcher Adapter | 现有 Session/Run 执行，必要时回报 ownership/progress | 配置、运行历史、诊断 |
| G50 WhatNeedsMe | 各域待处理事实与个人 dismissal | 个人聚合查询端口、SQLite union Adapter | 无新增参与 | 纯聚合收件箱 |
| G51 Skill Studio | Server Skill revision 与授权选择；Worker 缓存副本 | Skill catalog/distribution 端口、SQLite Adapter、可靠命令 Adapter | Skill materializer、launch-context injector、Agent Adapter | 编辑、版本、绑定与分发状态 |
| G52 Artifacts | Server 元数据与审查；Worker 文件内容 | Artifact catalog/review 端口、SQLite Adapter、session-files gateway | 文件 stat/read/摘要，文件仍属 Placement | 聚合、预览、下载、审查 |
| G53 Timeline | Audit 与领域活动事实 | 跨实体 timeline 查询端口、SQLite union Adapter | 无新增参与 | 纯只读时间线 |
| G54 Evals | Server Eval 定义、Case、Run、Score | Eval orchestration 端口、SQLite Adapter、Worker command Adapter | Eval executor 复用 `AgentRunner`，产出结构化结果 | 套件、矩阵、结果比较 |

## 二、七个功能的详细设计

### 2.1 G48 统一审批中心（Approvals）

#### 领域模型与不变量

统一 Approval 是跨域只读引用，不是新的审批权威表：

```ts
export type ApprovalSource =
  | { readonly kind: 'session_tool'; readonly sessionId: SessionId; readonly turnId: TurnId; readonly approvalId: ApprovalId }
  | { readonly kind: 'connector_call'; readonly sessionId: SessionId; readonly requestId: string }
  | { readonly kind: 'task_review'; readonly taskId: string; readonly runId: string; readonly reviewId: string }
  | { readonly kind: 'channel_governance'; readonly channelId: string; readonly operationId: string }

export type ApprovalProjectionStatus = 'pending' | 'approved' | 'denied' | 'changes_requested' | 'expired' | 'unavailable'

export interface ApprovalItem {
  readonly key: string
  readonly projectId: ProjectId
  readonly source: ApprovalSource
  readonly status: ApprovalProjectionStatus
  readonly title: string
  readonly reason: string | null
  readonly requestedBy: { readonly kind: 'user' | 'agent' | 'channel' | 'system'; readonly id: string | null }
  readonly requestedAt: Timestamp
  readonly decidedAt: Timestamp | null
  readonly decisionCapabilities: readonly ('approve' | 'deny' | 'changes_requested')[]
  readonly sourceRevision: string
}
```

不变量：

1. `key = source.kind + 权威实体身份`，聚合层不得生成可被误认为领域 ID 的随机 Approval ID。
2. 决策必须路由回来源域，并在来源域事务内验证状态、A3 权限、revision 和幂等身份。
3. 聚合读到 pending 后，写入前来源可能已变化。决策端以来源域 CAS 为准，409 后刷新列表。
4. Session Tool 审批只有当前活跃 Turn 且 Agent Adapter 支持 approvals 时可决策；断线、超时和无人处理不自动批准。

#### A3、审计与幂等

- 列表项只有在用户可读对应 Project 且可读目标 Session/Task 时出现。
- `task_review` 决策复用现有 Task/Review capability；`session_tool` 复用 `SessionAccessService.require(..., 'control')` 或原请求者处理自己的 Approval 的既有规则；Connector/Channel 继续求 Project、Worker、Session 权限交集。
- 写操作体统一为 `{ requestId, fingerprint, sourceRevision, decision, note? }`。来源域保存原结果，同 requestId 异 fingerprint 返回 409。
- 审计 action 使用来源动作，如 `review.approved`、`approval.session_tool.approved`，metadata 增加 `approvalProjectionKey`，不复制 tool input、完整 prompt 或 Secret。

#### Paperclip 参照与差异

参照：`ui/src/pages/Approvals.tsx`、`ui/src/api/approvals.ts`、`server/src/routes/approvals.ts`、`server/src/services/approvals.ts`、`packages/db/src/schema/approvals.ts`。

Paperclip 使用统一 `approvals` 表并让部分治理对象直接在服务中变更。Wemux 裁定为投影聚合，因为 Task Review、Session Approval、Connector approval 已有不同状态机、权限和执行宿主。复制为新表会产生双写、恢复顺序和“哪张表能批准”的歧义。代价是列表存在短暂一致性窗口：Server 缓存的 Worker Journal 审批相对 Worker 权威可能延迟，UI 必须显示 `freshness`，写入时再由权威来源拒绝过期决定。Server 本地 Review 与 Audit 为事务后立即可见；Worker 审批以可靠 Journal 同步为准。

#### API 与 wire

- `GET /api/approvals?status=pending&projectId=&cursor=&limit=` → `{ items, nextCursor }`
- `GET /api/approvals/:projectionKey` → `{ approval }`
- `POST /api/approvals/:projectionKey/decisions` → `{ approval, replayed }`

不新增通用 approval wire。Session Tool 决策继续使用现有 `runtime.approval.resolve`；Connector approval 继续使用 `ToolExecutionGateway` 的审批端口。仅当 Server 尚无来源事件时，补充来源专用 report，不创建跨域 `approval.resolve` 万能消息。

#### 验收

- 单元/集成：四种来源映射、权限过滤、游标稳定、同 requestId 重放、异 fingerprint 冲突、来源 revision 冲突、Worker stale freshness。
- 真实浏览器：两个 Project、两个用户；同页看到获权待办；批准 Task Review、拒绝 Pi tool approval；无权项不泄露标题；重复点击只产生一次决定；Worker 离线项明确显示不可用。

#### 关键决策

1. 采用跨域投影聚合，不建统一权威 Approval 表，因为各域状态机和宿主不同。
2. 一致性为“Server 本地域事务后可见，Worker 来源最终一致”；所有写操作重新检查来源权威。
3. 统一的是发现与导航，不统一审批策略。审批能力继续失败关闭。

#### 为了轻量而不做

不做 SLA、升级链、代理审批、法定人数、多级签核、自定义审批流程或 Approval 评论系统。

### 2.2 G49 Routines 定时例程

#### 领域模型与状态机

```ts
export type RoutineStatus = 'draft' | 'active' | 'paused' | 'archived'
export type RoutineTrigger =
  | { readonly kind: 'cron'; readonly expression: string; readonly timeZone: string }
  | { readonly kind: 'channel'; readonly channelId: string; readonly bindingId: string }
  | { readonly kind: 'api'; readonly tokenRef: string | null }

export interface Routine {
  readonly id: string
  readonly projectId: ProjectId
  readonly name: string
  readonly status: RoutineStatus
  readonly revision: number
  readonly trigger: RoutineTrigger
  readonly catchUpPolicy: 'skip_missed' | 'run_latest'
  readonly concurrencyPolicy: 'skip_if_active' | 'coalesce_if_active' | 'always_enqueue'
  readonly dispatch: {
    readonly taskTemplateId: string | null
    readonly workspaceId: WorkspaceId
    readonly preferredWorkerId: WorkerId | null
    readonly agentKey: AgentKey
    readonly modelId: ModelId | null
    readonly promptTemplate: string
  }
  readonly nextRunAt: Timestamp | null
}

export type RoutineReceiptStatus = 'received' | 'coalesced' | 'queued' | 'skipped' | 'failed_closed'
export type RoutineDispatchStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'ownership_unverified'
```

关键记录：

- `RoutineRevision`：每次启用或变更产生不可变快照。
- `RoutineTriggerReceipt`：唯一 `(routineId, triggerKind, idempotencyKey)`，保存 payload fingerprint。
- `RoutineDispatch`：绑定 receipt、revision、Task、Run、Session、Worker 与 lease/owner。
- `dispatchFingerprint = SHA-256(routineRevisionId + resolvedVariables + executionScope)`。

不变量：

1. 先持久化 receipt，再 ACK API/H4 入站；数据库只承诺 at-least-once，外部副作用靠稳定 requestId 幂等。
2. `queued -> running` 使用单语句条件更新并与 execution scope 绑定同一事务。
3. active Routine 必须能解析到 Project、Workspace、Agent 和至少一个获权且 Placement ready 的 Worker。
4. Run 成功不自动把 Task 标为 done。Routine 可创建 tracked Task 或附着到模板 Task，但审查规则不变。
5. `ownership_unverified` 不自动重跑，避免重复 Agent 或 Connector 副作用。

#### 调度器形态、追赶和 Worker 路由

裁定为 Server 进程内 SQLite 轮询器，不增加独立 tick 进程：

- `RoutineSchedulerPort.tick(now, limit)` 每 15 秒运行一次，启动后立即 tick。
- SQLite Adapter 以 `BEGIN IMMEDIATE`、到期索引和条件更新领取最多 50 个 trigger。
- 当前默认单 Server，不需要进程外 leader election。未来多 Server 是重新评估 PostgreSQL/租约的触发条件，不在本票据预建。
- `skip_missed`：恢复时推进到下一个未来 tick，不补跑。
- `run_latest`：每个 Routine 最多补一个最近遗漏窗口，并使用窗口时间形成稳定 idempotency key。首版不支持逐窗全量追赶。
- Worker 路由先锁定 Workspace Placement。若 `preferredWorkerId` 有 ready Placement 且用户仍有 `Worker use`，使用它；否则从 ready Placement 中按 `activeRunCount`、Worker ID 稳定排序选一个。已创建 dispatch 不因 Worker 离线透明迁移，重新放置必须新建显式 retry dispatch，并证明原 ownership 已终结或由人确认。

H4 webhook 复用：Routine 的 webhook 触发不是新公网 route。管理员创建 H4 Channel/Binding，并将 binding 的目标改为 `routine` 类型或通过新的 `RoutineChannelTarget` 关联表路由。H4 仍负责验签、token、delivery 去重、先持久化再 ACK；Routine 只消费 normalized `InboundDelivery`。飞书和钉钉同样经各自 Channel Adapter，不在 Routine 中重写平台协议。

#### A3、审计与幂等

- CRUD/启停要求 Project manager；手工 run 要求 Project contributor、Worker use、Workspace 与 Agent 可执行。
- scheduler 代表系统执行，但使用 Routine `createdBy` 与最新授权快照重新求值；授权撤销后 receipt 进入 `failed_closed`。
- 写操作 `{ requestId, fingerprint, expectedRevision }`；cron window、H4 delivery ID、API caller idempotency key 分别成为 trigger identity。
- 审计：`routine.created|updated|enabled|paused|triggered|dispatch.retried|dispatch.cancelled`。高频 tick 空跑不写审计。

#### Paperclip 参照与差异

参照：`ui/src/pages/Routines.tsx`、`ui/src/api/routines.ts`、`server/src/routes/routines.ts`、`server/src/services/routines.ts`、`packages/db/src/schema/routines.ts`、`server/src/services/heartbeat.ts`。

借鉴 immutable revision、catch-up、concurrency、dispatch fingerprint、durable receipt 与孤儿恢复。不同点：Paperclip 为例程创建 execution issue 并唤醒员工式 Agent；Wemux 使用现有 Task/Run/Session，不引入 issue；webhook 复用 H4 Channel；Worker 选择遵守 Workspace Placement 与 A3，不按公司 agent 归属路由。

#### API 与 wire

- `GET /api/projects/:projectId/routines?status=&cursor=&limit=`
- `POST /api/projects/:projectId/routines`
- `GET /api/projects/:projectId/routines/:routineId`
- `PATCH /api/projects/:projectId/routines/:routineId`
- `POST /api/projects/:projectId/routines/:routineId/enable`
- `POST /api/projects/:projectId/routines/:routineId/pause`
- `POST /api/projects/:projectId/routines/:routineId/run`
- `GET /api/projects/:projectId/routines/:routineId/dispatches?cursor=&limit=`
- `POST /api/projects/:projectId/routines/:routineId/dispatches/:dispatchId/retry`
- `POST /api/projects/:projectId/routines/:routineId/dispatches/:dispatchId/cancel`

列表均为 `{ items, nextCursor }`。优先复用现有 Run launch 与 Worker Command。若不能用现有 Task launch seam，新增 `routine.dispatch.start` 管理 Command，字段只引用 `dispatchId/runId/sessionId/revision`，不携带 Channel Secret 或未经上限处理的 webhook body；Worker 回报 `routine.dispatch.progress|settled`。不能用 transport ACK 当作终态。

#### 验收

- 调度单元测试：时区、DST、15 秒 tick、skip/run_latest、并发策略、receipt 冲突、CAS 输赢、启动恢复、ownership_unverified。
- H4 集成：同 delivery 重试只触发一次；generic webhook/飞书 normalized delivery 使用同一 Routine admission。
- 双 Worker：preferred ready、fallback 稳定选择、离线不透明迁移、授权撤销失败关闭。
- 真实浏览器：创建 cron Routine、手工 run、暂停、恢复；发送 webhook；观察 Task/Run/Session、dispatch 历史和失败诊断；Server 重启后不重复运行。

#### 关键决策

1. 单 Server 内轮询，不建独立 tick 进程，因为当前没有第二调度宿主变化点。
2. 追赶只支持跳过或补最近一次，避免恢复后任务风暴。
3. webhook 全部复用 H4 delivery，不另建入站鉴权、重放和平台 Adapter。
4. Worker 路由绑定 Placement，执行开始后不自动故障转移。

#### 为了轻量而不做

不做任意 DAG 编排、逐秒 cron、无限补跑、跨 Routine 依赖、动态脚本触发器、独立消息 Broker、多 Server leader election或透明跨 Worker 迁移。

### 2.3 G50 WhatNeedsMe 收件箱

#### 领域模型与不变量

```ts
export type AttentionKind = 'approval' | 'review' | 'assigned_task' | 'blocked_task' | 'failed_routine' | 'artifact_review'

export interface AttentionItem {
  readonly key: string
  readonly kind: AttentionKind
  readonly projectId: ProjectId
  readonly subject: { readonly kind: string; readonly id: string; readonly title: string }
  readonly reason: string
  readonly priority: 'normal' | 'aging' | 'urgent'
  readonly occurredAt: Timestamp
  readonly actionHref: string
  readonly availableActions: readonly string[]
}
```

AttentionItem 是只读派生，不拥有来源状态。首版“需要我”定义为：我可处理的 pending Approval/Review、明确分配给我的 Task、因我管理的上游阻塞而需要处理的 Task、失败且需人工处置的 Routine dispatch、等待我审查的 Artifact。退出条件由来源状态决定。

个人 dismissal 只隐藏非强制提示，记录 `(userId, attentionKey, sourceRevision, dismissedAt)`；来源 revision 变化后重新出现。Approval、Review 和权限/安全类事项不可永久 dismissal。

#### A3、审计与幂等

- 先按当前用户的 Team/Project 可见集合过滤，再读取来源，禁止先聚合标题后在 Web 隐藏。
- 纯读不审计；dismiss/restore 使用 requestId+fingerprint，审计 `attention.dismissed|restored`，资源锚到 Project。
- availableActions 由现有 capability 计算，Web 不自行猜角色。

#### Paperclip 参照与差异

参照：`ui/src/pages/WhatNeedsMe.tsx`、`ui/src/api/attention.ts`、`ui/src/lib/attention.ts`、`server/src/routes/attention.ts`、`server/src/services/attention.ts`、`packages/shared/src/types/attention.ts`。

Paperclip 聚合 company 内 approvals、interactions、decisions、join requests 等员工运营事项。Wemux 是集群协作平台，只聚合 Project/Task/Run/Session/Routine/Artifact 事实，不引入公司决策、雇佣、预算或员工状态。

#### API 与 wire

- `GET /api/me/attention?kinds=&projectIds=&priority=&cursor=&limit=` → `{ items, nextCursor, counts }`
- `POST /api/me/attention/:key/dismiss`
- `DELETE /api/me/attention/:key/dismiss`

无 wire 新消息，纯 Server 聚合。

#### 性能与验收

- `server-domain` 应用查询一次取得获权 Project ID，再以来源表的 status/assignee/project/time 索引做有界 union。
- 默认 50、最大 100；每类最多读取 `limit + 1`，禁止全表加载后前端过滤。
- 单元/集成：跨 Project、权限撤销、dismiss revision、稳定排序、空态、1000 条来源的查询计划。
- 真实浏览器：两个 Team 的事项不串；筛选、分组、键盘打开；从收件箱处理后项目内与收件箱同时消失；窄屏可完成主操作。

#### 关键决策

1. 放在 `server-domain` 应用查询，不建 Attention 权威表。
2. availableActions 使用后端 capability，不让 Web 复制 A3 规则。
3. dismissal 是个人视图偏好，不改变领域状态。

#### 为了轻量而不做

不做邮件摘要、智能优先级模型、SLA aging 自动升级、共享收件箱、规则编辑器或实时推送；首版 15-30 秒轮询与窗口聚焦刷新。

### 2.4 G51 Skill Studio

#### 领域模型与不变量

```ts
export interface Skill {
  readonly id: string
  readonly projectId: ProjectId
  readonly slug: string
  readonly name: string
  readonly status: 'draft' | 'published' | 'archived'
  readonly latestRevision: number
  readonly createdBy: UserId
}

export interface SkillRevision {
  readonly skillId: string
  readonly revision: number
  readonly contentSha256: string
  readonly manifest: {
    readonly description: string
    readonly entryFile: 'SKILL.md'
    readonly compatibleAgents: readonly AgentKey[]
    readonly containsExecutableFiles: boolean
  }
  readonly files: readonly { readonly path: string; readonly sha256: string; readonly size: number; readonly mediaType: string }[]
  readonly createdAt: Timestamp
}

export interface SkillBinding {
  readonly skillId: string
  readonly projectId: ProjectId
  readonly agentKey: AgentKey
  readonly workerIds: readonly WorkerId[]
  readonly selectedRevision: number
  readonly revision: number
  readonly enabled: boolean
}
```

存储裁定为 DB 元数据加 Server 管理文件目录，而不是 Project 仓库目录：

- SQLite 保存 Skill、revision、manifest、文件清单、binding、request identity 和 distribution 状态。
- 内容写入 Server data 下的内容寻址目录 `skills/blobs/<sha256>`，原子 staging 后发布。备份必须把数据库和该目录作为同一恢复集。
- 不写入用户 Git 仓库，避免平台编辑无意污染代码历史、不同 Worker checkout 不一致及删除语义混乱。
- 单 revision 总大小首版 1 MiB，最多 64 文件，路径规范化且禁止 `..`、绝对路径和符号链接。
- 首版拒绝 executable 文件和外部网络 import，只允许 Markdown、文本、JSON 和小型静态资源。出现可信脚本技能需求后另做低信任执行设计。

与 Agent 原生 skills 的边界：Wemux Skill 是 Project 级、版本化、可授权分发的执行资产；Pi/Claude/OpenCode 原生 skill 目录是 Agent Adapter 的消费形式。平台不扫描、接管或改写用户全局 `~/.pi`、`.claude` 等目录，也不声称所有 Agent 语义相同。

注入时机裁定为 launch preparation，不把全文塞入 `RunRequest.launchContext`：Worker 收到不可变 Skill revision 后物化到 `<worker-home>/skills/cache/<skillId>/<revision>/`，每次启动 Invocation 前创建 Session/Invocation 专用只读视图，并由 Agent Adapter 把目录路径或生成的简短索引加入 launch context。结束后清理视图，缓存按引用和 LRU 回收。

#### A3、审计与幂等

- Project manager 创建、发布、归档、绑定；contributor 可读取并在获权 Session 中使用已发布 binding；分发还要求目标 Worker manage，执行要求 Worker use。
- Skill 只能收窄现有 Agent 能力，不能授予 Secret、网络、Connector 或文件范围。
- create/update/publish/bind/distribute 均使用 requestId+fingerprint；Skill/Binding 更新带 expectedRevision。
- 审计记录 revision hash、文件数量和目标 Worker，不记录完整 Skill 内容。

#### Paperclip 参照与差异

参照：`ui/src/pages/SkillStudio.tsx`、`server/src/routes/company-skills.ts`、`server/src/services/company-skills.ts`、`server/src/services/runtime-skill-selections.ts`、`server/src/services/runtime-skill-cache.ts`、`server/src/services/company-skill-policy.ts`、`packages/db/src/schema/company_skills.ts`。

借鉴目录、版本、策略和运行时注入。不同点：Wemux 以 Project 而非 company 为范围；首版不扫描几十种第三方目录、不从 GitHub/URL 导入、不接受 executable scripts；分发必须跨 Server/Worker 双宿主，并保持 Server 不读取 Worker 全局 Agent 配置。

#### API 与 wire

- `GET /api/projects/:projectId/skills?status=&cursor=&limit=`
- `POST /api/projects/:projectId/skills`
- `GET /api/projects/:projectId/skills/:skillId`
- `POST /api/projects/:projectId/skills/:skillId/revisions`
- `POST /api/projects/:projectId/skills/:skillId/publish`
- `POST /api/projects/:projectId/skills/:skillId/archive`
- `PUT /api/projects/:projectId/skills/:skillId/bindings/:agentKey`
- `POST /api/projects/:projectId/skills/:skillId/distribute`
- `GET /api/projects/:projectId/skills/:skillId/distributions`

wire 新增：`skill.revision.sync`、`skill.revision.revoke`、`skill.revision.report`。Command 携带 manifest 与受上限约束的文件内容或分块引用，不携带 Secret。领域身份固定为 `(skillId, revision, workerId)`；重连重放同一 commandId。

#### 验收

- 包测试：路径穿越、hash、revision 不可变、CAS、大小/文件数上限、归档与引用。
- Worker：断点重放、原子物化、校验失败不激活、并发 Invocation 隔离、清理与 LRU、Agent 不支持 skills 时明确 unavailable。
- 真实浏览器：编辑、发布、绑定 Pi、分发两 Worker；在 Session 中证明 launch 使用固定 revision；发布新 revision 不影响运行中 Invocation；撤权后新 Invocation 不再注入。

#### 关键决策

1. DB 记录加内容寻址文件，不写 Project 仓库，因为平台资产生命周期不同于用户代码。
2. 平台 Skill 不替代 Agent 原生 skills，只通过 Adapter 提供目录或索引。
3. 在 launch preparation 物化并固定 revision，不在运行中热替换。
4. 首版只允许静态内容，不接收可执行脚本和远程 import。

#### 为了轻量而不做

不做 Skill marketplace、跨 Team 全局库、自动 Git 同步、在线脚本执行、自动抓取第三方 skill、语义搜索、多人实时编辑或 Agent 原生 skill 反向导入。

### 2.5 G52 Artifacts 交付物

#### 领域模型与状态机

```ts
export interface Artifact {
  readonly id: string
  readonly projectId: ProjectId
  readonly taskId: string
  readonly runId: string
  readonly sessionId: SessionId
  readonly workspaceId: WorkspaceId
  readonly workerId: WorkerId
  readonly path: string
  readonly pathFingerprint: string
  readonly mediaType: string
  readonly size: number | null
  readonly contentSha256: string | null
  readonly title: string
  readonly revision: number
  readonly createdAt: Timestamp
  readonly availability: 'available' | 'worker_offline' | 'missing' | 'changed'
}

export interface ArtifactReview {
  readonly artifactId: string
  readonly status: 'requested' | 'approved' | 'changes_requested' | 'superseded'
  readonly reviewerId: UserId | null
  readonly note: string | null
  readonly revision: number
  readonly requestedAt: Timestamp
  readonly decidedAt: Timestamp | null
}
```

Artifact 是对 Workspace Placement 文件的受控引用，不复制文件正文到 Server。创建时 Worker 返回规范化相对路径、stat、可选 SHA-256；下载或预览仍走 session-files/Worker file gateway，并重新验证 `(workspaceId, workerId, path)` 与当前权限。文件变化时不静默更新原 Artifact，标记 `changed`，用户可创建新 Artifact revision 或接受新 hash。

审查状态机：`requested -> approved | changes_requested`，重新提交生成新的 Artifact revision，并将旧 review 标 `superseded`。Artifact Review 评价单个交付物，M5 Run Review 评价整次 Run/Task 验收。所有必要 Artifact approved 可以成为 Run Review 的证据，但不得自动 approve Run；Run changes_requested 可让相关 Artifact 保持历史状态，不反向改写。

#### A3、审计与幂等

- 创建 Artifact 要求 Task/Run 可读、Session write、Project contributor、目标 Worker use；审查要求现有 Run Review capability 或 Project manager。
- 下载与预览每次重新检查 Project、Session、Worker 权限，不因持有 Artifact ID 绕过 A3。
- 创建 `{ requestId, fingerprint(runId,path,expectedHash,title) }`；更新标题、请求审查、决定均带 expectedRevision。
- 审计只记 path hash、mediaType、size、runId、review 状态，不记文件正文。

#### Paperclip 参照与差异

参照：`ui/src/pages/Artifacts.tsx`、`server/src/routes/companies.ts` 中 artifacts 路由、`server/src/services/company-artifacts.ts`、`server/src/services/artifact-review-documents.ts`。

Paperclip 聚合 documents、work products、attachments 并按 issue 分组。Wemux 首版只接受明确登记的 Run 文件引用，不把所有 Workspace 文件自动变成 Artifact，不建立第二份对象存储。这样符合 Worker 文件权威和不同 Placement 不隐式同步的原则。

#### API 与 wire

- `GET /api/projects/:projectId/artifacts?taskId=&runId=&reviewStatus=&mediaType=&cursor=&limit=`
- `POST /api/projects/:projectId/tasks/:taskId/runs/:runId/artifacts`
- `GET /api/projects/:projectId/artifacts/:artifactId`
- `PATCH /api/projects/:projectId/artifacts/:artifactId`
- `POST /api/projects/:projectId/artifacts/:artifactId/reviews`
- `POST /api/projects/:projectId/artifacts/:artifactId/review-decisions`
- `GET /api/projects/:projectId/artifacts/:artifactId/content`
- `GET /api/projects/:projectId/artifacts/:artifactId/preview`

复用现有 `fs.request/fs.response`；补充 `stat` 和可选流式 download 操作，requestId 稳定且带最大字节上限。不要把文件内容放入可靠 outbox 或 Audit。若先以现有 `read(maxBytes)` 实施，首版下载上限必须明确，不伪装支持大文件。

#### 验收

- 文件路径规范化、跨 Workspace/Worker 拒绝、文件缺失/变化、离线、hash 校验、权限撤销、审查状态与幂等。
- 验证 Artifact Review 不自动改变 Task/Run Review；Task done 仍需人工决策。
- 真实浏览器：从 Run 登记报告与截图，在聚合页筛选、预览、下载、要求修改、重新提交；Worker 离线和文件变化有真实状态；无权用户无法通过直链获得标题或内容。

#### 关键决策

1. 引用不复制，因为 Worker Workspace 是文件权威，Server 只保存安全元数据。
2. Artifact Review 与 Run Review 分层，不互相自动终结。
3. 内容访问复用 session-files，新增能力只是 stat/有界流式下载。

#### 为了轻量而不做

不做 Server 对象存储、自动扫描全部文件、跨 Worker 文件同步、Office 在线预览、病毒扫描平台、永久 CDN、Artifact 内评论线程或公开分享链接。

### 2.6 G53 Activity Timeline

#### 领域模型与不变量

```ts
export interface TimelineItem {
  readonly cursor: string
  readonly occurredAt: Timestamp
  readonly projectId: ProjectId | null
  readonly actor: { readonly kind: 'user' | 'agent' | 'channel' | 'system'; readonly id: string | null; readonly label: string }
  readonly action: string
  readonly subject: { readonly kind: string; readonly id: string; readonly label: string }
  readonly summary: string
  readonly result: 'succeeded' | 'failed' | 'informational'
  readonly href: string | null
}
```

来源是现有 `AuditEntry`、Task Activity、Run 投影、Channel delivery 终态与必要的 Session 管理事件。Timeline 不读取或展示完整聊天、tool input/output、Secret、邮箱 token 或文件正文。相同领域动作同时出现在 Audit 和 Task Activity 时，以稳定 `sourceKey` 去重，保留更适合人的摘要。

#### A3、审计与幂等

Timeline 是读模型，不审计“看过”。查询先根据 A3 得到可见 Project/Session/Worker，再 union；实例级账号安全审计继续留在账号审计页，不默认混入 Project Timeline。新增写操作不属于 Timeline。

#### Paperclip 参照与差异

参照：`ui/src/pages/Timeline.tsx`、`server/src/routes/activity.ts`、`server/src/services/activity.ts`、`server/src/services/activity-log.ts`、`packages/db/src/schema/activity_log.ts`。

借鉴跨 actor、project、时间窗的活动展示。不同点：Wemux 不新增通用 activity 采集总线，先投影既有 Audit/Task/Run/Channel 事实；不采用公司员工甘特隐喻，主视图是按时间倒序的事件流，可按 Worker/Agent/Project 筛选。

#### API 与 wire

- `GET /api/timeline?projectId=&actorKind=&actorId=&subjectKind=&from=&to=&cursor=&limit=` → `{ items, nextCursor }`
- `GET /api/projects/:projectId/timeline?...` → 同形状

无 wire 新消息。Worker 领域活动必须先通过已有 Journal/report 成为 Server 可验证事实，Timeline 不直接订阅 Provider 原生事件。

#### 性能与验收

- SQLite 为 Audit `(occurredAt,id)`、Task project activity cursor、Channel `(projectId,updatedAt)` 增加窄索引。
- 每来源先应用权限和时间范围，再各取 `limit+1`，应用层归并，不做无界全表 JSON 解析。
- 单元/集成：去重、脱敏、跨 Team 隔离、同时间稳定排序、cursor、30/100 上限。
- 真实浏览器：执行 Task/Run Review、Channel 入站、Artifact 审查后时间线出现可导航摘要；轮询刷新不打断滚动；无权 Project 不出现在筛选项和结果。

#### 关键决策

1. Timeline 是安全投影，不是新的事件源或审计表。
2. 聚合位于 `server-domain` 应用查询，SQLite Adapter 负责有界来源读取。
3. 首版轮询，不新增 SSE 事件种类；需要实时性的证据出现后再复用现有授权 SSE。

#### 为了轻量而不做

不做实时推送、任意报表构建器、长期分析仓库、全文聊天索引、跨实例聚合、甘特排程或用户可定义事件 schema。

### 2.7 G54 Evals 评测

#### 领域模型与状态机

```ts
export interface EvalSuite {
  readonly id: string
  readonly projectId: ProjectId
  readonly name: string
  readonly revision: number
  readonly status: 'draft' | 'active' | 'archived'
  readonly cases: readonly EvalCase[]
}

export interface EvalCase {
  readonly id: string
  readonly name: string
  readonly input: string
  readonly expected: EvalExpectation
  readonly timeoutMs: number
}

export type EvalExpectation =
  | { readonly kind: 'exact_text'; readonly value: string }
  | { readonly kind: 'contains'; readonly values: readonly string[] }
  | { readonly kind: 'json_shape'; readonly schema: Readonly<Record<string, unknown>> }
  | { readonly kind: 'manual'; readonly rubric: string }

export interface EvalCandidate {
  readonly agentKey: AgentKey
  readonly modelId: ModelId | null
  readonly skillRevisions: readonly { readonly skillId: string; readonly revision: number }[]
  readonly workerId: WorkerId
  readonly workspaceId: WorkspaceId
}

export type EvalRunStatus = 'queued' | 'running' | 'scoring' | 'completed' | 'failed' | 'cancelled' | 'ownership_unverified'

export interface EvalScore {
  readonly caseId: string
  readonly scorer: 'deterministic' | 'manual'
  readonly value: number | null
  readonly passed: boolean | null
  readonly explanation: string | null
}
```

执行面在 Worker，复用 `AgentRunner`：每个 case 创建隔离的 Eval Session 与 Invocation，使用固定 candidate 和 Skill revision；不复用用户聊天 Session，不读取其 Journal。首版顺序执行，每个 Eval Run 最多 50 cases，每 Worker 并发 1 个 Eval Run，避免与交互会话争抢。

评分存储：

- 确定性 scorer 在 Server 对有界结构化输出评分并保存输入 expectation、candidate snapshot、分数和摘要。
- manual scorer 保存 rubric 与人工决定。
- 首版不使用 LLM-as-judge，避免新增模型凭证、非确定性和隐藏成本。后续若增加，必须作为真实第二 scorer Adapter，并记录 judge model/version/prompt hash。
- 原始 Agent Journal 留在 Worker Eval Session；Server 保存有界结果摘要、usage、terminal reason 与必要证据引用，不复制完整 chain-of-thought。

Skill 关联通过 candidate 固定 revision。Skill 更新后旧 Eval Run 可复现原 snapshot；比较视图以 `(suiteRevision, candidateFingerprint)` 为单位。

#### A3、审计与幂等

- Suite CRUD 要求 Project manager；启动 Eval 要求 contributor、Worker use、Workspace 和 Agent 可执行；查看结果要求 Project viewer。
- Skill binding 不能扩大 Candidate 权限，Eval Session capability 采用最小默认：无 Channel、无 destructive Connector、无外部 Secret。需要工具的 suite 必须显式声明并经过现有 capability/approval；无人审批时失败关闭。
- start/cancel/manual-score 使用 requestId+fingerprint；Suite 更新带 expectedRevision；case/run identity 不因重试变化。
- 审计：`eval.suite.created|published|run.started|run.cancelled|manual_score.recorded`，不写完整输入输出。

#### Paperclip 参照与差异

参照：`packages/paperclip-eval-kernel/README.md`、`packages/paperclip-eval-kernel/src/index.ts`、`packages/paperclip-runner/src/eval/eval-execution.ts`、`packages/paperclip-runner/src/eval/eval-scoring.ts`、`packages/paperclip-runner/src/eval/eval-bundle.ts`。

借鉴 provider-neutral matrix orchestrator、candidate preflight 与 execution/scoring 分离。不同点：Wemux 的执行单元是 Worker 上的 `AgentRunner` 和隔离 Session，不引入独立 runner 产品协议；首版 scorer 为确定性或人工，不建设 corpus marketplace、CI 发布通道或云端排行榜。

#### API 与 wire

- `GET /api/projects/:projectId/evals/suites?cursor=&limit=`
- `POST /api/projects/:projectId/evals/suites`
- `GET /api/projects/:projectId/evals/suites/:suiteId`
- `PATCH /api/projects/:projectId/evals/suites/:suiteId`
- `POST /api/projects/:projectId/evals/suites/:suiteId/runs`
- `GET /api/projects/:projectId/evals/runs?cursor=&limit=`
- `GET /api/projects/:projectId/evals/runs/:runId`
- `POST /api/projects/:projectId/evals/runs/:runId/cancel`
- `POST /api/projects/:projectId/evals/runs/:runId/cases/:caseId/manual-score`

wire 新增 `eval.run.start`、`eval.run.cancel`、`eval.run.progress`、`eval.run.settled`。start 只携带 suite revision snapshot、candidate refs、有限 case 输入和 capability reference；若 payload 超上限则先分发 immutable eval bundle，再引用 bundle hash。终态以领域 report 为准，不以 ACK 代替。

#### 验收

- 纯内核：矩阵展开、candidate fingerprint、确定性 scorer、manual 状态、上限、取消、同 requestId 重放。
- Worker：复用真实 `AgentRunner` test adapter，随后用 Pi/OpenCode 各至少一组无副作用 suite；Agent 不可用不阻止 Worker 上线。
- 恢复：Server/Worker 重启、ownership_unverified、已完成 case 不重复，未证明终止的 case 不自动重跑。
- 真实浏览器：创建 suite，选择两个 candidate，其中一个绑定 Skill revision；运行、取消、人工评分、比较结果；无权用户看不到 case 输入与输出摘要。

#### 关键决策

1. Worker 上执行并复用 `AgentRunner`，不在 Server 或浏览器调用模型。
2. execution 与 scoring 分离，首版只有确定性和人工 scorer。
3. Skill 以不可变 revision 进入 candidate snapshot，便于回归比较。
4. Eval Session 与用户 Session 隔离，默认最小 capability。

#### 为了轻量而不做

不做 LLM-as-judge、云端排行榜、海量 corpus、自动 CI gate、分布式并行矩阵、跨 Project 数据集、训练或微调、费用优化器。

## 三、跨功能关键设计决策汇总

### 3.1 权威与投影

- Approvals、WhatNeedsMe、Timeline 均为跨实体只读投影。删除投影模块后，跨表权限、游标、脱敏和去重复杂度会散落到三个页面，因此 F1 是有深度的 Module。
- 投影不反向拥有来源生命周期。所有动作都调用来源应用接口，不允许直接 update 来源表。
- 首版查询时聚合。只有真实查询计划和延迟证据证明不足时，才增加某一来源的增量 projection table，不建通用 event sourcing 平台。

### 3.2 幂等、CAS 与审计

- HTTP 写请求：`requestId` 标识意图，`fingerprint` 绑定语义，`expectedRevision` 防止覆盖新状态。
- 定时/入站：cron window、H4 delivery、API idempotency key 分别是稳定触发身份。
- Worker 执行：`commandId/messageId` 仍只承担既有职责，Routine/Eval/Skill 使用自己的领域身份。纯 transport ACK 不重新入队。
- 所有决策、启停、发布、分发、审查、手工重试与取消进入 Audit；高频读、轮询和 scheduler 空 tick 不写审计。

### 3.3 授权矩阵

| 动作 | Project | Worker | Session/Task |
|---|---|---|---|
| 读聚合列表 | viewer | 仅展示 Worker 细节时 use | 对应资源 read |
| Approve/Review | 来源 capability | 涉及执行时 use | Session control 或 Review capability |
| Routine 管理 | manager | 指定 Worker 时 manage | 模板 Task 可管理 |
| Routine/Eval 执行 | contributor | use | Session write，Task launch capability |
| Skill 管理/绑定 | manager | 分发时 manage | Invocation 使用时 write |
| Artifact 登记 | contributor | use | Session write + Run 可读 |
| Artifact 审查 | Review capability 或 manager | 无额外要求 | Task/Run review capability |

任何一层撤权都不由其他层补足。系统身份调度也必须重新检查 Routine 创建者或责任人的当前授权。

### 3.4 一致性与恢复

- Server 本地 SQLite 事务内状态立即一致；Worker 来源通过可靠连接最终一致。
- 投影项带 `sourceRevision/freshness`；用户动作失败时返回权威冲突并刷新，不在 Web 乐观伪造终态。
- Routine/Eval 使用 lease、progress 和 ownership 证明。无法证明 owner 消失时进入 `ownership_unverified`，不自动重跑。
- Artifact 内容可因 Worker 离线、文件删除或变化而不可用，元数据历史仍保留。

## 四、分批实施计划与 G48-G54 映射

估时按一名熟悉仓库的工程师计，包含设计收口、迁移、单元/集成测试、真实浏览器脚本与验收摘要，不包含真实外部飞书环境申请。1 人日按 8 小时。

### 4.1 票据映射

| 票据 | 功能 | 主要里程碑 | 估时 |
|---|---|---|---:|
| G48 | Approvals | M5/M6 | 28-40h |
| G49 | Routines | M8 | 72-104h |
| G50 | WhatNeedsMe | M5/M8 | 24-32h |
| G51 | Skill Studio | M4/M8 | 56-80h |
| G52 | Artifacts | M5 | 40-56h |
| G53 | Activity Timeline | M6 | 20-28h |
| G54 | Evals | M4/M8 | 48-76h |
| 共同底座及跨批回归 | F1/F2/F3 契约、索引、证据 | M5/M6/M8 | 16-24h |
| **总计** | | | **304-440h，约 38-55 人日** |

批次共享可消除约 16-24h 重复工作，按并行人员排期时日历时间会小于串行人日，但关键路径仍经过 F1、G49 和 G51→G54。

### 4.2 批次一：F1 投影底座 + G48 Approvals + G53 Timeline

**目标**：先证明跨实体聚合模式、A3 过滤、稳定游标和来源动作路由。

**路径级交付物**：

- `packages/server-domain/src/projections.ts`
- `packages/web-contract/src/approvals.ts`
- `packages/web-contract/src/timeline.ts`
- `apps/server/src/application/cross-entity-projection-service.ts`
- `apps/server/src/application/approval-decision-router.ts`
- `apps/server/src/application/ports/cross-entity-projection-repository.ts`
- `apps/server/src/storage/sqlite/cross-entity-projection-repository.ts`
- `apps/server/src/http/routes/approval-routes.ts`
- `apps/server/src/http/routes/timeline-routes.ts`
- `apps/web/src/features/approvals/`
- `apps/web/src/features/timeline/`
- `apps/e2e/approvals-timeline.test.ts`
- `docs/acceptance/feature-suite-batch-1.md`

**验收标准**：G48/G53 各节全部断言；跨 Team 无标题泄漏；Task Review 和 Session approval 真实决策；审计/活动去重；浏览器桌面和窄屏；轮询不破坏当前滚动位置。

**估时**：64-92h，其中 F1 16-24h、G48 28-40h、G53 20-28h。G48 与 G53 在 F1 契约完成后可并行。

### 4.3 批次二：G50 WhatNeedsMe + G52 Artifacts

**目标**：把聚合模式扩展为个人工作入口，并建立 Run 交付物引用与审查闭环。

**路径级交付物**：

- `packages/domain/src/artifact.ts`
- `packages/server-domain/src/attention.ts`
- `packages/server-domain/src/artifacts.ts`
- `packages/web-contract/src/attention.ts`
- `packages/web-contract/src/artifacts.ts`
- `packages/wire-protocol/src/files.ts` 的 stat/有界 download 扩展
- `apps/server/src/application/attention-service.ts`
- `apps/server/src/application/artifact-service.ts`
- `apps/server/src/application/ports/artifact-repository.ts`
- `apps/server/src/storage/sqlite/artifact-repository.ts`
- `apps/server/src/http/routes/attention-routes.ts`
- `apps/server/src/http/routes/artifact-routes.ts`
- `apps/worker/src/application/workspace-artifact-files.ts`
- `apps/web/src/features/attention/`
- `apps/web/src/features/artifacts/`
- `apps/e2e/attention-artifacts.test.ts`
- `docs/acceptance/feature-suite-batch-2.md`

**验收标准**：个人事项权限和 dismissal revision；Artifact 引用不复制；文件变化/离线/撤权；Artifact Review 与 Run Review 分层；真实浏览器处理事项和交付物全链路。

**估时**：64-88h。G50 与 G52 可并行，最终由统一浏览器场景收口。

### 4.4 批次三：G49 Routines

**目标**：交付可恢复、可授权、复用 H4 的受控自动化闭环。

**路径级交付物**：

- `packages/domain/src/routine.ts`
- `packages/server-domain/src/routines.ts`
- `packages/web-contract/src/routines.ts`
- 仅在现有 Run seam 不足时扩展 `packages/wire-protocol/src/commands.ts` 与 `messages.ts`
- `apps/server/src/application/routine-service.ts`
- `apps/server/src/application/routine-scheduler.ts`
- `apps/server/src/application/routine-dispatcher.ts`
- `apps/server/src/application/ports/routine-repository.ts`
- `apps/server/src/storage/sqlite/routine-repository.ts`
- `apps/server/src/http/routes/routine-routes.ts`
- `apps/server/src/application/channel-router.ts` 的 Routine target 扩展
- `apps/web/src/features/routines/`
- `apps/e2e/routines.test.ts`
- `docs/operations/routines.md`
- `docs/acceptance/feature-suite-batch-3.md`

**验收标准**：cron/DST、两种 catch-up、三种 concurrency、H4 重放、双 Worker 路由、Server/Worker 重启、ownership_unverified、权限撤销、Run 成功不自动 done、浏览器诊断与重试。

**估时**：72-104h。调度内核、Web 和 H4 target Adapter 可在合同冻结后局部并行，恢复矩阵必须统一验收。

### 4.5 批次四：G51 Skill Studio + G54 Evals

**目标**：建立 Project 级可版本化执行资产，并用真实 Agent 执行面验证回归评测。

**路径级交付物**：

- `packages/domain/src/skill.ts`
- `packages/domain/src/eval.ts`
- `packages/server-domain/src/skills.ts`
- `packages/server-domain/src/evals.ts`
- `packages/web-contract/src/skills.ts`
- `packages/web-contract/src/evals.ts`
- `packages/wire-protocol/src/skills.ts`
- `packages/wire-protocol/src/evals.ts`
- `apps/server/src/application/skill-service.ts`
- `apps/server/src/application/eval-service.ts`
- `apps/server/src/application/ports/skill-repository.ts`
- `apps/server/src/application/ports/eval-repository.ts`
- `apps/server/src/storage/sqlite/skill-repository.ts`
- `apps/server/src/storage/sqlite/eval-repository.ts`
- `apps/worker/src/skills/skill-cache.ts`
- `apps/worker/src/skills/skill-injector.ts`
- `apps/worker/src/evals/eval-executor.ts`
- `apps/web/src/features/skills/`
- `apps/web/src/features/evals/`
- `apps/e2e/skills-evals.test.ts`
- `docs/operations/skills-and-evals.md`
- `docs/acceptance/feature-suite-batch-4.md`

**验收标准**：Skill immutable revision、内容 hash、原子物化、Pi/OpenCode 支持差异、撤权、Eval matrix/scoring/cancel/recovery、candidate 固定 Skill revision、真实浏览器比较结果。真实 Agent 验收记录版本、环境、成本和跳过原因，模拟结果不得写成生产支持。

**估时**：104-156h，其中 G51 56-80h、G54 48-76h。Eval 内核可先用 test Agent 并行，真实 Skill candidate 集成依赖 G51。

### 4.6 里程碑挂接与总排期

- M4：G51 Skill Studio、G54 Evals 的 Agent 能力、诊断和执行适配；未安装/未认证只使 candidate unavailable。
- M5：G48 Task Review 聚合、G50 任务待办、G52 交付物和审查。
- M6：G53 面向人的审计时间线及七件套所有新入口的 A3、PAT scope、撤权与安全审计。
- M8：G49 Routines、G50 自动化处置、G51 Skill 注入、G54 回归评测。

串行总估时为 304-440h，约 38-55 人日。两条实现线可将日历周期压缩到约 6-9 周：线 A 负责 F1/G48/G53/G50/G52，线 B 在合同冻结后负责 G49，再负责 G51/G54；跨宿主 wire、迁移和最终浏览器验收不得并行合并写同一共享文件。

## 五、风险、轻量边界与 Paperclip 差异

### 5.1 共同风险

| 风险 | 影响 | 控制 |
|---|---|---|
| 聚合查询绕过 A3 | 跨 Team 标题/状态泄漏 | 授权在 Server 应用查询中先行，Web 不做安全过滤；负面测试覆盖搜索、游标和直链 |
| JSON 存储导致无界扫描 | Timeline/Inbox 延迟和内存上涨 | 窄索引、每来源 limit+1、有界 union、查询计划测试；无证据不建通用物化层 |
| Worker 最终一致造成陈旧动作 | 重复或错误审批 | sourceRevision/freshness、来源域 CAS、冲突后刷新 |
| 自动化重复副作用 | 重复 Run、工具或外部写入 | durable receipt、fingerprint、scope lock、稳定 command/domain identity、ownership_unverified |
| Skill/Artifact 文件与 DB 不一致 | 丢内容或悬空引用 | staging+hash+原子发布、联合备份；Artifact 访问时重新 stat |
| Eval 与交互负载争抢 | 用户 Session 卡顿 | Worker 并发限额、最低优先级、可取消、能力目录显示负载 |
| 新功能膨胀 wire | 协议升级和重连复杂 | 优先复用现有 Run/fs/Session 命令；只有 Worker 必须知道的不可变引用进入 wire |

### 5.2 每功能明确不做

- Approvals：不做统一审批引擎、SLA、升级链、多签、自定义工作流。
- Routines：不做工作流 DAG、逐秒 cron、全量 catch-up、独立 Broker、多 Server leader、透明迁移。
- WhatNeedsMe：不做智能排序、邮件摘要、共享队列、实时推送和规则编辑器。
- Skill Studio：不做 marketplace、外部 URL/Git 自动导入、可执行脚本、全局 Agent 配置接管、实时协同编辑。
- Artifacts：不做对象存储、跨 Worker 文件复制、全部文件自动发现、公开分享、复杂在线预览。
- Timeline：不做新采集总线、全文聊天、分析仓库、实时推送、甘特排程。
- Evals：不做训练、LLM judge、云排行榜、海量 corpus、分布式矩阵和自动 CI gate。

### 5.3 与 Paperclip 的总差异声明

Paperclip 把 Agent 作为公司员工运营，许多功能围绕 company、issue、employee、heartbeat 展开。Wemux 是 Team/Project 下的分布式 Agent 集群与协作平台，核心差异是 Server 控制面、Worker 执行面、Workspace Placement、Session 持续上下文和 A3 权限交集。因此：

1. 不引入 company/employee/雇佣/预算隐喻，统一映射到 Project、Worker、Agent、Task、Run、Session。
2. 不复制 Paperclip 的统一 approvals 权威表，保留各域权威并做聚合。
3. 不复制 heartbeat 巨型服务，Routines 只借 durable receipt、CAS 签出、revision、catch-up 和恢复语义。
4. 不把 Server 变成文件或 Agent Runtime，Skill/Eval/Artifact 需要 Worker 的部分都通过明确 wire 和 Adapter 完成。
5. 不新建 webhook 系统，所有外部入站复用 H4 Channel、delivery 防重放、binding 与 outbox。
6. 不以“轻量”为由删除幂等、审计、恢复、授权或真实浏览器验收；轻量只限制不必要依赖和没有真实变化点的抽象。

### 5.4 设计退出门槛

G48-G54 各票据开工前必须把本文对应 TypeScript 形状冻结为可编译合同，并补齐：

1. 错误码、默认/最大 limit、payload/file/case 上限。
2. A3 capability 表与撤权后的在途行为。
3. requestId/fingerprint/CAS 决策表。
4. SQLite migration、索引与升级/回滚说明。
5. wire allowlist、版本兼容和 Secret/正文禁止字段扫描。
6. 可重复浏览器脚本路径、动态端口、失败/跳过记录和脱敏验收摘要。

只有合同、行为测试、真实浏览器操作和恢复场景都通过，票据才能标记已验收。文档、类型或静态页面单独完成不代表功能交付。
