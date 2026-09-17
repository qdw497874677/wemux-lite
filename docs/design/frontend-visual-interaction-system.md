# Wemux Lite 前端视觉与交互系统

> 定位：面向技术用户的 AI Agent 集群管理与协作工作台，直接对话与任务协作均为一等入口。
> 适用范围：视觉原则继续使用；下文审计结果与 V/P 阶段为历史快照，不是当前状态。方向和新验收门槛见 [产品方向](../product-direction.md) 与 [路线图](../roadmap.md)。源码契约只作补充，真实浏览器、窄屏和错误状态验证是交付要求。
> 设计语言：Linear 式克制、GitHub 式信息清晰度、操作系统控制台式稳定框架。
> 不做：营销页感、AI 紫色霓虹、全屏玻璃拟态、过度圆角、无意义动画、每块内容都套卡片。

## 修订记录

- **v1.1，2026-01-06，按子代理审查修订。** 落实 6 项 major 与 5 项 minor，无拒绝项；补齐阶段边界、字段契约、输入方式、颜色迁移、Run 启动、页面覆盖、响应式与验收规则。
- 跨文档统一裁定优先于参考文档中尚未同步的旧阶段编号与测试表述；本次仅修订本文件。
- V*/P* 对齐：V0（token/组件状态统一，纯样式层，行为零变化）→ P0–P1 期间并行落地；V1（App Shell 视觉）→ 挂 P3 路由；V2（看板视觉）→ 挂 P4；V3（Run 时间线视觉）→ 挂 P5；V4（视觉 QA）→ P7 之后、发布前。
- Inspector 宽度统一：默认 520px，可拖拽范围 480–560px，<1024px 转全屏 Sheet。
- 测试基线：不引入 DOM 测试环境；V2 静态原型验收用 source-contract/手动检查。

## 1. 设计参数

- `DESIGN_VARIANCE: 4`：布局稳定，允许局部非对称，但不牺牲扫描效率。
- `MOTION_INTENSITY: 3`：仅状态变化、拖拽、面板切换和按压反馈。
- `VISUAL_DENSITY: 7`：桌面工作台密度，信息紧凑但不拥挤。
- 主要目标设备：1280–1600px 桌面；1024px 可完整使用；<1024px Inspector 转全屏 Sheet，小于 768px 主布局退化为单栏与导航抽屉。

## 2. 当前样式审计

当前已有基础：

- Tailwind v4 与一套语义颜色变量。
- Radix Dialog、Select、Tabs、Tooltip 等可访问性 primitives。
- Lucide 作为统一图标族。
- Button、Input、Badge、Sheet、Toast 等基础组件。
- `prefers-reduced-motion` 降级规则。

需要调整的问题：

1. 目前是深色限定，缺少正式的 light/dark token 对称设计。
2. 主色是偏紫的 `hsl(244 75% 64%)`，容易产生通用 AI 产品感，应改为克制的蓝色操作强调色。
3. 页面层级主要依赖“卡片 + 背景色”，后续看板会产生过多容器嵌套。
4. 字号、控件高度、间距和圆角未形成明确密度规范。
5. 全局壳、看板、检查器、运行时间线还没有共享的视觉层级规则。
6. 颜色债不限于 zinc/hex：`badge.tsx` 的 emerald/amber/red 前景、背景、边框，`toast.tsx` 的 indigo/emerald 图标，`create-dialog.tsx` 的 red 错误文字，以及 `cluster-page.tsx` 的状态统计、提示条、破坏性操作、violet 图标都需迁入语义 token；并扫描其余业务组件的同类硬编码。
7. `styles.css` 的紫色 selection、硬编码 scrollbar 与 `color-scheme: dark` 需纳入双主题迁移。旧 `accent` 是中性 hover 面，不能直接改为蓝色，否则 Button、Select、DropdownMenu 的交互语义会被一起改变。

## 3. 视觉语言

### 3.1 色彩

采用中性冷灰底色，蓝色为唯一品牌/操作强调色。状态色只表达语义，不能充当装饰。

| Token | 深色用途 | 浅色用途 |
|---|---|---|
| `canvas` | 页面最底层，近黑石墨 | 冷白灰 |
| `surface` | 侧栏、主面板 | 白色 |
| `surface-raised` | 浮层、选中卡片、Popover | 略高于背景的白 |
| `surface-hover` | hover 与轻选中 | 冷灰 |
| `border-subtle` | 常规分隔线 | 中性浅灰 |
| `border-strong` | 聚焦、选中、拖拽目标 | 中性中灰 |
| `text-primary` | 标题、正文 | 深石墨 |
| `text-secondary` | 元数据、辅助信息 | 中灰 |
| `text-muted` | 时间、占位、禁用 | 满足可读性目标的灰色 |
| `accent` | 主按钮、当前导航、焦点环 | 克制电蓝/天蓝 |
| `success` | ready、succeeded、done | 绿色 |
| `warning` | provisioning、waiting、in_review | 琥珀色 |
| `danger` | failed、blocked、destructive | 红色 |

约束：

- 一个页面只使用一个主强调色。
- 状态必须同时有图标或文字，不依赖颜色判断。
- 静态列背景统一使用中性 `canvas`，不铺状态色 tint；状态色限列头图标与细边，拖入目标另用统一蓝色 `accent-subtle`。
- 不使用外发光；焦点使用 2px ring，选中使用边框 + 轻背景。

双色 token 候选值（仅在 token 定义层使用色值，业务组件不得复制色值）：

| Token | 深色 | 浅色 |
|---|---|---|
| `canvas` | `#020617` | `#f8fafc` |
| `surface` | `#0f172a` | `#ffffff` |
| `surface-raised` / `surface-hover` | `#1e293b` | `#f1f5f9` |
| `border-subtle` | `#334155` | `#cbd5e1` |
| `border-strong` | `#94a3b8` | `#64748b` |
| `text-primary` | `#e2e8f0` | `#0f172a` |
| `text-secondary` | `#cbd5e1` | `#475569` |
| `text-muted` | `#94a3b8` | `#475569` |
| `accent` / `accent-foreground`（实心按钮） | `#2563eb` / `#ffffff` | `#2563eb` / `#ffffff` |
| `accent-text` / `accent-subtle` / `accent-border` | `#93c5fd` / `#172554` / `#60a5fa` | `#1e40af` / `#eff6ff` / `#2563eb` |
| `success` / `success-subtle` / `success-border` | `#86efac` / `#052e16` / `#4ade80` | `#166534` / `#f0fdf4` / `#15803d` |
| `warning` / `warning-subtle` / `warning-border` | `#fde68a` / `#451a03` / `#fbbf24` | `#92400e` / `#fffbeb` / `#b45309` |
| `danger` / `danger-subtle` / `danger-border` | `#fca5a5` / `#450a0a` / `#f87171` | `#991b1b` / `#fef2f2` / `#b91c1c` |

状态 badge/提示条使用同名的前景、背景、边框三件套，不用独立透明度叠加；选中、drop、用户消息使用 `accent-text` + `accent-subtle`，焦点环使用 `accent-border`。`border-subtle` 仅作装饰分隔，必须依靠边界辨认的控件使用 `border-strong`。

旧新映射与迁移边界：

| 旧用途 | 新 token / 处理 |
|---|---|
| background / foreground、card/popover | 分别映射 `canvas` / `text-primary`、`surface` / `surface-raised` |
| muted 面与文字、border/input | 按用途映射 `surface-hover`、`text-muted`、`border-subtle` / `border-strong` |
| 旧 accent / accent-foreground（中性 hover） | 消费端改用 `surface-hover` / `text-primary`；迁完后才将新 `accent` 用于蓝色主操作 |
| primary / primary-foreground、ring | `accent` / `accent-foreground`、`accent-border`；导航文字用 `accent-text`，不直接用按钮底色 |
| emerald / amber / red 与 destructive | 按语义映射 success / warning / danger 三件套，含业务表单错误与破坏性操作 |
| indigo / violet 与其余非语义颜色 | 信息/操作用 accent 三件套，无状态含义的统计与图标用中性文字；禁止按原色机械映射 |
| selection、scrollbar、color-scheme | selection 用 accent 文字/底色；scrollbar 用 `border-strong` / `canvas`；color-scheme 随主题匹配 |

AA 是**待真实界面验证的验收目标**，不是现状达标声明。下面仅为候选不透明 sRGB 色对按 WCAG 相对亮度公式计算的对比度；实现后仍须核验 hover、focus、placeholder、实际叠色与截图，不能把表中计算值当作浏览器验收结果。

| 前景 / 背景组合 | 深色对比度 | 浅色对比度 | 门槛 |
|---|---:|---:|---|
| `text-primary` / `surface` | 14.48:1 | 17.85:1 | ≥4.5:1 |
| `text-secondary` / `surface-hover` | 9.85:1 | 6.92:1 | ≥4.5:1 |
| `text-muted` / `surface-hover`（11px、placeholder） | 5.71:1 | 6.92:1 | ≥4.5:1 |
| `accent-foreground` / `accent` | 5.17:1 | 5.17:1 | ≥4.5:1 |
| `accent-text` / `accent-subtle` | 8.15:1 | 8.01:1 | ≥4.5:1 |
| `success` / `success-subtle` | 10.62:1 | 6.81:1 | ≥4.5:1 |
| `warning` / `warning-subtle` | 12.03:1 | 6.84:1 | ≥4.5:1 |
| `danger` / `danger-subtle` | 8.51:1 | 7.60:1 | ≥4.5:1 |
| `accent-border` / `surface-hover`（焦点环） | 5.75:1 | 4.72:1 | ≥3:1 |

### 3.2 字体

- 主字体：Inter Variable。该产品需要中性、高可读、Linear 风格；沿用现有方向，不为了差异化换字体。
- 中文 fallback：`PingFang SC`, `Microsoft YaHei`, system-ui。
- 等宽字体：系统等宽栈，用于 ID、模型名、分支、事件序号、耗时和日志。
- 数字使用 `font-variant-numeric: tabular-nums`，避免状态列表抖动。

字号层级：

| 层级 | 大小 | 用途 |
|---|---:|---|
| Page title | 18px / 600 | 页面主标题 |
| Section title | 14px / 600 | 面板标题、列标题 |
| Body | 13px / 400–500 | 卡片标题、表单内容 |
| Secondary | 12px | 元数据、描述、标签 |
| Micro | 11px | ID、时间、计数、状态辅助文字 |

不使用大标题制造层级；工作台的层级通过位置、字重、分隔线与留白表达。

### 3.3 圆角与边框

规则固定，不随组件任意变化：

- Button/Input：6px。
- Card/Panel/Dialog：8px。
- Badge/Status：999px，仅语义胶囊使用。
- 主布局区域不做外层大圆角，保持工作台的连续画布感。
- 分隔线统一 1px；默认不使用重阴影。
- Popover/Dialog 可使用一层低透明、带背景色倾向的阴影。

### 3.4 间距与控件高度

采用 4px 基础网格：4 / 8 / 12 / 16 / 20 / 24 / 32。

- 顶栏：48px。
- 导航项：36px。
- 普通按钮/Input：32px。
- 主要按钮：36px。
- 看板列头：40px。
- 卡片内边距：12px。
- 面板内边距：16px；复杂表单区块间距 20px。
- 图标常规 16px；微型元数据 12px；空状态 24px。
- 视觉尺寸不等于实际命中区：所有操作至少 32×32px，移动端或粗指针至少 40×40px；普通 32px 控件在这些场景扩到 40px。40px 列头内按钮也必须有 40×40px 命中区，不得相互覆盖，必要时加高列头。
- V0 同步修复 Dialog 关闭按钮仅 16px 图标、Toast 关闭按钮 28px、Sheet 关闭按钮 32px 的欠账；使用按钮 padding/min-size 扩展实际命中区，保留既有事件与焦点行为。

## 4. 应用壳布局

```text
┌────────────────────────────────────────────────────────────────┐
│ 48px 顶栏：产品/当前项目 | 全局搜索 | 连接状态 | 用户与设置       │
├────────────┬──────────────────────────────────┬─────────────────┤
│ 左侧栏     │ 主工作区                           │ 右检查器         │
│ 248px      │ 自适应                             │ 默认 520px      │
│            │                                    │ 可关闭/可调宽     │
│ 项目列表   │ 页面标题与局部工具栏 48px           │ Task/Run 详情     │
│ 项目内导航 │ 看板 / 会话 / 工作区                │                 │
└────────────┴──────────────────────────────────┴─────────────────┘
```

### 4.1 左侧栏

- 默认 248px，可折叠为 56px；不照搬 wemux-slim 的 282–384px 宽侧栏。
- 第一层：项目切换。
- 第二层：项目内导航（概览、任务、会话、工作区、项目设置）；项目设置入口不能由底部全局设置替代。
- 底部：运行时、集群、设置。
- 当前项：蓝色 2px 左标记 + 低透明背景，不使用整块高饱和色。
- 项目状态只用小圆点/计数，不塞入多行摘要。

### 4.2 顶栏

- 不重复左侧栏已有导航。
- 中间可放全局搜索/命令面板入口。
- 右侧显示四层状态的压缩摘要：Browser / Server / Worker / Journal。
- 状态异常才展开文案；正常时只显示图标与 tooltip。

### 4.3 右侧检查器

- Task、Run、Workspace 共用同一 Inspector 壳。
- 默认 520px，可拖拽范围 480–560px，<1024px 转全屏 Sheet；各断点的 push/overlay 与锁焦规则以 §11 为准。
- 宽屏使用非 modal Inspector，不直接复用现有默认 modal、窄宽度的 Sheet；modal overlay 与全屏模式才使用 Radix Sheet，并显式覆盖宽度。调宽手柄可聚焦，左右方向键可调整宽度且受同一范围约束。
- 面板头固定，内容滚动；保存/启动等主操作固定在底部或标题栏。
- URL 记录选中的 Task/Run，关闭检查器不丢主页面滚动位置。

## 5. 任务看板样式

### 5.1 看板画布

- 列宽 280px，最小 260px，最大 320px；列不收缩（`flex-shrink: 0`），由看板专属 `overflow-x: auto` 容器横向滚动，不让整页横向溢出。
- 列与列之间 12px。
- 列不是厚重卡片：只使用中性 `canvas` + 顶部分隔，不铺静态状态 tint；减少“卡片套卡片”。
- 列头 sticky，包含状态图标、名称、数量、添加和更多操作。
- 空列维持最小高度，并提供轻量 drop target，不放大型插画。

### 5.2 任务卡片

卡片与 list 行共享字段契约，信息顺序固定：

| 顺序 | 字段与来源 | 空值与展示规则 |
|---|---|---|
| 1 | 任务键（Task `id`）/ `priority` / Task Link 标记 | 不新增业务编号；长 id 可视觉省略但提供完整可访问名称与复制值；id 缺失视为数据错误，不虚构编号。无优先级显示“未设优先级”，无关联不显示标记 |
| 2 | `title` | 最多两行；缺失显示“标题缺失”并标记数据异常 |
| 3 | `description` | 可选，最多两行；高密度模式可隐藏 |
| 4 | Task `status`（工作流状态） | 独立文字/图标 badge，列头不能替代；list 与脱离列的卡片同样保留，不与 Run 状态混用 |
| 5 | 当前 Assignment 的 Agent/Model 摘要 | 无活跃 Run 时仍展示；未指派显示“未指派”，字段缺失显示“指派不完整”；Workspace/Worker 在详情展开，显示名不可解析时回退对应 ID |
| 6 | 活跃 Run 的状态徽章 | 无活跃 Run 显示“无活跃运行”；需要展示执行配置时标为“本次运行”，只读该 Run 快照，不覆盖当前 Assignment |
| 7 | `updatedAt` | 显示相对时间并可查看完整时间；缺失显示“更新时间未知” |

Assignment 是可变的后续执行意图，Run 快照是历史事实；即使两者不同也各自展示，不能用活跃 Run 的 Agent/Model 冒充当前指派。

视觉状态：

- 默认：`surface` + subtle border。
- hover：边框增强、背景提高一级。
- selected：`accent-border` + `accent-subtle` 背景与 `accent-text` 文字，不额外叠透明度。
- dragging：轻微缩放到 0.98、透明度 70%、原位置保留占位。
- drop target：`accent-border` + `accent-subtle` 背景；不使用闪烁。
- blocked/failed：只在状态 badge/左侧 2px 标记中使用红色，不染红整张卡片。

卡片右上不常驻一排图标，仅保留一个“···”操作菜单触发器：

- 触发器始终在 Tab 顺序内，提供“任务操作”可访问名称；不得用 `display: none`、`visibility: hidden` 或移除 tabIndex 隐藏键盘入口。
- 鼠标 hover、卡片或其子控件 `focus-within` 时显示按钮；卡片详情入口与菜单按钮分开，点击菜单不打开 Inspector。
- `@media (hover:none)` 常显“···”按钮；`@media (pointer:coarse)` 同样常显，不以视口宽度替代输入能力判断。
- 菜单保留“移动到…”作为拖拽等价操作；键盘 Enter/Space 打开，方向键选择，Escape 关闭并回焦触发器。菜单与拖拽共享合法流转、乐观更新和失败回滚规则。

### 5.3 列状态色

- Backlog / Todo：中性灰。
- In progress：蓝色（与主强调色一致）。
- In review：琥珀色。
- Done：绿色。
- Blocked：红色。

不沿用 wemux-slim 对每列铺 amber/emerald/sky/rose 大面积背景的方式；Mini 静态列背景始终为中性，只在列头图标与细边使用对应状态色；drop target 无论目标列状态都使用蓝色 accent 三件套。

## 6. 任务详情样式

- 默认 520px，可拖拽范围 480–560px，<1024px 转全屏 Sheet；不另设窄屏整页路由，模式与焦点规则见 §11。
- 标题区：状态选择、任务标题、优先级、更多菜单。
- Tabs 不使用胶囊按钮组，使用底部指示线：概览 / 关联 / 工作区 / 运行 / 活动。
- 概览页不把每个字段都套卡片，采用分组标题 + `divide-y`。
- Agent Assignment 用一个明确的“执行目标”区块，展示 Workspace、Worker、Agent、Model 四行；编辑时打开紧凑表单。始终提示“修改指派只影响后续运行，不迁移已有会话”；运行中修改时同时保留当前 Run 不可变快照供对照。
- 主操作只有一个：根据状态显示“创建工作区 / 启动运行 / 查看运行 / 进入审查”。次要动作进入菜单。

新建/编辑任务使用同一紧凑表单规则：标题、描述、验收标准、状态、优先级，新建可带初始关联；字段标签、错误、提交中禁用与冲突保留草稿按 §9、§12 验收。任务工具栏提供 board/list 切换、状态/指派筛选、关键词搜索及清空筛选；URL 保留 view/filter。list 使用简单表格，沿用 §5.2 字段与菜单，窄屏允许表格容器横向滚动；筛选无结果须与项目尚无任务的空状态区分。

## 7. 工作区创建交互

单屏表单，不做多步骤向导：

```text
名称       [任务标题预填                         ]
执行节点   [worker-a · 在线 · 3 agents           ▾]
仓库       [org/repository · main                 ▾]
Agent      [Pi · available                        ▾]
模型       [gpt-5                                 ▾]

仅检测的 Agent：灰色、不可选、附“尚无执行适配器”说明

                              [取消] [创建工作区]
```

- Label 永远在输入框上方，不使用 placeholder 代替 label。
- 级联切换后，下游字段即时清空并解释原因。
- 创建后表单不等待 provisioning 完成；关闭 Dialog，在任务详情显示状态条。
- provisioning 用阶段文字和细进度条，不用无限旋转 spinner。
- failed 在原位置显示原因与“重试”，不只弹 toast。

## 8. Agent Run 与会话时间线

启动确认状态属于首批第 4 张页面的前置状态，不增加独立页面数量：

- 预填当前 Assignment，确认 Worker / Workspace / Agent / Model 四字段；初始 Prompt 由标题、描述、验收标准组成，允许预览和编辑。
- 显式选择“继续上次会话”（`reuse`）或“新开尝试”（`new`），展示复用 Session 的标识与上下文延续说明；无可复用 Session 时禁用 reuse 并说明原因，仍须确认 new，不能静默替用户选择。
- 未指派、工作区未 ready、Worker 离线时禁用启动并显示具体原因；已有活跃 Run 时显示“已有活跃运行，不能重复启动”与“查看运行”入口。禁用原因必须常驻，不能只靠 tooltip。
- 提交中禁用重复点击，沿用幂等请求；服务器确认后才进入对应 Run。失败保留 Prompt 和选择，冲突提示刷新当前运行，不宣称启动成功。
- 运行中修改指派提示“只影响后续运行”，当前 Session 与 Run 快照不变；Run 完成只建议进入审查，不自动完成任务。

### 8.1 Run Header

- 显示：Run #、Worker、Workspace、Agent、Model、状态、耗时；窄屏允许换行，不能省略四个快照字段。
- 不可变快照采用灰色标签和 tooltip，不做醒目警告框。
- running 时主操作为“停止”；结束后主操作为“建议进入审查”。

### 8.2 时间线

采用连续文档流，不做聊天软件式左右气泡：

- 用户消息：`accent-text` / `accent-subtle` 区块，作为指令输入，两主题均不额外叠透明度。
- Agent 文本：主画布正文，无大卡片。
- Tool Call：可折叠行；图标 + 工具名 + 状态 + 耗时，展开后显示参数和结果。
- 通知/系统事件：细分隔线上的小字，不占完整卡片。
- 正在运行：仅当前步骤显示低频脉冲点；遵守 reduced motion。
- Composer 固定底部，输入区与时间线之间有清晰边界；显示文案取决于确认阶段，不能仅凭乐观 `queued` echo 宣称已经入队。

| 提交状态 | 文案 | 恢复与操作 |
|---|---|---|
| 发送中（请求未返回） | 正在提交… | 保留草稿副本，防止同一提交重复触发 |
| 等待确认（含 unconfirmed） | 等待确认，尚未确认入队 | 保留 echo 与草稿；查询确认或沿用同一 commandId 重试，不生成重复消息 |
| 服务端确认入队 | 已排队，当前回合结束后执行 | 仅收到权威入队确认才使用此文案；已开始执行则显示当前执行状态 |
| 失败 / rejected | 提交失败：具体原因 | 标明失败，恢复可编辑草稿（不覆盖新输入），提供重试入口；同次请求重试沿用原 commandId |

HTTP 请求返回但尚无权威入队结果时仍是“等待确认”；断线不自动推断为已入队或已失败。

## 9. 状态反馈规范

每个异步界面都必须设计完整周期：

| 状态 | 表现 |
|---|---|
| Loading | 与最终结构一致的 skeleton，不用全屏 spinner |
| Empty | 说明为什么为空 + 一个明确下一步操作 |
| Error | 内容附近显示原因和重试；toast 仅用于瞬时错误 |
| Offline | 顶栏状态 + 局部不可执行说明，保留可浏览内容 |
| Stale | 显示“最后更新”但不阻断操作，必要时可刷新 |
| Conflict | 回滚乐观修改，保留用户输入，显示版本冲突与重新载入 |
| Success | 原位置状态更新；普通成功不弹 toast |

连接状态分四层呈现：Browser、Server、Worker、Journal，不合并成单个“在线”。令牌无效属于 Server 鉴权异常，提供连接配置入口；无当前 Session 时 Journal 显示 N/A，不误报断线。

## 10. 动效规范

以现有依赖（无 dnd-kit、无 motion）为前提，使用原生 HTML5 DnD + CSS transition，不新增动画库。沿用工程计划的原生 DnD 决策，阶段挂靠以 §13 统一裁定为准：

- hover/focus：120ms。
- 面板进入：160–200ms，transform + opacity。
- 第一版只承诺跨列状态流转，不提供同列持久排序；DOM 即时重排，边框/背景/透明度反馈过渡 150ms，不承诺重排位置平滑动画。
- dragstart 保留原卡片布局盒作为占位并应用 §5.2 源卡片样式，使用浏览器原生 drag preview；dragover 标记合法目标，drop 发起流转；drop/dragend/取消时清理占位与目标样式。失败即时回原列并说明原因，不为退场保留额外 DOM 生命周期。
- Tabs/选择背景：120ms。
- Button active：`scale(.98)` 或向下 1px。
- 禁止：循环渐变、页面入场编舞、数字滚动、无意义 shimmer、滚动劫持。
- `prefers-reduced-motion` 下全部退化为即时切换。

## 11. 响应式计划

Inspector 统一口径：默认 520px，可拖拽范围 480–560px，<1024px 转全屏 Sheet。

| 视口 | Inspector 模式与宽度 | 焦点与关闭 |
|---|---|---|
| ≥1280px | push，默认 520px，可拖拽范围 480–560px；主区与检查器可并行操作 | 非 modal，不锁焦、不禁用主区；打开聚焦面板标题，关闭按钮或面板内 Escape 关闭 |
| 1024–1279px | modal overlay，默认 520px，可拖拽范围 480–560px | 锁焦，背景 inert；关闭按钮或 Escape 关闭，未保存输入须确认后才丢弃 |
| <1024px | 全屏 Sheet，宽度 100vw，不可调宽，不采用独立 page 模式 | 锁焦，背景 inert；关闭按钮、Escape 或路由返回关闭，未保存输入按同一确认规则处理 |

所有模式关闭后返回原触发器；触发器已不存在时回到列表标题/最近可用任务入口。URL 直链进入时聚焦面板标题，关闭只清除选择并返回所属列表，不盲目 history.back 离开应用。跨断点切换保留草稿、选择、面板滚动与当前内部焦点，进入 modal 时确保焦点在面板内，退出 modal 时解除锁焦。

### ≥1280px

- 左侧栏 + 主工作区 + 可选右检查器同时存在。
- 看板横向滚动。

### 768–1279px

- 左侧栏折叠为图标栏或临时抽屉。
- 1024–1279px 使用上表 modal overlay；768–1023px 使用全屏 Sheet，不能继续沿用百分比覆盖面板。

### <768px

- 单栏。
- 顶栏 48px，左侧导航变 Sheet。
- 看板保持横向 scroll-snap，不把六列堆成超长纵向页面；容器 `scroll-snap-type: x proximity`，列 `scroll-snap-align: start`，列不收缩。
- Task / Run / Workspace Inspector 均为全屏 Sheet。
- 拖拽不是主要操作，“移动到…”为默认入口；所有宽度的无 hover/粗指针设备都按 §5.2 常显“···”。

看板滚动容器可聚焦且有名称，容器自身获得焦点时左右方向键按列滚动，Home/End 到两端；不截获输入框、菜单等子控件按键。Tab 到卡片或按钮时将其滚入可见区，不强制改变用户焦点。

## 12. 可访问性

- 所有状态同时有文字/图标；不得只靠颜色。
- 焦点环清晰，键盘可操作看板卡片、菜单、Tabs 和 Dialog。
- 看板拖拽必须有“移动到…”菜单等价路径；菜单触发器常在 Tab 顺序，`focus-within` 显示，`@media (hover:none)` 与粗指针常显“···”，详见 §5.2。
- 正文、micro text、placeholder 与状态 badge 以 ≥4.5:1 为验收目标，焦点/必要控件边界 ≥3:1；§3.1 候选矩阵尚不代表真实页面已达标，需实测全部实际前景/背景组合。
- 实际点击目标至少 32×32px，移动端或粗指针至少 40×40px；包含关闭按钮、普通控件与列头操作，落实 §3.4 迁移清单，不以图标大小代替命中区。
- Dialog/modal Sheet 打开时正确锁焦与返回焦点（沿用 Radix）；非 modal Inspector 不锁焦，按 §11 的模式表验收。
- 表单错误在字段下方，且通过 `aria-describedby` 关联。

## 13. 落地计划

视觉改造与工程 P0–P7 对齐，不单独搞一次“大换肤”。以下为统一裁定，旧参考文档中的阶段编号待同步，不能用其覆盖本表：

V0（token/组件状态统一，纯样式层，行为零变化）→ P0–P1 期间并行落地；V1（App Shell 视觉）→ 挂 P3 路由；V2（看板视觉）→ 挂 P4；V3（Run 时间线视觉）→ 挂 P5；V4（视觉 QA）→ P7 之后、发布前。

| 视觉阶段 | 原型与实现边界 | 依赖与验收挂靠 |
|---|---|---|
| V0 | token/现有组件状态样例与纯样式迁移；不改路由、布局结构、数据链路或业务操作 | P0–P1 期间并行落地；独立提交、独立截图/行为回归，不与模块搬迁捆绑回滚 |
| V1 | App Shell 原型与路由壳实现；既有页面只迁 token、保留页内布局 | 挂 P3 路由，依赖 P2 数据作用域与路由能力；在 P3 验收壳与存量页面 |
| V2 | 看板/详情静态原型先冻结字段，再按就绪的 Task 契约接 API | 挂 P4，依赖 V1 壳与 Task 契约；静态原型及真实交互分别验收，静态通过不等于 API 闭环通过 |
| V3 | 工作区创建、Run 启动确认、时间线与 Composer 状态实现 | 挂 P5，依赖 V2、Runtime Picker 与启动/会话契约；在 P5 验收真实链路 |
| V4 | 不新建业务界面，只对已完成界面做视觉 QA | P7 之后、发布前，依赖活动流/概览完成及全部链路就绪 |

各阶段样式提交、路由布局提交与业务接入提交分离，可独立回滚。测试基线：不引入 DOM 测试环境；V2 静态原型验收用 source-contract/手动检查。真实交互回归沿用现有浏览器 E2E，不把 source-contract 当作可访问性或视觉验证的替代。

### V0 — Token 与基础规范（P0–P1 期间并行落地，纯样式层，行为零变化）

1. 按 §2、§3.1 清单迁移全部非语义颜色，不止 zinc/hex；覆盖 badge/toast/create-dialog/cluster-page 的 emerald/amber/red/indigo/violet，以及 selection、scrollbar 和所有同类业务组件。
2. 按旧新 token 映射先拆中性 hover 与操作强调用途，再将主色改蓝；增加 light/dark 对称 token 与匹配的 color-scheme。V0 只定义并验证两主题样式，不增加主题切换/持久化逻辑，不改变当前默认选择行为。
3. 固化字号、圆角、间距、控件高度、z-index 层级；仅调整现有样式，不引入 App Shell 布局。
4. 统一 Button/Input/Select/Badge/Dialog/Sheet/Tabs/Toast 全状态与实际命中区，保留原交互逻辑。
5. 使用内部样例展示 default/hover/focus/disabled/error/loading，不新增产品路由或业务入口。

工作量单独估算（相对规模，非实测工期）：基础 token/组件迁移为中，业务组件硬编码清单迁移另计中，双主题全状态回归另计中；不能把后两项合并为一次颜色替换。每批保留独立提交与回归清单。

验收：基础组件及业务组件截图、两主题全状态、键盘焦点、命中区与 §3.1 对比度实测；同时确认旧业务链路与单屏导航行为零变化。

### V1 — App Shell（挂 P3 路由）

1. 实现 48px 顶栏、248px 可折叠侧栏、Inspector 壳。
2. 迁移现有 Workbench 与 ClusterPage，不改变业务行为；/runtimes、/cluster、项目列表、设置不在首批四张页面内，其视觉合规（token 迁移+布局不变）在 V1 App Shell 完成，覆盖清单见 §14。
3. 完成 §11 响应式壳与 Inspector 模式；“布局不变”指存量页面内部，不阻止 P3 引入共同应用壳。
4. 连接状态进入顶栏，但四层状态信息仍可展开。

验收：1440、1280、1279、1024、1023、768、390px，另验宽屏触屏设备；路由切换不跳布局；Inspector 模式、调宽、锁焦/不锁焦、关闭回焦与滚动保留正确，存量页面符合 §14 清单。

### V2 — 任务看板与详情（看板视觉挂 P4）

1. 先用静态样例数据做可交互视觉原型：六列、卡片密度、原生 HTML5 DnD 跨列反馈、选中 Inspector；不承诺同列持久排序。
2. 按 §5.2 固定共享字段契约，再连接 Task API；补齐搜索筛选、新建/编辑表单与 list 状态。
3. 完成 board/list 两视图和状态菜单等价操作。
4. 加载、空、错误、冲突、drop target 全状态一次性完成。

验收：静态原型用 source-contract/手动检查，不引入 DOM 测试环境；100 张卡片、无 Run 仍显示指派、宽屏触屏常显菜单、键盘等价操作、乐观回滚视觉正确。API 接入后另跑现有真实浏览器 E2E。

### V3 — 工作区与 Run（Run 时间线视觉挂 P5）

1. 任务工作区创建表单接入共享 Runtime Picker。
2. provisioning/failed/ready 状态统一。
3. 完成 Run 启动确认（Assignment、可编辑 Prompt、reuse/new、重复启动禁用）、四字段快照 Header、时间线、Tool Call 折叠与 Composer 确认阶段提示。
4. 在同一 Session 组件上验证“普通会话”和“Task Run”两种外壳。

验收：完整真实链路；重复启动幂等、运行中改指派不影响本次快照、reuse/new 显式选择、确认前不误报入队；长工具输出不破版；断线重连状态明确。

### V4 — 视觉 QA（P7 之后、发布前）

1. 验证 P7 已完成的 Task Activity 和项目概览注意力流，不把业务实现推迟到视觉 QA。
2. 双主题、对比度、键盘、reduced motion 审计。
3. 100 Task / 1000 Journal events 性能与滚动测试。
4. 清理所有临时硬编码颜色、任意 radius、重复 CTA 与无意义 toast。

验收：视觉回归图、Lighthouse/axe、最终真实浏览器 E2E。

## 14. 首批设计交付物

四张静态/可交互页面按 §13 对应阶段交付，各页面包含关键状态变体，不另造模糊的前置里程碑：

1. App Shell + 项目任务空状态（V1 / P3）。
2. 有数据的六列任务看板 + 选中 Task Inspector，附 list、筛选搜索、新建/编辑任务状态（V2 / P4）。
3. Task Workspace 创建 Dialog + pending/provisioning/ready/failed 结果（V3 / P5）。
4. Run 启动确认 + Agent Run 时间线：Assignment 四字段、可编辑 Prompt、reuse/new、活跃 Run 禁用启动；用户消息、Agent 文本、Tool Call running/succeeded/failed、Composer 提交中/待确认/已排队/失败状态（V3 / P5）。

这四张覆盖新增任务工作流的四个关键界面，不代表全部页面覆盖率。/runtimes、/cluster、项目列表、设置不在四张页面内，其视觉合规（token 迁移+布局不变）在 V1 App Shell 完成。

页面覆盖矩阵（复用规范也是明确验收范围，不等于另画一套布局）：

| 页面/状态 | 是否在四张内 | 复用规范与交付/验收阶段 |
|---|---|---|
| App Shell、项目任务空状态 | 第 1 张 | §4、§9、§11；V1 / P3 完成壳，任务数据状态由 V2 接入 |
| board/list、Task Inspector、搜索筛选、新建/编辑任务 | 第 2 张及变体 | §5–6、§9、§12；V2 / P4，list 共享字段契约与菜单，表单覆盖错误/冲突 |
| Task Workspace 创建与结果 | 第 3 张 | §7、§9；V3 / P5，复用 Runtime Picker 与级联可用性 |
| Run 启动、快照、时间线、Composer | 第 4 张及变体 | §8–9；V3 / P5，覆盖重复启动与运行中改指派 |
| `/runtimes` | 否 | V1 / P3 完成 token 迁移+布局不变；沿用目录/表格，Worker × Agent × Model、在线/available/仅检测文字、空/错状态与共享 Picker 语义一致 |
| `/cluster` 与 Worker 注册令牌流程 | 否 | V1 / P3 完成 token 迁移+布局不变；沿用 Worker 表格、注册 Dialog、令牌生成/复制/失效与失败重试反馈，不改注册业务行为；破坏性操作用 danger 语义 |
| 项目列表、项目设置、全局设置 | 否 | V1 / P3 完成 token 迁移+布局不变；列表/紧凑表单复用基础组件与 §9；项目设置保留独立导航入口 |
| 项目工作区列表、会话列表、既有 Workbench | 否 | V1 / P3 完成存量列表与布局迁移；工作区状态 badge、列表空/错状态复用 §9，会话内容后续复用 V3 时间线规范 |
| bootstrap / 连接配置 | 否 | 当前范围，V1 / P3 完成存量表单 token 迁移与错误提示；令牌无效归 Server，不扩展为登录系统 |
| 未知 ID、无权限、失效链接错误页 | 否 | V1 / P3，复用 §9 的就地错误与返回项目/连接配置入口，不静默跳转到另一资源 |
| Task Activity、项目概览注意力流 | 否 | P7 完成业务界面，复用 §8 连续事件流与 §9 状态；V4 在 P7 之后、发布前验收 |
| 多用户登录、身份/团队/PAT 管理 | 否 | 明确不在当前承诺内，不作为四张页面遗漏项补做 |

四张及其变体按阶段单独确认；V4 对矩阵中全部当前范围页面做双主题、输入方式、断点和真实链路复核，而不把存量页面合规推迟到 V4。