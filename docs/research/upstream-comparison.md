# wemux 上游 vs wemux-mini 差距报告

> 调研日期：2026-09-26。对照对象：`project/wemux-upstream`（34MB / 1734 TS）与本仓库 `project/wemux-mini`。
> 方法：直接读上游源码（`apps/worker/src/execution|runtime`、`packages/shared/src`、`apps/web/src/routes|components`、`apps/server/src`），并与 mini 对应文件逐一比对。所有结论都带真实文件路径与行号级证据，不引用记忆。

## 0. 总览

| 维度 | 上游核心文件 | mini 对应 | 差距等级 |
| --- | --- | --- | --- |
| agent 编排 | `apps/worker/src/execution/agent-runner.ts` + `runtime-context.ts`(1014 行) + 各 `*-runner.ts` | `apps/worker/src/agents/*`（pi-rpc/pi-agent/claude-agent/opencode-agent） | **大**：mini 缺统一 runtime 注册表、缺 runtime 上下文准备层、缺审批桥接 |
| 本地存储三层 | `packages/shared/src/workspace-paths.ts`(273 行纯函数) + `docs/WORKER-LOCAL-STORAGE.md` | `apps/worker/src/workspaces/local-provisioner.ts` + `config.ts` | **中**：mini 是 `~/.wemux-lite` 扁平 + sha256 哈希目录 |
| Web 信息架构 | `apps/web/src/routes/{chat,workspace,workspaces}.tsx` + `components/app-sidebar.tsx`(2193 行) | `apps/web/src/app/shell.tsx`(59 行) + `App.tsx` 内联导航 | **大**：mini 是 Project-first 两级栏，无三页面语义 |
| server 控制面 | `apps/server/src/app.ts` + `routes/`(60+ 文件) + `control-plane/` | `apps/server/src/http/handler.ts`(446 行 / 43 个正则分支) | **中**：mini 传输层反而更强，缺的是路由组织与调度/租约 |

一个先说结论的反直觉发现：**mini 的 worker 传输层（`apps/worker/src/transport/transport-store.ts` 的 durable-ack / bounded-replay / delivery-epoch）比上游 `apps/worker/src/control-plane/ws-client.ts`（79 行，无 outbox、断线即丢）更健壮**。差距集中在执行编排与产品信息架构，不在连接可靠性。

---

## 1. Worker Agent 编排

### 上游实现要点

**A. 统一执行入口 + Runtime 注册表**
- `apps/worker/src/execution/agent-runner.ts`：`runWorkerAgentPrompt()` 是所有 agent 的唯一入口，固定流水线：校验 cwd（`validateWorkerPromptWorkingDirectory`，ENOENT 转中文错误）→ `ensureWorkerRuntimeReady({ autoInstall: true })` → 物化附件 → `prepareWorkerAgentRuntime()` → 查 `PROMPT_RUNNERS: Partial<Record<RuntimeId, RuntimePromptRunner>>` 注册表派发 → `finally` 里统一 cleanup。每个阶段先 `emitWorkerPromptStatus`（"正在准备附件…"），前端能看到执行进度。
- `packages/shared/src/agent-type.ts`：`RUNTIME_DESCRIPTORS` 声明每个 runtime 的 `transport: 'STDIO' | 'SDK' | 'RPC'` 与 `modelIdStrategy: 'canonical' | 'native'`。业务层 `AgentType` 与执行层 `RuntimeId` 分离，执行层不再散落 if/else。

**B. runtime 上下文准备层（mini 完全没有的一层）**
- `apps/worker/src/execution/runtime-context.ts`（1014 行，但接口只有一个 `prepareWorkerAgentRuntime()`）：按 runtime 注入隔离环境——
  - `HOME` 重定向到 `users/<actingUserId>/runtime/<prefix>-<hash>`（`getRuntimeBaseRoot`/`buildStableRuntimeBucket`，sha1 短桶稳定复用），配 `XDG_CONFIG_HOME/XDG_DATA_HOME/XDG_STATE_HOME/XDG_CACHE_HOME`；Windows 另设 `USERPROFILE/APPDATA/LOCALAPPDATA`（`buildWindowsRuntimeHomeEnv`）。
  - Skill 物化到临时根 + `.wemux-managed.json` 索引做增量清理（`writeRuntimeSkillPackages`/`readManagedSkillIndex`），带路径穿越校验（`targetPath.startsWith(skillRoot + sep)`）。
  - Codex 专属：TOML config 的表删除/合并/root 键提升（`removeTomlTable`/`hoistCodexRootKeys`，注释写明真实线上事故：model 夹在 table 后导致回退 ChatGPT 订阅）。
  - `RUNTIME_PREPARERS` 注册表返回 `{ promptPrefix, runtimeEnv, runtimeArgs, cleanup }`，`cleanup()` 在任务隔离路径时整目录删除。

**C. 三种真实协议实现（可当参考实现读）**
- Claude Code（`execution/claude-runner.ts`，625 行）：`-p --output-format=stream-json --input-format=stream-json`，stdin 写 JSON 行。**双向控制协议**：子进程发 `control_request`（含 `hook_callback`、权限询问），worker 回 `control_response`；`handleControlRequest` 里 `shouldAllowClaudeTool()` 决定 allow/deny，deny 时先发 `interaction.pending` 事件再回 `{ behavior: 'deny' }`。中止 = 发 `control_request{subtype:'interrupt'}` → 250ms 后仍存活则 SIGTERM（`handleAbort`）。会话续接 `--resume <sessionId>`，从每个事件的 `session_id` 字段捕获。
- Codex（`execution/codex-runner.ts`，2110 行）：JSON-RPC 2.0 over stdio（`codex proto app-server`，先 `--help` 探测子命令版本），**服务端主动请求**：`item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/tool/requestUserInput`，worker 用 `respond(id, { decision })` 应答；`buildPermissionDecision()` 把 approval mode 预编译成 allow/decline 决策表。还有 `spawn e2big` 的友好文案（环境变量/Skills 过多）。
- Pi（`execution/pi-runner.ts`，754 行）：**不走 CLI 子进程，用进程内 SDK**（`@mariozechner/pi-coding-agent` 的 `createAgentSession`），含 `repairPiAssistantMessageForToolCalls()`（修复流式 toolCall 分片）、`session.idle` 事件、`waitForIdle` 排空。

**D. 准入队列与中止原因分类**
- `apps/worker/src/runtime/message-handler/prompt-queue.ts`：worker 侧 prompt 准入队列（`pendingPromptRequests`/`queuedPromptRequestIds`/`runningTaskIds` 三个集合），每个阶段向控制面发 `executor.agent.prompt.event`（session.status busy 消息），完成时 `drainExecutionQueue()`。`message-handler/task.ts:17` 对已 assigned/running/queued 的 task 幂等去重。
- `execution/agent-runner-shared.ts`：`ExecutorAgentPromptAbortReason` 七值枚举（`user_stop/server_timeout/executor_disconnected/executor_reconnect/control_plane_disconnect/...`），`resolveAbortMessage()` 映射成用户可读文案；`AbortSignal.reason` 携带结构化原因。事件统一 `ExecutorAgentPromptEvent`：`session.status | message.updated | message.part.updated | message.part.delta | interaction.pending | permission.updated | session.error | session.idle`（`packages/shared/src/types/executor.ts:536-547`）。

**E. 心跳与执行器在线判定**
- worker：`runtime/daemon.ts:1000` 每 15s 发 `executor.heartbeat`；server：`control-plane/executor-ws-service.ts:255` `heartbeatIntervalMs: 15000`，掉线后 `previous?.status === 'offline'` 分支处理状态迁移（`socket.close(1011, 'executor offline')`）。

### mini 现状与差距

- `apps/worker/src/agents/pi-rpc.ts`（141 行）质量很高：bounded pending Map、16MiB 行上限、`trackDescendants()` 用 /proc starttime 防止 PID 复用误杀、detached 进程组 SIGTERM→500ms→SIGKILL。**这部分不用抄上游，上游没有等价物。**
- 差距 1：`pi-agent.ts` 每个 turn `new PiRpc()` 冷启动 CLI（`startTurn` 里 spawn + `get_available_models` + `set_model` + `get_state`），上游 pi-runner 是进程内 SDK 常驻。mini 的常驻会话由 `pi-runtime-session-adapter.ts` 弥补了一部分（persistent child），但 detect 路径每次也是冷启动。
- 差距 2：**没有 runtime 注册表**。`agentKey` 字符串散落在 `agents/*.ts`、`runtimes/management.ts`、`application/cluster-lifecycle.ts`（硬编码 `selected.pi?.executable / selected.opencode?.executable / selected['claude-code']?.executable`）。新增一个 agent 要改多处。
- 差距 3：**没有 runtime-context 层**。`FilesystemAgentLaunchContextProvider`（cluster-lifecycle.ts:242）只提供 skillsRoot/instructions；没有按用户隔离 HOME、没有 skill 物化索引、没有 codex/claude 配置准备。mini 当前单用户部署尚可，但 `docs/design/worker-web-workbench.md` 的双宿主方向落地时会成为阻塞点。
- 差距 4：**审批流只有 Pi 半条链路**。`runtime-session.ts:28` 有 `resolveApproval(approvalId, decision)` 端口，`runtime-event-mapper.ts:68` 映射 `approval_required`；但 `claude-agent.ts:24/31` 声明 `approvals: false` 且直接 `--permission-mode bypassPermissions`（读 env `WEMUX_CLAUDE_PERMISSION_MODE` 但默认 bypass），`opencode-agent.ts` 同样 `approvals: false`。上游对三家都有 permission 决策 + `interaction.pending` 事件桥接。
- 差距 5：无 worker 侧准入队列与 abort 原因分类；`application/runtime.ts:15/38` 有 `idleMs/maxMs` 超时（默认 10min hard cap），但没有 `executor_disconnected` 之类的语义区分，断连时用户看到的是笼统失败。

### 值得直接抄（按性价比排序）

1. **Abort 原因枚举 + 用户文案映射**：把 `agent-runner-shared.ts` 的 `resolveAbortReason/resolveAbortMessage/toAbortError` 模式搬进 `packages/domain`（纯函数，node:test 可覆盖），worker `AbortSignal.reason` 带结构化原因，server SSE 事件透传。改动小、用户感知大。
2. **统一事件契约**：`ExecutorAgentPromptEvent` 的 8 种 type 收敛 mini 的 `AgentSignal`/`runtime-event-mapper` 输出（mini 已有 `assistant.text.delta/tool.started/tool.output.delta/tool.finished/approval.requested`，补 `session.status`（阶段进度）与 `permission.updated`）。
3. **Runner 注册表**：`PROMPT_RUNNERS`/`RUNTIME_PREPARERS` 的 `Partial<Record<RuntimeId, ...>>` 表驱动模式，替换 `cluster-lifecycle.ts` 里的硬编码 executable 选择；descriptors（transport/modelIdStrategy）放 `packages/domain/src/runtime.ts`。
4. **Claude control_request 桥接**：照 `claude-runner.ts:321-375` 的 `handleControlRequest`（hook_callback 自动 success + 权限询问 allow/deny + `interaction.pending`）把 mini 的 claude adapter 从 bypassPermissions 升级为可审批。mini 已有 `/sessions/:id/runtime/approvals/:approvalId` 路由（`http/handler.ts:368`），缺的是 worker 侧桥。
5. **Skill 物化 + managed index**：`runtime-context.ts` 的 `.wemux-managed.json` 索引 + 路径穿越校验，当 mini 做技能下发时直接照抄。

### 明确不抄

- **`codex-runner.ts` 的 2110 行单体**（含 TOML 手写解析器、OAuth 账户切换、模型库注入）：上游为商业模型库做的兼容层，mini 无此需求；抄它等于背一个 codex 配置浏览器的维护负担。只抄 `requestApproval` 的 JSON-RPC server-request 应答模式（约 80 行）。
- **Pi 进程内 SDK 方式**（`@mariozechner/pi-coding-agent`）：会把重依赖钉死在 worker 里，违背 mini「worker 生产依赖只有 ws」的边界（AGENTS.md「Worker 与 Agent 安装边界」）；mini 的 CLI RPC + 版本探测（`supportedVersion` 校验 >=0.85.1）是更适合轻量版的路线。

---

## 2. Worker 本地存储三层结构

### 上游实现要点

- 规则文档：`docs/WORKER-LOCAL-STORAGE.md`（写明设计目标：多用户隔离 / workspace 共享 / workspace 隔离 / 节点级独立 / worker-first，以及 6 条禁止事项：不建根级 projects/repos/worktrees、不用 unknown 当 scope、凭据不进 workspaces/、不用 taskId 伪造 workspaceId）。
- 实现：`packages/shared/src/workspace-paths.ts` 全部纯函数（273 行，带 `workspace-paths.test.ts`）：
  - `requireScopeId(value, 'userId'|'workspaceId')`：空或 `unknown` 直接 throw——**把「非法 scope 不落盘」做成构造期错误**，而不是事后清理。
  - `getWorkspaceNodeDir/getWorkspaceUserScopeDir/getWorkspaceSharedScopeDir` 三层 scope dir；`getWorkspaceScopeDir` 按「有 workspaceId 走共享，否则走用户级」二选一。
  - `sanitizePathSegment`（非法字符转 `-`）+ `joinSegments`（归一化斜杠）——scope id 进路径前必过。
  - 旧结构识别：`isObsoleteManagedWorkspacePath` 用正则识别 `.wemux*|\.vibemux*` 品牌窗口与旧 `workspace/` 中缀、`users/<id>/workspaces/<id>` 嵌套，**只识别不新建**；`matchesExpandedHomePath` 处理 `~` 展开后的 `/Users/x` vs `/home/y`。
  - `resolveTaskWorktreePath(root, project, task)`：worktree 路径 = scope dir + `worktreeId || task.id`，一处定义。
  - `isManagedWorkspaceContainerPath`：判定「这个路径是否管理面拥有的容器目录」，用于安全删除边界。
- 消费方式：AGENTS.md 明确「优先改 shared helper，再同步消费方」；server 派发时必须带真实 `workspaceId` + `actingUserId`。

### mini 现状与差距

- `apps/worker/src/config.ts:26`：home = `~/.wemux-lite`（或 `--home`）。布局：`credential`、`runtime.lock`、`transport.sqlite`、`worker.sqlite`、`workspaces/` 全部平铺在 home 根（AGENTS.md「Worker home 目录直接含 …」）。
- `apps/worker/src/workspaces/local-provisioner.ts`：`workspaces/<sha256(workspaceId)>` 哈希目录 + `<key>.partial` 暂存 + 原子 `rename` + `<key>.ready` 签名标记（`JSON.stringify({spec, repositories})` 比对，冲突即 throw）。**这个原子 provision 协议本身很好，保留。**
- 差距 1：**目录名是 sha256 而非 workspaceId**，排查问题时 `ls workspaces/` 全是哈希，无法人工对应到业务 workspace（上游 AGENTS.md 专门强调可读性与 remap 识别）。
- 差距 2：**无 node/ 与 users/ 概念**：`credential`（worker 集群凭据）与将来的 agent runtime/用户凭据没有分层；一旦做双宿主（worker 自身 Web + 集群），用户私有凭据与节点凭据会混在 home 根。
- 差距 3：`LocalProvisioner` 只输出 `rootPath`，没有 repos/worktrees/cache/artifacts 子分层；将来做 worktree 隔离（任务并行改同一 repo）时无处落。
- 差距 4：路径规则没有共享层测试；`local-provisioner` 的 git 参数注入防护（`gitUrl.startsWith('-')` 检查）是好的，但路径 scope 校验只有哈希一层。

### 值得直接抄

1. **`packages/domain` 新增 `workspace-paths.ts`**：照抄上游 5 个核心函数（`sanitizePathSegment/joinSegments/requireScopeId` 三层 scope dir + `resolveTaskWorktreePath`），纯函数 + node:test。mini 先落两层：`node/`（credential、runtime.lock、transport.sqlite、worker.sqlite 迁入）+ `workspaces/<workspaceId>/`（明文 id，内部保留 `repos/ worktrees/ artifacts/` 预留位）。`users/` 层等双宿主动工时再加，但 helper 先留接口。
2. **`requireScopeId` 的构造期拒绝**：workspaceId 缺失/unknown 时 throw 而不是静默落到根目录——这条规则写进 `packages/domain` 后，provisioner 与未来 worktree 逻辑都免费获得保护。
3. **`.ready` 签名标记 + 旧路径只识别不新建**：mini 已有 `.ready`；补「哈希旧目录识别→迁移→删除」的一次性 remap 函数（放 worker CLI `migrate` 子命令），对齐上游「旧结构只允许 remap」的纪律。
4. **`isManagedWorkspaceContainerPath` 式的删除边界判定**：mini 将来做 workspace 回收（五态 placement + 空闲回收已实现）时，删除操作必须先过「这个路径确实归我管」断言，防路径注入。

### 明确不抄

- **`playground/` 自由工作区与日期子目录**（`buildWorkspacePlaygroundSessionDir`）：上游给「无项目临时执行」用的 codex 风格目录，mini 的产品语义是 Project→Workspace→Session，没有 playground 概念，抄了是死代码。
- **品牌兼容窗口（`.vibemux*` 识别）与多 home 探测**：上游历史包袱，mini 无存量用户。

---

## 3. Web 信息架构

### 上游实现要点

**三页面语义（AGENTS.md 用整节「禁止混用」锁定）**
- `/chat`：`routes/chat.tsx` 仅 11 行——`createFileRoute('/chat')` + 委托 `routes/-chat-route/chat-route.tsx`（TanStack 的 `-` 前缀 = 不生成路由的私有模块）。复杂度全部下沉：`chat-route.tsx`(353 行，目标选择 state 机) + `chat-target-sidebar.tsx`（agent/group/dm 三类目标左栏）+ `chat-session-list-sidebar.tsx`(220 行) + `chat-main-panel.tsx`(806 行) + `dm-chat-panel.tsx` + `workspace-group-chat-panel.tsx`；行为逻辑再拆 `use-chat-route-{controller,state,stream-actions,session-actions,share-actions}.ts` 六个 hook。布局用 `react-resizable-panels`（`Group/Panel/Separator`），移动端切换 list/detail 双态。
- `/workspaces`：`routes/workspaces.tsx` 23 行，`validateSearch: buildWorkspacesRouteSearch`（URL 即状态：projectId/taskId/workspaceId/workspaceSessionId/launchId/panel/terminal）；页面实现在 `components/workspaces/workspaces-page.tsx`(3273 行，但拆出 `workspaces-page-{view,queries,ui-store,utils,helpers}.ts*` 与 `use-workspaces-selection-model.ts`)。视图 `workspaces-page-view.tsx`：23/77 双栏 `react-resizable-panels`，左 `WorkspacesListPanel`，右 `WorkspaceDetailPaneCache`（按 selectedWorkspaceId 缓存详情实例）。
- `/workspace`：`routes/workspace.tsx`(2170 行) 单工作区详情，共享 `components/workspaces/workspace-shell.tsx`(1005 行)。**关键机制：`retained-workspace-panel.tsx` 的面板保活缓存**——`touchRetainedWorkspacePanelKey` LRU 保留最近 16 个面板实例，非激活面板 `className='hidden' + aria-hidden` 挂载不卸载，切换 workspace 不丢终端/聊天状态；配 `workbench-resource-registry` 决定隐藏时是否保留活资源（如终端进程）。

**左侧导航 `components/app-sidebar.tsx`（2193 行，含拖拽排序）**
- 结构：rail 快捷入口（dashboard/workspaces/drive/chat/inbox/review/actions…，`mainNavItems` 约 796-830 行，带 `isActiveOverride` 处理非标准路径激活态）+ 项目区（`partitionProjectsByScope` 分「协作区 / 私人 / 与我共享」三段，`ProjectSidebarSubsection`）+ Agent 区（`AgentSidebarGroups`，同样按 scope 分组，`SidebarAgentButton` 显示 agent 在线态与默认执行器名）。
- 项目拖拽排序：`app-sidebar-project-order.ts` 的 `mergeProjectSectionOrder` + 乐观 setState + 失败回滚 + `api.reorderProjects`。
- 移动端：`mobile-bottom-nav.tsx` 独立底部导航。
- UI 纪律：`docs/LINEAR-STYLE-UI-GUIDE.md`（扁平布局、双栏、紧凑控件、统一色板、禁止 Card 嵌套）。

### mini 现状与差距

- `apps/web/src/app/shell.tsx` 全部 59 行：`AppShell/GlobalRail/ProjectNavigation/MainCanvas/InspectorHost` 五个布局原语；`App.tsx:299` 的 `globalRail` 是 6 个文字链接（项目/团队/运行时/集群/组件/设置），`App.tsx:253` `projectNavigation` 是 6 个 section 链接（新对话/概览/看板/工作区/活动/设置）。路由 `app/router.tsx:12`：`/projects/$projectId/{overview,canvas,board,tasks,activity,settings,workspaces,sessions}` 全部嵌在项目下。
- 差距 1：**Project-first vs Conversation-first**。mini 的会话入口是 `/projects/:id/sessions`（新对话页 chips 已做），上游把「跟 agent 说话」提为顶级 `/chat`（不依赖项目选择）。mini 的 quick-conversation 组件承担了同样职责但 URL 不独立，深链/分享/移动端切换都受限。
- 差距 2：**工作区列表与详情不分离**。mini `workspaces` 只是项目下的一个 section（`App.tsx` 中 `resourceList` 渲染），没有「列表页保持、详情页独立 URL + 缓存」的结构；上游 `/workspaces` 列表 + `/workspace` 详情 + 详情面板保活是三件套。
- 差距 3：**无面板保活**。mini 切换 session/workspace 会卸载组件（除 InspectorHost 的 inert 方案外），终端、滚动位置、草稿全部丢失。
- 差距 4：导航无分组语义（协作区/私人）、无拖拽排序、无未读角标联动（上游 `chatTotalUnread` 聚合 DM+群聊写入 sidebar dot）。
- mini 已有的优势：InspectorHost 的焦点管理/陷阱（shell.tsx）比上游精细；`randomId()` 非安全上下文兼容纪律。

### 值得直接抄

1. **`RetainedWorkspacePanel` 保活缓存**（`retained-workspace-panel.tsx` 全文约 110 行，零依赖）：LRU key 列表 + hidden 挂载。直接套在 mini 的 session 详情/终端面板外层，成本一个下午，收益是「切会话不丢终端」这类体感质变。
2. **三页面 URL 语义**：把 `/projects/:id/sessions` 的 quick-conversation 提升为 `/chat`（保留 project 过滤参数），工作区列表独立为 `/workspaces`、详情 `/workspace/:id`。mini 已用 TanStack Router（`app/router.tsx` paths 数组），加三个 path 即可，`resolveSelection`（`app/selection.ts`）同步扩展。
3. **route 文件薄壳 + `-xxx-` 私有模块约定**：上游 `routes/chat.tsx` 11 行的模式——路由文件只做 `createFileRoute` + validateSearch，页面体放 `routes/-chat-route/` 或 components。mini 的 `App.tsx` 已 700+ 行且巨型 JSX 三元嵌套（第 256 行的单行渲染树），按此模式拆分能直接缓解。
4. **`validateSearch` 把 URL 当状态**（`-workspace-route-shared.ts` 的 `WorkspaceRouteSearch` 类型）：mini 当前 selection 大部分在组件 state，刷新即丢；学上游把 panel/terminal/launchId 写进 search params。
5. **侧栏 scope 分组 + 未读聚合**：`partitionProjectsByScope` 的三分组（协作/私人/共享）与 `chatTotalUnread` 聚合写角标，mini 的团队功能上线时直接套用。

### 明确不抄

- **`app-sidebar.tsx` 的 2193 行单体与拖拽排序子系统**：上游自己也承认在恶化（AGENTS.md「新增文件若逼近 800 行优先拆分」）；mini 的两级栏 + Sheet 抽屉（`App.tsx:334`）在当前信息量下更清晰。抄它的「结构」（scope 分组、激活态覆盖）而不是它的「体量」。
- **TanStack Start / SSR 与 `components/commercial-*-gate.tsx` 扩展边界**：mini 是纯 Vite SPA + 单一部署单元，open-core 双构建装配是上游商业模式的需求。

---

## 4. Server 控制面

### 上游实现要点

**A. 组装式路由**
- `apps/server/src/app.ts`（35 行）：`createHttpApp()`（`routes/http.ts`，319 行：bootstrap/state-stream/鉴权中间件 requireAuth）+ `createNodeWebSocket` + 7 个 `registerXxxWsRoute(app, upgradeWebSocket)`（executor/preview-tunnel/task-chat/workspace-session-history/main-chat/conversation/preview-gateway）。HTTP 路由按域拆 60+ 文件（`routes/project-main-chat.ts` 1521 行、`workspace-management-routes.ts` 3354 行、`collaboration-workspace-routes.ts`、`workspace-group-chat-routes.ts` 1243 行、`workspace-session-history-routes.ts` 295 行…），路由层只做协议/校验/响应码，业务在 `services/`、`control-plane/`、`repositories/`。
- HTTP+WS 统一在一个 Hono app 上，`@hono/node-ws` 提供 upgrade。

**B. 调度：纯函数打分**
- `packages/shared/src/executor-scheduling.ts`（199 行纯函数）：`buildExecutorSchedulingCandidates()` 对每个 executor 计算 `availableSlots = maxConcurrency - effectiveRunningCount`、`busyScore = running + controlPlaneQueued + localQueued`、近 20 个终态任务的 `failureRate`，排序键依次：手动指定 > 沿用当前 > 项目绑定命中 > 在线 > 有空槽 > 槽位多 > 失败率低 > 负载低 > 名字序；每候选带 `reasons[]` 人类可读理由（「命中项目绑定」「剩余 2 个并发槽位」「近期失败率 15%」）。server 侧 `control-plane/scheduler.ts` 只有 56 行——包装 registry + 可见性过滤。
- **双层队列**：executor 有空槽直接派发；无空槽任务留在控制面队列（reasons 明示「先进入控制面队列」）。

**C. 派发：租约 + 幂等**
- `control-plane/task-dispatch.ts`：`claimDistributedTaskForDispatch({ taskId, executorId, leaseExpiresAt: now+30s })` CAS 认领；`reclaimExpiredDistributedTaskLeases()` 把超租约任务收回队列并写事件「执行器在租约窗口内未确认启动」。派发前 `resolveTaskRuntimeCapabilitySnapshot()` 组装 MCP/skills/env 快照并 diff 回写，`hydrateTaskGitIdentity()` 注入 git 身份。worker 侧 `task.ack` 确认（`executor-messages.ts:169`）。

**D. WS 协议与请求-响应桥**
- 协议类型：`packages/shared/src/types/executor-messages.ts`（1078 行判别联合）：worker→server 44 种（register/heartbeat/latency.pong/capabilities.update/task.ack/task.event/task.result + 37 种 `executor.*.response`），server→worker 对应 request。全部类型化，无裸 JSON。
- `control-plane/executor-ws-requests.ts`：**按类型分桶的 pending 注册表**（`pendingAgentPrompts/pendingGitCommits/pendingTerminalRequests/...` 十几个 Map），把「发 request → 等 response」包装成 Promise；支持集群转发（`resolveExecutorRequestTarget`）。
- `executor-ws-service.ts`（840 行）：连接注册、15s 心跳、offline 迁移、重连时 `previous?.status === 'offline'` 广播。
- web 侧 WS：`main-chat-ws-route.ts` 用 `lastSeq` 游标重放（「Per-thread incremental event stream with seq-based cursor replay」，与 workspace-session-history-ws-route 同模式）；`/api/bootstrap` 带 `stateHash`，`/api/state/stream` 用 hash 判断是否需要重发全量。

### mini 现状与差距

- 传输层（**优势区，勿动**）：`apps/server/src/worker-ws/gateway.ts`（145 行）epoch symbol 防旧连接串话、`serializeLifecycle` 每连接操作串行化、`bufferedAmount > 2MB` 背压 terminate；`transport-store.ts` durable-ack + bounded-replay + delivery epoch（AGENTS.md §9.2/10.1 引用设计文档）。**比上游 ws-client 断线即丢强一档。**
- SSE：`http/sse.ts` 的 `SessionStreams` 已是 seq 游标重放 + freshness 事件 + 订阅先于回放（防窗口丢失）+ 15s 心跳 + 授权失效即断。这一块与上游 main-chat-ws 等价甚至更细。
- 差距 1：**路由组织**。`http/handler.ts` 446 行单函数 43 个 `path.match/path.startsWith` 顺序分支，`server.ts` 构造函数 20+ 个服务参数（`httpHandler(service, auth, streams, capabilities?, downloads?, control?, staticSite?, ..., canvasLayouts?)`）。加一个资源要改三处（构造、分发、handler 签名），且无中间件层（鉴权/CSRF/PAT scope 内联在分支里）。
- 差距 2：**无调度器**。Session 固定绑定 Worker/Workspace（AGENTS.md 领域模型），创建时人选 worker；没有并发槽位、失败率、项目绑定概念。单 worker 下无感，多 worker（mini 已支持多 worker 注册）时是裸的。
- 差距 3：**无租约**。Run 派发后如果 worker 掉线，靠 transport 重放恢复，但「worker 收到但从未开始」没有 30s 租约回收语义。
- 差距 4：**server→worker 无类型化 request/response 桥**。mini 的 `worker-ws` 是 Command/事件流（domain commands），不像上游把 37 种 `executor.*.request` 都包装成 Promise 化 RPC。mini 目前 control 面操作少，暂时不痛。

### 值得直接抄

1. **路由表化**：不必引入 Hono——在 `apps/server/src/http/` 加一个 30 行的 method+pattern 匹配器（`[method, RegExp, handler]` 数组），把 handler.ts 的 43 个分支拆成 `routes/{sessions,projects,workers,teams,tasks,auth}.ts` 每文件一个 `register(handler)`；`server.ts` 的 20 参构造改成 options 对象。这是纯重构，行为不变，typecheck+现有测试可完全锁定。
2. **`stateHash` bootstrap 模式**：mini 的 `/api/bootstrap` 等价物（首屏资源加载）加 payload hash，web 端带 `lastHash` 轮询/订阅时跳过重传。对 Tailscale/弱网场景收益明显。
3. **调度候选纯函数**（未来多 worker）：把 `executor-scheduling.ts` 的「打分 + reasons[]」模式（不是全部排序键）放进 `packages/server-domain`，mini 先只做：在线 > 空闲槽（worker 上报 maxConcurrency/running）> 最近失败率，`reasons` 直接展示在创建对话框里（「为什么推荐这个节点」）。
4. **租约式派发确认**：Run 创建后写 `leaseExpiresAt = now + 30s`，worker `start` 回执后清；超时回收进 queued + 事件说明。补上 mini「Run 排队/启动/完成三态竞态」之外的第四种竞态（派发石沉大海）。
5. **pending 注册表 RPC 桥**：等 mini 需要 server 主动向 worker 发一次性请求（如读文件、探测 repo）时，照 `executor-ws-requests.ts` 的分桶 pending Map + 超时 reject 模式，在 `worker-ws` 上加一个 `request<T>(workerId, payload)` helper。

### 明确不抄

- **Hono / @hono/node-ws / zod 全家桶**：mini 的 node:http + 手写 SSE 已覆盖需求且是明确的设计约束（AGENTS.md「保留 node:http/node:sqlite 默认方案，新增中间件需说明真实问题」）。上游用 Hono 是因为 60+ 路由文件与集群/企业装配的规模需求。
- **cluster/（集群转发）、enterprise/、commercial-extension-loader、preview-gateway/tunnel**：多 server 级联与商业扩展装配，mini 单 server + 直连 worker 的拓扑用不上；`resolveExecutorRequestTarget` 的集群路由层同理。
- **`workspace-management-routes.ts` 3354 行**：上游自己也标了反模式（AGENTS.md 函数/文件长度红线）；mini 拆路由时以它为反面教材，单文件守住几百行。

---

## 5. 行动建议（按优先级）

### P0（本里程碑内，直接补产品短板）

1. **拆分 `apps/server/src/http/handler.ts`**：43 分支 → `http/routes/*.ts` 表驱动注册 + `server.ts` options 对象化。纯重构、测试锁定，解锁后续所有 server 侧功能。（对照上游 `apps/server/src/app.ts` + `routes/http.ts`）
2. **Abort 原因分类 + 统一 agent 事件契约**：`packages/domain` 加 `AbortReason` 枚举与文案映射；`runtime-event-mapper.ts` 补 `session.status`/`permission.updated`；worker 断连/超时/用户停止在 UI 可区分。（对照 `execution/agent-runner-shared.ts`、`packages/shared/src/types/executor.ts:536`）
3. **`packages/domain` 新增 `workspace-paths.ts`**：`requireScopeId`/三层 scope dir/`resolveTaskWorktreePath` 纯函数 + 测试；worker home 迁移为 `node/` + `workspaces/<workspaceId>/`（明文 id 替代 sha256，附一次性 remap 子命令）。（对照 `packages/shared/src/workspace-paths.ts` + `docs/WORKER-LOCAL-STORAGE.md`）
4. **Claude 审批桥接**：`claude-agent.ts` 从 bypassPermissions 升级为 `handleControlRequest` 模式（hook_callback 自动 success、权限询问 allow/deny + `interaction.pending` → mini 已有的 `/sessions/:id/runtime/approvals` 链路）。（对照 `execution/claude-runner.ts:295-375`）

### P1（下个里程碑，信息架构与体验）

5. **`RetainedWorkspacePanel` 保活缓存**进 web：session 详情/终端面板 LRU 保活（上限 16），切换不卸载。（对照 `components/workspaces/retained-workspace-panel.tsx`）
6. **三页面 URL 语义**：`/chat`（quick-conversation 提升）、`/workspaces` 列表、`/workspace/:id` 详情；`app/router.tsx` paths 数组 + `app/selection.ts` 扩展；route 文件薄壳化并拆 `App.tsx` 巨型 JSX。（对照 `apps/web/src/routes/{chat,workspaces,workspace}.tsx`）
7. **Runner 注册表**：`cluster-lifecycle.ts` 硬编码 executable 选择改 `Partial<Record<AgentKey, ...>>` 表驱动 + `packages/domain/src/runtime.ts` descriptors（transport/approvals/usage 能力位复用 mini 已有的 `runtime` 声明）。（对照 `execution/agent-runner.ts` 的 `PROMPT_RUNNERS`）
8. **bootstrap `stateHash`**：首屏资源响应带 hash，web 携带上次 hash 跳过重传。（对照 `routes/http.ts:201-246`）

### P2（多 worker 规模化前）

9. **调度候选纯函数 + reasons 展示**：worker 上报 `maxConcurrency/runningTaskIds`（可搭 heartbeat），创建对话框展示推荐理由。（对照 `packages/shared/src/executor-scheduling.ts`）
10. **租约式派发**：Run 派发 30s 租约 + 超时回收事件。（对照 `control-plane/task-dispatch.ts` 的 `claimDistributedTaskForDispatch`）
11. **worker 侧 prompt 准入队列**：多 session 并发打同一 worker 时的排队 + 阶段状态事件（「正在准备附件…」「正在启动 Pi…」）。（对照 `runtime/message-handler/prompt-queue.ts`）
12. **server→worker Promise 化 RPC 桥**（按需）：分桶 pending Map + 超时。（对照 `control-plane/executor-ws-requests.ts`）

### 保持不动（mini 已优于上游或约束使然）

- worker 传输层：`transport-store.ts` durable-ack/bounded-replay/epoch、`gateway.ts` 背压与串行化——**上游没有等价物**。
- `pi-rpc.ts` 的子孙进程追踪与确定性 teardown；`pi-agent.ts` 的版本探测门槛。
- `SessionStreams`（sse.ts）的「订阅先于回放 + freshness」语义。
- node:http + node:sqlite 零框架约束；InspectorHost 焦点管理；`randomId()`/`copyText()` 非安全上下文纪律。

## 6. 佐证文件清单（上游侧）

| 主题 | 文件 |
| --- | --- |
| 统一执行入口 | `apps/worker/src/execution/agent-runner.ts`（274 行） |
| runtime 上下文 | `apps/worker/src/execution/runtime-context.ts`（1014 行） |
| 共享参数/中止原因 | `apps/worker/src/execution/agent-runner-shared.ts` |
| Claude JSONL+控制协议 | `apps/worker/src/execution/claude-runner.ts`（625 行） |
| Codex JSON-RPC | `apps/worker/src/execution/codex-runner.ts`（2110 行） |
| Pi SDK | `apps/worker/src/execution/pi-runner.ts`（754 行） |
| prompt 准入队列 | `apps/worker/src/runtime/message-handler/prompt-queue.ts` |
| daemon/心跳 | `apps/worker/src/runtime/daemon.ts`（1000/757 行处） |
| 存储分层 | `packages/shared/src/workspace-paths.ts`（273 行）、`docs/WORKER-LOCAL-STORAGE.md` |
| 路由组装 | `apps/server/src/app.ts`（35 行）、`routes/http.ts`（319 行） |
| 调度 | `packages/shared/src/executor-scheduling.ts`（199 行）、`control-plane/scheduler.ts`（56 行）、`control-plane/task-dispatch.ts`（227 行） |
| WS 服务/请求桥 | `control-plane/executor-ws-service.ts`（840 行）、`control-plane/executor-ws-requests.ts` |
| executor 协议 | `packages/shared/src/types/executor-messages.ts`（1078 行）、`types/executor.ts`（655 行） |
| 主聊天 WS | `apps/server/src/routes/main-chat-ws-route.ts` |
| 三页面路由 | `apps/web/src/routes/chat.tsx`、`workspaces.tsx`、`workspace.tsx`、`-workspace-route-shared.tsx` |
| chat 页组件群 | `apps/web/src/routes/-chat-route/*`（chat-route/chat-main-panel/chat-target-sidebar/…） |
| workspaces 页 | `apps/web/src/components/workspaces/workspaces-page*.tsx`、`workspace-shell.tsx`、`retained-workspace-panel.tsx` |
| 侧栏 | `apps/web/src/components/app-sidebar.tsx`（2193 行）、`app-sidebar-project-order.ts`、`app-sidebar-workspace-switcher.tsx` |
| UI 纪律 | `docs/LINEAR-STYLE-UI-GUIDE.md`、`docs/WORKER-AGENT-ARCHITECTURE.md` |
