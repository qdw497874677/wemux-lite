# Task Platform 权威契约裁定（Ticket 01）

状态：Ticket 01 的后续实现依据；本文件是 spec、交互架构、实施方案、视觉设计与 CONTEXT 残留冲突的唯一裁定入口。父 spec `docs/specs/0001-task-board-agent-platform.md` 保留原文，不删除、不改写。冲突处以本文件为准，未冲突部分继续遵循父 spec。这里冻结的是实现契约与 M1 共享 DTO 代码，不代表 Task API 或业务已交付；Ticket 01 不实现 Ticket 02+。

## 1. 身份、尝试与启动

- Task 是人的工作单元；Session 是对话执行现场；Run 是一次 launch 初始消息所对应的单 Turn 执行尝试，三者不等同。独立追加 Session 消息不归属 Run，也不延长 Run 生命周期。
- Assignment `{workspaceId, workerId, agentKey, modelId}` 可变，只影响后续执行；Run 从实际 Session binding 固化不可变快照。一个 Task 至多一个 pending/running/cancelling Run，服务校验与数据库唯一约束共同保证。任务完成永远由人决定；成功只建议审查。
- 裁定替代父 spec 的“task_id + 内容指纹唯一”“相同内容必须修改才能重跑”：LaunchRequest 增加客户端生成的 `requestId`，幂等身份是 `(taskId, requestId)`，不是内容。新尝试生成新 requestId，允许完全相同 Prompt；网络重试、双击、响应丢失重试必须保留原 requestId 及完整请求。客户端在确认启动时生成并保存身份，不能每次 HTTP 重试重新生成。
- `attempt` 由 Server 在成功创建新 Run 的事务内按 Task 分配递增整数（从 1 开始），不是客户端输入；回滚不消耗 attempt，幂等命中不递增。`(task_id, attempt)` 与 `(task_id, request_id)` 唯一；内容 fingerprint 不唯一。
- 请求 fingerprint 使用 SHA-256，对固定序列 `[mode, prompt, reuseSessionId, [workspaceId, workerId, agentKey, modelId]]` JSON 编码；new 的 reuseSessionId 规范为 null；完整 Prompt 保留原文，不以 trim 后文本合并身份。校验空白 Prompt 时可以 trim 判空但不改请求内容。保存原请求、fingerprint、Run/Session/create-command/enqueue-command/message/turn/cancel-command 映射。
- 顺序：鉴权、Task 归属、请求结构校验 → 按 requestId 查历史 → 同身份同 fingerprint 返回原 Run（包括终态）；同身份不同 fingerprint 返回 409 → 未命中才检查确认的 Assignment 与当前值一致、Workspace ready、Worker 在线、Agent execution/available、已上报模型、活跃唯一性及 reuse 资格。重试命中不受后来的离线、改指派或其他活跃 Run 阻断。
- 一个 application 入口、一个 ServerStore 事务，创建 Run/Session、快照、初始 enqueue 与活动原子提交。禁止在事务中调用公共 createSession/enqueue/createWorkspace；使用接收 ServerStoreTx 的原语；提交后通知，失败不通知。事务内不得等待网络、Worker、Agent 或文件系统。
- Server 原子提交不是 Worker 原子执行。后续投递协调必须先确认 session.create accepted 才投 enqueue，不能持有事务等待回执。最终 rejected 映射 failed，保留历史与补偿诊断，不自动新建尝试。此协调是后续票工作，不是本票更改现有公共投递行为。

样例（后续 web-contract 生产端、消费端、测试必须同步采用）：

```json
{"requestId":"launch-01","mode":"new","prompt":"请实现验收标准","reuseSessionId":null,"assignment":{"workspaceId":"ws-1","workerId":"worker-1","agentKey":"pi","modelId":"provider::model"}}
```

`launch-01` 重放返回同 Run/attempt/command；改 Prompt 但仍用 `launch-01` → 409；执行完成后相同请求内容配 `launch-02` → 新 Run、attempt + 1。

## 2. reuse 与取消收敛

reuseSessionId 必须来自本 Task 历史 Run、同项目、未删除，binding 四字段与确认且当前有效的 Assignment 全等。Session 必须无运行 Turn、无排队消息、无未收敛取消、同步状态足以证明可接收。未知/离线/日志缺口不是空闲证明。不满足返回 409 并提示 new；不得悄悄换 Session 或修改 binding。new 也不能绕过 Task 活跃 Run 唯一性。

裁定收紧父 spec/实施方案的“停止 accepted 即 cancelled”：accepted 只表示持久受理，不证明停止；Run 保持 cancelling，直到所属消息的取消 Journal 或所属 turn.finished 证明执行已收敛，才进入 cancelled 并释放活跃约束。否则 accepted 后允许 new 会形成同 Task 两个实际执行。

| 事件 | Run 处理 |
|---|---|
| launch 提交 | pending |
| 创建/入队 accepted | 保持 pending |
| 关联 turn.started | running；若已有取消意图保持 cancelling 并补发 stop |
| 关联 turn.finished，未有取消意图 | completed → succeeded；failed/cancelled → failed |
| 用户 cancel，尚未终态 | 同事务写取消意图及取消命令，cancelling |
| cancel-queued/stop accepted | 保持 cancelling，等待 Journal |
| 所属排队消息确认取消 / 所属 turn.finished，已有取消意图 | cancelled |
| 创建/入队最终 rejected，无取消意图 | failed；已有取消意图且已证明未执行则 cancelled |
| 取消命令 rejected | 保持 cancelling，提示重试并重新核对 Journal |
| Worker 掉线/日志缺口 | 不猜终态，恢复投递和补传 |
| 终态后的迟到/重复事件 | 不回退，只补诊断 |

取消只针对 Run 初始 enqueue：未开始用现有 session.cancel-queued(submissionCommandId)，已开始用 turn.stop(turnId)；取消排队与启动竞态由 Journal 识别后补 stop，不清空独立消息。单独停止当前 Turn 不是取消 Run 意图。完成先提交则 cancel 返回原终态；取消先提交则完成收敛 cancelled。同事务 CAS 串行决议。归属链严格为 message.queued(commandId,messageId) → turn.started(messageId,turnId) → turn.finished(turnId)，不能把同 Session 任意事件算给 Run。按 `(sessionId,seq)` 去重、有序补齐，投影与游标原子提交。无新增 wire 字段或 Worker 改动。

### Ticket06 implementation checkpoint (in-progress)

Explicit independent task Session creation is permitted while the Task has a pending/running Run: it creates a separate Session with immutable taskId and runId:null, not another Run, so the one-active-Run constraint is unaffected. Messages in that separate Session do not belong to the Run and are not targets of its cancellation. Launching another Run still requires no active Run. The Web creation control remains available after launch, and provides a direct conversation link.

Ticket06 cleanup extends the existing command union with `session.delete(sessionId)`: Server tombstones the proven-idle Session and durably queues cleanup in the same transaction; Worker atomically rejects active/queued work, removes Session Journal/queue/turn state, retains command deduplication records and a deletion tombstone, and never recreates that Session on late create replay. There is no separate persistent Worker outbox/cursor table: Journal is the replay source and cursor derives from it. This narrowly supersedes the earlier no-Worker/wire-change restriction for Session cleanup only. Run cancellation still uses unchanged cancel-queued/turn.stop fields.

Run cancel uses existing wire commands with HTTP body `{runId, sessionId, requestId}`; acceptance is not terminal proof. Request identities are persisted in `run_cancel_requests`; stable per-target cancel command IDs survive retries/replay. Session soft deletion preserves Run records/snapshots and rejects active or unproven-idle execution. This checkpoint is not acceptance: rejected cancellation recovery, Session association semantics, deletion activity/cleanup and responsive boundaries remain open. Evidence and P0–P2 blockers: `.scratch/task-board-agent-platform/evidence/ticket-06/current/status.md`.

## 3. 绑定事实源与工作流

`task_workspaces` 为唯一绑定事实源：Task 可多个 Workspace，Workspace 至多一个 Task，均必须同项目。`workspace.boundTaskId` 若实现只是可重建冗余，不能从 Assignment 推导历史。改指派 A→B 时保留 A 绑定，在同事务绑定 B 并 CAS 更新 Assignment；删 Assignment 不解绑。解绑不删除 Workspace/Session/Run 历史，不能解绑活跃 Run 的 Workspace；解绑当前 Assignment 工作区必须带 version 并原子清空 Assignment。任务工作区创建原子组为 Repository（可选）+ Workspace + 绑定 + provision command + 活动（及可选 Assignment CAS）；绑定失败全回滚，provisioning 失败保留绑定可重试。

Task.version 从 1 开始，仅 status/assignee 实际变化递增。任何含二者的 PATCH、transition、Assignment PUT/DELETE 必须 version；缺失 400、失配 409，混合 PATCH 全成或全败。普通字段按提交字段更新，不整行覆盖、不递增版本。链接、Run 投影、绑定与 last_activity_at 不参与版本。

| 当前 | 可转目标 |
|---|---|
| backlog | todo、blocked、人工 cancelled |
| todo | in_progress、blocked、人工 cancelled |
| in_progress | in_review、blocked、人工 cancelled |
| in_review | done、in_progress、blocked、人工 cancelled |
| done | 人工 in_progress、blocked、人工 cancelled |
| cancelled | 人工恢复取消前状态、blocked |
| blocked | 恢复 blocked 前状态、人工 cancelled |

分别保存 blocked/cancelled 来源；重复 blocked 不覆写来源。同状态经 CAS 校验后 no-op。未列出跳转 409。活跃 Run 阻止 done/cancelled，blocked 不停止执行。六列固定 backlog/todo/in_progress/in_review/done/blocked；cancelled 从列表筛选访问，不增加第七列。v1 不删除 Task。

活动必须从每个业务写入口首次上线就与业务事务一起记录，不能到活动页上线才开始采集。task_activity 以 `(taskId,seq)` 持久排序，含创建/编辑/转移/Assignment/绑定/链接/Run 起止；回滚无活动、无通知。既有 audit 继续保留，不冒充尚未实现的 task_activity。

## 4. 项目事件、错误与路由

裁定使用父 spec 的**扁平事件格式**，不得另建嵌套 payload 或拿 Journal 充当项目事件：

```json
{"id":"opaque-notification-id","projectId":"project-1","type":"run.changed","taskId":"task-1","runId":"run-1"}
```

冻结 type 集：task.created、task.updated、task.transitioned、assignment.changed、binding.changed、link.changed、run.changed、workspace.provisioning。只有相关实体 ID 才出现（task 类必须 taskId；run.changed 必须 taskId/runId；workspace.provisioning 必须 workspaceId，绑定任务时带 taskId）。`/api/projects/:id/events` 统一鉴权和项目归属，只在提交后发布。id 是不透明失效通知身份，不是可靠游标，不代替 activity seq。断线/重启/缺口重校验当前项目所有订阅 Query，再按 task_activity after=seq 追平去重。P6 前及断线使用显式轮询，per-session Journal SSE 不变且不进入 Query 双重缓存。切连接作用域关闭旧订阅并隔离缓存。

后续任务 API 错误 envelope 冻结为 `{error:{code,message,details?}}`；不改本票既有 API envelope。400 invalid_request（缺 version/格式错误）；401 unauthorized；403 forbidden；404 not_found；409 request_id_conflict、version_conflict（details 含 currentVersion 与权威 status/assignment）、active_run、assignment_changed、workspace_not_ready、runtime_unavailable、reuse_ineligible、workspace_bound、invalid_transition。UI 保留草稿及意图，显式确认后用新 version 重试，不能自动覆盖。幂等冲突不能通过客户端自动换 requestId 绕过。

根路径 `/?project=&workspace=&session=` 是**新增兼容输入格式**，不是当前已支持深链。先鉴权并验证实体与归属，缺上级可从授权资源推导，再 replace 到规范项目/任务/会话路径。规范路径选择优先，冲突查询参数明确报错；未知/越权/跨项目 ID 不跳第一个资源。实体选择归 URL，view/tab/filter 为查询展示状态，不能另设镜像选择源。

## 5. Inspector 与阶段映射

采纳视觉设计 §11，不采用交互旧稿的窄屏独立 page：≥1280px 非 modal push；1024–1279px modal overlay；二者默认 520px，可调 480–560px；<1024px 全屏 Sheet 100vw、不可调宽。modal 锁焦/背景 inert，push 不锁焦；关闭恢复触发器或列表入口。直链关闭清选择回所属列表，不盲目 history.back。跨断点保留草稿/选择/滚动/内部焦点；未保存关闭须确认。<768px 单栏导航抽屉，看板横向滚动，状态菜单为触屏等价操作。

以父 spec 补充说明为阶段主轴，替代实施方案旧表的 P4 仅服务端/P5 才看板以及视觉 V3 已承诺完整闭环的说法：

| 里程碑 | 工程阶段 | 视觉 |
|---|---|---|
| M1 契约/回归前置 | P0；本 Ticket 01，不实现 App Shell/任务域 | V0 可在 P0–P1 独立进行，本票不做 |
| M2 行为保持前端迁移 | P1 模块化 → P2 Query → P3 路由/App Shell | V1→P3 |
| M3 服务端任务域 | 与 M2 并行，按冻结契约/文件所有权隔离 | 不占 P4 前端阶段 |
| M4 看板 | M2/M3 就绪后 P4 看板/详情 | V2→P4 |
| M5 执行闭环与收尾 | P5 Run 时间线；P6 工作区/launch/项目 SSE 完整联调；P7 活动页/概览 | V3→P5（完整联调仍 P6）；V4→P7 后发布前 |

## 6. M1 代码冻结与 reviewer blocker 修复

M1 冻结不后移。唯一代码定义为 `packages/web-contract/src/task-platform.ts`，从 `@wemux/web-contract` 及无领域依赖的 `@wemux/web-contract/task-platform` 导出；后者允许 domain 使用而不引入 session-view 的领域依赖环。不在 domain/server/web 复制 DTO，也不实现 Task endpoint/UI。

- 冻结 TaskSummary/TaskDetail（Task）、Assignment、TaskWorkspace、TaskLink、BoardColumn、TaskViewMode、RunSummary/Run、LaunchRequest/LaunchResponse/CancelRunResponse、状态集合、TaskPatch/TaskCAS/TransitionRequest/AssignmentRequest、错误 envelope/CAS 权威值及扁平 ProjectEvent。
- TaskSummary 必带 `linkCount: number`，为非负整数的外部关联总数，无关联为 0；详情继承该字段，值与同一响应快照的 `links.length` 一致。BoardColumn/列表直接用 `linkCount > 0` 显示关联标记，不得逐卡片请求详情产生 N+1；后续生产实现负责聚合与运行时校验，本票仅冻结契约。
- Task 的指派字段为 `assignee`；LaunchRequest 的确认快照为 `assignment`；Run 的不可变实际 binding 为 `snapshot`。优先级采用交互稿 none/low/medium/high；时间为现有领域 Timestamp 的 ISO 字符串线格式；可缺省事实显式 null。Run 的 command/message/turn/cancel 映射保留在 Run detail。
- `launchFingerprintInput` 冻结固定元组（服务端对 JSON 做 SHA-256），排除 requestId/attempt，保留完整 prompt。requestId 是客户端重试身份，attempt 只在响应中由 Server 分配；取消 accepted 不改变 cancelling 的活跃属性，响应返回当前 Run，终态重试不回退。
- `packages/web-contract/src/task-platform.test.ts` 是本次 M1 契约确认门禁：测试包根与 domain-safe 子路径类型一致、规范化指纹输入、状态/错误全集、CAS 权威值、扁平序列化；TypeScript 负例锁定缺 version、错误 mode/session、客户端 attempt、缺 Run ID/冲突权威值以及快照改写。全 workspace typecheck 同时通过。这是共享契约测试确认，不声称双端功能或真实浏览器验收。
- 双端编译确认已补齐：`apps/server/src/application/task-platform.contract.ts` 与 `apps/web/src/task-platform.contract.ts` 是 production src 范围内的 compile fixture，均从 `@wemux/web-contract/task-platform` 导入，不复制 DTO、不接入 endpoint/UI。Server 构造摘要/列，Web 消费摘要 linkCount/Run attempt 并构造 LaunchRequest。Web 补现有 workspace 包依赖并更新 lockfile，两端现有 tsconfig include 足够，无相对路径绕行。两端 `tsc --listFilesOnly` 均包含 `packages/web-contract/dist/task-platform.d.ts`；这是双端类型形状确认，不是双端功能验收。
- 后续 M2/M3 修改必须同步更新生产端、消费端及契约测试，不能单端破坏冻结。真实浏览器前置门禁仍未完成，由主会话执行；Ticket 02 不启动。

SQLite 采用单连接 FIFO committed-read barrier，保持 `:memory:`：public identity/resources/commands/cache 与事务串行；tx readers 直接读取本事务。当前 audit 只有 tx writer，没有 public audit reader，不能通过 public API 读取未提交 audit。未来增加 reader 必须经过同一 barrier。所有事务内调用改用 tx readers；异步上下文识别 public read/嵌套 transaction 误用并立即拒绝，合法并发调用排队，失败不毒化队列。事务禁止等待网络、Worker、文件系统；测试暂停门只用于确定性交错证明。

最后一轮 hardening：每次事务创建独立 `{id, active}` token 和 ServerStoreTx facade，所有分组的 reader/writer（包括事先捕获的方法）在调用时检查 active 与当前事务身份，commit/rollback 后立即拒绝，旧 tx 不能污染下一事务。原始 SQL 操作不跨 await 暂停，避免校验后写入逃逸；调用方仍须 await 全部 tx 操作。AsyncLocalStorage 共享 token 生命周期，finally 失效后派生异步任务可以公共读取/开启新事务；真正事务内依旧 fail-fast，不建议在事务中启动后台工作。

Notifications 每个 subscriber 独立隔离同步 throw 与返回 Promise 的 rejection；失败不改变已提交 API 结果、不跳过后续 listener。构造器可注入接收 `{key,error}` 的同步/异步 reporter，默认 console.error；reporter 自身失败也被隔离，避免诊断破坏业务。subscriber 必须返回异步工作 Promise 才能由通知层观察；自行脱离返回值的后台工作由其所有者处理。通知仍是内存唤醒，不承诺可靠投递/重试。

后端零新依赖，不修改 Worker/wire-protocol；Web 仅补已有 workspace 契约包依赖，无新增第三方依赖。Router/Query 仅后续 Web 允许新增的两项产品依赖。
