# UI 审计：mini 对照上游 wemux 前端交互设计

> 审计范围：`apps/web/src`（mini，React+Vite）对照 `apps/web/src/routes/` + `components/workspaces/` + `docs/LINEAR-STYLE-UI-GUIDE.md`（上游）。
> 只提交互 / 信息架构 / 视觉层面问题，不涉及架构补功能。共 15 项：P0×5、P1×7、P2×3。

## mini 当前页面地图（审计基线）

- 布局骨架：`app/shell.tsx`（AppShell / GlobalRail / ProjectNavigation / MainCanvas / InspectorHost）
- 巨型入口：`App.tsx`（约 340 行单文件承载全部路由分支）
- 全局：header（Logo +「工作台|集群」segmented + 搜索 + 添加节点 + 刷新/设置）→ 常驻连接状态条 → workbench-layout（global-rail 64px 文字导航 → project-column【projectNavigation 6 项 + Sidebar】→ MainCanvas）
- 路由：`/projects`、`/projects/:id/{sessions|overview(+canvas)|board|tasks/:id|workspaces[/:id]|activity|settings}`、`/teams`、`/runtime`、`/cluster`、`/components`、`/settings`
- 会话页：header 面包屑 + details 状态条 + Conversation/Composer + SessionInfoPanel + InspectorHost(ContextPanel)

---

## P0 交互硬伤

### 1. Cmd/Ctrl+K 快捷键定位依赖脆弱的选择器，移动端完全失效
- 位置：`apps/web/src/App.tsx:234`（shortcut），搜索框在 `:310`（`hidden md:block`）与 `:334`（Sheet 内）
- 问题：用 `document.querySelector('input[aria-label="搜索会话"]')` 定位，但同 aria-label 有两个实例。<768px 时命中的 header 输入框处于 `display:none`，`focus()` 静默无效；md+ 时也取决于 DOM 顺序而非意图。
- 上游参照：`components/global-search/global-search-palette.tsx` 独立命令面板组件，快捷键由组件自身持有，不查 DOM 猜目标。
- 修复：把快捷键与目标绑定在同一组件内（useEffect 内 ref.focus()），或做成命令面板；至少让移动端命中 Sheet 内的输入框。

### 2. 会话切换全量重挂载，无面板保活，每次切换都回到加载态
- 位置：`apps/web/src/App.tsx:325-327`（`<Conversation key={sessionId}>`、`ClusterControls key`、`Composer key={selected.id}`）
- 问题：key 强制重挂整个对话区，切换会话必经「正在加载会话历史…」，滚动位置、草稿上下文全部丢弃；频繁切换体验割裂。
- 上游参照：`components/workspaces/retained-workspace-panel.tsx` LRU(16) hidden 挂载保活（`MAX_RETAINED_WORKSPACE_PANEL_INSTANCES = 16`），`workspaces-page-view.tsx` 的 `WorkspaceDetailPaneCache` 同款思路；AGENTS.md 明确这是关键设计。
- 修复：仿 retained-panel 用 hidden 挂载缓存最近 N 个会话面板，切换即时显示、后台静默刷新。

### 3. 「新建会话」双实现：CreateDialog 的 session 表单流已成不可达代码，实际入口走 chips 流
- 位置：`apps/web/src/App.tsx:269-284`（`openResource` 中 `kind === 'session'` 直接 `go(sessions); return`，永不 `setCreateKind('session')`）；死分支在 `components/create-dialog.tsx:61-80`（Worker/工作区/智能体/模型四连 select 表单）
- 问题：同一域存在两套平行的会话创建交互（QuickConversation 的 ConfigChip vs CreateDialog 的原生 select 表单），后者无任何入口可达，维护者极易改错地方；Sidebar Plus 按钮（`features/sessions/navigation.tsx:79`）、workspaces 卡片按钮、InspectorHost 按钮全部汇入 quick 流但行为 subtly 不同（是否预填 workspaceId）。
- 上游参照：会话创建单一入口——`workspaces-page.tsx` 的 `onCreateWorkspaceSession`，列表页与详情页共用一个 controller。
- 修复：删除 CreateDialog 的 session 分支（或整个 kind），统一收敛到 QuickConversation，并在注释里写明唯一入口。

### 4. 画布相关导航用 `window.location.href` 整页刷新，与其余 SPA 导航割裂
- 位置：`apps/web/src/App.tsx:256`（overview `onActivate`）、`:319`（「返回画布」按钮）、`features/session-canvas/adapters/react-flow/react-flow-canvas.tsx:149`（`onOpenFocus`）
- 问题：从画布进入会话 / 返回画布触发整页 reload，全部 React 状态（含 quick-start 草稿、optimistic echo）丢失，白屏一跳；同为导航的 `go()` 却是 SPA 行为，交互不一致。
- 上游参照：`routes/workspace.tsx` 全部经 TanStack Router（`buildWorkspaceRouteSearch` / `openPageTab`）导航，无整页跳转。
- 修复：三处 `window.location.href` 换成 `go()`（react-flow 内可通过回调上抛），保持 SPA。

### 5. 同屏双套项目导航（xl+ 桌面），三套导航集合互不一致
- 位置：`apps/web/src/App.tsx:253`（projectNavigation：sessions/overview/board/workspaces/activity/settings 六项纯文字）+ `:318`（project-column 同时渲染它与 Sidebar）；`features/sessions/navigation.tsx:39-74`（Sidebar nav：sessions/workspaces/board/activity 四项 + 「更多」下拉藏 overview/settings）；`components/project-quick-nav.tsx`（<1280px 时第三套：sessions/workspaces/board + 更多）
- 问题：xl+ 同屏出现两份几乎相同的项目导航（纯文字版 6 项 + 图标版 4+2 项），信息重复且两套的可见项集合不同；窄屏又换成第三套集合，用户记忆负担大。
- 上游参照：单一 `components/app-sidebar.tsx` 承载全局+项目导航，图标+文字，一处定义。
- 修复：删除 App.tsx:253 的 projectNavigation，只保留 Sidebar 一套导航；ProjectQuickNav 复用 Sidebar 的 navigation 数组保证集合一致。

---

## P1 冗余清理

### 6. 连接状态三层反馈常驻：状态条 + 诊断 details + 琥珀横幅，健康时也占整行
- 位置：`apps/web/src/App.tsx:315`（常驻 role=status 条：「服务端已连接 · N/M 个工作节点在线」+「诊断」`<details>`）、`:316`（异常琥珀横幅）
- 问题：一切正常时仍用一整行 border-b 展示低频信息；异常时又叠横幅，同一状态两处表达；「诊断」折叠是低频调试功能却常驻 header 下方。
- 上游参照：状态指示收进 sidebar/workspace 卡片的小 dot/badge，异常才出 `workspace-environment-status-banner.tsx` 横幅。
- 修复：健康态收成 header 一个状态 dot（hover/点开看详情），仅异常时展示横幅，诊断并入其中。

### 7. 集群入口双份：header segmented「工作台|集群」+ globalRail「集群」链接
- 位置：`apps/web/src/App.tsx:305-306`（segmented control）与 `:299`（globalRail 六项文字导航含「集群」）
- 问题：同一目的地两个一级入口、两种选中态视觉（segmented 高亮 vs rail 无高亮态——global-rail CSS 只有 hover/active，无 aria-current 样式）；且 global-rail 是纯文字 44px 方块，与全站 lucide 图标导航风格割裂。
- 上游参照：`app-sidebar.tsx` 单侧栏承载全部一级导航，`isActive` 统一。
- 修复：二选一（建议删 header segmented，rail 链接加图标 + aria-current 高亮），集群只留一个入口。

### 8. Worker 智能体/模型清单三处平铺展示
- 位置：`apps/web/src/App.tsx:256`（`/runtime` 页内联 capabilities 平铺）、`components/cluster-page.tsx:148`（executionAgents 统计 + 详情）、`features/sessions/navigation.tsx:99`（ContextPanel「查看智能体与模型」details）
- 问题：同一份 workers.capabilities 数据在三个页面重复展开，均为低频只读信息却各占高版位；/runtime 页尤其裸（无状态筛选、纯 `<p>` 列表）。
- 上游参照：执行器/运行时信息集中在 `execution/execution-executors-tab.tsx` 一处，其他页面只放一行摘要 + 跳转。
- 修复：保留 /cluster 为唯一详情处，/runtime 降级为跳转或删除，ContextPanel 只留「N 个可用智能体」摘要 + 链接。

### 9. 会话元信息三处重复：header 面包屑 + details 状态条 + SessionInfoPanel
- 位置：`apps/web/src/App.tsx:319`（header：项目 > 工作区 > 会话 · worker）、`:320`（`<details>` 会话状态：freshness 文案在 `:71` freshnessLabels 与 `session-info-panel.tsx:11` 定义了两份）、`features/sessions/session-info-panel.tsx`（信息面板全量重复展示）
- 问题：workspace 路径、freshness、排队数在三个 UI 层重复；freshnessLabels 字典复制两份已开始漂移风险；details 条默认折叠但仍占一行。
- 上游参照：`workspace-session-chat-layout.tsx` 单一 header + 可开合 outline，元数据一处渲染。
- 修复：header 面包屑保留一行摘要，details 状态条并入 SessionInfoPanel；freshnessLabels 提到 `lib/display.ts` 单一来源。

### 10. workspaces 列表与单工作区详情语义混在同一 URL 段
- 位置：`apps/web/src/App.tsx:254`（resourceList：无 workspaceId 时全部卡片，有 workspaceId 时在同一张卡片下追加会话链接）、详情靠 `InspectorHost` 侧栏（:332）补
- 问题：`/projects/:id/workspaces` 与 `/projects/:id/workspaces/:id` 页面形态几乎相同（后者只是过滤+内嵌列表），「详情」实为侧栏 Inspector，关闭时还会跳回列表（`:332` onOpenChange），页面语义不清、层级混乱。
- 上游参照：AGENTS.md 三页面语义铁律——`/workspaces`（列表/入口）与 `/workspace`（单工作区详情）是两个独立路由、独立组件（`workspaces-page.tsx` vs `workspace-shell.tsx`）。
- 修复：给 `workspaces/:id` 独立详情视图（会话列表为主内容），去掉「关 Inspector 跳回列表」的隐式导航。

### 11. window.prompt / window.confirm 与 Dialog 两种弹窗模式混用
- 位置：`features/sessions/navigation.tsx:89`（重命名用 `window.prompt`、归档用 `window.confirm`）；另 `cluster-page.tsx`、`team-page.tsx`、`board.tsx` 共 10+ 处 `window.confirm`
- 问题：重命名这种高频轻操作用原生 prompt（不可样式化、移动端体验差、无校验），与 CreateDialog/CreationDialog 的正式 Dialog 模式割裂；危险操作的确认框风格也不统一。
- 上游参照：`workspace-session-rename-dialog.tsx` 重命名是标准 Dialog；危险操作统一走 `app-dialog-provider.tsx` 确认弹窗。
- 修复：重命名换 inline 编辑或小 Dialog；确认类操作收敛为一个 ConfirmDialog 组件统一文案与 danger 样式。

### 12. 加载态全部是纯文本 `<p role="status">`，Skeleton 组件只有演示页在用
- 位置：`apps/web/src/App.tsx:256`（「正在加载资源…」整屏文字）、`features/tasks/board.tsx:89`、`features/tasks/project-pages.tsx`（「正在读取项目概览…」）、会话区「正在加载会话历史…」；`ui/skeleton.tsx` 仅 `component-library.tsx:183` 使用
- 问题：列表/看板/概览的加载都是布局跳变的单行文字（内容到达后高度突变），与 AI Elements 会话页的 loader 动画并存，加载语言不统一。
- 上游参照：`-workspace-route-shared.tsx:351` `WorkspaceLoadingState` 统一加载组件，列表用 skeleton 保形。
- 修复：会话列表、看板列、概览卡片改用 Skeleton 占位，全局导出一个 LoadingState 约定。

---

## P2 体验提升

### 13. 「组件」内部演示页占据一级导航
- 位置：`apps/web/src/App.tsx:299`（globalRail「组件」→ `/components`，`component-library.tsx` 为 21st.dev 导入演示）
- 问题：开发向演示页与「项目/团队/集群/设置」并列一级导航，对最终用户是永久噪音，也让 globalRail 六项中一项永远低频。
- 上游参照：上游导航（`app-sidebar.tsx`）不含任何内部演示入口。
- 修复：从 globalRail 移除，保留 URL 直达即可（或仅 dev 构建显示）。

### 14. 聚焦搜索框会触发布局变化 / 打开导航抽屉
- 位置：`apps/web/src/App.tsx:310`（`onFocus` → `setConversationFocus(false)` 或 `setNavigation(true)`）
- 问题：焦点进入输入框却引发会话页收起侧栏、窄屏弹出整页导航 Sheet，反直觉且打断输入（移动端键盘刚弹起又被抽屉覆盖）。
- 上游参照：搜索是独立命令面板（`global-search-palette.tsx`），聚焦不改变布局。
- 修复：去掉 onFocus 副作用；若为腾空间可改到blur/提交后再收起。

### 15. 快捷键覆盖不足，且无统一注册处
- 位置：全局唯一快捷键在 `apps/web/src/App.tsx:235`（Cmd/Ctrl+K，见 P0-1）；Composer 斜杠命令在 `features/sessions/conversation.tsx` 自成体系
- 问题：高频操作（新建会话、切项目、关面板、刷新）均无快捷键；Esc 关 Inspector 在 `app/shell.tsx:47` 有，但 Sheet/Dialog 各自为政，行为不一致。
- 上游参照：上游有全局搜索 palette、`-workspace-route-shortcuts.tsx` 集中快捷键处理（如终端开合）。
- 修复：建一个 `lib/shortcuts.ts` 统一注册（新会话、搜索、Esc 层级），在 UI 上以 kbd hint 暴露。

---

## 结论优先级建议

先做 P0-3（删死代码，纯减法）、P0-4（三处 href 换 go()，低风险）、P0-5（删一套导航）；P0-2 面板保活收益最大但需验证内存；P1-6/7/8 是用户可直接感知的「界面冗余」主诉来源。
