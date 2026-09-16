# Wemux 对话入口对比与 Lite 调整建议

状态：源码调研与待确认方案，未实施界面或后端变更。
范围：本地 `../wemux-slim` 与当前 Lite 工作台。未启动参考项目做浏览器体验验证；布局和行为结论来自组件及控制器源码。

## 结论

保留自由对话、不强制 Task；用稳定的会话工作台承载“新对话草稿”和已有 Session。不要继续把快速创建表单堆在项目概览、会话列表上方，也不要退回强制逐级创建的向导。

参照的是 wemux 的上下文连续性、输入组件复用和新建/继续的明确区分，不是复制其桌面工作区、多面板、云执行或 Git worktree 能力。

## 当前审计

- 沿用现有 Tailwind token、深浅主题、Inter/system/中文系统字体和 `.625rem` 基础圆角；无需换肤或新增组件库。视觉基线见 `apps/web/src/styles.css`。
- `apps/web/src/App.tsx` 在 `overview` 和 `sessions` 同时渲染 `quickEntry`，后面紧接项目统计和资源/会话列表。主区域同时承担创建、浏览和管理，主动作不明确。
- `apps/web/src/components/quick-conversation.tsx` 是独立表单，使用顶部大文本框、配置折叠及“发送并开始对话”按钮。配置把 Workspace、Worker、Agent、Model 串成一个触发器，展开后才出现选择器。
- 已有会话使用 `apps/web/src/features/sessions/conversation.tsx` 中底部固定的 `Composer`。两个输入区的布局、快捷键和状态表现不同。已有 Composer 实现 Enter/Shift+Enter 与 IME 防误发，QuickConversation 没有对应 onKeyDown。
- `apps/web/src/features/sessions/quick-start.ts` 把草稿、启动尝试、completed 放在同一份项目级状态中。成功后返回项目页会显示锁定状态与“再开新对话”，混淆项目首页和上一轮启动结果。
- 快速启动在首条消息请求返回后才返回 Session ID 并导航；Session 已建但发送失败时，用户仍可能停留在创建表单。
- 存储草稿、防止不确定请求重复创建、稳定 commandId/messageId、配置失效不静默换 Worker/模型，是必须保留的正确性能力。

## wemux 源码依据

以下路径相对于 `../wemux-slim/`：

| 来源 | 已核实行为 | Lite 可借鉴点 |
| --- | --- | --- |
| `apps/web/src/components/workspaces/workspaces-create-panel.tsx` | 独立创建面板，以输入为中心，Agent/模型和项目/执行节点/目录等作为输入区 footerControls | 新建应是明确模式，执行上下文就近可见，而非资源列表中的附属表单 |
| `apps/web/src/components/workspaces/workspace-create-composer.tsx` | `WorkspaceCreateComposer` 复用 `TaskChatComposer` | 首条消息与后续消息共享基础输入组件、键盘和按钮语义 |
| `apps/web/src/components/workspaces/workspace-shell.tsx` | 工作区内会话导航支持侧边/顶部放置，同一区域提供新会话按钮 | 创建和切换 Session 不离开执行上下文；Lite 只需一种桌面布局与移动端抽屉 |
| `apps/web/src/routes/workspace.tsx`，`handleCreateWorkspaceSession` | 在当前工作区创建新 Session，继承部分上下文，再定位到新会话 | 已选 Workspace 内新建时无需重复选择执行位置 |
| `apps/web/src/lib/workspace-creation-use-case.ts` | 编排创建 Workspace/Session，先执行 onWorkspaceSessionReady，再发送首条消息 | Session 身份确定后进入聊天界面，首条消息失败也留在该会话恢复 |
| `apps/web/src/components/workspaces/use-workspaces-create-controller.ts`，`onWorkspaceSessionReady` | 更新缓存、选中 Workspace/Session、打开工作区、退出 create 模式；首条消息使用 dedupeKey | 创建成功与消息送达是两个状态，不让创建表单长期承担发送恢复 |

参考项目还支持 `deferUntilWorkspaceReady: true`、多种目录模式、图片和 Task 聊天桥。Lite 的 Workspace 必须 ready 才能创建 Session/发送，不能仅通过 UI 仿造上述能力。参考项目的静态说明文档部分仍围绕旧 Task 流程，以上判断优先依据实际组件与调用链。

## 建议交互

### 1. 项目入口

进入项目只做导航，不创建任何远程资源。

- 有最近访问且仍可读的 Session：恢复该项目上次打开的会话。
- 没有历史或历史不可访问：进入新对话草稿状态。
- 左侧提供“新对话”与该项目会话，按 Workspace 分组；项目会话总览保留为显式浏览入口，不与聊天输入叠放。
- 项目概览只展示概览，不再包含 quickEntry；看板、工作区管理保持次级入口，不是聊天前置步骤。
- 最近会话仅作为客户端偏好，按连接/用户范围及 projectId 隔离。读取历史不要求 Worker 在线；离线应允许看历史、写草稿，发送则明确阻止。
- 保留现有 Session 深链接；导航标签或新增 draft 路由需实施前确认，不在调研中修改。

### 2. 新对话与已有会话使用同一布局

```text
项目 / 会话                    项目名 / 新对话
[新对话]                       工作区 A   Worker NAS（只读）
工作区 A
  检查测试                     空白提示 / 对话时间线
  优化接口
工作区 B                       [输入消息……                  ]
  部署问题                     [Agent ▼] [模型 ▼]       [发送]
```

新对话是本地草稿，不是预先创建的空 Session。首次发送才创建 Session。Session ID 一旦确定即进入正式会话，首条消息立即显示乐观条目，沿用相同 messageId 与 Journal 去重；后续接受、排队、失败都在这条消息附近反馈。

通过当前 Workspace 的“新对话”入口时预填该 Workspace；项目级入口使用仍有效的上次选择或唯一候选。多个候选且没有有效偏好时，明确要求选择，不擅自使用列表第一项。

### 3. 执行环境呈现

- Workspace 是执行位置；Worker 是它的只读绑定信息，不提供与 Workspace 冲突的独立选择。
- 新对话允许选择 Workspace、Agent、模型。模型多时支持搜索，可用现有 UI 基础设施实现。
- 已有 Session 清楚展示绑定；本轮不新增原地更换 Worker/Agent/模型的产品语义。需要更换时明确新建会话，不在运行期间默默重绑。
- 无 Workspace 时显示“准备工作区”空态；创建/准备期间保留草稿，显示真实 pending/provisioning/failed/ready，ready 前不下发聊天。
- 新 Session 只隔离对话上下文，不隔离文件；同 Workspace 的会话共享文件，需要文件隔离须另建 Workspace。

### 4. 错误与恢复

- 一般用户只需看到“消息尚未确认，正在核对”或“发送失败，重试”；commandId、messageId 等移到可展开诊断。
- 首条消息失败，在已创建会话中恢复，不带用户回项目页，也不创建第二个 Session。
- 结果不确定的创建仍保持现有锁定保护，不能用“重试”偷偷再次 POST 创建。
- 当前创建接口没有可用于自动核对的幂等身份。要取消手输 Session ID 恢复入口，需新增 Server 持久化创建 requestId、重复请求返回同一 Session 的契约及测试，而不只是隐藏 UI。
- 不新增常驻多阶段进度条；以消息局部状态、必要错误和轻量等待反馈为主。

### 5. 手机端

仅保留一块聊天画布；项目/会话切换放抽屉，执行环境在标题或设置面板中查看。输入区固定在可视区域底部并适配软键盘、安全区。新建和已有会话采用相同交互，触屏 Enter 默认换行，发送用按钮。

## 实施顺序（待确认）

### 第一阶段：连续工作台，尽量不改 API

1. 拆开项目总览、会话目录、新对话草稿、已有会话四种视图职责；去除概览重复表单。
2. 提取共用输入组件，复用键盘/IME、草稿、发送按钮、错误反馈；启动控制器与 Session 提交控制器仍保留各自生命周期。
3. 实现项目最近会话导航、Workspace 上下文继承和移动端抽屉。
4. Session 创建成功后接入已有会话视图，保留首条消息持久意图和回执核对，不在组件卸载时丢失发送。
5. 保留不确定创建保护作为临时高级恢复；不把未增强的流程包装为完全自动恢复。

### 第二阶段：简化恢复所需的最小后端契约

给 Session 创建增加持久化 requestId 幂等性，限定调用者/资源范围，同 ID 不同 payload 返回冲突，同 ID 重试返回原 Session。事务内同时保存映射、Session 和下发命令；验证响应丢失、Server 重启及并发重试。继续复用 SQLite 和现有命令队列，不引入中间件。

## 验收重点

- 点击项目、点击新对话不产生空 Session；明确发送才创建。
- 从 Workspace 内新建正确继承执行位置，配置失效不静默切换。
- 成功、失败、未确认均在同一聊天布局完成，草稿和首条消息不因导航/刷新丢失。
- 请求重试不重复消息；第二阶段进一步保证不重复 Session。
- 新/旧输入区快捷键一致，中文输入法 Enter 不误发，移动端软键盘不遮挡发送。
- 无 Worker、离线、无 Agent、模型消失、准备失败均有明确可行动反馈；离线历史仍可查看。
- 多项目、快速切换、连接变化不串草稿、不错误导航、不污染其他会话。
- 源码契约/控制器测试及真实浏览器验证分开记录；调研本身不等于这些验收已通过。
