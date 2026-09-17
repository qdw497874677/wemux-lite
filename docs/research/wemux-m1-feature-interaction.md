# M1：Wemux 功能与交互对照调研

状态：源码调研完成，设计建议待确认；不代表浏览器体验验收或功能交付。

## 1. 范围与证据边界

- 参考项目：本地 `../wemux-slim`，HEAD `9aba1e6`；本次检查工作区无变更。本文“Wemux”指该项目，不指同名终端工具。
- 当前项目：Wemux Lite，HEAD `13d710a` 加当前未提交工作树。现有产品方向文档与 Web 变更均保留，不能仅凭 HEAD 重建全部调研输入。
- 方法：直接读取 Web 组件、控制器、HTTP 路由、服务及 Worker 命令实现，优先于旧 README 和历史完成声明。
- 未启动两套系统做浏览器比较，未运行真实 Agent 或测试；布局判断来自 JSX/状态逻辑，不评价未经观察的实际手感、性能与可靠性。
- 任务边界：先补功能与交互，不进行全面稳定性审计，不修改业务代码。
- 后续实施依据：[功能与交互设计计划](../design/feature-interaction-plan.md)、[产品路线图](../roadmap.md)。

## 2. 核心结论

1. **不是从零补聊天**。Lite 已有项目路由、工作区会话树、快速首条消息、乐观回显、Journal 时间线和任务审查。应补齐并统一这些能力，而非新建第二套执行系统。[L1–L5、L9]
2. **优先补执行位置选择**。逻辑 Workspace 已有 `placements`，但快速选择、资源树和详情仍大量读取 `workspace.workerId/status/location` 兼容字段。多节点数据模型与用户操作尚未对齐，应在 M2 先补选择契约，M3 再完善副本生命周期。[L2、L3、L6]
3. **管理按钮缺失不一定意味着后端没实现**。Project/Workspace/Session 的名称更新已有通用 PATCH；Web 项目设置却显示“项目编辑尚未提供 API”。重命名应优先接入现有能力，归档、置顶则不能冒充已有能力。[L1、L5、L7]
4. **执行控制确有产品链路缺口**。普通 Composer 只有发送，显示队列数量但无逐条队列管理；Worker 支持 `turn.stop` 和 `session.cancel-queued`，Task Run 能调用，普通 Session 缺少相应公开操作闭环。集群里的取消未交付命令不是取消已入队消息。[L4、L5、L8]
5. **参考交互，不复制产品复杂度**。Wemux 的持续工作台、共用输入框、可操作队列与会话管理值得借鉴；其 Task 聊天桥、浏览器草稿队列、原地配置变化和桌面面板不能直接成为 Lite 的领域规则。[W1–W5]

## 3. 按用户工作链路比较

| 场景 | Wemux 源码表现 | Lite 当前事实 | 建议与优先级 |
| --- | --- | --- | --- |
| 进入工作现场 | WorkspaceShell 组织会话和主/侧面板，工作区详情有有界缓存与可见性控制 [W1、W6] | AppShell、InspectorHost、项目导航与专注对话已有实现，但顶栏、全局 rail、项目树多处导航重叠 [L1] | M2 收敛导航职责，保留切换状态；不复制全部面板缓存体系 |
| 开始新对话 | 创建用例先回调会话就绪，再发送首条消息 [W2] | QuickConversation 和已有 Composer 分离；QuickStartController 已有稳定请求身份、核对与恢复 [L2、L4] | 统一输入外观与键盘行为，保留独立的创建/发送编排；会话身份确定后在该会话恢复首条消息 |
| 选择执行目标 | 创建面板和工作现场就近承载环境与 Agent 配置 [W1、W2] | QuickConfig 有 workerId，但 UI 只有工作区/Agent/模型三个选择，节点来自工作区兼容字段 [L2] | M2 明确 Workspace → Placement/Worker → Agent → Model，不能把 Worker 一直作为只读单绑定 |
| 找会话 | 列表支持状态、未读、置顶、重命名、删除及本地会话入口 [W3] | 已能按工作区分组、按标题/Agent/模型搜索、显示运行状态 [L3] | 首批补最近访问、筛选、重命名；置顶/归档分后续切片，本地会话导入暂缓 |
| 连续输入 | 共用 ChatComposer 自动增高、IME 处理、beforeInput/footer 插槽 [W4] | 已有 Enter/Shift+Enter、IME 保护、提交期间仍可编辑；快速输入有同类键盘处理 [L2、L4] | 复用行为，不重复“实现已有快捷键”；统一草稿作用域与提交反馈 |
| 排队与停止 | 显示队列预览、编辑/移除；消息控制器调用停止及移除 API [W5] | 会话显示 queuedMessageCount；普通 Composer 没有停止/逐条取消；Worker 协议已支持 [L4、L8] | 首批只做权威队列查看、逐条取消与停止当前 Turn；队列编辑晚于取消竞态契约 |
| 工具与用量 | 聊天和工作区分工，详情可按视图展开 [W1、W5] | TimelineEntry 已渲染工具参数/输出和 usage；输出默认展开，部分 usage 标签为空 [L4] | 改为紧凑摘要、展开详情，补用量字段标签；不把缺失数值当 0 |
| 环境管理 | 文件/Git/预览/终端等独立面板，移动端有 list/detail/create 模式 [W1、W6] | 工作区列表/详情和重新下发入口已有，但多处仍只显示一个节点 [L1、L6、L10] | M3 优先节点副本状态与定向恢复；文件/Git 只读视图另做能力规格，非本轮必需 |
| 集群能力 | 节点清单、详情、版本过旧提示、状态刷新、安装命令 [W7] | Worker 卡片、注册指引、撤销，命令/工作区/会话阶段表；能力在运行时页及 ContextPanel [L1、L3、L10] | M4 合并成集群内节点/能力/诊断导航，日常使用不要求理解命令表 |
| 任务协作 | 任务详情包含环境、Agent 活动、子任务、评论与分派预览 [W8] | 看板、Assignment、Run、新建/复用、批准/请求修改；Run 共用 Composer/TimelineEntry [L9] | M5 补证据和交付体验，复用已有审查；多人评论待 M6 授权闭环 |

## 4. API 与数据接线盘点

这是本次读取范围内的结论，不把“未发现 UI”扩大为“整个后端不存在”。

| 能力 | 已找到 | 还要做 |
| --- | --- | --- |
| 重命名 | `PATCH /projects/:id`、`/workspaces/:id`、`/sessions/:id` 调用 `ServerService.update` [L7] | Web client 方法、入口、缓存更新与失败保留；替换错误提示 |
| 添加 Placement | Web client 声明 `POST /api/workspaces/:id/placements`，当前 handler 未见匹配该路径；服务 reprovision 可处理目标上不存在的副本 [L5–L7] | 明确采用独立添加路由还是明确复用物化操作，保持已有调用兼容；端到端验证，不能称客户端方法即可用 |
| 定向重试 | handler 与 service 接受 `workerId`、`requestId`；Web client 仅传 workerId，集群页通常不指定节点 [L5–L7、L10] | 逐副本入口、稳定重试身份、明确冲突反馈 |
| 停止/取消队列 | Wire/Worker 有命令，Run projection 已使用；普通 Session 路由与 client 未接完 [L5、L8] | 公开会话控制 API、权威队列/activeTurn 投影、所属关系与幂等校验 |
| 原生运行时操作 | `/sessions/:id/runtime/commands` 支持 compact/set_model/set_thinking_level，另有 approval 路由 [L7] | 不能一律称为“缺 API”；先解决可用能力、授权及 set_model 与固定 Session 绑定之间的语义冲突，未经裁定不放进普通模型切换下拉框 |
| 附件 | Lite 当前 enqueue 从 `content` 创建文本消息 [L7] | 上传、引用、权限、保留、适配器支持与错误完整设计后再开放，不只增加上传图标 |
| 归档/置顶/未读 | 当前读取的 Session 更新入口仅修改 title；未见完整持久产品契约 [L7] | 归档不得复用删除；置顶/已读需明确用户作用域，后续分切片落地 |

## 5. 借鉴决策

### 直接借鉴交互原则

- 持续工作现场：切会话不丢草稿，回到工作时不反复配置环境。
- 新建与继续共享输入组件，但区分远程资源创建与消息提交状态。
- 队列放在输入区附近，状态/工具详情按需展开。
- 会话名称、当前执行状态、执行位置就近可见；技术 ID 移入诊断。
- 手机上以列表/会话/详情切换，而非挤压桌面三栏。

### 改造后借鉴

- 会话置顶、未读、归档：先确定用户作用域与持久性，不直接采用一套全局前端状态。
- 侧面工具面板：先运行详情，后续按实际 API 增加文件/变更；不显示假数据或无效入口。
- 队列编辑：Wemux 存在移除旧项、内容放回输入的交互，Lite 首批不复制；取消必须确认后才能作为新提交，防止旧消息已开始又重复执行。
- 节点选择：翻译其 Executor 交互，但 Lite 正式术语仍为 Worker，Agent 不是注册节点。

### 本轮不引入

远程桌面、任意终端、云托管、自动导入本地原生 Session、会话 Fork/修改历史、跨节点自动文件同步、自动调度、复杂多面板布局选项。并非永久排除；先有明确用户场景、权限与能力契约再排期。不复制其依赖栈或大组件实现。

## 6. 旧调研需要修正的认识

`wemux-conversation-entry-ux.md` 保留参考价值，但以下是旧快照而非当前结论：

- 当前 QuickConversation 已有键盘提交处理，不能再列为完全缺失。
- 当前创建 Session 已要求 requestId，并检查既有请求，不再按“尚无幂等创建”规划。
- 当前 quickEntry 主要在 sessions 页，不能照旧声称概览重复渲染同一表单。
- “Worker 只读随 Workspace 确定”只适合旧单副本模型；当前设计必须支持选择 Placement。

以上差异以 [L1、L2、L7] 为依据。不要照旧文档再实现一遍已存在的功能。

## 7. 源码索引

路径相对各自仓库根；函数/组件名是检索锚点。引用证明实现结构，不证明功能已通过实际验收。

| 编号 | 仓库与来源 | 核对点 |
| --- | --- | --- |
| L1 | Lite `apps/web/src/App.tsx`：Workbench；`apps/web/src/app/shell.tsx`：InspectorHost | 路由页面、导航、详情、项目设置、会话状态 |
| L2 | Lite `apps/web/src/components/quick-conversation.tsx`；`apps/web/src/features/sessions/quick-start.ts`：initialQuickConfig/quickConfigReason/fillQuickChoices/QuickStartController | 创建配置、单节点读取、首条消息与恢复 |
| L3 | Lite `apps/web/src/features/sessions/navigation.tsx`：Sidebar/ContextPanel | 搜索、分组、单节点资源树与详情 |
| L4 | Lite `apps/web/src/features/sessions/conversation.tsx`：TimelineEntry/Composer/MessageStatus | 工具、usage、输入及消息状态 |
| L5 | Lite `apps/web/src/api/client.ts`：createApi | 已暴露的 Web 操作，新增副本路径、重试和删除 |
| L6 | Lite `apps/web/src/api/dto.ts`：WorkspaceDTO；`apps/server/src/storage/sqlite/store.ts`：Workspace 兼容转换 | placements 与兼容字段 |
| L7 | Lite `apps/server/src/http/handler.ts`；`apps/server/src/application/server-service.ts`：update/createSessionInTx/reprovisionWorkspaceInTx/invokeRuntimeCommand/enqueueInTx | PATCH、创建幂等、物化、运行时和文本消息 |
| L8 | Lite `packages/wire-protocol/src/commands.ts`；`apps/worker/src/application/runtime.ts`；`apps/server/src/application/run-projection.ts` | turn.stop/session.cancel-queued 和 Run 取消 |
| L9 | Lite `apps/web/src/features/tasks/board.tsx`、`runs.tsx`、`review.tsx` | 现有任务与审查、共享对话组件 |
| L10 | Lite `apps/web/src/components/cluster-page.tsx`；`worker-enrollment-dialog.tsx` | 节点与阶段管理、注册入口 |
| W1 | Slim `apps/web/src/components/workspaces/workspace-shell.tsx`：WorkspaceShell | 会话列表、面板、移动布局及管理回调 |
| W2 | Slim `apps/web/src/lib/workspace-creation-use-case.ts`：onWorkspaceSessionReady；`apps/web/src/components/workspaces/workspaces-create-panel.tsx`、`workspace-create-composer.tsx` | 创建与首条消息分离、输入复用 |
| W3 | Slim `apps/web/src/components/workspaces/workspace-session-list.tsx`；`use-workspaces-session-actions.ts` | 状态/未读/置顶/名称、实际 mutation 适配 |
| W4 | Slim `apps/web/src/components/chat/chat-composer.tsx`：ChatComposer | 共用输入、自适应高度、IME、插槽 |
| W5 | Slim `apps/web/src/components/workspaces/workspace-session-chat/workspace-session-chat.tsx`、`workspace-session-chat-ui.tsx`：QueuedMessages/AgentChatQueue、`workspace-session-chat-message-actions.ts`：handleStop/handleRemoveQueuedMessage | 队列显示、编辑草稿、停止与移除接线 |
| W6 | Slim `apps/web/src/components/workspaces/workspaces-page-view.tsx`：WorkspaceDetailPaneCache | 缓存上限 8、可见性控制、移动模式 |
| W7 | Slim `apps/web/src/components/execution/execution-executors-tab.tsx` | 版本提示、详情、刷新与安装引导 |
| W8 | Slim `apps/web/src/components/kanban/task-detail-panel-sections.tsx` | 环境、子任务、评论与 Agent 分派预览 |
