# t3code（pingdotgg/t3code）调研：为 wemux-mini 所用的可行性评估

> 调研日期：2026-09-26。源码快照：`/opt/data/profiles/hacker/workspace/project/t3code-upstream`（main 分支 tarball，103MB 压缩 / 316MB 解压，gzip -t 校验通过）。所有路径均相对该目录，另有标注者除外。

## 1. 项目本质

| 维度 | 结论 | 证据 |
|---|---|---|
| 作者 | Ping.gg（Theo 的公司），版权主体 **T3 Tools Inc.**，确属 T3 生态官方项目 | `LICENSE` 第 3 行 `Copyright (c) 2026 T3 Tools Inc.`；GitHub org `pingdotgg` 描述 "We build tools for modern devs" |
| 定位 | **"agent harness control surface"**：不自己实现 agent loop，而是驱动本机已装的 agent CLI（Codex / Claude Code / Cursor / Grok Build / OpenCode / Antigravity），提供 Web + 桌面（Electron）+ 移动（Expo）三端控制面 | `README.md` 第 3、5 行 |
| 成熟度 | 23,617 stars / 6,121 forks / 2,348 open issues；创建于 2026-02-08，最近推送 2026-09-26（调研当天），极活跃但自述 "very very early… Expect bugs" | GitHub API 实测；`README.md` 第 83 行 |
| License | **MIT**（见 §4c） | `LICENSE` |
| 贡献政策 | **明确基本不接受贡献**："We are (mostly) not accepting contributions yet. Small fixes may be considered. Big features will not be." | `README.md` 第 85 行 |

技术栈（`package.json`、`apps/*/package.json`）：

- **Monorepo**：pnpm 11 + 自研构建器 **`vite-plus`（vp）**——不是标准 Vite，贡献者必须先装全局 `vp` CLI（`CONTRIBUTING.md`、`README.md` 第 105-121 行）。Node 要求 `^24.13.1`。
- **后端** `apps/server`：纯 **Effect 生态**（`effect`、`effect/unstable/rpc`、`effect/Schema`、`effect/Stream`、Layer/Context.Service），自研 RPC 契约包 `packages/contracts`（1,539 行 `rpc.ts`）；SQLite 持久化（`src/persistence/Migrations`）；`node-pty` 做终端。
- **前端** `apps/web`：React 19.2 + **React Compiler**（`babel-plugin-react-compiler`）+ **TanStack Router**（文件路由）+ **Tailwind v4** + **Base UI**（`@base-ui/react`，非 Radix）+ shadcn（`components.json` style=`base-mira`）+ **TipTap** 富文本 composer + zustand + `@effect/atom-react`。
- **桌面** Electron、**移动** Expo/React Native（`apps/mobile`）。
- 共享层：`packages/client-runtime`（web/mobile 共享连接、重试、状态）。

## 2. Agent 部分怎么实现

### 2.1 核心：它没有自己的 agent loop，是"驱动 + 归一化 + 事件溯源"三层

**第一层：Driver SPI（进程/协议驱动）**。`apps/server/src/provider/ProviderDriver.ts` 定义：driver 是 plain value 而非 Context.Service，`create()` 返回 `ProviderInstance`（`snapshot` / `adapter` / `textGeneration` 三组闭包 + instanceId）。六个实现：

- `Drivers/CodexDriver.ts`（351 行）：spawn **`codex app-server`** 子进程走 JSON-RPC（`Layers/codexLaunchArgs.ts` 第 13 行 `"app-server"`；客户端在 `packages/effect-codex-app-server/src/client.ts`，child stdio JSON-RPC）。
- `Drivers/ClaudeDriver.ts`（353 行）→ `Layers/ClaudeAdapter.ts`：**直接用 `@anthropic-ai/claude-agent-sdk` 的 `query()`**（非 CLI 文本协议；见文件头 import 块与第 6 行注释 "Wraps `@anthropic-ai/claude-agent-sdk` query sessions"）。`apps/server/package.json` 依赖 `@anthropic-ai/claude-agent-sdk ^0.3.276`。
- Cursor / Grok / Antigravity：走 **ACP（Agent Client Protocol, agentclientprotocol.com）**，自研 `packages/effect-acp`（`src/agent.ts` 实现 `session/update`、`session/request_permission`、`session/elicitation`、fs 读写等客户端方法）。
- OpenCode：`@opencode-ai/sdk` + 每 thread 一个 server 进程（`docs/internals/providers.md`）。

**第二层：ProviderAdapter 归一化契约**。`provider/Services/ProviderAdapter.ts` 定义统一操作面：`startSession` / `sendTurn` / `interruptTurn` / `respondToRequest`（approval）/ `respondToUserInput`（结构化问答）/ `stopSession` / `listSessions` / `compaction`（`native` 或 `slash-command` 两种模式，第 35-42 行）+ `capabilities`（会话中换模型、无 prompt 续跑、会话回滚）。各 provider 的错误/权限语义在这里被压平，例如 `provider/acp/AcpAdapterSupport.ts` 把 ACP 的 `allowOnce→accept`、`allowAlways→acceptForSession` 映射为内部枚举（第 50-62 行 `acpPermissionOutcome`）。

**第三层：事件溯源编排**。`docs/internals/overview.md`（第 53-78 行）+ 源码：

- `orchestration/Layers/OrchestrationEngine.ts` 串行化命令；`orchestration/decider.ts` 纯函数产出事件（不做任何 provider/文件系统 I/O）；**事件 + 投影 + 命令回执在同一个数据库事务提交**，命令重试幂等。
- Reactor 在意图落库后做副作用再回灌命令：`Layers/ProviderCommandReactor.ts`（下发 turn）、`Layers/ProviderRuntimeIngestion.ts`（把 provider 原生事件流归一化入库）、`Layers/CheckpointReactor.ts`、`ThreadSettlementReactor.ts`（turn 结算）。
- 会话管理：thread 为一等实体，SQLite 投影；**checkpoint 用隐藏 git refs 保存工作区状态**，不污染用户分支（`src/checkpointing/CheckpointStore.ts`，overview.md 第 79-82 行）；会话回滚要求 provider 能回滚对话否则先拒绝。

### 2.2 事件模型（与我们 AgentEvent 最可直接对照的部分）

`packages/contracts/src/providerRuntime.ts`（约 1,240 行，effect Schema 定义的 `ProviderRuntimeEvent` V2）。事件类型字面量清单（第 83-201 行）：

- 会话：`session.started/configured/state.changed/exited`
- 线程：`thread.started/state.changed/metadata.updated/token-usage.updated` + realtime 语音系列
- 轮次：`turn.started/completed/aborted/plan.updated/proposed.delta/proposed.completed/diff.updated`
- 条目与流式：`item.started/updated/completed`、**`content.delta`**（带 `streamKind`：`assistant_text | reasoning_text | reasoning_summary_text | plan_text | command_output | file_change_output | unknown`，第 83-91 行）
- 交互：`request.opened/resolved`（审批）、`user-input.requested/resolved`
- 子任务/工具：`task.*`、`hook.*`、`tool.progress`、`tool.summary`、`tool.denied`
- 账户/运维：`auth.status`、`account.rate-limits.updated`、`mcp.*`、`model.rerouted`、`runtime.warning/error` 等

每个事件 base 结构：`{ eventId, provider, providerInstanceId, threadId, createdAt, turnId?, itemId?, requestId?, raw? }`（第 202-216 行）。token 用量快照 `ThreadTokenUsageSnapshot` 细到 `cachedInputTokens / reasoningOutputTokens / compactsAutomatically / autoCompactThreshold`。

**对照 wemux-mini**：我们的 `packages/agent-interchange/src/event.ts`（`AgentEvent { id, invocationId, author, content, actions, partial, timestamp, customMetadata.wemux.{terminal,error,usage,nativeSession,approvalId} }`）粒度更粗：流式只有 `partial` 布尔 + `content`，没有 streamKind 区分（推理/计划/命令输出/文件变更混在一起）；审批只有 `approvalId` 引用没有 request/respond 事件对。t3code 的 `content.delta.streamKind` 与 `request.opened/resolved` 是最值得抄的协议语义。

### 2.3 流式输出与上下文管理

- 流式：adapter 层以 Effect `Stream` 暴露 provider 原生事件流（`ProviderAdapterShape` 里 `ProviderRuntimeEvent` 流 + `RuntimeContentStreamKind`），orchestration 有 `ThreadLiveEventCoalescer.ts` 与 `LiveStreamBudget.ts` 做合并/限流再推 WS。
- 上下文：`thread.token-usage.updated` 持续上报 before/after tokens；**compaction 双模式**（native API 或 `/compact` 斜杠命令当 turn 发送，`ProviderAdapter.ts` 第 35-42 行）；Claude 的 resume 压缩问答有专门处理（`shared/claudeCompaction` 的 `CLAUDE_RESUME_COMPACTION_NEVER_ANSWER`）。

## 3. 前端样式与组件

- **是 SPA**：Vite(+) 纯客户端构建，TanStack Router 文件路由（`apps/web/src/routes/`：`_chat.$environmentId.$threadId.tsx`、`settings.*.tsx`、`connect.tsx`、`pair.tsx` 等），无 SSR。
- **组件体系**：shadcn 注册表配置 `apps/web/components.json`（`style: "base-mira"`、baseColor zinc、lucide 图标、CSS 变量模式）。**基于 Base UI 而非 Radix**。`src/components/ui/` 40+ 个原语组件（button/badge/dialog/sheet/menu/sidebar/command/kbd/middle-truncate/qr-code…），这部分相对自包含。
- **样式系统**：`src/index.css` 2,237 行——Tailwind v4 `@theme` + 大量语义 CSS 变量：紧凑几何 token（`--control-radius: 0.5rem`、`--sidebar-content-inset`）、玻璃拟态（`--glass-blur/--glass-opacity`）、**对比度增强系统**（`--appearance-contrast-boost` + `contrast-*` 前景变量）、diff 专用色（`--diff-addition/deletion`）、语义状态色（warning/error/success/info/update 各有 foreground/surface 三层）、Electron WCO titlebar 变量、移动端 composer View Transition 动画。深浅色用 `.dark` class 变体。
- **会话交互组件**（`src/components/chat/`，89 个非测试文件）：
  - 输入框：`chat/ChatComposer.tsx`（**7,056 行**）+ `ComposerPromptEditorTiptap.tsx`（1,444 行，TipTap 富文本：@mention、斜杠命令、上下文 chip、图片附件、排队消息）。
  - 消息流：`components/ChatView.tsx`（**10,442 行**）、`chat/MessagesTimeline.tsx`（5,007 行 + `MessagesTimeline.logic.ts` 1,696 行），含 timeline minimap、滚动锚定（`chat/timelineScrollAnchoring.ts`）、工具组折叠（`summarizeToolGroup`）。
  - 工具展示：`packages/client-runtime/src/work-log/toolPresentation.ts` + `presentation.ts`——`WorkLogPresentationEntry { tone: thinking|tool|info|error, action: read|edit|command|browser|search|…, toolTitle, changedFiles }` 的归一化层，UI 按 tone/action 渲染。
  - 审批/问答：`chat/ComposerPendingApprovalPanel.tsx`、`ComposerPendingUserInputPanel.tsx`；diff 视图 `components/diffs/`（`@pierre/diffs` 树 + 注释）。
- **状态管理**：zustand（UI store）+ `@effect/atom-react`（领域状态），领域状态在 `packages/client-runtime/src/state/*`（threads/terminal/vcs…）。
- **体量**：`apps/web/src` 839 个 ts/tsx 文件、**约 21.8 万行**（含测试）；深度依赖 `@t3tools/contracts`（RPC 契约）、`@t3tools/client-runtime`、Clerk 认证、t3 relay/配对（`pair.tsx`、`ws.ts` 的 wsTicket）。

## 4. 集成评估

### a) Agent 部分能否抽出来接 wemux-mini 的 worker 体系？

**不能直接抽**。理由：

1. **全仓 Effect 化**：driver/adapter/engine/reactor 全部构建在 `effect`（Layer、Stream、Schema、unstable/rpc）之上，连 JSON-RPC 客户端（`packages/effect-acp`、`packages/effect-codex-app-server`）都是 Effect Service。抽出任何一个模块都会拖进 effect 运行时，与我们 worker（零框架、node:sqlite、`ws` 唯一生产依赖，见 AGENTS.md「Worker 与 Agent 安装边界」）的轻量约束直接冲突。
2. **它不是 agent loop 而是编排系统**：价值集中在事件溯源 orchestration + 六 provider 归一化，两块都与 T3 自己的 SQLite 投影/RPC 绑死；我们 worker 已有 AgentEvent + journal 投影，重复引入等于双写。
3. 与我们架构同构但不可移植：我们 worker 本地跑 agent CLI + BYOK 的模式和它一致（`docs/internals/overview.md`："Provider processes… belong to the server"），但我们的 `apps/worker/src/agents/*-runtime-session-adapter.ts` 已经在做同样的事。

**可移植/可借鉴的机制**（按价值排序）：
1. **`ProviderRuntimeEvent` 的事件分类与 `content.delta.streamKind`**——直接作为 `AgentEvent` 协议升级的参考（纯语义设计，无依赖）。
2. **`request.opened/resolved` + `user-input.requested/resolved` 事件对**——比我们现在的 `approvalId` 单引用完整（决策结果进入事件流，可回放）。
3. **`ProviderCompaction` 的 native/slash-command 双模式抽象**——我们接 Claude/pi 的 /compact 时可直接抄这个建模。
4. **`ThreadLiveEventCoalescer` / `LiveStreamBudget`** 的流控思路（合并高频 delta、预算限流）。
5. **checkpoint 用隐藏 git refs**——比文件快照干净，适合我们 Workspace Placement。
6. **若未来要接 Codex**：`packages/effect-codex-app-server/src/schema.ts` 有完整 `codex app-server` JSON-RPC 方法面定义，可当协议参考文档用（实现自己写轻量 stdio JSON-RPC 即可，不必引 Effect）；接 Cursor/Grok 时 `packages/effect-acp` 同理是 ACP 协议的现成参考实现。

### b) 前端完全替换的可行性

**不可行，工作量差三个数量级**：

- 我们现有 `apps/web` 约 1,000 行会话 UI（App.tsx 339 行 + features/sessions 8 个文件共约 860 行 + AI Elements 组件）；t3code web 端 **21.8 万行 / 839 文件**，单个 `ChatView.tsx`（10,442 行）就超过我们全部前端代码 10 倍。
- 强耦合非公开包：`@t3tools/contracts`（RPC 契约 1,539 行 rpc.ts + 全部领域 Schema）、`@t3tools/client-runtime`（连接/重试/领域状态）、Clerk、t3 relay 配对——这些是它的"后端"，换绑到 wemux-mini server 等于重写数据层。
- 构建工具链锁死 `vite-plus`（vp）+ React Compiler + pnpm catalog + Node 24，与我们 npm workspaces + 标准 Vite 冲突；`package.json` 明言贡献需装 vp。
- 但**样式层可以整体借鉴**（见下）。

### c) License 是否允许

**MIT（T3 Tools Inc.），允许**：复制、修改、再分发、商用、 sublicense 均可，唯一义务是在副本中保留版权与许可声明（`LICENSE` 全文 21 行，标准 MIT）。即：抄 CSS token、抄组件代码、甚至 fork 整仓再闭源分发都合法，只需在源码/发布物里保留 MIT 声明（建议在我们的 `docs/research/` 或组件头部注明 "Derived from pingdotgg/t3code, MIT"）。注意：MIT 只覆盖版权，不授权商标，"T3 Code" 名称与 logo 不应在我们产品中出现。另 `third-party-licenses.config.json` 显示其对第三方依赖合规有整理，抄文件时留意组件上游（Base UI 是 MIT）。

## 5. 结论与建议

**结论：部分借鉴（样式系统 + 协议语义），不直接集成、不整体替换前端。** 一句话理由：agent 侧是深度 Effect 化的事件溯源编排系统（抽出即拖运行时），前端侧是 21.8 万行、绑定 T3 私有契约与 vite-plus 工具链的成品应用（替换成本远超重写），而 MIT license 让"抄设计与代码片段"完全合法且成本最低。

### 如果集成，分几步走（行动草案）

1. **样式 token 迁移（1-2 天）**：把 `apps/web/src/index.css` 的语义变量体系（`--control-radius`/sidebar 几何、`--glass-*`、`--appearance-contrast-*`、`--diff-addition/deletion`、warning/error/success/info/update 三层状态色、`.dark` 变体）移植进 wemux-mini `apps/web/src/styles.css`，保持现有深色优先策略；文件头加 MIT 来源注释。
2. **原语组件拷贝（2-3 天）**：从 `apps/web/src/components/ui/` 挑 button/badge/kbd/middle-truncate/scroll-area/separator/sheet/dialog-styles 拷入（Base UI + cva + tailwind-merge，需加 `@base-ui/react`、`class-variance-authority` 依赖，评估与现有 AI Elements 的重叠后二选一），同步拷 `components.json` 的 base-mira 约定。
3. **AgentEvent 协议升级（2-3 天，独立于前端）**：在 `packages/agent-interchange/src/event.ts` 为流式事件加 `streamKind`（assistant_text/reasoning_text/plan_text/command_output/file_change_output）语义，把审批从 `approvalId` 单引用升级为 `request.opened/resolved` 事件对；各 runtime-session-adapter 增量映射。
4. **会话 UI 局部重构（1 周）**：消息流参考 `work-log/toolPresentation.ts` 的 `tone/action` 归一化模型改造我们 conversation.tsx 的工具展示；滚动锚定参考 `chat/timelineScrollAnchoring.ts`；Composer 若要富文本再评估 TipTap（当前建议缓，保持轻量）。
5. **按需接新 provider（远期）**：接 Codex 时以 `packages/effect-codex-app-server/src/schema.ts` + `codexLaunchArgs.ts` 为协议参考，在 worker 里自写轻量 stdio JSON-RPC；接 Cursor/Grok 时以 `packages/effect-acp` 为 ACP 参考。
6. **持续跟踪不 fork**：上游明确不接受大贡献且迭代极快（当天仍有推送），以"定期 diff 挑文件"的方式跟进，不做长期 fork 维护。

### 附：关键文件速查

| 主题 | 路径 |
|---|---|
| Driver SPI | `apps/server/src/provider/ProviderDriver.ts` |
| 归一化契约 | `apps/server/src/provider/Services/ProviderAdapter.ts` |
| 六个驱动 | `apps/server/src/provider/Drivers/{Codex,Claude,Cursor,Grok,OpenCode,Antigravity}Driver.ts` |
| Claude SDK 接法 | `apps/server/src/provider/Layers/ClaudeAdapter.ts` |
| 事件模型 | `packages/contracts/src/providerRuntime.ts` |
| 事件溯源 | `apps/server/src/orchestration/{decider.ts,Layers/OrchestrationEngine.ts,Layers/ProviderRuntimeIngestion.ts}` |
| ACP/Codex JSON-RPC | `packages/effect-acp/src/`、`packages/effect-codex-app-server/src/` |
| 设计 token | `apps/web/src/index.css`（2,237 行） |
| shadcn 配置 | `apps/web/components.json`（base-mira / Base UI / zinc） |
| Composer/消息流 | `apps/web/src/components/chat/ChatComposer.tsx`、`MessagesTimeline.tsx` |
| 工具展示归一化 | `packages/client-runtime/src/work-log/{toolPresentation,presentation}.ts` |
