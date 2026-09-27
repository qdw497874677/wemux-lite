# wemux-mini 前端重构计划：保留 wemux 灵魂，大力借鉴 t3code

> 制定日期：2026-09-26。依据：`docs/research/t3code-research.md`（134 行调研）、`docs/research/ui-audit-vs-upstream.md`（15 项审计）、`docs/research/upstream-comparison.md`（上游对照）。
> 决策（用户确认）：保留 wemux 灵魂 = 团队协作 + 多 Worker 网络 + Project→Workspace→Session 域模型 + 画布 + BYOK；其余大力借鉴 t3code。

## 总原则

1. **不 fork、不整体替换**（t3code 前端 21.8 万行、Effect/vite-plus/T3 私有契约锁死，替换成本超重写），采用**逐模块移植 + 适配我们数据层**。
2. **MIT license 允许直接抄代码**，每个拷入文件头部注明 `Derived from pingdotgg/t3code (MIT)`。
3. **保留清单不动**：画布（session-canvas + AI Elements workflow 组件）、server/worker 架构、AgentEvent 主干、任务看板。
4. **每 Phase 独立验收**：typecheck + web 测试 + 浏览器截图，绿了才进下一 Phase。

## Phase 0：样式基座（t3code token + 原语，1-2 天）

**目标**：全站视觉升级为 t3code 的设计系统，后续组件有统一样式底座。

- 移植 `apps/web/src/index.css`（2,237 行）的语义变量体系到 `apps/web/src/styles.css`：`--control-radius` 紧凑几何、`--glass-*` 玻璃拟态、`--appearance-contrast-*` 对比度增强、`--diff-addition/deletion`、warning/error/success/info/update 三层状态色、`.dark` 变体（保持深色优先）
- 从 `apps/web/src/components/ui/` 拷原语：button/badge/kbd/middle-truncate/scroll-area/separator/sheet（Base UI + cva，加 `@base-ui/react` 依赖；与 AI Elements 重叠的原语二选一，AI Elements 保留其 AI 专属组件）
- 布局壳换 `AppSidebarLayout.tsx` 模式（顺带解决 UI 审计 P0-5 三套导航 → 一套）
- **同批清理**（迁移前减面）：UI 审计 P0-3（删 CreateDialog 死代码）、P0-4（画布 window.location.href → go()）

**验收**：全站截图对比新 token 生效；195+ web 测试通过；单一导航。

## Phase 1：窗口管理系统（2-3 天）★ 用户点名

**目标**：会话页右侧多面板容器 + 面板保活，后续文件/终端/agent 面板都挂这里。

- 参照 `RightPanelTabs.tsx` + `RightPanelSheet.tsx`：右侧面板 Tab 系统（lucide 图标 + 下拉切换 + 音量/静音等面板级控制）
- 参照 `desktopTabLifetime.ts`：**租约式面板保活**（引用计数 + 延迟关闭 timer + 操作串行化队列）——同时解决 UI 审计 P0-2（会话切换全量重挂载，直接升级为通用面板保活）
- 面板注册表：PanelDescriptor { id, icon, title, render, keepAlive }，画布作为其中一个可挂面板（保留能力）
- 快捷键：`lib/shortcuts.ts` 统一注册（顺带解决审计 P0-1/P2-15 的 Cmd+K 命令面板 + Esc 层级）

**验收**：会话页右侧可开 2+ 面板切换；切换会话再切回，滚动/草稿不丢（浏览器实测）。

## Phase 2：Session 管理升级（1 周）

**目标**：会话体验对齐 t3code chat 质量。

- 滚动锚定：参照 `chat/timelineScrollAnchoring.ts`（用户上翻时新消息不打断阅读，底部时自动跟随）
- 工具展示归一化：参照 `work-log/toolPresentation.ts` 的 `{ tone: thinking|tool|info|error, action: read|edit|command|browser, toolTitle, changedFiles }`，改造 conversation.tsx 工具卡（替换现有裸 Tool 折叠）
- ContextWindowMeter：上下文用量条（token 上限/已用/压缩阈值可视化，/compact 入口顺势挂这里）
- 会话列表管理：参照 thread 管理面板（重命名 inline 编辑、归档确认统一 ConfirmDialog——顺带解决审计 P1-11 window.prompt 混用）
- 加载态：Skeleton 保形（审计 P1-12）

**验收**：长会话滚动体验、工具组折叠、上下文条、会话 CRUD 全浏览器实测。

## Phase 3：文件管理器（3-4 天）★ 用户点名

- 移植 `components/files/`（文件树 + 预览，含 DelimitedTablePreview）
- worker 侧新增文件 API：list/read（经现有 WS 通道，路径按 workspace scope 校验——配合上游 P0-3 workspace-paths 三层结构一起做，安全边界就位再开文件访问）
- 挂入 Phase 1 面板系统；编辑用现有 editor 习惯（首版只读 + 下载，编辑后续）

**验收**：会话页开文件面板浏览 workspace 目录树、预览文本/表格文件。

## Phase 4：终端管理（1 周）★ 用户点名

- **xterm.js 方案**（t3code 的 ghostty 是 native wasm，太重不适合 mini；node-pty 在 worker 侧 spawn）
- worker 侧 PTY 会话：spawn（默认 shell）+ resize + 输出流（经 WS），初始 cwd 锁定为会话 workspace root；`node-pty` 作为可选生产依赖，原生模块不可用时上报终端不可用但不阻塞 Worker 注册
- 已知安全边界：当前不提供 chroot 或容器级文件系统隔离，终端启动后用户可通过 `cd` 离开 workspace root；公网或多租户部署必须在 Worker 主机层提供独立账号、容器或等价隔离
- 前端：`ThreadTerminalDrawer`（终端抽屉）+ **TerminalContextInlineChip**（终端上下文作为 chip 附到 composer——t3code 的终端×对话融合，agent 可看到终端状态）
- 挂入面板系统；租约保活防终端状态丢失

**验收**：开终端面板跑命令、拖拽 resize、终端 chip 附到消息发送。

## Phase 5：智能体面板（2-3 天）★ 用户点名

- 移植 `AgentsPanel.tsx` 模式：agent 实例列表（运行状态/模型/用量），点击进入会话
- 新对话的智能体选择 chips 升级为此面板的轻量版（当前 chips 保留，面板做全量管理）
- 参照六 provider 归一化展示（Pi/OpenCode/Claude/Codex + 未安装态）

**验收**：AgentsPanel 列出 worker 上全部 agent，状态徽章正确，点击可开新会话。

## Phase 6：协议升级（server/worker 侧，与前端并行）

- `AgentEvent` 加 `streamKind`（assistant_text/reasoning_text/plan_text/command_output/file_change_output）——t3code 最值得抄的协议语义，Reasoning/工具展示的前置
- 审批升级为 `request.opened/resolved` 事件对（决策结果进事件流可回放，配合上游 P0-4 审批链）
- compaction 双模式抽象（native / slash-command）
- AbortReason 七值枚举（上游 P0-2，t3code 的 turn.aborted 语义同源）
- 前置依赖：task9b 路由拆分（验证收尾中）

**验收**：协议测试 + 会话页 Reasoning 展示真实 reasoning_text 流。

## 执行顺序与依赖

```
Phase 0 (样式+减面) → Phase 1 (窗口管理) → Phase 2 (session) ┐
                                    ├─→ Phase 3 (文件) ─┐
                                    ├─→ Phase 4 (终端) ─┼─ 可并行
                                    └─→ Phase 5 (agent)─┘
Phase 6 (协议) 独立线，随 task9b 收尾后启动
```

## 风险与对策

| 风险 | 对策 |
|---|---|
| Base UI 与现有 Radix/AI Elements 冲突 | Phase 0 先做依赖共存验证，冲突则 t3code 组件改写为 Radix 底座（cva 层不变） |
| t3code 组件深度依赖 `@t3tools/*` 私有包 | 每个拷入组件先剥离 import，适配我们的 api/client 层；不引 client-runtime |
| 终端 PTY 在 Windows worker 不可用 | 首版 Linux/macOS，Windows 报「不可用」不阻塞（同 agent 未安装语义） |
| 与并行会话的未提交改动冲突 | 每 Phase 开工前 git status 检查，只碰本 Phase 文件 |

## 已就绪待执行

- task9b（路由拆分 141 路由）：验证收尾中，绿后提交
- task10（审计 P0-3/4/5 清理）：并入 Phase 0 执行
- 本计划评审通过后，Phase 0 提示词即可派 pi
