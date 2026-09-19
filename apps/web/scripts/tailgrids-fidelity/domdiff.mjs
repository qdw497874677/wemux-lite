// 机械化的 DOM/计算样式比对：把两侧同一份样本的渲染树拉平成「路径 + 样式子集」，
// 按路径对齐后逐条列出差异。所有结论都来自浏览器计算值，不靠读源码猜。
//
// 用法：
//   node domdiff.mjs [--only all|button-fill,input,card-plain] [--themes dark,light] [--json out.json]
//     不传 --only 时样本清单从 playground 页面的 [data-spec-index] 读（与 specimens.tsx 同源）。
// 说明：
//   - path 形如 stage/div[0]/button[1]，两侧结构一致时可对齐；
//   - 结构改变（子树增删）会在差异里以「+/- 子树」形式出现，代表解剖结构不同；
//   - 颜色统一转成 rgb() 文本，避免 var()/hex 写法差异造成假差异。
// 浏览器驱动与启动参数见 browser.mjs（playwright-core 不是仓库依赖）
import { chromium, launchOptions } from './browser.mjs'
import { writeFileSync } from 'node:fs'

const BASE = 'http://127.0.0.1:5199'
const PAGES = { upstream: '/upstream.html', ours: '/ours.html' }
const PROPS = [
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing',
  'color', 'backgroundColor', 'borderTopWidth', 'borderTopColor', 'borderTopStyle',
  'borderRadius', 'gap', 'display', 'width', 'height', 'opacity', 'boxShadow',
]

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? dflt : process.argv[i + 1]
}
const parseIds = () => {
  const multi = arg('ids', '')
  if (multi) return multi.split(',').map((s) => s.trim()).filter(Boolean)
  const only = arg('only', '')
  if (only && only !== 'all') return only.split(',').map((s) => s.trim()).filter(Boolean)
  return null
}

// 样本清单的唯一来源是 playground 的 specimens.tsx：页面把它序列化在 [data-spec-index] 里。
// 这里曾经硬编码过一份 id 列表，新增样本忘了同步就会静默漏测（spinner-dotted 漏过两轮）。
const fetchSpecIds = async () => {
  const browser = await chromium.launch(launchOptions())
  try {
    const page = await browser.newPage()
    await page.goto(`${BASE}${PAGES.ours}`, { waitUntil: 'load' })
    await page.waitForSelector('[data-spec-index]', { state: 'attached', timeout: 20000 })
    const index = JSON.parse(await page.locator('[data-spec-index]').textContent())
    return index.map((s) => s.id)
  } finally {
    await browser.close()
  }
}

const explicitIds = parseIds()
const themes = arg('themes', 'dark,light').split(',').filter(Boolean)
const ids = explicitIds ?? (await fetchSpecIds())
const outJson = arg('json', '')
const outClasses = arg('classes', '')
const classDump = []

// 冻结策略：不能再一刀切禁用 transition——react-aria 的遮罩/弹层把可见性交给 transition 驱动，
// 禁掉之后上游遮罩永远停在 opacity:0（会误判成巨大差异）。改为：让有限动画跑完、无限动画只跑一轮，
// 再等待过渡自然结束，两侧都落在静止态。
const FREEZE = "*,*::before,*::after{animation-iteration-count:1 !important;animation-duration:0.05s !important;animation-delay:0s !important;transition:none !important}"

// 颜色归一：上游令牌大量用 oklch()，我们的 @theme 是 hex/rgb，两者视觉相同但 computed
// 文本不同。这里统一用 canvas 把任意颜色文本转成 sRGB 十六进制，避免颜色空间写法造成假差异。
// 注意：SNAPSHOT 会被序列化后丢进页面执行，所有依赖必须写在函数体内。
const SNAPSHOT = (props) => {
  const COLOR_PROPS = new Set(['color', 'backgroundColor', 'borderTopColor', 'boxShadow'])
  const cv = document.createElement('canvas')
  cv.width = 1
  cv.height = 1
  const ctx = cv.getContext('2d', { willReadFrequently: true })
  const COLORS = /(oklch|oklab|rgb|rgba|hsl|hsla|lab|lch|hwb|color)\([^()]*\)|#[0-9a-fA-F]{3,8}/g
  // 白发/彩色断言都靠像素：Chromium 的 fillStyle 会把 oklch()/oklab() 原样回显，
  // 只有真画到 1×1 画布再读回来，才能得到与渲染一致的 sRGB（含 alpha）。
  const toRgba = (m) => {
    ctx.clearRect(0, 0, 1, 1)
    ctx.fillStyle = m
    ctx.fillRect(0, 0, 1, 1)
    const d = ctx.getImageData(0, 0, 1, 1).data
    return `rgba(${d[0]}, ${d[1]}, ${d[2]}, ${Math.round((d[3] / 255) * 100) / 100})`
  }
  const norm = (v) => (typeof v === 'string' && v.includes('(') ? v.replace(COLORS, toRgba) : v)
  const stage = document.querySelector('[data-stage]')
  if (!stage) return []
  const rows = []
  const walk = (el, path) => {
    const cs = getComputedStyle(el)
    // 视觉隐藏元素（sr-only：absolute + 1×1）不参与可见对比：它只承载状态，
    // 两侧的隐藏实现不同会刷出一堆假差异。
    const hidden = cs.position === 'absolute' && parseFloat(cs.width) <= 1 && parseFloat(cs.height) <= 1
    const style = {}
    for (const p of props) style[p] = COLOR_PROPS.has(p) ? norm(cs[p]) : cs[p]
    if (!hidden) {
      rows.push({
        path,
        tag: el.tagName.toLowerCase(),
        cls: (el.getAttribute('class') || '').replace(/\s+/g, ' ').trim(),
        style,
      })
    } else {
      // 隐藏元素整棵子树都跳过，两侧保持同一套路径编号
      return
    }
    const counts = {}
    for (const child of el.children) {
      const tag = child.tagName.toLowerCase()
      counts[tag] = (counts[tag] || 0) + 1
      walk(child, `${path}/${tag}[${counts[tag] - 1}]`)
    }
  }
  walk(stage, 'stage')
  return rows
}

const STYLE_KEYS = new Set(['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'color', 'backgroundColor', 'borderTopWidth', 'borderTopColor', 'borderTopStyle', 'borderRadius', 'gap', 'display', 'width', 'height', 'opacity', 'boxShadow'])
// 只报告「可见差异」：字重/字号/内外边距/底色/边框/圆角/gap/宽高/文字色
const isEmptyish = (v) => v === '0px' || v === 'normal' || v === 'none' || v === 'rgba(0, 0, 0, 0)' || v === 'auto' || v === '' ||
  v === 'block' || v === 'static' || v === '0' || v === 'visible' || v === 'start' || v === 'nowrap'

const results = []
for (const theme of themes) {
  for (const id of ids) {
    const sides = {}
    for (const [side, url] of Object.entries(PAGES)) {
      sides[side] = { url, id }
    }
    const snaps = {}
    // 每个主题只开一次浏览器，两侧共用，减少启动噪声
    const browser = await chromium.launch(launchOptions({ args: ['--force-device-scale-factor=1'] }))
    for (const side of Object.keys(PAGES)) {
      const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1, colorScheme: theme })
      // 上游主题自带 Google Fonts 的 @import：两侧一起阻断，字体回退到工装指定的同一套本机字体，
      // 免得网络竞态被算成组件差异
      await ctx.route('**fonts.googleapis.com/**', (r) => r.abort())
      await ctx.route('**fonts.gstatic.com/**', (r) => r.abort())
      const page = await ctx.newPage()
      await page.goto(`${BASE}${PAGES[side]}?only=${id}&scheme=${theme}`, { waitUntil: 'load' })
      // 页面挂载完成信号：DOM 里出现舞台元素（缺它时快照会拿空数组，误报“空舞台”）
      await page.waitForSelector('[data-stage]', { timeout: 10000 }).catch(() => {})
      // 冻结动画与过渡：脉动/旋转的相位差、过渡中间态都会被误判成样式差异
      // （skeleton 的 opacity、spinner 的 transition-all duration-700 都这样飘出过假差异）。
      // 关掉 transition 会让元素直接落到终态，正是我们要比的那个状态。
      await page.addStyleTag({ content: FREEZE })
      await page.waitForTimeout(600)
      let rows = await page.evaluate(SNAPSHOT, PROPS)
      if (!rows.length) {
        // 极端情况（首次编译慢）重载一次再取，避免把渲染延迟当成空舞台
        await page.reload({ waitUntil: 'load' })
        await page.waitForSelector('[data-stage]', { timeout: 10000 }).catch(() => {})
        await page.addStyleTag({ content: FREEZE })
        await page.waitForTimeout(800)
        rows = await page.evaluate(SNAPSHOT, PROPS)
      }
      snaps[side] = rows
      await ctx.close()
    }
    await browser.close()
    // 空舞台守卫：样本 id 打错、app 抛错（unknown specimen）都会得到
    // “两侧都没内容”，此时逐条比对必然 0 差异。必须显式报错，不能计为通过。
    if (!snaps.upstream.length || !snaps.ours.length) {
      results.push({ theme, id, diffCount: -1, empty: true, diffs: [] })
      continue
    }
    const a = snaps.upstream
    const b = snaps.ours
    if (outClasses) {
      classDump.push({ theme, id, upstream: a.map((r) => ({ path: r.path, tag: r.tag, cls: r.cls })), ours: b.map((r) => ({ path: r.path, tag: r.tag, cls: r.cls })) })
    }
    const byPathB = new Map(b.map((r) => [r.path, r]))
    const diffs = []
    const seen = new Set()
    for (const rowA of a) {
      seen.add(rowA.path)
      const rowB = byPathB.get(rowA.path)
      if (!rowB) {
        diffs.push({ kind: 'missing-in-ours', path: rowA.path, tag: rowA.tag })
        continue
      }
      if (rowA.tag !== rowB.tag) {
        diffs.push({ kind: 'tag', path: rowA.path, upstream: rowA.tag, ours: rowB.tag })
        continue
      }
      const props = {}
      for (const p of STYLE_KEYS) {
        const va = rowA.style[p]
        const vb = rowB.style[p]
        if (va === vb) continue
        // 双方都是空值语义（0/none/normal）时不算差异
        if (isEmptyish(va) && isEmptyish(vb)) continue
        props[p] = { upstream: va, ours: vb }
      }
      // 无边框的元素上 border-color 不可见：我们的 `* { border-color }` 与上游
      // preflight 的 currentColor 不同，但那属于基础层差异，不代表组件差异。
      if (props.borderTopColor && rowA.style.borderTopWidth === '0px' && rowB.style.borderTopWidth === '0px') delete props.borderTopColor
      if (Object.keys(props).length) diffs.push({ kind: 'style', path: rowA.path, tag: rowA.tag, clsUpstream: rowA.cls, clsOurs: rowB.cls, props })
    }
    for (const rowB of b) if (!seen.has(rowB.path)) diffs.push({ kind: 'extra-in-ours', path: rowB.path, tag: rowB.tag, cls: rowB.cls })
    results.push({ theme, id, diffCount: diffs.length, diffs })
  }
}

const lines = []
let empties = 0
let clean = 0
for (const r of results) {
  if (r.empty) {
    empties++
    lines.push(`## ${r.id} [${r.theme}] -- !! 舞台为空：两侧都没取到样本元素（harness 错误，不计入通过）`)
    lines.push('')
    continue
  }
  if (r.diffCount === 0) clean++
  lines.push(`## ${r.id} [${r.theme}] -- ${r.diffCount} 处计算样式/结构差异`)
  for (const d of r.diffs) {
    if (d.kind === 'style') {
      const parts = Object.entries(d.props).map(([p, v]) => `${p}: 上游 ${v.upstream} → 我们 ${v.ours}`)
      lines.push(`  - ${d.path} <${d.tag}>  ${parts.join(' | ')}`)
      lines.push(`      上游类名: ${d.clsUpstream}`)
      lines.push(`      我们类名: ${d.clsOurs}`)
    } else if (d.kind === 'missing-in-ours') {
      lines.push(`  - ${d.path} <${d.tag}> 上游有、我们没有（解剖结构差异）`)
    } else if (d.kind === 'extra-in-ours') {
      lines.push(`  - ${d.path} <${d.tag}> 我们额外多出的元素: ${d.cls}`)
    } else {
      lines.push(`  - ${d.path} 标签不同: 上游 <${d.upstream}> vs 我们 <${d.ours}>`)
    }
  }
  lines.push('')
}
lines.push(`统计：${results.length} 次比对（${ids.length} 样本 x ${themes.length} 主题）—— 零差异 ${clean}，有差异 ${results.length - clean - empties}，空舞台 ${empties}`)
const text = lines.join('\n')
console.log(text)
if (outJson) writeFileSync(outJson, JSON.stringify(results, null, 2))
if (outClasses) writeFileSync(outClasses, JSON.stringify(classDump, null, 2))