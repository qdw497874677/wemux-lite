#!/usr/bin/env node
/**
 * 组件保真度对比：上游 TailGrids 原始组件 vs Wemux 实现。
 * 同一 Chromium、同一视口、同一批样本，逐样本截图 + 计算样式 + 像素差异，
 * 输出并排对比图 / 热力图 / JSON / Markdown 报告。
 *
 * 用法: node compare.mjs [--base http://127.0.0.1:5199] [--out .out] [--only button-fill,card]
 * 前置: node prepare.mjs + 在 playground 里起 vite（见 README.md）
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, launchOptions } from './browser.mjs'

const here = dirname(fileURLToPath(import.meta.url))

const argv = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : dflt
}
const BASE = arg('--base', 'http://127.0.0.1:5199')
const OUT = resolve(arg('--out', join(here, '.out')))
const ONLY = arg('--only', null)
const ONLY_LIST = ONLY ? ONLY.split(',').map((s) => s.trim()).filter(Boolean) : null
const THEMES = ['dark', 'light']
const PAGES = { upstream: '/upstream.html', ours: '/ours.html' }
const STYLE_PROPS = [
  'width', 'height', 'backgroundColor', 'color', 'borderTopColor', 'borderTopWidth', 'borderRadius',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'marginTop', 'gap',
  'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'boxShadow', 'opacity',
]

mkdirSync(join(OUT, 'shots'), { recursive: true })
mkdirSync(join(OUT, 'compare'), { recursive: true })

const browser = await chromium.launch(launchOptions({
  args: ['--force-color-profile=srgb', '--font-render-hinting=none', '--disable-lcd-text', '--antialiased-text=false'],
}))

async function capture(side, theme, spec) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: theme,
    locale: 'zh-CN',
    reducedMotion: 'reduce',
  })
  // 上游主题自带 Google Fonts 的 @import：两侧一起阻断，字体回退到工装指定的同一套本机字体，
  // 免得网络竞态被算成组件差异
  await ctx.route('**fonts.googleapis.com/**', (r) => r.abort())
  await ctx.route('**fonts.gstatic.com/**', (r) => r.abort())
  const page = await ctx.newPage()
  // vite dev server 会在预构建依赖时重载模块图，页面偶尔会白屏（React 根本没起来）。
  // 重试一次比把「没起来」当成差异要诚实，也不至于让整轮审计颗粒无收。
  for (let attempt = 1; ; attempt += 1) {
    try {
      await page.goto(`${BASE}${PAGES[side]}?only=${spec.id}&scheme=${theme}`, { waitUntil: 'load' })
      await page.waitForSelector('[data-ready]', { state: 'attached', timeout: 20000 })
      break
    } catch (e) {
      if (attempt >= 2) throw e
      console.warn(`  重试 ${side}/${theme}/${spec.id}：${e.message.split('\n')[0]}`)
      await page.waitForTimeout(1000)
    }
  }
  await page.evaluate(() => document.fonts.ready)
  // 冻结动画与过渡，保证截图与计算样式都看终态（否则相位差与过渡中间态会被当成差异）
  await page.addStyleTag({ content: '*,*::before,*::after{animation-iteration-count:1 !important;animation-duration:0.05s !important;animation-delay:0s !important;transition:none !important}' })
  await page.waitForTimeout(600)

  const shotPath = join(OUT, 'shots', `${theme}-${spec.id}-${side}.png`)
  // 浮层样本：截面板本身（元素裁剪），而不是视口区域。
  // 理由：遮罩是否由组件内置、以及 floating-ui/radix 的定位与偏移不同，
  // 都会让“同一样本”落在不同坐标上；面板级比较才是组件表面的比较。
  let panelShot = false
  for (const sel of spec.panel ?? []) {
    const el = page.locator(sel).first()
    if (await el.count() === 0) continue
    if (!(await el.isVisible().catch(() => false))) continue
    await el.screenshot({ path: shotPath })
    panelShot = true
    break
  }
  if (panelShot) {
    // 已截面板
  } else if (spec.overlay) {
    await page.screenshot({ path: shotPath, clip: spec.clip })
  } else {
    await page.locator(`[data-fidelity="${spec.id}"]`).screenshot({ path: shotPath })
  }

  const styles = await page.evaluate(({ id, props }) => {
    const frame = document.querySelector(`[data-fidelity="${id}"] [data-fidelity-body]`)
    const el = frame?.firstElementChild
    if (!el) return null
    const cs = getComputedStyle(el)
    const out = {}
    for (const p of props) out[p] = cs[p]
    const box = el.getBoundingClientRect()
    out.childCount = frame.children.length
    out.box = { w: Math.round(box.width), h: Math.round(box.height) }
    return out
  }, { id: spec.id, props: STYLE_PROPS })

  await ctx.close()
  return { styles, shotPath }
}

await mkdirSync(OUT, { recursive: true })
const ctx0 = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await ctx0.route('**fonts.googleapis.com/**', (r) => r.abort())
await ctx0.route('**fonts.gstatic.com/**', (r) => r.abort())
const probe = await ctx0.newPage()
await probe.goto(`${BASE}${PAGES.ours}`, { waitUntil: 'load' })
await probe.waitForSelector('[data-ready]', { state: 'attached' })
const specIndex = JSON.parse(await probe.locator('[data-spec-index]').textContent())
const mapping = JSON.parse(await probe.locator('[data-kit-mapping]').textContent())
await ctx0.close()

const proc = await (await browser.newContext()).newPage()
await proc.goto('about:blank')

const results = []
for (const theme of THEMES) {
  for (const spec of specIndex) {
    if (ONLY_LIST && !ONLY_LIST.some((needle) => spec.id.includes(needle))) continue
    const up = await capture('upstream', theme, spec)
    const ours = await capture('ours', theme, spec)

    const toDataUrl = (p) => `data:image/png;base64,${readFileSync(p).toString('base64')}`
    const a = toDataUrl(up.shotPath)
    const b = toDataUrl(ours.shotPath)

    const diff = await proc.evaluate(async ({ a, b, thresh }) => {
      const load = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src })
      const [ia, ib] = await Promise.all([load(a), load(b)])
      const w = Math.max(ia.width, ib.width)
      const h = Math.max(ia.height, ib.height)
      const draw = (img) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.drawImage(img, 0, 0); return x.getImageData(0, 0, w, h) }
      const A = draw(ia), B = draw(ib)
      const heat = document.createElement('canvas'); heat.width = w; heat.height = h
      const hx = heat.getContext('2d'); hx.drawImage(ib, 0, 0)
      const out = hx.getImageData(0, 0, w, h)
      let diffPx = 0, sum = 0
      const cw = Math.min(ia.width, ib.width), ch = Math.min(ia.height, ib.height)
      let commonDiff = 0
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4
          const d = Math.abs(A.data[i] - B.data[i]) + Math.abs(A.data[i + 1] - B.data[i + 1]) + Math.abs(A.data[i + 2] - B.data[i + 2]) + Math.abs(A.data[i + 3] - B.data[i + 3])
          sum += d
          if (d > thresh) {
            diffPx++
            if (x < cw && y < ch) commonDiff++
            out.data[i] = 255; out.data[i + 1] = 0; out.data[i + 2] = 0; out.data[i + 3] = 255
          }
        }
      }
      hx.putImageData(out, 0, 0)
      const gap = 12
      const comp = document.createElement('canvas')
      comp.width = w * 3 + gap * 2
      comp.height = h
      const cx = comp.getContext('2d')
      cx.fillStyle = '#1b1b1b'; cx.fillRect(0, 0, comp.width, comp.height)
      cx.drawImage(ia, 0, 0); cx.drawImage(ib, w + gap, 0); cx.drawImage(heat, w * 2 + gap * 2, 0)
      return {
        upSize: { w: ia.width, h: ia.height },
        oursSize: { w: ib.width, h: ib.height },
        sizeMatch: ia.width === ib.width && ia.height === ib.height,
        diffPx, total: w * h, diffRatio: diffPx / (w * h), meanDelta: sum / (w * h * 4),
        commonDiffRatio: commonDiff / (cw * ch),
        composite: comp.toDataURL('image/png'),
      }
    }, { a, b, thresh: 12 })

    writeFileSync(join(OUT, 'compare', `${theme}-${spec.id}.png`), Buffer.from(diff.composite.split(',')[1], 'base64'))

    const styleDelta = {}
    if (up.styles && ours.styles) {
      for (const p of STYLE_PROPS) {
        if (up.styles[p] !== ours.styles[p]) styleDelta[p] = { upstream: up.styles[p], ours: ours.styles[p] }
      }
      if (up.styles.box.h !== ours.styles.box.h || up.styles.box.w !== ours.styles.box.w) {
        styleDelta.box = { upstream: up.styles.box, ours: ours.styles.box }
      }
    }

    results.push({
      id: spec.id, name: spec.name, group: spec.group, theme, overlay: spec.overlay,
      deviations: spec.deviations,
      upSize: diff.upSize, oursSize: diff.oursSize, sizeMatch: diff.sizeMatch,
      diffRatio: +(diff.diffRatio * 100).toFixed(2),
      commonDiffRatio: +(diff.commonDiffRatio * 100).toFixed(2),
      meanDelta: +diff.meanDelta.toFixed(2),
      styleDelta,
    })
    process.stdout.write(`${theme.padEnd(5)} ${spec.id.padEnd(18)} ${String((diff.diffRatio * 100).toFixed(1)).padStart(5)}%  common ${String((diff.commonDiffRatio * 100).toFixed(1)).padStart(5)}%  ${diff.upSize.w}x${diff.upSize.h} vs ${diff.oursSize.w}x${diff.oursSize.h}${diff.sizeMatch ? '' : '  [size!=]'}  styleΔ=${Object.keys(styleDelta).length}\n`)
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  base: BASE,
  viewport: { width: 1440, height: 900 },
  notes: [
    '两侧样本清单、结构、容器宽度完全一致。',
    '画布（页面底色与默认文字色）是受控变量：dark 固定 #111827，light 固定 #ffffff，两侧写死同一个常量，不参与组件比对。',
    '字体被强制归一为本机 DejaVu Sans，避免 webfont 差异污染判定。',
    'diffRatio 按并集画布计算（尺寸不同也算差异），commonDiffRatio 只统计两者重叠区域。',
    'overlay 样本按固定 clip 截视口，placement 已归一（toast 尤其）。',
  ],
  mapping,
  results,
}
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))

const worst = [...results].sort((a, b) => b.diffRatio - a.diffRatio)
const md = []
md.push('# 组件保真度对比（TailGrids 原始组件 vs Wemux 实现）')
md.push('')
md.push(`生成时间: ${report.generatedAt}`)
md.push('')
md.push('- 同一 Chromium (playwright-core/chromium-1228)、视口 1440x900、deviceScaleFactor 1。')
md.push('- 字体强制归一为本机 DejaVu Sans，排除 webfont 差异。')
md.push('- `并集差异%` 把尺寸不一致也算作差异；`重叠差异%` 只看两者共同区域，用于判断"颜色/圆角/间距"级别的偏差。')
md.push('')
md.push('## 差异最大的样本')
md.push('')
md.push('| 样本 | 主题 | 并集差异% | 重叠差异% | 上游尺寸 | 我们尺寸 | 结构差异字段 |')
md.push('| --- | --- | --- | --- | --- | --- | --- |')
for (const r of worst.slice(0, 20)) {
  md.push(`| ${r.id} | ${r.theme} | ${r.diffRatio} | ${r.commonDiffRatio} | ${r.upSize.w}x${r.upSize.h} | ${r.oursSize.w}x${r.oursSize.h} | ${Object.keys(r.styleDelta).join(', ') || '无'} |`)
}
md.push('')
md.push('## 逐样本明细（dark）')
md.push('')
for (const r of results.filter((x) => x.theme === 'dark')) {
  md.push(`### ${r.id} — ${r.name}`)
  md.push(`- 并集差异 ${r.diffRatio}% / 重叠差异 ${r.commonDiffRatio}% / meanDelta ${r.meanDelta}`)
  md.push(`- 尺寸 上游 ${r.upSize.w}x${r.upSize.h} vs 我们 ${r.oursSize.w}x${r.oursSize.h}${r.sizeMatch ? '（一致）' : '（不一致）'}`)
  if (r.deviations?.length) md.push(`- 已知差异: ${r.deviations.join('；')}`)
  const keys = Object.keys(r.styleDelta)
  if (!keys.length) md.push('- 计算样式: 完全一致')
  else for (const k of keys) md.push(`- ${k}: 上游 \`${JSON.stringify(r.styleDelta[k].upstream)}\` → 我们 \`${JSON.stringify(r.styleDelta[k].ours)}\``)
  md.push('')
}
md.push('## 上游词汇 → 我们 props 的映射')
md.push('')
for (const [k, v] of Object.entries(mapping)) md.push(`- ${k}: ${v}`)
md.push('')
writeFileSync(join(OUT, 'report.md'), md.join('\n'))

// 人看的入口：一个不依赖外部资源的画廊页，左上游/中我们/右差异热力图直接铺开。
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])
const html = []
html.push('<!doctype html><html lang="zh"><meta charset="utf-8"><title>TailGrids 保真对比</title>')
html.push('<style>body{margin:0;padding:24px;background:#0b0f19;color:#e5e7eb;font:14px/1.6 system-ui,-apple-system,"Noto Sans SC",sans-serif}h1{font-size:20px;margin:0 0 4px}small{color:#9ca3af}h2{font-size:15px;margin:32px 0 12px;padding-bottom:8px;border-bottom:1px solid #1f2937}figure{margin:0 0 28px;background:#111827;border:1px solid #1f2937;border-radius:12px;overflow:hidden}figcaption{padding:10px 14px;display:flex;flex-wrap:wrap;gap:12px;align-items:baseline}figcaption b{font-weight:600}figcaption span{color:#9ca3af;font-size:12px}img{display:block;width:100%;height:auto;background:#111827}code{background:#1f2937;padding:1px 5px;border-radius:4px;font-size:12px}a{color:#93b4ff}</style>')
html.push(`<h1>TailGrids 保真对比：上游原始组件 vs 我们</h1><small>生成于 ${report.generatedAt}；左＝upstream（TailGrids core）、中＝ours（apps/web）、右＝差异热力图（红点＝像素差）；同一 Chromium、视口 1440x900、字体归一</small>`)
for (const theme of THEMES) {
  html.push(`<h2>${theme === 'dark' ? '深色' : '亮色'}主题</h2>`)
  for (const r of results.filter((x) => x.theme === theme)) {
    const deltas = Object.keys(r.styleDelta)
    html.push('<figure>')
    html.push(`<figcaption><b>${esc(r.id)}</b><span>${esc(r.name)}</span><span>并集差异 <b>${r.diffRatio}%</b> / 重叠 ${r.commonDiffRatio}%</span><span>上游 ${r.upSize.w}x${r.upSize.h} vs 我们 ${r.oursSize.w}x${r.oursSize.h}${r.sizeMatch ? '' : '（不一致）'}</span><span>计算样式差：${deltas.length ? esc(deltas.join(', ')) : '无'}</span></figcaption>`)
    // 不用 loading="lazy"：58 张图总共不到 1MB，惰性加载会让“离屏还没解码”的图在截图与自动检查里看起来像破图。
    html.push(`<img src="compare/${theme}-${esc(r.id)}.png" alt="${esc(r.id)} ${theme}">`)
    if (r.deviations?.length) html.push(`<figcaption><span>已知结构差异：${esc(r.deviations.join('；'))}</span></figcaption>`)
    html.push('</figure>')
  }
}
html.push('<h2>上游词汇 → 我们 props 的映射</h2><ul>')
for (const [k, v] of Object.entries(mapping)) html.push(`<li><code>${esc(k)}</code> ${esc(v)}</li>`)
html.push('</ul></html>')
writeFileSync(join(OUT, 'gallery.html'), html.join('\n'))

console.log(`\n报告: ${join(OUT, 'report.md')}\n画廊: ${join(OUT, 'gallery.html')}\nJSON: ${join(OUT, 'report.json')}\n对比图: ${join(OUT, 'compare')}`)
await browser.close()