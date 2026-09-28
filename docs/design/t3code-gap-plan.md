# t3code 差距收敛计划（20 项全量排期）

> 依据：docs/research/t3code-gap-remaining.md + opencode-web-research.md（微交互补充）
> 前置：task15（斜杠命令 agent 适配）→ task16（会话中换模型）已在队列
> 执行模式：每项独立 pi 派发 → 验证（typecheck/测试/build）→ 浏览器验收 → 提交 → 下一项

## 批次一：高性价比快赢（P0 快项 + 超轻 P1）

| 序 | 任务 | 内容 | 估时 |
|---|------|------|------|
| G6 | 审批面板分型 | requestKind 分型渲染 + always/once；形态用 **opencode dock 停靠堆栈**（输入框上方按 dockProgress 展开，输入区 lift 上移）| 8-12h |
| G3 | 消息操作集 | 编辑重发（回填 composer）/失败重试/删除，ActionsBar 扩展 | 8-12h |
| G5 | Cmd+K 命令面板 | 轻量版：搜会话标题+时间线文本、跳转；命令项后续叠入 | 10-12h |
| G15 | 消息时间戳 | hover 时间 + 日期分隔线 | 2-4h |
| G8 | prompt 历史箭头 | composerPromptHistory 模式（上下键翻历史） | 4-6h |

批次一小计：30-44h

## 批次二：代码体验核心（P0 重项）

| 序 | 任务 | 内容 | 估时 |
|---|------|------|------|
| G1 | 语法高亮 | shiki-wasm + LRU 缓存 + 流式完成后高亮（ChatMarkdown 模式） | 16-24h |
| G2 | diff 视图 | 工具卡 changedFiles 行级 +/- diff + 右面板 DiffPanel（worker fs.read 扩展） | 16-24h |
| G12 | ProposedPlanCard | plan_text streamKind → 计划卡 UI（步骤列表+批准/修改） | 6-8h |

批次二小计：38-56h

## 批次三：输入与附件（P0+P1）

| 序 | 任务 | 内容 | 估时 |
|---|------|------|------|
| G4 | 图片粘贴与上传 | 粘贴/拖入图片→预览→经 worker fs 写入 workspace 引用；HEIC 识别可后置 | 12-20h |
| G11 | @文件提及 | textarea @ 触发文件树补全 + inline chip（非 TipTap 轻量版，文件 API 已有） | 12-16h |
| G7 | 排队消息可视化 | **opencode dock 模式**：排队条停靠输入框上方（可展开/撤回），非时间线卡片 | 8-12h |

批次三小计：32-48h

## 批次四：体验完善（P1 剩余 + P2）

| 序 | 任务 | 内容 | 估时 |
|---|------|------|------|
| G9 | 会话标题自动生成 | 首轮完成后摘要写回 title | 6-10h |
| G10 | 主题手动切换 | 深/浅/跟随 + 设置页外观区 | 6-8h |
| G13 | 长会话虚拟化 | 时间线行回收 + 锚定端空间 | 12-16h |
| G14 | 未读与完成通知 | 浏览器通知 + badge + 列表未读态 | 8-12h |
| G16 | 划词引用回复 | 选中文本浮动工具条 + 引用 chip | 8-12h |
| G17 | minimap 导航 | 时间线缩略跳转（P2） | 8-12h |
| G19 | 项目全文搜索 | worker grep API + 分组对话框（P2） | 12-16h |
| G20 | 快捷键自定义 | registry 展示+少量可改（P2） | 8-12h |
| G18 | Git 集成 | 依赖 G2 完成 + worker git 能力规划（P2，最后评估） | 24h+ |

| G23 | 任务模块增强 | multica 式：指派字段（agent/人头像）+ Run 结束自动 run-report 评论 + 审查闭环（完成摘要/一键重发起）| 12-16h |
| G21 | agent 身份色 token | opencode --v2-agent-* 三件套（solid/border/background）：画布节点/会话消息/智能体面板按 agent 身份着色 | 4-6h |
| G22 | hairline 边框 + elevation | 0.5px 边框（inset box-shadow）+ 分层阴影（含 inset 高光），task13 之上再升级 | 6-8h |

批次四小计：104-132h

## 总量与顺序

总计约 194-266h（pi 执行约 15-25 个工作日）。
执行顺序：批次一 → 二 → 三 → 四；批次内按表序。
G18（Git 集成）在 G2 落地后单独评估，不自动开工。

## 借鉴纪律（不变）

- 每项先读 t3code 源文件路径（报告已给）再派发
- MIT 注明 Derived from pingdotgg/t3code
- 浏览器验收截图后才提交
- 我们四块差异功能（团队/项目/节点/画布）不用 t3code 的功能形态，只统一视觉语言

## 批次五：全站样式孤岛清理 + 深度借鉴（2026-09-27 追加）

> 诊断：G23 发现任务模块是旧版式孤岛；泛化排查发现 styles.css 还有 6 套旧 CSS 体系未统一。
> 另：三源调研还有未消化的深度借鉴项。

| 序 | 任务 | 内容 | 估时 |
|---|------|------|------|
| G24 | 落地页 t3code 化 | landing-*（landing-card/feature-icon/grid）旧体系 → t3code 首页语言（居中限宽 + surface 卡 + 渐变资产）；落地页是第一印象 | 4-6h |
| G25 | CreationDialog/InspectorSheet 统一 | creation-dialog/inspector-sheet 旧类 → 统一 Dialog/Sheet 组件 + t3code 表单密度 | 3-4h |
| G26 | ai-prompt-* 双轨输入框合并 | styles.css 里还有一套 .ai-prompt-*（与 ai-elements prompt-input 平行的旧输入框体系）→ 确认消费方（component-library/旧页面）后删除或迁移 | 3-5h |
| G27 | component-library 演示页处置 | 21st.dev 演示页（component-library-* 12 个类）：从一级导航已移除（审计 P2-13），本轮决定保留 URL 直达但样式对齐，或直接删除 | 2-3h |
| G28 | gradient-* 体系收敛 | gradient-border/gradient-primary/subtle 检查使用处，统一到 primary token | 1-2h |
| G29 | opencode 微交互包 | hairline 0.5px 边框 + elevation 分层阴影（G22 深化）+ text-shimmer 流式占位 + tabular-nums 全局数字 + 工具计数 0fr→1fr 展开动画 | 6-8h |
| G30 | agent 身份色应用深化 | G21 token 落地后：会话消息 sender 图标、画布节点描边、AgentsPanel 徽章、任务指派头像四处统一用身份色 | 3-4h |
| G31 | multica realtime 分层重构 | web 的 SSE/WS 事件处理改 per-domain updater + Query/Zustand 边界（multica 模式，同栈）——中期项，改善状态同步质量 | 16-24h |
| G32 | AX runner 契约引入 | worker agent 进程管理升级：healthz/readyz 语义（进程活 vs 环境就绪分离）+ 子进程组 SIGTERM 宽限 + metadata 自描述 | 8-12h |
| G33 | multica steer 契约 | 运行中转向：单槽信号合并 + [ADDITIONAL GUIDANCE] 模板 + 四失败枚举（capabilities 已声明 steering 未实现）| 8-12h |
| G34 | 会话标题自动生成（G9 深化版） | worker 侧首轮完成后摘要写回 + 列表实时刷新 | 6-10h |

批次五小计：60-90h。执行顺序：G24-G28（样式孤岛，快）→ G29/G30（微交互+身份色）→ G32/G33（协议深化）→ G31（realtime 重构，大）→ G34。

## 批次六：画布驱动的任务-会话图操作（2026-09-27 追加，用户愿景）

> **设计立场：看板与画布并存互补**，不是替代关系——看板是列表维度（状态流转/批量管理/进度总览），画布是空间维度（关系拓扑/分配操作/多任务并行全景）。同一份 Task/Session 数据，两个投影视图，操作互通（画布建的任务出现在看板，看板指派的关联显示在画布）。
> 用户愿景：画布成为任务↔会话的图操作界面——任务节点化、连线即关联、从任务拉线创建会话（丝滑分配感）。
> 数据基础已具备：session.taskId 字段已存在（sqlite 触发器保证完整性）；画布 graph 走 lineage.getGraph；React Flow 已支持自定义节点/边/连线交互。

| 序 | 任务 | 内容 | 估时 |
|---|------|------|------|
| G39 | 画布任务节点 + 混合图 | ①graph 投影升级：Task 作为一等节点类型（与 Session 并列），Task→Session 的 taskId 关联渲染为边；任务节点显示标题/状态/指派者 ②画布过滤器加「任务」维度 ③任务节点点击打开任务详情面板（右面板） | 10-14h |
| G40 | 画布创建任务 + 拉线分配 | ①画布空白处右键/加号 → 创建任务（Popover 表单：标题/描述/验收标准，落到画布坐标） ②**从任务节点拉线**（React Flow onConnect 手势）：拉到空白 → 弹出"创建会话并关联"（选 agent/workspace，复用 launch-draft 的 taskPrompt）③拉到已有会话节点 → 建立关联（更新 session.taskId）④拉到 worker/agent 区域（可选）→ 创建该 agent 的会话 ⑤连线动画反馈 + 建立后 edge 语义色（任务色） | 14-20h |
| G41 | 任务生命周期画布可视化 | ①任务状态变化画布实时反映（状态徽章 + 边流动画：in_progress 的关联会话边用 animated）②run-report 到达时任务节点脉冲提示 ③审查通过/驳回的视觉反馈（done 灰化 / blocked 警示描边） | 6-8h |
| G35 | 任务调度闭环（multica） | deferred 提升 + empty-claim 缓存 + idle watchdog——配合画布指派，多 worker 场景调度质量 | 8-12h |

批次六小计：38-54h。顺序：G39（读）→ G40（写，核心丝滑感）→ G41（动）→ G35（调度）。
依赖：G39/40 依赖 G23 的指派字段（已在队列）；G41 依赖 G23 的 run-report。


## 批次七：连接器模块（2026-09-27 追加，用户需求：外部服务调用 + IM 接入）

> 需求：连接器模块 = 与外部世界交互的统一入口。两个方向：
> - **出站（agent 用工具）**：调用外部服务/API（webhook、HTTP API、MCP 服务器接入）
> - **入站（外部触发我们）**：IM 通道接入（飞书/Slack/Telegram/微信），外部消息→会话，agent 回复→IM
>
> 现状：worker 无 MCP 支持（claude-agent 内置受限）；server 无任何 IM/webhook 通道（multica 的"产品外围"项我们全是空白）。
> 用户环境优势：已有飞书 bot 基础设施（Hermes 本身就跑在飞书上，凭证/经验可复用）。

| 序 | 任务 | 内容 | 估时 |
|---|------|------|------|
| G42 | 连接器架构设计（先行） | 设计文档：连接器域模型（Connector 实体：kind/type/凭证/作用域）、出站工具桥（agent 调用外部 MCP/HTTP 的安全通道：凭证不出 worker、审批门禁、限流）与入站通道（IM webhook→session 路由→回复推送）的协议；参照 multica 通道架构 + 我们的 BYOK 原则 | 6-8h |
| G43 | 出站：MCP 客户端接入 | worker 侧 MCP 客户端（stdio/HTTP 两种 transport）：项目级配置 MCP 服务器清单；agent 会话可发现并调用 MCP 工具（经现有审批链，工具调用走 ToolExecutionGateway）；凭证 worker 本地存储 | 16-24h |
| G44 | 出站：HTTP 服务连接器 | 通用 HTTP 连接器（server 存连接器定义：name/baseUrl/auth 类型/预设 headers）：agent 经专用工具 http_call 调用（作用域校验+审批）；web 管理页（连接器 CRUD+测试连接） | 12-16h |
| G45 | 入站：飞书通道 | 飞书 bot 接入（事件订阅→server webhook 端点）：IM 消息→路由到绑定会话（按 chat_id↔session 映射）；agent 回复→飞书 API 推回；@bot 触发；凭证复用用户现有飞书应用模式 | 16-20h |
| G46 | 入站：通道抽象 + webhook 通用入口 | 通道抽象层（Channel 接口：incoming/outgoing/routing），飞书为第一实现；通用 webhook 入口（token 鉴权）供后续 Slack/Telegram/自定义快速接入 | 8-12h |

批次七小计：58-80h。顺序：G42 设计先行（必须）→ G43（MCP，agent 能力质变）→ G44 → G46（抽象）→ G45（飞书首发，用户有真实场景可立即用）。
依赖：G43/G44 依赖 G42 契约；G45 依赖 G46 抽象（可并行开发飞书实现）。
安全边界：连接器凭证全部 worker/server 本地（BYOK 原则）；出站调用默认过审批（高危操作白名单豁免）；入站 webhook 严格鉴权+防重放。
