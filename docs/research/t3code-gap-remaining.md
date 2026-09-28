# t3code 剩余差距盘点（样式 + 功能）

> 盘点日期：2026-09-27。基线：wemux-mini `dd2a2d5`（task14b 之后）对照 t3code-upstream main 快照。
> 前提：30 个 commit 已对齐设计 token、半透明边框、surface-grain、侧栏三态、右面板五 tab、文件/终端/智能体面板、圆形上下文指示器、滚动锚定、工具展示归一化、消息气泡、ConfirmDialog、快捷键 registry。在途：task15 斜杠命令 agent 适配、task16 会话中换模型。
> 已知不适用（不列为差距）：Electron/Expo 多端、vite-plus 构建链、TipTap 富文本（决定缓）、Clerk/relay 私有依赖、21.8 万行体量差异。团队/项目/节点管理/画布是我们的差异功能，故意保留。
> 附带发现：t3code 同样没有语音输入（全文 grep 无 dictation/speech 实现），该维度不适用。

## 一、t3code apps/web/src 组件清单（按功能分组）

`components/` 顶层（约 110 文件）+ 子目录：

| 分组 | 代表文件（行数） | mini 对应 |
|---|---|---|
| 时间线渲染 | `chat/MessagesTimeline.tsx`（5007，行回收虚拟化 + minimap）、`ChatMarkdown.tsx`（shiki-wasm 语法高亮 + LRU 缓存 + 流式增量高亮） | conversation.tsx（199 行）全量 map 渲染，无高亮 |
| 消息操作 | `chat/MessageCopyButton.tsx`、`AssistantSelectionToolbar.tsx`（划词引用）、`AssistantCitation*`（引用评论链）、编辑/重发（MessagesTimeline case "edit"） | 仅复制 |
| Composer | `chat/ChatComposer.tsx`（7056）、`ComposerCommandMenu`、`composerPromptHistory`、`composerAttachmentFiles`（图片/HEIC 压缩）、`composerMentionDrag`、`folderDrop`、`ComposerBannerStack` | ai-prompt-input（112）+ conversation.tsx，3 个硬编码斜杠命令 |
| 模型/上下文 | `ProviderModelPicker`、`ModelPickerContent`（1056）、`ContextWindowMeter`、`ComposerUsageLimits` | ContextWindowMeter 已对齐；模型 chip 只读（task16 在途） |
| 审批/输入 | `ComposerPendingApprovalPanel`、`ComposerPendingUserInputPanel`、`permissions/PermissionChecklist` | cluster-controls.tsx 裸 JSON + 双按钮 |
| 计划/变更 | `ProposedPlanCard`（260）、`ChangedFilesTree`（273）、`WorktreeSetupCard` | changedFiles 文件名列表（无 diff） |
| 会话管理 | `Sidebar.tsx`（4969：pin/snooze/settle/undo/mark-unread/regenerate-title）、`threadActionMenu.logic.ts` | 重命名/归档（已对齐基础项） |
| 全局导航 | `CommandPalette.tsx`（3043，含 ThreadSearchMatch 会话全文搜索） | 无 |
| Git | `BranchToolbar*`（分支/环境切换）、`GitActionsControl`（commit/push/PR）、`pullRequest/`、`diffs/`（StyledDiffCodeView 325 + DiffFileTree + 行内评论） | 无 |
| 右面板内容 | `DiffPanel`（1205）、`files/FilePreviewPanel`（1313，编辑+虚拟化）、`preview/`（浏览器预览 + mini player） | 文件只读预览（无编辑/无 diff） |
| 设置 | `settings/`（120+ 文件：ThemeSettings/主题编辑器、KeybindingsSettings 1325 行可自定义、ProviderSettings、UsageLimits） | account-page（密码/邮箱/PAT/设备/审计），无外观设置 |
| 系统反馈 | `ThreadNotificationCoordinator`（浏览器通知/未读）、`Sidebar.snooze`、`usage/UsagePage`（1151） | 无 |
| 排队 | `QueuedMessageSender` + queuedMessageStore + 时间线内排队卡片 | 仅 `queuedMessageCount` 数字 |

`chat/` 子目录实际 143 文件（任务描述的 89 为不含测试的口径），其中约 40 个 `.logic`/纯逻辑文件已被 mini 的 work-log/journal 归一化吸收。

## 二、差距清单（20 项，按优先级）

### P0 用户可感（6 项）

**1. 代码块语法高亮**（样式 + 功能）
- 现状：`markdown-message.ts` 用 react-markdown 渲染 `<pre>`，无任何高亮；`response.tsx` 直接管文本。代码会话中代码块占比极高，这是当前最可感的样式差距。
- t3code 参照：`apps/web/src/components/ChatMarkdown.tsx`（`getSyntaxHighlighterPromise` + `highlightedCodeCache` LRU + 流式 `createIncrementalHighlightedDocument` 增量高亮，流式期间不高亮、完成后一次性高亮，避免每帧重排）+ `apps/web/src/lib/syntaxHighlighting.ts`（shiki-wasm 共享 highlighter）。
- 做法：react-markdown `code` 组件接 shiki 单例（懒加载 wasm），完成后高亮 + LRU；注意流式时降级纯文本。
- 工作量：16-24h。

**2. 变更 diff 视图**（工具展示）
- 现状：工具卡 `changedFiles` 只有文件名列表（conversation.tsx L54）；编辑类工具结束后用户不知道改了什么，只能去文件面板开原文件。
- t3code 参照：`components/diffs/StyledDiffCodeView.tsx`（325 行）+ `DiffFileTree.tsx` + `DiffPanel.tsx`（1205，右面板 diff 浏览）；worker 侧需补 file diff API（`git diff` 或读新旧内容）。
- 做法：第一步在工具卡内嵌单文件 unified diff（+/- 行着色）；第二步右面板加 diff tab。依赖 worker 文件 API 扩展。
- 工作量：16-24h（第一步骤 8-10h）。

**3. 消息操作集：编辑重发 / 失败重试 / 删除**（chat 相关）
- 现状：ActionsBar 只有复制（conversation.tsx L81）；发送失败只有 hint 文案，用户消息无法编辑重发，长会话纠错成本高。
- t3code 参照：`chat/MessagesTimeline.tsx`（case "edit" 于 L3316 附近：编辑用户消息回填 composer 并截断后续）、`MessageCopyButton.tsx`。
- 做法：user 消息加「编辑」→ 草稿回填 + 服务器截断（依赖 turn 语义）；assistant 失败 turn 加「重试」。
- 工作量：8-12h（前端 4h + 协议确认）。

**4. 图片粘贴 / 附件上传到工作区**（composer 相关）
- 现状：附件按钮存在，但 submit 只内联 <10KB 文本（conversation.tsx L163-170），图片直接被 skip 并提示"将随后支持"；markdown 中 img 也被安全策略替换成链接文本。
- t3code 参照：`chat/composerAttachmentFiles.ts`（MIME 识别 + HEIC）、`chat/ComposerImageThumbnail.tsx`、`lib/imageCompression.ts`（上限 50MB 压缩到 1.3MB dataURL）、`chat/ExpandedImagePreview.tsx`/`ZoomableImage.tsx`（放大预览）。
- 做法：worker 文件 API 加 write；composer 粘贴/拖拽图片→缩略图→上传 workspace→消息内以路径引用；消息渲染器对 workspace 内图片放行。
- 工作量：12-20h（含 worker 侧）。

**5. 命令面板 / 会话搜索（Cmd+K）**（键盘导航完整度）
- 现状：快捷键 registry 已就绪（lib/shortcuts.ts 质量不错），但只注册了 Mod+B 与 Esc；无 Cmd+K、无任何会话全文搜索入口（header 搜索框已在前次清理中移除）。
- t3code 参照：`components/CommandPalette.tsx`（3043）+ `CommandPalette.logic.ts` + `ThreadSearchMatch.tsx`（命中摘录高亮）。
- 做法：轻量版：Cmd+K 弹面板，搜会话标题 + 时间线文本（journal 已全量在内存），支持跳转会话；命令项（切面板/新会话/换主题）后续叠入。
- 工作量：16-24h（轻量版 10-12h）。

**6. 审批面板形态升级**（chat 相关）
- 现状：审批已有功能链（`resolveApproval`、approve/deny），但 UI 是 `<pre>JSON.stringify</pre>` + 两个按钮（cluster-controls.tsx L105），命令风险/参数不可读。
- t3code 参照：`chat/ComposerPendingApprovalPanel.tsx` + `ComposerPendingApprovalActions.tsx`（按 requestKind 分型展示：command 用 code 块、mcp-elicitation 用说明文本）+ `permissions/PermissionChecklist.tsx`（权限粒度清单 + always/once）。
- 做法：按 action.kind 分型渲染（command → 命令 + cwd；write → 目标文件列表），加"本会话总是允许"，挂在 composer 上方而非列表堆叠。
- 工作量：6-10h。

### P1 体验提升（10 项）

**7. 排队消息可视化**
- 现状：运行中发消息进队列，界面只有 hint 一行字 + info 面板里的计数，用户看不到排了什么、排第几、能否撤回。
- t3code 参照：`chat/MessagesTimeline.tsx`（queuedMessages 渲染为时间线内可操作卡片）+ `QueuedMessageSender.tsx` + `sendQueuedMessage.ts`（turn 结束自动依序发送）。
- 工作量：8-12h。

**8. Prompt 历史（上/下箭头）**
- 现状：textarea 无历史；多轮调试时重复输入。
- t3code 参照：`chat/composerPromptHistory.ts`（含附件-only bootstrap 语义）。
- 工作量：4-6h。

**9. 会话标题自动生成**
- 现状：会话标题靠手 rename；列表里一片"新会话"。
- t3code 参照：`threadActionMenu.logic.ts` 的 `regenerate-title` + Sidebar 标题流。
- 做法：首轮 assistant 完成后 worker 取首段摘要写回 title（可复用 agent 侧能力或简单截断策略），列表自动刷新。
- 工作量：6-10h。

**10. 主题手动切换（深/浅/跟随）+ 外观设置区**
- 现状：只有 `prefers-color-scheme` 自动双主题（styles.css 5 处覆盖），用户无法固定深色；设置页无外观 section。
- t3code 参照：`settings/ThemeSettings.tsx` + `ThemeColorPicker.tsx`（主题编辑器整套太重，只借"切换 + 少量预设"层）。
- 工作量：6-8h。

**11. @ 文件提及（轻量实现）**
- 现状：无提及；引用文件只能手打路径。
- t3code 参照：`chat/composerMentionDrag.ts`（提及可拖拽）+ `composerInlineChip.tsx` + `contextChipParts.tsx`。TipTap 不做，textarea 上以 `@` 触发文件树补全、以 inline chip 呈现即可。
- 依赖：文件 API 已有（list）。
- 工作量：12-16h。

**12. ProposedPlanCard 计划卡**
- 现状：协议已有 `plan_text` streamKind（Phase 6 已落地），但前端把它当 reasoning 文本渲染，没有计划/确认交互。
- t3code 参照：`chat/ProposedPlanCard.tsx`（260 行：步骤列表 + 批准/修改）。
- 工作量：6-8h。

**13. 时间线长会话性能（行回收/虚拟化）**
- 现状：`timeline.map(entry => <TimelineEntry/>)` 全量渲染（App.tsx 会话区），长会话（数百条 + 工具输出）DOM 无上限；t3code 有明确 AGENTS 约束（列表难渲染是性能回归主源）。
- t3code 参照：`chat/MessagesTimeline.tsx`（virtualizer 行回收 + `resolveChatListAnchoredEndSpace` 锚定端空间）+ `ChatMarkdown` LRU。
- 工作量：12-16h。

**14. 未读与完成通知**
- 现状：后台会话跑完无任何提示；会话列表无未读态。
- t3code 参照：`components/ThreadNotificationCoordinator.tsx`（浏览器通知 + badge）+ `Sidebar.logic.ts` 未读标记。
- 工作量：8-12h。

**15. 消息时间戳**
- 现状：消息无任何时间显示（conversation.tsx 无 timestamp 渲染）；排查"什么时候说的" impossible。
- t3code 参照：`chat/MessagesTimeline.tsx`（hover 时间 + 日期分隔）。
- 工作量：2-4h。

**16. 划词引用回复**
- 现状：选中 assistant 文本无操作。
- t3code 参照：`chat/AssistantSelectionToolbar.tsx`（portal 浮动工具条 + `captureAssistantTextSelection`）+ `AssistantCitationChip.tsx`。
- 工作量：8-12h。

### P2 锦上添花（4 项）

**17. 时间线 minimap 导航**
- t3code 参照：`chat/timelineMinimapItems.ts` + MessagesTimeline minimap gutter。长会话侧边缩略跳转。8-12h。

**18. Git 集成（分支切换 + commit/push/PR 快捷操作 + diff 注释）**
- t3code 参照：`BranchToolbar*.tsx`、`GitActionsControl.logic.ts`、`pullRequest/`、`diffs/DiffCommentAnnotation.tsx`。依赖 worker git 能力整体规划，先做 diff（第 2 项）再评估。24h+。

**19. 项目内容全文搜索对话框**
- t3code 参照：`search/ProjectContentSearchDialog.tsx`（文件内容匹配分组 + `HighlightedSearchLine`）。依赖 worker 侧 grep API。12-16h。

**20. 设置页扩展：快捷键自定义面板**
- 现状：快捷键硬编码于注册处；t3code 有完整 KeybindingsSettings（1325 行）。
- 参照：`settings/KeybindingsSettings.tsx` + `CaptureShortcutConfig.tsx`。mini 已有 registry，做"展示 + 少量可改"即可。8-12h。

## 三、样式维度专项核对

| 维度 | 现状 | 结论 |
|---|---|---|
| 交互细节（hover/动画/微交互） | ActionsBar group-hover 渐显、press-feedback、ring-focus、transition-smooth 已就绪；但 `animate-fade-up` 全站仅 1 处使用，进入动画基本缺席 | 部分对齐；随 1/12/16 项补消息级动画，避免常驻重绘（t3 AGENTS 明确禁连续动画） |
| 排版细节 | 无语法高亮、无等宽对齐的行号（文件预览有）、无时间戳 | 第 1、15 项补齐 |
| 移动端适配 | sm/md/2xl 断点 + RightPanelSheet 抽屉已有；t3code web 端同级 | 基本对齐，不单列差距 |
| 无障碍 | aria-label/role=status/sr-only 广泛使用；dialog focus 管理有 | 基本对齐，不单列 |
| 键盘导航完整度 | registry 优秀但覆盖少：Mod+B、Esc 仅此；缺 Cmd+K、上箭头历史、消息间焦点移动 | 第 5、8 项补齐 |

## 四、建议批次

1. **快赢批（1-2 天）**：#15 时间戳、#8 prompt 历史、#12 计划卡、#6 审批面板形态、#10 主题切换。
2. **核心体验批（约 1 周）**：#1 语法高亮、#3 消息操作集、#7 排队可视化、#5 命令面板轻量版。
3. **需要 worker 侧配合批**：#2 diff（文件 API 扩展）、#4 图片上传、#9 标题生成、#11 @提及、#14 通知。
4. **性能与长尾**：#13 虚拟化、#16 划词引用、#17-20。

> 总量级约 180-260h；P0 六项约 74-98h。task15/task16 在途项落地后，#5 的命令项与模型 chip 相关差距会自然收窄。
