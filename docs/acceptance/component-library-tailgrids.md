# 组件库采纳 TailGrids 与 /components 展示页重做

日期：2026-09-17（含同日第二轮「与上游逐项对齐」的复审结论）
范围：`apps/web`（设计令牌、`components/ui` 基础组件、新增展示组件、`/components` 展示页、契约回归测试、可重复的保真审计工装）

## 目标

把 `/components` 从「源码片段清单」改成真实组件展示页，并统一视觉来源：基础组件按 TailGrids 的组件集与样式令牌实现，展示页只列真实存在的组件与令牌。

第二轮复审的目标（用户要求「参考目标，重新审查我们实现的是不是一致，不用考虑我们原有的主题」）是把「像上游」从口头判断变成可复算的证据：同一台浏览器、同一套样本、同一份令牌，逐组件比对像素、计算样式、几何与解剖结构，并把无法消除的差异逐条登记。

## 来源与许可

- 组件与令牌样式取自 TailGrids（MIT）：
  - 契约参照物是 commit `b54636bac9fa6ab64cf5eff388c3de07b6adc515` 的 `apps/docs/src/registry/core`，题录写在 `apps/web/tests/fixtures/tailgrids-parity.json` 的 `_source` 里；
  - 主题令牌来自 `@tailgrids/cli 1.4.3` 的 `dist/templates/themes/{dark,default}.css`。
- 我们只移植配方类名与令牌值，组件实现仍是本项目自己的代码，不引入任何运行时依赖，也不复制其演示页代码。
- 令牌在 `apps/web/src/styles.css` 中落位为 Wemux 语义层：TailGrids 的原始名（`--color-primary-*`、`--border-color-base-*`、`--color-input-*` 等）保留原值，另有一批 Wemux 语义别名（`--color-surface`、`--color-text-100` 等）指向同一批变量，存量页面不改类名即可获得新配色。
- 深色仍是默认；亮色通过既有自动切换覆盖同一批变量的值。

## 交付内容

- `apps/web/src/styles.css`：令牌层重写（上游原始名与 Wemux 语义别名共存），并把全局基础规则收进 `@layer base`（见下）。
- `apps/web/src/components/ui/*`：`button/input/textarea/badge/dialog/sheet/dropdown-menu/select/tabs/tooltip/toast` 按 TailGrids 规格重写内部样式；新增 `alert/avatar/card/checkbox/field/separator/skeleton/spinner/ai-prompt-input`；新增 `tailgrids-icons.tsx`（`Close/Check/ChevronDown` 等上游图标，浮层关闭图标不再用 lucide）。
- `apps/web/src/components/task-board/`：`task-status`、`task-card`、`task-column`（任务工作流组件的真实实现）。
- `apps/web/src/components/component-library.tsx`：展示页重写，8 个分区（操作、表单、反馈、容器、导航、浮层、令牌、任务工作流），左侧为就地目录导航，令牌区展示 16 个色卡。
- 验收入口（都可重复执行）：
  - `apps/web/scripts/verify-component-library.mjs`：真实浏览器打开 `/components`，断言分区、锚点、色卡、交互与移动端溢出；
  - `apps/web/tests/tailgrids-parity.test.mjs` + `apps/web/tests/fixtures/tailgrids-parity.json`（生成器 `apps/web/scripts/tailgrids-parity/gen-fixture.mjs`）：零额外依赖的契约回归，盯上游 base 类名、令牌值、图标来源与层叠写法有没有漂；
  - `apps/web/scripts/tailgrids-fidelity/`：把「上游原始组件」与「我们的实现」并排渲染的保真审计工装（用法见该目录 README），产出像素差、计算样式差、几何差与解剖结构差。

## 验收

### 契约回归

```bash
npm run typecheck
npm test --workspace @wemux/web
npm run build --workspace @wemux/web
```

实测：

- `npm run typecheck`：退出码 0。
- `npm test --workspace @wemux/web`：**145 通过 / 0 失败**（4.1s）。
- `npm run build --workspace @wemux/web`：构建通过（仅 chunk 体积警告）。

### 展示页的真实浏览器验收

```bash
# 需要先有静态服务：vite preview 指向 apps/web/dist
WEMUX_VERIFY_BASE=http://127.0.0.1:4175 node apps/web/scripts/verify-component-library.mjs
```

实测：h1「组件库」1 个、分区 8 个、目录链接 8 个（无缺失锚点）、色卡 16 个、任务列 2 个；交互断言 `dialog/dialogClosed/sheet/bottomSheet/menu/toast/tabs` 全部 `true`；移动端溢出 0px；失败请求 0、控制台错误 0。脚本把截图（深色整页、亮色、移动宽度、浮层）与结论 JSON 写到 `/tmp/wemux-component-library/`；本轮这一份另存了一份在 `.scratch/component-library-fidelity/components-page/`（`.scratch/` 不入库）。

### 与上游逐项对齐的保真审计（第二轮）

方法：把上游原始组件（同一份 `registry/core` 检出，经 `prepare.mjs` 复制进工装）和我们 `apps/web` 的组件放进同一个 dev server，用同一台 Chromium、同一视口（1440x900）、同一字体、同一批样本渲染，再逐样本取浏览器计算值与截图比对。两侧的页面底色与默认文字色被显式写死成同一份，避免把主题底色算成组件差异。

```bash
# 一次性准备见 apps/web/scripts/tailgrids-fidelity/README.md
npm --prefix apps/web/scripts/tailgrids-fidelity/playground run dev
node apps/web/scripts/tailgrids-fidelity/domdiff.mjs --json /tmp/dom.json      # 计算样式/几何/解剖结构
node apps/web/scripts/tailgrids-fidelity/compare.mjs --out /tmp/fidelity      # 截图 + 像素差 + 并排图 + 画廊
```

| 口径 | 样本量 | 结果 |
| --- | --- | --- |
| 计算样式 / 几何 / 解剖结构（`domdiff`） | 29 样本 × 双主题 = 58 次 | 零差异 **56**，有差异 **2**，空舞台 **0** |
| 像素差（`compare`） | 58 行 | 尺寸不一致 **0**，计算样式差 **0**，最大并集差异 **tooltip-open 0.23%（深）/ 0.21%（亮）**，其余全部 0.00% |
| 令牌值（上游主题声明逐条对照） | 深色 318 条 / 亮色 315 条 | 缺失 21 条，值不同 1 条（两侧同一条） |

逐条说明：

- 唯一的解剖结构差异是 `select-closed`（深/亮各 17 处）：上游 Select 用 react-aria 的隐藏原生 `select` + 模板层做无障碍，我们用 Radix trigger + listbox，所以「上游有、我们没有」的元素全部出自那层；两侧没有任何计算样式差异，像素差 0.00%。
- 唯一的像素差异是 `tooltip-open`：上游 Tooltip 用 floating-ui，气泡下沿带一个 `FloatingArrow`；我们不渲染箭头（见「有意偏差」）。
- 令牌缺失的 21 条是我们没有采用的营销页与仪表盘令牌（`--color-chart-line`、`--color-bento-*`、`--color-hero-*`、`--color-ai-sidebar-*`、`--drop-shadow-theme-3xl`），展示页与产品页面都不使用；值不同的 1 条是 `--font-sans`：上游写 `"DM Sans", sans-serif`，我们多一个 `"DM Sans Variable"` 回退（自托管可变字体），计算后的字族一致。
- 截图对比产物：`report.md`（逐样本数字）、`gallery.html`（按主题分组的「左上游 / 中我们 / 右差异热力图」，带尺寸、样式差与偏差说明）、`compare/*.png`、`shots/*.png`。本轮那一份（含 `dom.json` 与两份运行日志）留在 `.scratch/component-library-fidelity/`，`.scratch/` 不入库，可随时用上面的命令重放。

## 第二轮修掉的真差异

按「根因 → 修法」列出。所有条目都有上表量化口径的对照结果支撑（修前差异、修后归零或收敛）。

- **层叠顺序错了（主因）**：`styles.css` 的全局基础规则（`button, input, textarea, select`、滚动条、`:focus-visible` 等）写在 `@theme` 之外，特异性压过组件类，导致组件配方在浏览器里失效。修法：整段收进 `@layer base`，组件工具类重新生效。
- **亮色边界令牌取值不同**：`--border-color-base-200` 亮色原本取 gray-300（`#d1d5db`），上游是 gray-200（`#e5e7eb`）。修法：改为上游值；`* { box-sizing: border-box; border-color: ... }` 拆成不带 `border-color` 的写法，避免全局预置边框色。
- **Button**：尺寸从固定高度改为上游的 padding 驱动（`px-3.5 py-2.5 text-xs|text-sm` 与 `[&>svg]:size-5`），禁用态走令牌色，不再叠一层全局 55% 透明度。
- **Input / Textarea**：基础类与上游逐字一致（含 `max-w-full`，不含 `w-full`），补齐 `aria-invalid` 通路的错误/成功边框与焦点环；调用点自己写 `w-full`，宽度归布局决定。
- **Field**：`Label` 用 `text-sm font-medium text-input-label-text`，`Field` 用 `flex min-w-0 flex-col gap-6`（对齐上游 `FieldGroup`），保留 `FieldError/FieldDescription` 作为可访问性补充。
- **Checkbox**：勾选指示器的尺寸、配色与对齐按上游规格，去掉只在我们这边出现的优先级写法与多余盒模型。
- **Select**：触发器配方对齐上游（补回指示图标位置、去掉额外包裹层），下拉面板表面令牌对齐。
- **Dialog / Sheet**：面板、标题、描述、页脚的间距与圆角按上游；关闭按钮图标换成 `tailgrids-icons` 的 `Close`（不再 lucide）；打开时焦点落面板容器而不是第一个可聚焦元素，消除关闭按钮上多出来的 3px 焦点环。
- **DropdownMenu**：去掉多余的 `border`/`p-1`，菜单项配方对齐上游。
- **Separator**：上游是 1px 背景色条而非边框（`bg-(--border-color-base-200)` + `h-[1px]`），类名逐字沿用；像素差从 3.32% 归零。
- **Spinner**：改为自绘 SVG（含 dotted / dotted-round 两个变体），颜色走 `--color-primary-500` 等令牌，不再用 lucide 的 `Loader2`。
- **Tabs**：重写为方向感知组件（`default/minimal/plain` × `vertical/horizontal`），类名配方逐字沿用上游，上游按方向拆两个文件的差异以 `direction` 属性吸收。
- **Toast / Tooltip / Avatar / Alert / Card**：表面令牌、图标颜色、圆角与状态点颜色按上游（状态点用 `--color-success-500` / 上游色阶字面量）。

## 与 TailGrids 的有意偏差

这些差异是设计选择，不是遗漏；`apps/web/tests/fixtures/tailgrids-parity.json` 的 `deviations` 字段逐条登记了「上游片段 / 我们的片段 / 原因」，测试会检查它们仍然成立。

- **Field**：上游 `FieldGroup` 带容器查询前缀（`@container/field-group`）；我们不依赖 container query，保留同样的纵向排列与 `gap-6`，另加 `min-w-0`。
- **Avatar**：在上游三个在线状态之外补 `away`（离席）；其余颜色仍用上游色阶字面量。
- **Input**：上游用 Base UI 的 `data-invalid`；我们同时支持 Radix/原生表单的 `aria-invalid`，两条通路颜色一致。
- **Tabs**：上游按方向拆两个文件，我们合成一个组件用 `direction` 区分。
- **Select**：上游用 react-aria 的隐藏原生控件做无障碍层，我们用 Radix trigger + listbox；触发器视觉配方逐字沿用，解剖结构不同（上表里的唯一结构差异）。
- **Dialog / Sheet**：上游用 react-aria 的 Modal/Dialog 并内置关闭按钮；我们用 Radix 的 Overlay/Content/Close 承载同一套面板与关闭按钮配方，动画改用 `data-state` 过渡，关闭文案改中文以匹配应用语言。
- **DropdownMenu**：上游是 react-aria Popover + Menu，我们用 Radix Content/Item；表面与条目配方逐字沿用，额外加 `z-50` 保证多层 portal 的堆叠顺序。
- **Tooltip 不画箭头**：上游气泡下沿有 floating-ui 的 `FloatingArrow`，它自身渲染成 18x18 视图里的一条约 5px 窄条，深色下与气泡同色、亮色下才隐约可见；用 radix 的 Arrow 复刻会把气泡再推开 18px，比不画更偏离观感。因此登记为有意偏差，代价是 `tooltip-open` 保留 0.2% 的像素差。
- **禁用态不叠二次透明度**：带 `--color-button-*-disabled-*` 令牌的按钮（`default/destructive/success` 的 fill 与 outline、`variant="outline"`）不叠加全局 `:disabled` 的 55% 透明度，避免令牌色被二次减淡；`ghost`、`secondary` 仍依赖全局透明度表达禁用。
- **展示页卡片网格**使用 `align-items: start`，卡片贴合内容高度。
- **保留 Wemux 旧类名别名**（`bg-surface`、`text-text-100` 等）指向同一批令牌，存量页面不改类名即可换装。

## 已知边界

- 保真工装是审计证据的生产工具，不参与 CI：它需要一份上游检出、一次性依赖安装与一台浏览器。契约级的回归由 `tailgrids-parity.test.mjs` 承担（零额外依赖，每次 `npm test` 都跑），两层互补。
- 工装的画布是受控变量：两侧底色、默认文字色、字体都写死成同一份，它测的是组件配方，不测主题令牌本身；令牌一致性由 fixture 里记录的令牌值与 `styles.css` 的对照审计负责。
- 上游未采用的 21 条营销页令牌不会因为「对齐」而补进主题；需要用时再按上游原值添加。

## 已知与本改动无关的失败

本沙箱内 `npm test` 全量运行的结果是 **tests 432 / pass 420 / fail 5 / cancelled 2 / skipped 5**（71.6s）。失败与取消的 7 个用例全部属于 `apps/server` 与 `apps/e2e`，都是真实 CLI / 多进程 / 计时相关的集成路径：

- `apps/e2e/full-stack.test.ts`：`real Server and Worker CLI complete the project-to-agent conversation loop`（45s 超时）
- `apps/server/src/test/cluster-stages.test.ts`：`workspace reprovision: only pending/failed, re-issues provision command deliverable to the worker`
- `apps/server/src/test/server.test.ts`：`HTTP + SQLite + Worker WS + SSE durable end-to-end loop`、`reject unauthorized, malformed and cross-worker protocol writes; atomic enrollment`
- `apps/server/src/test/task-assignment-http.test.ts`：`HTTP retry requestIds matching Object prototype names create and reuse string commandIds`
- `apps/server/src/test/task-runs.test.ts`：`real WS contradictory terminal Journal cannot regress an undeleted cancelled Run`、`real gateway hello reconnect and disk server restart redeliver create/enqueue IDs after lost ACK`

上一轮把 `apps/worker`、`scripts` 的未提交改动 stash 后同样为 `fail 5`，且失败集合在多次运行间变化，属既有的沙箱时序与真实 CLI 依赖问题；本次改动只涉及 `apps/web`，未触碰这些路径。同理，`apps/server` 与 `apps/worker` 的工作区里另有前序未提交改动，不在本次交付范围内。