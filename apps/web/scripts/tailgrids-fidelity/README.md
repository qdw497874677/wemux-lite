# TailGrids 保真工装

用同一台浏览器、同一个视口、同一批样本，把**上游 TailGrids 原始组件**和**我们的实现**并排渲染，然后逐样本比对：像素差、计算样式差、元素几何差、解剖结构差。所有结论都来自浏览器计算值，不靠读源码猜。

工装是审计证据的生产工具，不参与 CI：

- 需要一份上游检出和一次性依赖安装（见下），不适合每次 `npm test` 都跑；
- 契约级的回归由仓库里的 `apps/web/scripts/tailgrids-parity/gen-fixture.mjs` + `apps/web/tests/tailgrids-parity.test.mjs` 承担，它零额外依赖、每次 `npm test` 都跑，盯的是上游 base 类名与令牌值有没有漂。
- 本轮审计的结论、截图与偏差登记见 `docs/acceptance/component-library-tailgrids.md`。

## 一次性准备

```bash
# 1. 上游检出（只读它的 apps/docs/src/registry/core，MIT）
git clone --depth 1 https://github.com/TailGrids/tailgrids /tmp/tg/src-repo

# 2. 生成运行时输入：上游组件副本 + 我们的样式表副本
WEMUX_TAILGRIDS_SRC=/tmp/tg/src-repo \
  node apps/web/scripts/tailgrids-fidelity/prepare.mjs

# 3. 工装自己的依赖（独立 package.json，不进产品依赖树）
npm --prefix apps/web/scripts/tailgrids-fidelity/playground install

# 4. playwright-core 也不是产品依赖：指向本地已装好的那份
export WEMUX_PLAYWRIGHT=/path/to/playwright-core/index.mjs
export WEMUX_CHROME=/path/to/chromium/chrome   # 可选，不设则用 playwright 的解析
```

## 跑一次

```bash
# 起保真页面（上游 /upstream.html、我们 /ours.html，端口 5199）
npm --prefix apps/web/scripts/tailgrids-fidelity/playground run dev

# 计算样式/结构逐元素比对（默认全量样本 × 双主题）
node apps/web/scripts/tailgrids-fidelity/domdiff.mjs --json /tmp/dom.json

# 截图 + 像素差 + 并排对比图 + 报告
node apps/web/scripts/tailgrids-fidelity/compare.mjs --only button-fill,card --out /tmp/fidelity
```

产物：

| 路径（相对 `--out`） | 内容 |
| --- | --- |
| `report.md` | 逐样本像素差占比、尺寸差、计算样式差、API 映射表 |
| `gallery.html` | 人看的入口：按主题分组的「左上游/中我们/右热力图」三栏图，带差异数字与偏差说明 |
| `compare/*.png` | 左=上游、中=我们、右=差异热力图 |
| `shots/*.png` | 两侧各自的截图（可单独看） |
| `report.json` | 上面那份报告的结构化版本 |
| `domdiff --json` | 每个元素的 path/tag/类名/样式子集差异，含「上游有我们没有」的结构差异 |
| `.out/` | 未指定 `--out` 时的默认输出目录（已 gitignore） |

## 怎么读结论

- **零差异**＝该样本在 20 个样式属性 + 尺寸 + 元素结构上完全一致。
- **有差异但要读逐条**：`domdiff` 会把每个差异的「上游类名 / 我们类名」打出来，能直接看出是配方不同还是令牌不同。
- **空舞台**＝工装错误（样本 id 写错或页面没挂载），不计入通过。
- 样本的已知结构性差异（例如上游 Tooltip 带 FloatingArrow，我们不画）登记在 `playground/src/specimens.tsx` 的 `deviations` 字段里，会随报告一起输出。

## 已知边界

- 上游 Tooltip 用 floating-ui、我们用 radix：给足上方空间后几何一致（`tooltip-open` 样本为此预留了 `headroom`），仅剩上游箭头不在我们的 DOM 里。
- 画布是受控变量：两侧底色、默认文字色、字体都写死成同一份（见 `playground/src/shell.tsx`），不测主题令牌本身；令牌一致性由 `gen-fixture.mjs` 记录的令牌值和 `styles.css` 的对照审计负责。