# Wemux Lite 重构与改造实施方案

> 状态：历史任务切片重构方案，保留原始阶段与事实快照供追溯，不作为当前进度。新的产品定位、阶段编号和发布门槛见 [产品方向](../product-direction.md) 与 [路线图](../roadmap.md)。
>
> 下文单屏代码规模、Ticket 状态、M/P/V 编号和 MVP 限制属于当时基线；旧 Task 主路径与单 Worker Workspace 已被替代。领域细则中仍有效的幂等与取消规则以 [契约裁定](task-platform-contract-decisions.md) 为准。新的 UI 交付必须真实浏览器验收；不可按旧“可选 E2E”标准发布。

## 修订记录

- **v1.1，2026-01-06，按子代理审查修订**：落实审查 #1–#14（2 blocker / 9 major / 3 minor）；三条 minor 均采纳，分别纠正首次 URL 化、详情路由与数据库回滚语义。§2 与交互架构 §9 模块清单已逐项核对，目录无冲突，保留七个 features。
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

> 依据：`docs/design/frontend-interaction-architecture.md`（交互设计）+ 2026-02 当前代码盘点。
> 原则：三段式推进（行为保持迁移 → 架构升级 → 能力扩展）；每阶段独立可验收、可回滚；保持最小依赖（不引入数据库/消息队列/SSR，仅新增 TanStack Router + TanStack Query 两个前端依赖）。

## 1. 现状盘点（2026-02）

### 1.1 代码结构

```text
apps/web/src/           App.tsx(293 行单屏) · api/{client,dto,journal,use-session} · components/{cluster-page,create-dialog,connection-dialog,worker-enrollment-dialog}
apps/server/src/        http/handler.ts(148 行 if 链路由) · application/server-service.ts(256 行) · storage/sqlite/{store(180 行),migrations} · worker-ws · sse · static
apps/worker/src/        agents/ · capabilities/ · commands/ · execution/ · workspaces/ · transport/ · storage/
packages/               domain · server-domain · web-contract(仅 session-view) · wire-protocol
apps/web/tests/         6 个 source-contract 测试(api/connection-storage/conversation-ux/navigation-hierarchy/proxy/worker-enrollment)
```

### 1.2 债务点（重构动因）

| # | 债务 | 位置 | 影响 |
|---|---|---|---|
| D1 | 单屏 App.tsx：导航、选择状态、会话执行、Composer 全在一个文件 | `apps/web/src/App.tsx` | 无法承载项目/任务多路由 |
| D2 | 双份轮询：Workbench 与 ClusterPage 各自 setInterval 拉 workers/projects | App.tsx / cluster-page.tsx | 定时器泄漏风险、缓存不一致 |
| D3 | source-contract 测试断言源码字符串而非行为 | `apps/web/tests/*.mjs` | 重构时要么全重写要么失效 |
| D4 | server-service.ts 混合 enroll/auth/capability/session/workspace 命令 | server-service.ts | 任务域再塞入会失控 |
| D5 | SQLite 仅 3 表（records/commands/events），任务/活动无投影表 | storage/sqlite/migrations.ts | 任务列表/活动需新投影 |
| D6 | 无任务域：Task/Assignment/Link/Run 概念不存在 | 全栈 | 本次改造主体 |

### 1.3 可复用资产（保持协议与行为，必要时抽取接口）

- 会话执行闭环：`api/journal.ts` projector + `use-session.ts` + Composer 乐观提交链路（已有 E2E 验证记录，不等于可复现自动门禁；P1 单独修复生命周期缺陷）
- Worker 命令管线：commands 表 + worker-ws 投递 + receipt 轮询（幂等 commandId）
- Workspace provisioning 流程（pending→provisioning→ready/failed）
- Agent/模型能力上报与级联过滤（capabilities 契约 + create-dialog 级联逻辑）
- 领域术语已定稿（CONTEXT.md 6 个新术语）

## 2. 目标架构（终态）

```text
apps/web/src/
├── app/          AppShell · router · QueryClient · providers
├── routes/       薄壳路由组件（参数校验 + 组合）
├── features/
│   ├── connection/     连接作用域（现 connection-storage + ConnectionDialog）
│   ├── projects/       项目表单/查询
│   ├── tasks/          api · queries · workflow · task-board · task-detail · task-links   ★新
│   ├── execution/      launch-task · run-queries · run-inspector                          ★新
│   ├── sessions/       现会话屏迁入：use-session-execution · timeline · composer
│   ├── infrastructure/ cluster-page 演进：workers · enrollment · workspaces
│   └── capabilities/   agent/model 目录查询 + runtime-picker（create-dialog 级联抽出）
├── shared/api/   http-client · errors（client.ts 拆分）
└── shared/ui/    Radix 封装

apps/server/src/
├── application/  server-service 拆分 + task-service.ts ★新 · run-service.ts ★新
├── http/         handler.ts 改路由表分发（不引框架，手工 route matcher）
└── storage/      migrations v2：tasks/task_runs/task_links/task_activity 专用表（权威字段与可重建投影分离）

packages/web-contract/  + task-view.ts + execution-view.ts
packages/wire-protocol/ 不变（任务不新增 wire 命令；workspace 复用现有）
```

## 3. 阶段划分总览

| 阶段 | 主题 | 规模 | 依赖 |
|---|---|---|---|
| P0 | 测试基线升级 | 小 | 无 |
| P1 | Web 模块化拆分（行为保持） | 中 | P0 |
| P2 | 数据层统一（TanStack Query + 连接作用域） | 中 | P1 |
| P3 | 路由化 + App Shell | 中 | P2 |
| P4 | Server 任务域 + 契约 | 大 | M1 契约冻结；按文件所有权与 P1–P3 条件并行 |
| P5 | 任务看板 + 任务详情 | 大 | P3 + P4 |
| P6 | 任务→工作区创建 + Run 启动跟踪 | 大 | P5 |
| P7 | 活动流 + 收尾优化 | 小 | P6 |

每阶段完成即打 tag（`phase-N`），仅作为代码回退定位；数据库备份恢复与外部副作用处理见 §4。视觉阶段按头部 V*/P* 裁定执行，不将 V2 误排到 P5。

---

## P0 — 测试基线升级

**目标**：先保留现有覆盖，再随模块抽取增加纯逻辑契约测试；不承诺 DOM 渲染行为测试，不让 P0 依赖 P1 hook 或 P3 路由。

**步骤**
1. P0 原样运行六组现有测试，保留 source-contract；测试基线使用 node:test + tsx，不增加 DOM 依赖。含 TypeScript 的逻辑测试以 `node --import tsx --test <测试文件>` 执行；不把类型擦除等同 TSX 挂载。
2. P1 抽取时同步迁移下表断言，保留源断言直到等价测试落地。所谓 hook 测试是测试 hook 委托的可注入 API/时钟/调度器的纯函数与执行 controller，不直接调用 React Hook，不声称覆盖 React 挂载/渲染。
3. P3 才新增路由参数、默认跳转与归属校验的纯逻辑测试，不能用路由表代替资源树行为覆盖。
4. Server 补 command receipt 受理/拒绝、session journal 分页、workspace provisioning 状态机测试（已有覆盖则保留）。

**逐项保留映射**（路径均相对 `apps/web/`；测试文件名保留，import/源码目标随迁移调整）：

| 现有测试/断言 | P1 后目标与保留方式 | 阶段 |
|---|---|---|
| conversation-ux：人类可读消息进度、工具状态、freshness 标签 | `features/sessions/timeline`、标签纯函数 + 对应源码断言，禁用内部状态码替代用户标签 | P1 |
| conversation-ux：发送中仍可编辑、禁止重复发送 | `features/sessions/composer` 源码断言保留 Textarea 可编辑；执行 controller 测 pending/busy 门禁 | P1 |
| conversation-ux：E2E 消息安全限制 | 原脚本安全断言原位保留，不随 App.tsx 删除；发送内容校验迁到 `features/sessions` 公开入口测试 | P0–P1 |
| navigation-hierarchy：Project→Workspace→Session、会话按 Workspace 分组 | `features/sessions/navigation` 分组纯函数与层级源码断言 | P1 |
| navigation-hierarchy：Workspace 内新建 Session 的预选与 ready/online 门禁 | `features/sessions/session-form`、`features/infrastructure/workspaces` 入口参数断言及门禁纯函数 | P1 |
| navigation-hierarchy：选择后展开所属 Workspace、搜索与面包屑 | `features/sessions/navigation` 选择/过滤纯函数与标签源码断言；P3 另加跨项目 ID 校验 | P1/P3 |
| api：HTTP、错误、消息与 Journal 行为 | 旧 client import → `shared/api/http-client` 及资源 feature API；旧 journal import → `features/sessions/journal`，逐项保留断言 | P1 |
| proxy：开发代理请求旧 client 模块及导出检查 | 请求目标 → `shared/api/http-client`，资源导出 → 对应 feature 公开 API，保留代理转发断言 | P1 |
| connection-storage：存取、清理、连接配置约束 | import → `features/connection` 公开接口；保留所有存储断言 | P1 |
| worker-enrollment：注册/安装命令及安全约束 | import/源码目标 → `features/infrastructure/enrollment`；保留原断言 | P1 |
| 新增执行安全网：echo messageId 去重、pending 清理、失败回滚、同请求重试身份 | `features/sessions` controller 的注入式纯逻辑测试 | P1 |

**验收**：P0 `npm test` 全绿并登记现有断言；P1 每搬一项同步验证映射，无删测空窗。故意破坏去重、可编辑门禁、层级预选或重试身份时对应测试必须失败（随后还原），不以“删除文件后失败”冒充行为保障。
**风险**：既有 source-contract 仍有局限，浏览器交互由 §4 人工验收补足；不再承诺半天完成。M1 末尾执行 §6 契约冻结门。

## P1 — Web 模块化拆分（行为保持）

**目标**：App.tsx 293 行拆为 features 模块，产品行为零变化。

**拆分前状态所有权矩阵**（切连接指服务器/团队/身份改变）：

| 当前状态/副作用 | P1 归属模块 → 后续迁移去向 | 重置条件 | 清理机制 |
|---|---|---|---|
| config、generation、浏览器 online/offline、连接错误 | `features/connection` → `app` 连接代数边界消费 | 保存连接递增 generation；权限失效阻止请求 | 移除监听、取消旧请求；P2 重建 QueryClient |
| project/session 选中、由 Session 推导 workspace | `features/sessions/navigation` → P3 `routes` 参数 | P1 保持原选择；P3 禁止自动首选覆盖直链 | 项目切换清旧选择，参数归属校验；无 ID 镜像 Context |
| 搜索、Workspace 折叠、抽屉、创建弹窗/预选、创建后刷新回调 | `features/sessions/navigation` 与资源 feature 表单 → `app` 仅组合 | 项目/连接切换关弹窗；选择会话展开所属 Workspace | 移除快捷键监听，P2 回调改精确 invalidate，P3 改导航 |
| workers/projects 10s 轮询、loading/error/revision | `features/infrastructure` / `features/projects` → P2 queries | 切连接重置 | abort + clearInterval；P2 删除组件定时器 |
| workspaces/sessions 5s 轮询及项目错误 | `features/infrastructure` / `features/sessions` → P2 queries | 切项目/连接重置 | abort + clearInterval；迟到结果不能覆盖新项目 |
| 按 Session drafts | `features/sessions` 连接级草稿容器 → 路由外存活 | 切会话/离开路由保留该会话草稿，切连接清空 | 不持网络副作用，清理已删除会话条目 |
| echo、messageId 去重、canSend 推导 | `features/sessions/use-session-execution` → 保持 | 切会话撤回旧 echo；Journal 确认后去重 | 回调校验 sessionId + generation，拒绝迟到更新 |
| Composer pending/error/receipt、attempt、同步 busy ref | `features/sessions` 执行 controller → hook 薄包装 | 切会话清 attempt/busy/receipt；未确认重试限原会话同内容 | dispose 后不得写状态；保留输入中的新草稿 |
| receipt 轮询 controller、等待定时器、send 请求 | `features/sessions` 执行 controller → 保持 | 切会话/切连接/离开执行路由 | 持有全部 AbortController，abort、clearTimeout、失效代数；旧 finally 不得解除新提交 busy |
| Session SSE、补页 cursor、dirty/syncing、5s 兜底轮询 | `features/sessions/journal` + `use-session-execution` → 不进 Query | 切会话/切连接/离开路由重置 | closeStream、abort、clearInterval；连续游标校验 |
| scroll/nearBottom/previousSession refs、动画帧 | `features/sessions/timeline` → 保持 | 切会话重置滚动判定 | cancelAnimationFrame；卸载不滚动旧节点 |

既有缺陷（切 Session 未清 attempt、receipt controller 未清理）在搬迁后各做独立修复提交，不混入行为保持提交。注入式 controller 回归覆盖切会话、切连接、离开路由、迟到回执/请求、双击及新草稿不被旧失败覆盖；DOM 展现用人工浏览器回归，不伪称 Hook 挂载测试。

**步骤（顺序执行，每步可独立提交）**
1. `shared/api/`：client.ts 拆 http-client（fetch+超时+错误归一）与 errors；dto.ts 按资源拆分。
2. `features/sessions/`：Timeline、Composer、useSessionExecution（原 use-session.ts + journal.ts 整体迁入，App.tsx 只留组合）。
3. `features/connection/`：connection-storage + ConnectionDialog 迁入。
4. `features/capabilities/`：runtime-picker——从 create-dialog 抽出 Worker→Agent→Model 级联（核心 hook：`useExecutionTargets(workerId)`，纯函数过滤 available）。
5. `features/projects/` + `features/infrastructure/`：create-dialog 拆为 project/workspace/session 三个表单组件；cluster-page 迁入 infrastructure。
6. App.tsx 缩为 <100 行组合壳（此阶段仍是单屏，无路由）。

**验收**：手工回归清单——建项目/工作区/会话、发消息见回复、断线重连提示、Worker 注册；`npm run build` 产物体积变化 <5%。
**风险**：迁移时丢状态刷新逻辑 → 以 P0 行为测试为准，逐 hook 迁移。

## P2 — 数据层统一（TanStack Query + 连接作用域）

**目标**：消灭双份轮询，建立单一服务器状态缓存。

**步骤**
1. 引入 `@tanstack/react-query`；QueryClient 由 `app/` 的连接边界实例持有。**选择保留连接代数 remount（`key={generation}`）**：每次切服务器/团队/身份重建 Provider 和 QueryClient，不采用共享单例 `queryClient.clear()+重连 invalidate`，避免迟到请求重新填入旧身份数据。
2. 定义代数内 query keys：`['workers']`、`['projects']`、`['project', id, 'workspaces']`、`['project', id, 'sessions']`；key 不含原始令牌。旧边界先 cancelQueries（queryFn 必须消费 signal）、关闭 SSE/执行 controller，再清空并释放旧 client。新边界首次加载；同代数网络重连才精确 invalidate。相同资源 ID 在不同服务器间不得复用缓存。
3. workers/projects 使用 10s，workspaces/sessions 使用 5s refetchInterval；staleTime 显式声明、Query 去重，删除组件内 setInterval。
4. 当前仅 Session SSE，可精确失效该 Session 元数据；项目/任务/Workspace 列表在 P6 前依赖 Query 轮询（任务列表 5s），不得假设全局资源 SSE。P6 项目频道上线后才消费资源失效通知，仍保留轮询兜底。
5. 会话 Journal 保持现有 use-session 私有链路（不进 Query 缓存，避免双源），仅列表元数据进缓存。

**验收**：Network 面板单屏只看到声明过的轮询；断开 server 后 UI 显示分层新鲜度；无内存泄漏（长时运行定时器计数稳定）。
**风险**：SSE 失效风暴 → 只失效精确 key；journal 仍走私有通道。

## P3 — 路由化 + App Shell

**目标**：URL 拥有选择状态；多页面骨架就位（页面可空壳）。

**步骤**
1. 引入 `@tanstack/react-router`（唯一新依赖之二）；手写小路由树（不用文件路由）。
2. 路由与交互架构 §1.2 使用同一矩阵（`:id` 统一写作 `:projectId`）：

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

   不支持 `?taskId=` 第二身份入口；详情返回列表保留 view/filter。
3. App Shell：全局栏（连接状态/刷新/设置）+ 全局导航（可折叠）+ 项目内导航 + 可选右栏检查器。
4. 现有单屏内容映射：Workbench → `sessions/:sessionId`；ClusterPage → `/cluster`；CreateDialog → 各页内按钮。
5. 首次 URL 化与根路径默认跳转：当前选择仅在 useState，并无历史 query URL；移除加载后首选资源逻辑对直链的覆盖。客户端 replace 不是 HTTP 301；仅发现真实外部链接证据后另设可选 query 兼容入口，不列入本次必做。
6. 未知 ID / 无权限：明确错误页，不静默替换。

**验收**：新增路由纯逻辑测试（含跨项目 task/session/workspace ID 不一致拒绝、未知 ID/无权限错误）；浏览器人工验证刷新/前进/后退/直链、宽窄详情与“直链打开会话并发消息”（§4）。
**风险**：Session SSE 与路由卸载竞争 → 执行 P1 清理矩阵；此时不存在全局资源 SSE。

## P4 — Server 任务域 + 契约（M1 冻结后条件并行）

**目标**：Task/Assignment/Link/Run 的持久化、状态机与 API 就位（无 UI 消费也可测）。

**步骤**
1. **server-domain**：`task.ts` 新增实体与值对象
   ```ts
   TaskStatus = 'backlog'|'todo'|'in_progress'|'in_review'|'blocked'|'done'|'cancelled'
   Task { id, projectId, title, description, acceptanceCriteria?, priority, status, blockedFrom?, version,
          assignee?: AgentAssignment, origin: 'manual', createdAt, updatedAt }
   AgentAssignment { workspaceId, workerId, agentKey, modelId }   // 可变，仅意图
   TaskLink { id, taskId, type: 'github-issue'|'github-pr', externalId, url, title?, syncState: 'none' }
   AgentRun { id, taskId, attempt, fingerprint, snapshot: {workerId,workspaceId,agentKey,modelId},
              sessionId, commandId, messageId, turnId?, cancelCommandId?, lastProjectedSeq,
              status: 'pending'|'running'|'succeeded'|'failed'|'cancelling'|'cancelled', result?, startedAt?, endedAt? }
   LaunchRequest { mode: 'new'|'reuse', sessionId?: string, prompt: string,
                   assignee: AgentAssignment, attempt: number }
   LaunchResult { runId, sessionId, commandId, messageId, attempt }
   ```
   状态机纯函数 `transition(task, to)` 严格执行头部矩阵；进入 blocked 保存 `blockedFrom`，解除只能回该状态。backlog/cancelled 保留展示/历史值，不因此开放任意拖拽流转；未列出的边拒绝。done 只由人确认。领域 Assignment 对应 API/存储字段 `assignee`，不得混用两套写入字段。
2. **storage 迁移 v2**（顺序追加，完整事务 DDL；不是只有示意列名）：
   ```sql
   CREATE TABLE tasks (
     id TEXT PRIMARY KEY NOT NULL,
     project_kind TEXT NOT NULL DEFAULT 'project' CHECK(project_kind = 'project'),
     project_id TEXT NOT NULL,
     status TEXT NOT NULL CHECK(status IN ('backlog','todo','in_progress','in_review','blocked','done','cancelled')),
     blocked_from TEXT CHECK(blocked_from IN ('backlog','todo','in_progress','in_review','done','cancelled')),
     assignee TEXT CHECK(assignee IS NULL OR (json_valid(assignee) AND json_type(assignee) = 'object')),
     data TEXT NOT NULL CHECK(json_valid(data) AND json_type(data) = 'object'),
     version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
     updated_at TEXT NOT NULL,
     FOREIGN KEY(project_kind, project_id) REFERENCES records(kind, id) ON DELETE RESTRICT,
     CHECK((status = 'blocked' AND blocked_from IS NOT NULL) OR (status <> 'blocked' AND blocked_from IS NULL))
   );
   CREATE INDEX tasks_project_status ON tasks(project_id, status, updated_at);
   CREATE TABLE task_links (
     id TEXT PRIMARY KEY NOT NULL,
     task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
     data TEXT NOT NULL CHECK(json_valid(data) AND json_type(data) = 'object')
   );
   CREATE INDEX task_links_task ON task_links(task_id);
   CREATE TABLE task_runs (
     id TEXT PRIMARY KEY NOT NULL,
     task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
     attempt INTEGER NOT NULL CHECK(attempt > 0),
     fingerprint TEXT NOT NULL,
     session_kind TEXT NOT NULL DEFAULT 'session' CHECK(session_kind = 'session'),
     session_id TEXT NOT NULL,
     command_id TEXT NOT NULL UNIQUE REFERENCES commands(id) ON DELETE RESTRICT,
     message_id TEXT NOT NULL,
     turn_id TEXT,
     cancel_command_id TEXT REFERENCES commands(id) ON DELETE RESTRICT,
     status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed','cancelling','cancelled')),
     snapshot TEXT NOT NULL CHECK(json_valid(snapshot) AND json_type(snapshot) = 'object'),
     data TEXT NOT NULL CHECK(json_valid(data) AND json_type(data) = 'object'),
     last_projected_seq INTEGER NOT NULL DEFAULT 0 CHECK(last_projected_seq >= 0),
     FOREIGN KEY(session_kind, session_id) REFERENCES records(kind, id) ON DELETE RESTRICT,
     UNIQUE(task_id, attempt),
     UNIQUE(task_id, fingerprint),
     UNIQUE(session_id, message_id),
     UNIQUE(session_id, turn_id)
   );
   CREATE UNIQUE INDEX task_runs_one_active ON task_runs(task_id)
     WHERE status IN ('pending','running','cancelling');
   CREATE INDEX task_runs_session ON task_runs(session_id, last_projected_seq);
   CREATE TABLE task_activity (
     task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
     seq INTEGER NOT NULL CHECK(seq > 0),
     source_key TEXT NOT NULL,
     data TEXT NOT NULL CHECK(json_valid(data) AND json_type(data) = 'object'),
     PRIMARY KEY(task_id, seq),
     UNIQUE(task_id, source_key)
   );
   ```
   在事务外启用并检查 `PRAGMA foreign_keys=ON`；`project`/`session` 为现有 records kind，使用复合外键，不错误引用 `records(id)`。迁移不新增 records kind，不删除旧数据。tasks（状态、指派、内容）、links、Run 身份/请求指纹/快照及 activity 管理事件是权威数据；Run status/turn 关联和 Journal 派生活动是可重建投影，重放也必须保留 launch 与取消意图，不能把四张表统称可丢弃投影。
   `ServerStore` 新增 `tasks` 只读端口（get/listByProject/getRun/listRuns/findLaunch/readActivity）；`ServerStoreTx.tasks` 提供相同事务视图读取及 insertTask/updateContent/compareAndSetStatus/compareAndSetAssignee/insertRun/projectRun/addLink/removeLink/appendActivity。事务内资源/命令读取也走同一 tx 视图，保证读己之写；所有写端口禁止自行开事务或通知。
3. **task-service.ts**：createTask / updateContent / transition / setAssignee / addLink / removeLink；listByProject 聚合活跃 Run。CAS 仅 status+assignee：这两类请求携带 version，`UPDATE ... WHERE id=? AND version=?` 并原子 `version=version+1`，零行返回 409；同事务写活动。标题/描述/优先级/links 不携带 CAS、不递增此 version，采用字段级更新防止全量 JSON 覆盖状态。blockedFrom 随 status 原子更新。
4. **application 事务原语与 Run 投影**：
   - 唯一 launch 编排入口 `ServerService.launchTaskRun(taskId, request: LaunchRequest): Promise<LaunchResult>`；`run-service.ts` 只提供接收 `ServerStoreTx` 的校验/写入/投影助手，不另开 launch 入口。先抽取 `createSessionInTx(tx, preparedSession)`、`enqueueInTx(tx, session, preparedMessage)`；现有 createSession/enqueue 包装器也委托这些原语。禁止从 launch 调用其原有开事务包装器，禁止嵌套 BEGIN。
   - `prepareTurn` 改为可接受已构造 Session、Workspace、capability assets 的内存准备函数，不能为新 Session 经 store.requireSession 读取尚未提交资源。事务内读取权威资源和资产，纯本地准备 grant/snapshot（无网络/文件 I/O），所有持久写都用同一个 tx。复用现有 capability/消息大小校验；准备失败整体回滚。
   - launch 顺序：鉴权及请求规范化 → **同一 store 写事务**内按 task_id+fingerprint 查历史命中并返回原 LaunchResult → 未命中才检查 active-run → 检查 expected attempt、assignee、ready/online/执行能力/已上报模型 → new 创建 Session 与 session.create 命令（reuse 校验原 Session）→ 固化 Run 快照并入队初始消息、写 task_runs/活动。为满足即时外键，先写 Session 和 enqueue command 行再插入引用它们的 Run 行；事务原子性不变。事务提交后才统一通知 Worker；失败不通知。并发 active 检查与 run 写入不可分开，部分唯一索引兜底。
   - 内容指纹 = SHA-256(稳定规范化的 LaunchRequest：mode、显式 reuse sessionId、trim 后 prompt、四字段 assignee、attempt)。唯一键为 `(task_id, fingerprint)`，不另创随机 launch 幂等键；`attempt` 是客户端从任务详情取得的“下一次尝试号”，是请求内容的一部分，不是 commandId。客户端冻结请求直至确认；两种 mode 的新运行都取 max(attempt)+1，重试不得重新计算；同号异内容返回 409。明确发起下一次运行才刷新 attempt，因此相同 prompt 的新尝试与网络重试可区分。命中在前，即使原 Run 结束或指派/在线状态已变，仍返回原身份（鉴权仍必须通过）。
   - new 禁止传 sessionId；reuse 必须指定本 Task 最近一次 Run 的 sessionId，属于同项目、可读写且未删除；Session 的 worker/workspace/agent/model binding 必须等于请求 assignee 和当前 Task assignee，否则 409 要求显式 new，禁止静默换绑。Run 快照来源于经校验的 Session binding，而不是可变 Task 当前显示值。
   - new 的 session.create 与初始 enqueue 虽同事务持久入队，Server 投递必须按 Session 建立依赖：先投递 create，受理后再投递 enqueue；create rejected 时取消尚未投递的 enqueue 并记失败。这是 application/投递端的依赖控制，不新增 wire 命令，也不在事务内等待 Worker 回执。
   - `task_runs.command_id` 是初始 `session.enqueue` 命令 ID（不是 session.create ID），关联 commands.id；保存 messageId，连续 Journal 的 message.queued 核对 commandId/messageId，turn.started 用 messageId 绑定 turnId。每次 Run 只跟踪该初始提交的 Turn；同 Session 后续 Composer 排队消息不自动归入该 Run，避免其完成误终结 Run。
   - WorkerService 接收连续 Journal 时，在原事件缓存事务内同步投影 Run 与 activity、推进 lastProjectedSeq；重复/乱序先补连续缺口，按 sessionId+seq/source_key 幂等，断线补传不重复结束。线协议现有 outcome `completed`/`failed` 分别映射裁定的 `complete`/`error`，不修改 wire-protocol。
   - accepted 只表示 Worker 持久受理，不能置 running/succeeded；初始提交或 session.create 明确 rejected 时记 failed/原因，需阻止依赖提交继续执行。turn.started→running；turn.finished 正常完成/错误→succeeded/failed。取消意图先持久置 cancelling 并入队取消命令：排队提交用 `session.cancel-queued(submissionCommandId)`，已开始用 `turn.stop(turnId)`。停止回执的 accepted 也仅是受理，不等价“已停止”；现协议须等连续 message.cancelled 或目标 turn.finished 才记 cancelled（未来只有明确停止完成回执才可终结）。取消与启动竞态补发目标 turn.stop；取消命令 rejected 保留原因并核对 Journal/重试，不伪报 cancelled。终态不可被迟到受理/开始事件回退，取消意图先提交时目标 turn.finished 归 cancelled。turn.stop 只停当前 turn，不清空其他排队消息、不取消 Session。
5. **http 路由表**：handler.ts 从 if 链改数组路由 matcher（method+path 模式 → handler），新旧端点共存过渡：
   ```text
   GET/POST            /api/projects/:id/tasks
   GET/PATCH           /api/tasks/:id            （内容 PATCH 不带 CAS）
   POST                /api/tasks/:id/transition {to, version}
   PUT/DELETE          /api/tasks/:id/assignment  （assignee 变更携带 version）
   POST/DELETE         /api/tasks/:id/links
   GET                 /api/tasks/:id/runs · POST /api/tasks/:id/runs LaunchRequest
   POST                /api/runs/:id/cancel
   GET                 /api/tasks/:id/activity?after=seq
   ```
6. **web-contract**：`task-view.ts`（TaskSummary/TaskDetail/BoardColumn 视图 DTO + 视图模式枚举）、`execution-view.ts`（RunSummary/LaunchRequest）。
7. 任务域服务测试：矩阵所有合法/非法边与 blocked 回原状态；仅 status/assignee CAS 冲突；launch 响应丢失重试、原 Run 已终态后重试、同 attempt 异内容、reuse 换绑拒绝；并发一活跃 Run；accepted 不完成、Journal 乱序/补传/重复、取消竞态及后续排队消息不影响目标 Run。session.create 拒绝时依赖 enqueue 不得继续投递；如已受理则记录取消意图并走取消确认。

**验收**：curl 链路建任务→指派→launch→Journal 投影；新库/旧库迁移与重复打开、旧 records/commands/events 内容保留、DDL 中途失败连同版本标记回滚、外键/唯一约束拒绝、并发 CAS/launch、每个 launch 写点故障注入均无部分 Session/Run/入队、提交前无 Worker 通知。旧版本打开 v2 库兼容性按 §4 实测；P0–P3 测试不受影响。
**风险**：事务组合与取消投影是 P4 主工作量，不得省略。worker 离线时新 launch 拒绝，但历史幂等命中先返回原结果。

## P5 — 任务看板 + 任务详情

**目标**：主工作流 UI 上线。

**步骤**
1. `features/tasks/queries.ts`：任务列表/详情/变更 mutation（status/assignee 乐观更新 + version 冲突回滚提示；内容编辑不套 CAS）。
2. `task-board.tsx`：六列看板（cancelled 不占列）+ 卡片（标题/状态/运行徽章/assignment 摘要/link 标记）+ 拖拽（HTML5 DnD，不引库；乐观移动→transition→失败回滚+toast）。
3. 视图模式注册表：`TaskViewModeRegistry = { board, list }`，URL `?view=` 驱动；list 为简单表格。
4. `task-detail.tsx`：实装 P3 注册的 `/projects/:projectId/tasks/:taskId`，右栏面板（宽 480–560px）五 Tab（overview/links/workspaces/runs/activity），窄屏整页（非 Sheet）；view/filter 随详情往返保留。
5. `task-links.tsx`：`TaskLinkAdapter` 接口 + github-issue/pr 两个 parser（纯前端 URL 解析）；添加/移除/跳转。
6. 新建任务表单（单屏紧凑）：标题/描述/验收标准/状态/优先级/可选初始 link。
7. 浏览器人工验收（非自动门禁）：建任务→矩阵允许的拖拽流转→加 issue 链接→status/assignee 乐观锁冲突（双开标签页模拟）回滚；脚本化前须满足 §4 独立 E2E 前提。

**验收**：看板交互 <100ms 本地响应；非法拖拽/失败可见回滚；`?view=list` 与详情 tab 直链正确；P3 引入的路由测试扩展覆盖任务详情，宽窄屏与触屏状态菜单人工检查。
**风险**：拖拽在触屏不可用 → 提供卡片状态菜单作为等价操作（第一版必须有，无障碍同样受益）。

## P6 — 任务→工作区创建 + Run 启动跟踪

**目标**：任务内完成"指派→执行→审查"闭环。

**步骤**
1. `task-workspace-create.tsx` 归 `features/tasks/`：单屏表单（名称预填任务标题 / Worker / 内嵌 git URL / Agent / Model），复用 capabilities 的公开 `useExecutionTargets` 和 infrastructure 的工作区 API；Repository 不拉取目录 API，提交现有内嵌 repository 输入。v1 只允许该 Worker 已上报模型，自定义模型是产品 v1.1（不是本文修订版本即已实现）；未实现执行 Adapter 的 agent 置灰“仅检测”。
2. 创建调用 workspace 创建应用入口，增加 task 绑定：Task.assignee 为权威，workspace `boundTaskId` 为导航冗余；绑定变更带 version CAS，同事务完成 workspace/命令创建与 assignee 更新，失败不留半绑定，不复用会嵌套开事务的包装器。
3. **新增 `GET /api/projects/:id/events` 项目级频道**：P6 实现授权、连接清理及资源失效通知契约 `{projectId, resourceType, resourceId}`，覆盖 task/Run/activity 与 Workspace provisioning。application/WorkerService 资源事务提交后发通知；不复用 Session SSE，不假定 P2 已具备。订阅由 `features/projects` 拥有、按项目/连接切换关闭，精确 invalidate P2 keys；连接建立/重连全量核对当前项目相关查询并保留 5s 轮询，SSE 是失效提示而非唯一事件日志。ready 后“启动运行”激活。
4. `launch-task.tsx`：确认 Assignment + Prompt + mode + reuse sessionId + 下一 attempt，按 P4 冻结 LaunchRequest，提交 `POST /api/tasks/:id/runs`。结果未确认只重试同一内容指纹请求，不递增 attempt；409 明确区分 active-run、版本/绑定及 attempt 内容冲突。
5. `run-inspector.tsx`：Run 头（不可变快照徽章 + 状态 + 停止按钮）+ 内嵌会话时间线（复用 `features/sessions`，仅换壳）；活跃 run 存在时任务详情禁用"启动运行"。
6. Run 结束：结果摘要回写；任务详情出现"建议进入审查"一键流转（in_review），不自动 done。
7. 运行中发送消息：复用 Composer，提示进入 Turn Queue 语义（现有排队链路）。
8. 浏览器人工验收（隔离真实 Worker + 可执行测试 Agent）：任务→建工作区→ready→launch→工具时间线→Journal 确认 succeeded→建议审查→人工 done；同时测试停止仅当前 turn、项目频道重连核对与无 Session 打开时 provisioning 更新。自动化前提见 §4。

**验收**：完整链路人工验收单（含断线重连恢复、launch 重复点击幂等、运行中改指派只影响下次）；worker 无需任何改动。
**风险**：绑定双写与通知遗漏 → assignee + boundTaskId 同事务、提交后通知；以 Task 为准。P6 项目频道是 P7 的显式依赖。

## P7 — 活动流 + 收尾优化

**步骤**
1. 任务活动 Tab 消费 `GET /api/tasks/:id/activity?after=seq`（增量游标）；依赖 P6 项目级 SSE 失效，重连从已确认 seq 补拉并按 taskId+seq 去重，5s 轮询兜底，不把通知当活动权威日志。
2. 项目概览页：需要关注的事（活跃 run、in_review 任务、failed 工作区）——纯聚合查询，无新域。
3. 性能实测：看板 100+ 任务、时间线 1000+ 事件滚动；虚拟滚动按需再引（不预算入）。
4. 文档：README 截图更新、CONTEXT.md MVP 段更新为已实现能力、删除过期 research 注记。

**验收**：活动流断线重连无丢事件（seq 游标）；文档与实际行为一致。

## 4. 测试与验收策略

- **每阶段**：`npm test`（现有覆盖 + features 纯逻辑/hook 委托逻辑测试）+ `npm run typecheck` + 手工回归；node:test + tsx 不变，无 DOM 渲染测试环境。
- **浏览器 E2E 边界**：仍为 `scripts/` 独立脚本，现有脚本动态加载外部 Playwright，并非已声明且可复现的自动栈。本轮选择将 P3 导航/直链、P5 拖拽/双标签冲突、P6 真 Worker 闭环明确列为**人工验收，非自动 CI 门禁**；不编造尚不存在的 npm E2E 命令。每次记录浏览器版本、步骤、期望/实际、通过截图及操作者。
- **独立脚本转自动门禁的前置条件**：实施时在 scripts 运行说明固定 Playwright/浏览器版本、外部包加载路径与安装/执行命令，准备独立 Server 数据库、测试管理员身份、隔离在线 Worker、已上报且有执行 Adapter 的测试 Agent/模型、ready Workspace；测试数据带唯一前缀，不连接生产。运行后先取消并确认测试执行已停，再关闭 Worker/Server、删除测试目录/库。未提供这些可复现条件前只能报告人工结果，不能声称“沿用现成 E2E 栈已自动通过”。
- **最终验收链路**（P6 完成时）：`项目 → 任务 → 指派 → 运行 → 排队消息 → 工具时间线 → 审查 → 完成` + 断线重连、重复启动、权限丢失、运行中改指派四场景。
- **回滚分三层**：①代码：tag/revert 仅定位代码版本，P4 验证旧版本可打开含 v2 及 schema_migrations 标记的库并忽略新增表；不把未验证兼容当保证。②数据库：迁移仅向前，不自动 DROP 新表；迁移前停止写入并做一致性 SQLite 备份（含正确处理 WAL），恢复演练比较旧资源/命令/事件与版本标记；恢复会丢失备份后业务数据，必须明确停机窗口与取舍。③外部执行：入队已投递的命令、Worker Journal、文件/git 变化不会随代码或数据库回退；先暂停入口/投递、确认停止回执/Journal、盘点副作用，再按 commandId 对账防止恢复后重放；不可逆修改由人工补偿。

## 5. 依赖与不做清单

**新增产品依赖（仅 2 个；不新增 DOM 测试依赖，外部 E2E 环境不计作现有产品依赖）**：`@tanstack/react-query`、`@tanstack/react-router`（均限 apps/web）。
**明确不引入**：Express/Fastify（手工路由表足够）、Prisma/Drizzle（原生 sqlite 足够）、React Router、Redux、SSR/Start、拖拽库、虚拟滚动（按实测）。
**后端零新依赖**；wire-protocol 与 worker 完全不动（任务执行复用现有命令管线）。

## 6. 里程碑与相对规模

| 里程碑 | 阶段 | 相对规模 | 交付物 |
|---|---|---|---|
| M1 安全网 | P0 + 契约冻结 | 1–1.5 | 现有断言登记、无 DOM 测试基线、冻结契约 |
| M2 模块化 | P1+P2+P3 | 4–5 | 状态矩阵、生命周期修复、连接隔离、可路由 features |
| M3 任务域 | P4 | 4–6 | 事务原语 1–1.5 + DDL/端口/CAS 1 + 幂等/reuse 1–1.5 + Journal/取消/故障测试 1–2 |
| M4 看板 | P5 | 2 | 主工作流 UI |
| M5 闭环 | P6+P7 | 2.5 | 任务→工作区→运行→审查全链路 |

以上为重新拆分后的相对规模区间，非天数承诺；M4/M5 需在 M1 冻结后复估（尤其 P6 项目 SSE 与绑定事务）。

**M1 末尾：web-contract 契约冻结检查点（M2/M3 开工门）**：冻结 `task-view.ts` / `execution-view.ts` 的字段与导出、LaunchRequest/LaunchResult、状态/assignee CAS、错误码（404/403/409 的资源归属语义）、路由装载读取语义、事务 tx 原语及 Journal→Run 映射、P6 项目频道通知格式；以契约 fixture/兼容测试与双方签字为退出条件，不要求此时已实现 P4 服务。

M2/M3 **有条件并行，不是互不依赖**：M2 拥有 apps/web，M3 拥有 application/storage/http/server-domain；web-contract 由指定单一契约负责人串行合并，P1 DTO 搬迁不得删旧导出，P4 只增量追加。路由重构保持现有 HTTP 行为，P3 任务占位只用冻结 fixture；P2 在 P6 前用轮询，不依赖未实现通知。每天集成执行现有测试、类型检查与契约 fixture；契约变更先双方批准并重开冻结门再消费。M4 依赖 M2+M3 完成；V0→P0–P1 并行；V1→P3；V2→P4；V3→P5；V4→P7 后。
