// 生成 TailGrids 对齐契约夹具：apps/web/tests/fixtures/tailgrids-parity.json
//
//   WEMUX_TAILGRIDS_SRC=/path/to/tailgrids node apps/web/scripts/tailgrids-parity/gen-fixture.mjs
//
// 参照物是 TailGrids 官方仓库 apps/docs/src/registry/core 下的源码（MIT）。夹具把
// “上游 base 类名”逐词记下来，配上我们已记录的扩展词，让 apps/web/tests/tailgrids-parity.test.mjs
// 能做严格比对：base 类名少一个词或多一个未记录的词都会失败。
//
// 为什么用逐词而不是整串：我们与上游的类名顺序偶有不同（可读性排序），但类名集合
// 必须一致。顺序不参与比对，集合必须相等。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../..')
const upstreamRoot = process.env.WEMUX_TAILGRIDS_SRC ?? '/tmp/tg/src-repo'
const REF = 'apps/docs/src/registry/core'

/** 组件 -> 上游文件、我们的文件、档位。strict 走“集合相等”，loose 只查必含词。
 *  只收录能机械抽到“单一 base 配方串”的组件（cva 第一个参数）；结构不同的
 *  组件进 requiredTokens，并在审计报告里登记偏差。 */
const MAP = {
  button: { upstream: 'button.tsx', ours: 'apps/web/src/components/ui/button.tsx', tier: 'strict' },
  input: { upstream: 'input.tsx', ours: 'apps/web/src/components/ui/input.tsx', tier: 'strict', forbidden: ['w-full'] },
  textarea: { upstream: 'text-area.tsx', ours: 'apps/web/src/components/ui/textarea.tsx', tier: 'strict' },
  badge: { upstream: 'badge.tsx', ours: 'apps/web/src/components/ui/badge.tsx', tier: 'loose' },
  separator: { upstream: 'separator.tsx', ours: 'apps/web/src/components/ui/separator.tsx', tier: 'strict' },
  skeleton: { upstream: 'skeleton.tsx', ours: 'apps/web/src/components/ui/skeleton.tsx', tier: 'strict' },
}

/** 纯语法等价归一：上游 Tailwind v4 的 `data-invalid:` 简写与 v3 的 `data-[invalid]:`
 *  指的是同一个属性选择器，不能算行为差异。归一后才拿来做集合比对。 */
const SYNTAX_ALIASES = [
  { from: /^data-\[invalid\]:/, to: 'data-invalid:' },
  { from: /^data-\[disabled\]:/, to: 'data-disabled:' },
  { from: /^data-\[state=([a-z]+)\]:/, to: 'data-$1:' },
]
const canonical = (tok) => SYNTAX_ALIASES.reduce((acc, { from, to }) => acc.replace(from, to), tok)

/** 扩展词的统一理由：我们额外加的类名，必须在夹具里留下原因。 */
const EXTENSION_NOTES = {
  'ring-focus': '可访问性钩子：基础层用它把焦点环交给组件的 ring 工具类，避免双外框。',
  'inline-flex': '见 button 的 documentedMissing：块级 flex 会撑满父宽，保留行内 flex。',
  'whitespace-nowrap': '避免按钮文案折行（应用里按钮宽度受外面容器约束）。',
  '[&>svg]:shrink-0': '图标在窄容器里不被压缩。',
  '[&>svg]:text-current': '图标颜色跟随文字色，修掉图标拿到默认色的偏差。',
}

/** 已登记的真实缺失：上游有、我们没有的类名，带原因。测试会校验缺失集合不超出这份白名单。 */
const DOCUMENTED_MISSING = {
  button: [
    {
      token: 'flex',
      reason: '上游用块级 flex，我们保留 inline-flex：块级 flex 在普通块上下文会撑满父宽，把应用里的按钮变成整行。两者在 flex/grid 容器内计算值相同（domdiff 0 差异）。',
    },
  ],
  textarea: [
    {
      token: 'data-invalid:border-input-error-focus-border',
      reason: '上游靠 Base UI 注入的 data-invalid 属性选择器；我们用 aria-invalid + state 变体覆盖 React 表单场景，两者指向同一视觉。',
    },
    {
      token: 'data-invalid:ring-input-error-focus-border/20',
      reason: '同上一项：错误态焦点环改由 aria-invalid 触发。',
    },
  ],
}

/** 结构不同的组件只锁“必须出现的上游词组”：我们换了底层实现，解剖结构不一一对应。 */
const REQUIRED_TOKENS = {
  checkbox: {
    ours: 'apps/web/src/components/ui/checkbox.tsx',
    upstream: `${REF}/checkbox.tsx`,
    tokens: ['size-4 rounded [&>svg]:size-3', 'size-5 rounded-md [&>svg]:size-3.5', 'group inline-flex select-none'],
  },
  select: {
    ours: 'apps/web/src/components/ui/select.tsx',
    upstream: `${REF}/select.tsx`,
    tokens: [
      'flex w-full items-center justify-between',
      'border-button-outline-border bg-button-outline-background',
      'bg-dropdown-background',
      'border-base-100',
      'focus:bg-dropdown-hover-background',
      'text-text-100',
    ],
  },
  toast: {
    ours: 'apps/web/src/components/ui/toast.tsx',
    upstream: `${REF}/toast.tsx`,
    tokens: ['flex max-w-112.5 min-w-96.25 items-center gap-3 rounded-lg border border-base-200', 'bg-background-100 p-3 shadow-sm', 'absolute top-1 right-1'],
  },
  tooltip: {
    ours: 'apps/web/src/components/ui/tooltip.tsx',
    upstream: `${REF}/tooltip.tsx`,
    tokens: [
      'bg-background-100',
      'hidden sm:block',
      'rounded-lg',
      'px-3 py-2',
      'text-sm',
      'font-medium',
      'text-tooltip-text',
      'shadow-md',
      'border-tooltip-border',
    ],
  },
  field: {
    ours: 'apps/web/src/components/ui/field.tsx',
    upstream: `${REF}/field.tsx`,
    tokens: ['text-sm font-medium text-input-label-text select-none cursor-pointer', 'flex min-w-0 flex-col gap-6'],
  },
  spinner: {
    ours: 'apps/web/src/components/ui/spinner.tsx',
    upstream: `${REF}/spinner/default.tsx`,
    tokens: ['viewBox={`0 0 ${size} ${size}`}', 'animate-spin'],
  },
  dialog: {
    ours: 'apps/web/src/components/ui/dialog.tsx',
    upstream: `${REF}/dialog.tsx`,
    tokens: [
      'w-full max-w-140 max-sm:max-w-[calc(100%-2rem)]',
      'rounded-xl border border-base-100 bg-background-100',
      'shadow-lg outline-none',
      'py-4 text-sm text-text-100',
      'size-7 items-center justify-center rounded-md text-text-100 opacity-70',
      '[&>svg]:size-5',
      "import { Close } from './tailgrids-icons.tsx'",
    ],
  },
  sheet: {
    ours: 'apps/web/src/components/ui/sheet.tsx',
    upstream: `${REF}/sheet.tsx`,
    tokens: [
      'flex flex-col gap-4 border-base-100 bg-background-100 p-6 shadow-lg outline-none',
      'fixed z-50 flex flex-col gap-4 border-base-100',
      'size-7 items-center justify-center rounded-md text-text-100 opacity-70',
      '[&>svg]:size-5',
      "import { Close } from './tailgrids-icons.tsx'",
    ],
  },
  dropdown: {
    ours: 'apps/web/src/components/ui/dropdown-menu.tsx',
    upstream: `${REF}/dropdown.tsx`,
    tokens: [
      'min-w-40 overflow-clip rounded-xl bg-dropdown-background shadow-md outline-none',
      'gap-3 rounded-md px-1.5 py-1',
      'focus:bg-dropdown-hover-background focus:text-title-50',
      'text-sm text-text-50',
    ],
  },
}

/** 已登记的偏差：上游写法与我们的写法不同，但计算值一致或为功能所需。
 *  测试只校验 oursSnippet 存在（锁住我们的意图）+ reason 非空，防止默默改回。 */
const DEVIATIONS = [
  {
    component: 'field',
    ours: 'apps/web/src/components/ui/field.tsx',
    upstreamSnippet: '@container/field-group flex flex-col gap-6',
    oursSnippet: 'flex min-w-0 flex-col gap-6',
    reason: '上游 FieldGroup 带容器查询前缀；我们不依赖 container query（没有按字段容器宽度切换布局的需求），保留同样的纵向排列与 gap，另加 min-w-0 防止在 flex 行里被内容撑宽。',
  },
  {
    component: 'avatar',
    ours: 'apps/web/src/components/ui/avatar.tsx',
    upstreamSnippet: 'AvatarStatus = online | offline | busy',
    oursSnippet: "away: 'bg-base-300'",
    reason: '我们在上游的三个在线状态之外补了 away（离席）；其余颜色仍用上游色阶字面量（bg-green-500 / bg-yellow-500 / bg-red-500）。',
  },
  {
    component: 'input',
    ours: 'apps/web/src/components/ui/input.tsx',
    upstreamSnippet: 'data-invalid:*',
    oursSnippet: 'aria-invalid:border-input-error-focus-border',
    reason: '上游用 Base UI 的 data-invalid，我们同时支持 Radix/原生表单的 aria-invalid；两条通路颜色一致。',
  },
  {
    component: 'tabs',
    ours: 'apps/web/src/components/ui/tabs.tsx',
    upstreamSnippet: 'TabsVertical / TabsHorizontal 两个文件',
    oursSnippet: 'direction',
    reason: '上游按方向拆成两个文件，我们合成一个组件并以 direction 区分，类名配方逐字沿用。',
  },
  {
    component: 'select',
    ours: 'apps/web/src/components/ui/select.tsx',
    upstreamSnippet: 'react-aria hidden native select + 模板',
    oursSnippet: 'SelectPrimitive.Trigger',
    reason: '上游 Select 用 react-aria 的隐藏原生控件做无障碍层，我们用 Radix trigger+listbox；触发器的视觉配方逐字沿用，解剖结构不同（像素对比里唯一的已知差异）。',
  },
  {
    component: 'dialog',
    ours: 'apps/web/src/components/ui/dialog.tsx',
    upstreamSnippet: 'AriaModal + AriaDialog + showCloseButton',
    oursSnippet: 'DialogPrimitive.Content',
    reason: '上游用 react-aria 的 Modal/Dialog 并内置 showCloseButton；我们用 Radix 的 Overlay/Content/Close 承载同一套面板与关闭按钮配方，动画改用 data-state 过渡、关闭文案改中文以匹配应用语言。',
  },
  {
    component: 'sheet',
    ours: 'apps/web/src/components/ui/sheet.tsx',
    upstreamSnippet: 'AriaModal + 固定 left/right 面板',
    oursSnippet: "side === 'left'",
    reason: '上游把抽屉宽度交给调用方（w-full + min-w-xs + sm:max-w-sm），我们在单个固定元素里用 min(88vw,20rem) 同时兼顾窄屏与桌面宽度，避免 content 撑破视口。',
  },
  {
    component: 'dropdown',
    ours: 'apps/web/src/components/ui/dropdown-menu.tsx',
    upstreamSnippet: 'react-aria Popover + Menu',
    oursSnippet: 'DropdownMenuPrimitive.Content',
    reason: '上游菜单是 react-aria Popover+Menu，我们用 Radix Content/Item；表面与条目配方逐字沿用，额外加 z-50 保证多层 portal（弹窗内菜单）的堆叠顺序。',
  },
]

/** 源码级不变量：直接读文本，锁定“不能再退回旧行为”的地方。 */
const INVARIANTS = {
  styles: [
    { path: 'apps/web/src/styles.css', contains: 'button, input, textarea, select { color: inherit; }' },
    { path: 'apps/web/src/styles.css', notContains: '* { box-sizing: border-box; border-color:' },
    { path: 'apps/web/src/styles.css', contains: '--border-color-base-200: #e5e7eb' },
    { path: 'apps/web/src/styles.css', contains: '* { box-sizing: border-box; }' },
  ],
  tokens: {
    // 值逐条取自尊门@tailgrids/cli 1.4.3 的 dist/templates/themes/{dark,default}.css。
    '--border-color-base-200': { dark: '#374151', light: '#e5e7eb' },
    '--color-background-100': { dark: '#111827', light: '#ffffff' },
    '--color-input-background': { dark: '#ffffff0d', light: '#ffffff' },
    '--color-input-primary-focus-border': { dark: '#91aeff', light: '#91aeff' },
  },
  // 图标层：浮层的关闭按钮必须用上游同一套图标路径，而不是 lucide 近似图标
  // （lucide 的 X 是 2px 描边 + 6/18 端点，上游 Close 是 1.5px + 6.75/17.25，像素对比里肉眼可见）。
  icons: [
    {
      path: 'apps/web/src/components/ui/dialog.tsx',
      contains: 'import { Close } from \'./tailgrids-icons.tsx\'',
      notContains: "from 'lucide-react'",
    },
    {
      path: 'apps/web/src/components/ui/sheet.tsx',
      contains: 'import { Close } from \'./tailgrids-icons.tsx\'',
      notContains: "from 'lucide-react'",
    },
  ],
}

/** 抽取“单一 base 配方串”：cva 第一个参数，退而求其次 cn(...) 的第一段字面量，
 *  再退为 `const XClass = '...'`。都不是就说明这个组件没有单一配方串。 */
const cvaBase = (src) => {
  const patterns = [
    /cva\(\s*['"`]([^'"`]+)['"`]/,
    /cn\(\s*\n?\s*['"`]([^'"`\n]{20,400})['"`]/,
    /const \w*[Cc]lass(?:Name)?\s*=\s*\n?\s*['"`]([^'"`]{20,400})['"`]/,
  ]
  for (const re of patterns) {
    const m = src.match(re)
    if (m) return m[1]
  }
  return null
}
const tokens = (s) => (s ? s.trim().split(/\s+/) : [])

const commit = execFileSync('git', ['-C', upstreamRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()

const fixture = {
  _source: {
    repo: 'https://github.com/TailGrids/tailgrids',
    commit,
    license: 'MIT',
    reference: `${REF} @ ${commit}`,
    themes: '@tailgrids/cli 1.4.3 dist/templates/themes/{dark,default}.css',
    generatedBy: 'apps/web/scripts/tailgrids-parity/gen-fixture.mjs',
    note: '上游源码是审计参照物，不构成本仓库的运行时依赖：我们只移植配方类名与令牌，组件实现仍是本项目自己的代码。',
    comparison: '类名按空字符切词后做集合比对；`data-[invalid]:` 与 `data-invalid:` 视为同一选择器（语法归一）。',
  },
  recipes: {},
  requiredTokens: REQUIRED_TOKENS,
  deviations: DEVIATIONS,
  invariants: INVARIANTS,
}

for (const [key, spec] of Object.entries(MAP)) {
  const upstreamSrc = readFileSync(resolve(upstreamRoot, REF, spec.upstream), 'utf8')
  const oursSrc = readFileSync(resolve(repoRoot, spec.ours), 'utf8')
  const upstreamBase = cvaBase(upstreamSrc)
  const oursBase = cvaBase(oursSrc)
  if (!upstreamBase || !oursBase) throw new Error(`无法抽取 base 类名: ${key}`)
  const upstreamTokens = tokens(upstreamBase)
  const oursTokens = tokens(oursBase).map(canonical)
  const normalizedUpstream = upstreamTokens.map(canonical)
  const extensions = oursTokens.filter((t) => !normalizedUpstream.includes(t))
  const missing = normalizedUpstream.filter((t) => !oursTokens.includes(t))
  fixture.recipes[key] = {
    upstream: `${REF}/${spec.upstream}`,
    ours: spec.ours,
    tier: spec.tier,
    baseTokens: normalizedUpstream,
    extensions,
    missing,
    documentedMissing: (DOCUMENTED_MISSING[key] ?? []).filter((d) => missing.includes(canonical(d.token))),
    extensionNotes: Object.fromEntries(extensions.filter((t) => EXTENSION_NOTES[t]).map((t) => [t, EXTENSION_NOTES[t]])),
    forbidden: spec.forbidden ?? [],
  }
}

const out = resolve(repoRoot, 'apps/web/tests/fixtures/tailgrids-parity.json')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`)
console.log(`写入 ${out}`)
for (const [key, r] of Object.entries(fixture.recipes)) {
  console.log(`${key.padEnd(10)} tier=${r.tier.padEnd(6)} 上游词=${String(r.baseTokens.length).padStart(2)} 缺失=${r.missing.length} 扩展=${r.extensions.length}`)
}