# Multica 调研报告（对 wemux-mini 的借鉴价值评估）

> 调研日期：2026-09-27 · 调研人：subagent · 源码版本：main@2026-09-26
> 本地源码：`/opt/data/profiles/hacker/workspace/project/multica-upstream/multica-main/`（tarball 19.9MB，已解压）

## TL;DR

**Multica 是与 wemux-mini 定位最接近的开源参照物之一（"把 AI coding agent 当队友管理的自托管平台"），成熟度远高于我们，值得作为 t3code 之后的第二个核心借鉴源。** 但它的 License（Apache 2.0 + 附加条款，非 OSI）禁止直接复制其 UI 代码且限制商用托管，**只能学机制、不能抄代码**。前端同栈（TanStack Query + Zustand + WebSocket realtime），可借鉴密度极高。

---

## 1. 定位与作者

### 同名歧义与选择理由

GitHub 搜索 "multica" 有多个结果，按任务规则选择 AI agent 相关、star 最高的：

| 候选 | Stars | 判断 |
| --- | --- | --- |
| **`multica-ai/multica`** | **51,401** | ✅ 唯一正主：AI agent 协作平台 |
| `rkol2025/multica-ai_multica`、`botiverse/multica` 等 | 0-2 | 镜像/fork，忽略 |
| `sky-ecosystem/multicall`、`oliver-batchelor/multical` 等 | 200-800 | 拼写相近但完全无关（Solidity multicall 合约 / 多相机标定），忽略 |

### 基本盘（GitHub API 实测，2026-09-27）

- **仓库**：https://github.com/multica-ai/multica
- **定位**：「Make humans and AI agents work as one team — open-source and self-hostable」。看板式 workspace，把 issue 指派给 AI coding agent（像指派同事一样），agent 在你的机器（runtime）上领取任务、执行、评论汇报、交回 review。驱动 26 个 agent CLI（Claude Code、Codex、Cursor、Copilot、Hermes、OpenCode、OpenClaw、Kimi、Grok、Pi 等）——**它不内置模型，只编排已有 agent CLI**。
- **作者/公司**：Index Labs (Hong Kong) Limited（见 LICENSE Part I）；主要提交者 Jiayuan Zhang 等；有商业云（multica.ai）+ Discord。
- **成熟度**：⭐ 51,401 stars / 6,663 forks；创建于 2026-01-13，8 个月冲到 5 万星；最近提交 2026-09-26（调研前一天，日均数十 commit）；release v0.5.3（2026-09-24），约 2-3 天一版；open issues 1,688。**极度活跃，工程化程度非常高**（单 `daemon.go` 10,631 行、`task.go` 8,070 行，测试文件与源码约 1:1）。
- **License**：**"Multica License" = Apache 2.0 全文 + Part I 附加条款**（GitHub 显示 NOASSERTION）：
  - (1a) 未购商业许可不得用它向第三方提供托管服务（含免费公开实例）；组织内部使用 OK；
  - (1b) 不得移除/修改 Multica LOGO、产品名、版权信息——且「Multica user interface」定义为"从其 UI 代码整体或实质部分派生的任何界面"，**即复制 UI 代码会触发品牌条款**；
  - 结论：**自用/内部部署没问题；把它的代码抄进 wemux-mini 并发布，后端代码走 Apache 2.0 需保留署名，UI 代码基本不能碰。正确姿势是读源码、学机制、自己实现。**

### 技术栈

| 层 | Multica | wemux-mini 现状 |
| --- | --- | --- |
| 前端 | Next.js 16 (App Router) + **TanStack Query + Zustand** + pnpm/turbo monorepo；`packages/core`（无头逻辑+API client+Query hooks+Zustand stores）/ `packages/ui` / `packages/views`（web/desktop 共享页面）；apps/web、apps/desktop（Electron）、apps/mobile（Expo） | React + Vite + TanStack，monorepo packages/* —— **状态管理与 realtime 模式同栈** |
| 后端 | Go（Chi router、sqlc、gorilla/websocket）、PostgreSQL 17 + pgvector、Redis（可选） | Node + `node:sqlite`、ws —— 刻意零外部依赖 |
| Agent 运行时 | 本地 daemon（Go，goreleaser 发布）拉起各 agent CLI | Worker（Node CLI）+ Agent Adapter Bridge |
| 部署 | Docker Compose（selfhost）/ Helm / GHCR 镜像 | 单端口 Node 部署 |

目录结构：`server/`（Go 后端：`cmd/ internal/ migrations/ pkg/`）、`apps/{web,desktop,mobile,docs,ui-lab}`、`packages/{core,ui,views,plugin-sdk,eslint-config,tsconfig}`、`e2e/`（Playwright）、`deploy/helm/`。

---

## 2. 核心机制（源码级）

### 2.1 Server–Daemon：出站长连接 + 拉取式认领（claim）

架构上与 wemux 的「Worker 主动长连接加入 Server」同构，但细节更成熟：

- Daemon 通过 **WSS 出站连接**注册其 runtimes，server 只发**内容无关的 wakeup 提示**（`TaskAvailablePayload`），daemon 收到后主动 `tasks.claim`。claim 走 **WS 上的 request/response RPC**（`RPCRequestPayload{request_id, method, timeout_ms}`，server 侧按 timeout 回滚慢请求），HTTP claim 端点作为旧版回退。
  - 证据：`server/pkg/protocol/messages.go`（RPCRequestPayload / RPCResponsePayload）、`server/internal/daemon/wakeup.go`（taskWakeupLoop、指数退避封顶 30s、jitter、连接期 ≥10s 重置退避、64MiB 读上限防 claim 响应被截断）。
- **批量认领** `ClaimTasksForRuntimes`（`server/internal/service/task.go:3892`，文件 8,070 行）：先提升到期 deferred 任务（promote-first）→ 再按 runtime 集合认领；**empty-claim 缓存**（`empty_claim_cache.go`）让空闲 runtime 不必每次打满 DB，且 promote 时主动 bump 失效缓存，避免"刚提升的任务被 stale empty verdict 卡住"。
- **能力协商优于版本比较**：`DaemonCapability*` 常量（skill-bundles-v1、rpc-v1、task-supplement-v1、local-worktree-v1…），每个都带注释说明为什么版本号判断会失败（如 git-describe dev build 豁免导致 MUL-5707 事故）。未声明能力的 daemon 走回退路径，**fail-closed**。

### 2.2 运行中转向（Steer / Task Supplement）

不打断 agent、不新开任务，把用户中途的消息注入当前 turn：

- `server/internal/daemon/task_supplement.go`（183 行）：每 task 一个单槽 channel 合并重复提示；在 provider 启动**前**创建槽位，覆盖"server 已标 running 但 provider 尚未确认 turn"的窗口；WS 提示 + 5s 轮询兜底（50ms ready 轮询）。
- 注入用**结构化 prompt 模板** `formatTaskSupplementInstruction`：`[ADDITIONAL GUIDANCE] Human X added guidance...`，明确"补充而非替换原目标、并入本轮最终回复、不要单独 ack"。
- 失败原因枚举：`turn_not_started / provider_rejected / timeout / turn_ended`，capability 缺失时静默降级。
- wemux 的 capabilities 里已声明 `steering`，但这套**时序处理 + prompt 契约 + 失败语义**值得对照实现。

### 2.3 Squad：leader–worker 多智能体编排

不是代码级编排引擎，而是**协议级**：squad = 一个 leader agent + 一组成员（agent 或人）。

- `server/internal/handler/squad_briefing.go`（368 行）：leader 每次被触发都注入硬编码 `squadOperatingProtocolHeader`——「你是 LEADER，职责是协调不是干活；用精确 @mention 语法委派给最合适的成员（按 Roster 里的 skills 匹配）；**委派完就停**（stop-after-dispatch）；每轮必须用 `multica squad activity <issue-id> <outcome> --reason` 记录 action/no_action/failed」。no_action 规则单一来源，防止四处复制漂移。
- `server/internal/handler/squad.go`（1,243 行）：成员权限模型（owner/admin 全管、creator 管自己的 squad；`memberCanWireAgent` 防止把无权 @ 的 agent 塞进 squad 走路由后门，MUL-4223）。
- **对我们的启示**：wemux 的 Agent Delegation 领域模型（parentInvocationId、Delegated Authority 交集收窄）比它的权限模型更严谨；但它的「**用评论 @mention 作为编排总线 + leader 协议 prompt + 决策留痕**」是已经跑在生产上的轻量方案，比写编排 DSL 便宜得多。

### 2.4 Agent 自调度唤醒（Issue Wakeup）

agent 可以给自己安排"闹钟"——这是它自治闭环的关键：

- `server/internal/service/issue_wakeup.go`（831 行）：`kind ∈ {event, at, every, cron}`，`mode ∈ {once, continuous}`；event 型可按事件类型（issue/comment/reaction/attachment/task.*）+ actor/agent/task 过滤器订阅；instruction 限 12,000 字节；支持时区。典型用法：agent 提 PR 后设一个「PR 被 review 评论时唤醒我」的订阅，人类一评论它就自动回来继续改。
- 执行端由 DB-backed 调度器驱动：`server/internal/scheduler/spec.go` —— `sys_cron_executions` 表以 `(job_name, scope_kind, scope_id, plan_time)` 唯一键做**分布式租约 + 审计日志**，多实例同 tick 只有一个赢；stale-lease 可窃取；CatchUpMode（latest_only / every_plan）处理补账。
- wemux 目前完全没有这一层。

### 2.5 失败分类 + 重试策略

- `server/pkg/taskfailure/classify.go`（618 行）：把各 agent CLI 的自由文本错误映射到 **14 个 `agent_error.*` 子原因**。规则顺序敏感（context_overflow 必须在 quota 之前）；正则带**数字边界守卫**（`(^|[^0-9])5[0-9][0-9]([^0-9]|$)`，防 "402913 tokens" 误入 auth 桶）；与离线回填 SQL CASE 保持 lock-step（SQL 是 source of truth）。
- 重试白名单：**只有 `provider_network` 可自动重试**（MUL-4910），其余全部停机报因。配套 `checkout-keeps-work-v1` capability 保证重试复用父 workdir 时不清掉未提交工作。
- wemux 的 Journal/错误上报目前没有等价的失败语义分层。

### 2.6 前端 realtime → Query 缓存协同（与我们同栈，最直接可抄）

- `packages/core/realtime/use-realtime-sync.ts`（1,835 行）：WS 事件**只 patch/invalidate TanStack Query 缓存，不写 Zustand**（Zustand 只放 UI 状态：过滤器/草稿/弹窗/tab 布局）；每个领域有 `ws-updaters`（`onIssueCreated/onIssueUpdated/...`）做细粒度缓存手术；`cache-coordinator` 处理按 last_activity/updated_at 排序列表的失效；chat 消息按 `mergeTaskMessagesBySeq` 序号合并。
- `AGENTS.md` 里的状态规则写得很完整：乐观 patch 四条件（结果可预测、失败罕见、回滚 trivial、留在当前屏）、create/delete 不乐观、`wsId` 进 query key、zod `parseWithFallback` 兜底坏响应。
- **wemux 的 web-contract/session-view 尚是自研投影，这套 Query/Zustand 边界 + WS updater 分层可以整体对照重构。**

### 2.7 Worker 本地卫生（对 wemux Worker 直接相关)

- agent CLI 发现：`agents_probe.go`（489 行）exec.LookPath 常规扫 + **login-shell PATH 解析带 TTL 缓存**（避免每次 fork 用户 shell 跑 rc 文件）。
- 磁盘治理：`gc.go`（1,651 行）——裸仓缓存目录 `.repos` 与任务目录分层、保留策略、按 LRU 逐出 repo、Windows junction 处理。
- 技能分发：`skill_cache.go` + `pkg/skillbundle/hash.go` —— bundle 内容寻址缓存，**rename 原子安装**，失败回退。

---

## 3. 与 wemux-mini 的重叠对比

### wemux-mini 已有（不需要抄）

- **Server/Worker 分体 + Worker 主动长连接**：wemux transport v2（`packages/wire-protocol/src/transport-v2.ts`）与 multica daemon↔server 模式同构，且 wemux 的 Reliable Worker Delivery（invocationId 幂等 + messageId 传输去重 + 重连重发）设计上**更严谨**——multica 只做到 claim 级 at-least-once。
- **Agent 适配层**：wemux `apps/worker/src/agents/`（pi/claude/opencode + runtime-session-adapters + runtime-event-mapper）对应 multica `server/pkg/agent/`（26 个 CLI 适配）。multica 胜在广度，wemux 胜在统一 ADK Profile 契约。
- **能力声明**：wemux `capabilities.ts`（streaming/resume/steering/approval/artifacts…，"不静默降级"）与 `DaemonCapability*` 思想一致，wemux 甚至更细。
- **Workspace/Placement 模型**：wemux 的 Workspace→Placement→Checkout 层次比 multica 的 flat task workdir + repocache 更有表达力（multica 没有"一个 workspace 多机落点"的概念）。
- **终端/文件/窗口**：已从 t3code 借鉴，multica 无此模块。

### Multica 做得更好（差距项）

1. **任务调度闭环**：deferred 提升、批量认领、empty-claim 缓存、并发槽位、idle watchdog（超预算检测窗封顶 +5min）。
2. **运行中转向**的完整时序与失败语义。
3. **失败分类 + 自动重试白名单**。
4. **Agent 自治闭环**（wakeup 订阅 + cron + autopilot）。
5. **前端 realtime 缓存协同**的规模化经验（1,800 行 updater 编排 + 明文状态规则）。
6. **产品外围**：plugin SDK、5 语言 i18n、Slack/Lark/DingTalk/WeCom/Telegram 通道、Composio 集成、usage 计费分析。wemux 均为空白，但多数属于"以后再说"。

---

## 4. 可借鉴清单

> ⚠️ License 前提：**学习机制、重新实现**；Apache 2.0 部分的后端代码如需片段引用须保留署名，**UI 代码一律不抄**（触发品牌附加条款）。

### 建议抄（按优先级）

1. **失败分类 + 重试白名单**（性价比最高）
   源码：`server/pkg/taskfailure/classify.go`、`failure.go`、`server/internal/service/task.go`（retryableReasons）
   做法：在 `packages/domain` 或 worker 侧用 TS 重写 14 类错误分类器（正则 + 边界守卫 + 顺序敏感），Journal 失败事件带上 `failureReason`；自动重试只放行 `provider_network` 类。纯函数、无依赖、一两天落地。

2. **运行中转向（steer）的契约与时序**
   源码：`server/internal/daemon/task_supplement.go`、`server/pkg/protocol/messages.go`（TaskSupplementFailure\* / DaemonCapabilityTaskSupplementV1）
   做法：wemux 已声明 steering 能力，补上：注入 prompt 模板（"补充而非替换"三原则）、turn 未开始窗口的单槽信号合并、`turn_not_started/provider_rejected/timeout/turn_ended` 失败枚举、能力未声明时 fail-closed。

3. **realtime 事件 → TanStack Query 缓存的分层 updater**
   源码：`packages/core/realtime/use-realtime-sync.ts`、`packages/core/issues/ws-updaters.ts`（目录）、`packages/core/issues/cache-coordinator.ts`、`packages/core/chat/queries.ts`（mergeTaskMessagesBySeq）
   做法：把 wemux web 的 SSE/WS 事件处理改成 per-domain updater + query key 带 scope + 排序列表集中失效；同时采纳其 AGENTS.md 状态规则（Query 管服务端数据 / Zustand 管视图状态 / 乐观 patch 四条件）。**同栈同库，抄的是纯模式**。

4. **能力协商常量替代版本比较**
   源码：`server/pkg/protocol/messages.go`（DaemonCapability\* 全部带 why 注释）
   做法：wemux `wire-protocol/capabilities.ts` 已有雏形，补"每个能力必须写清不声明时的回退行为 + 为什么版本号判断不可靠"的纪律；steering/supplement 这类"不支持会做错事"的能力必须 fail-closed 而非缺字段默认。

5. **Agent 自调度唤醒（wakeup 订阅）**
   源码：`server/internal/service/issue_wakeup.go`、`server/internal/scheduler/spec.go`（DB 租约调度器）、`server/internal/daemon/wakeup.go`（提示通道）
   做法：中期项。wemux 的 SQLite 单实例用不到分布式租约，但 `kind(event/at/every/cron) + filter + once/continuous` 的输入模型和"agent 提交后订阅 review 事件自动回来"的产品闭环值得进 roadmap。

### 明确不抄

1. **Go + PostgreSQL + pgvector + Redis 后端栈**：与 wemux「Lite = node:sqlite、零外部依赖、单二进制部署」的根本定位冲突；其 sqlc/迁移纪律（无外键、应用层管关系、CONCURRENTLY 索引）好但绑定 PG。只取模式（如"逻辑关系在应用层校验"这条对 SQLite 同样适用）。
2. **Next.js + Electron + Expo 三端 monorepo 与 packages/views 共享层**：wemux 是 Vite SPA 单端口部署，没有 SSR/桌面/移动需求；引入 NavigationAdapter/StorageAdapter 那套平台抽象是为自己没有的问题付费。同理**不抄它的 UI 代码**（License 品牌条款）。
3. **（附带）26 个 CLI 适配的广度**：先做好 pi/claude/opencode 三个的深度（wemux ADK Profile 路线正确），别被广度带偏。

---

## 5. 结论

**值得跟进，建议列为继 t3code 之后的核心借鉴源（调度/转向/失败语义/前端 realtime 四个专题），定位是"读源码学机制"而非"复制代码"。**

- 与 t3code 分工：t3code → 窗口/文件/终端等 Workbench 模块（已借鉴完）；multica → **任务调度闭环、运行中转向、失败分类重试、Query/Zustand realtime 协同**（wemux 的四个空白/薄弱区）。
- 它是市场上与我们领域定义（"自托管 AI agent 集群/团队协作平台"）重合度最高的 5 万星项目，竞品+教材双重身份，roadmap 决策时应持续对照。
- License 决定姿势：机制级学习 + 自行实现；**绝不复制其 UI 代码**；若未来引用其 Go 后端代码片段需保留 Apache 2.0 署名。
- 源码已留在 `project/multica-upstream/multica-main/`，上述文件路径均可直接查阅。

### 证据索引

- stars/forks/license/最近提交：GitHub API `repos/multica-ai/multica`（2026-09-27 实测 51,401★ / 6,663 forks / pushed 2026-09-26 / license NOASSERTION）
- License 附加条款：`LICENSE` Part I（Index Labs (Hong Kong) Limited，1a 托管限制、1b 品牌限制）
- 关键源码：见第 4 节各条目路径（本地 `project/multica-upstream/multica-main/` 下）
- 技术栈：README.md Development 段 + `AGENTS.md` 包边界表
