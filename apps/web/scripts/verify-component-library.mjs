// Repeatable acceptance check for the /components page (component library).
//
//   npm run build --workspace @wemux/web
//   npx vite preview --port 4175 --strictPort   # from apps/web
//   node apps/web/scripts/verify-component-library.mjs
//
// playwright-core is intentionally NOT a repo dependency (it would pull browser
// downloads into every install). Point WEMUX_PLAYWRIGHT at a local install:
//   WEMUX_PLAYWRIGHT=/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs \
//     WEMUX_VERIFY_BASE=http://127.0.0.1:4175 node apps/web/scripts/verify-component-library.mjs
//
// Drives a real Chromium against the built bundle: it asserts the catalog
// structure, exercises the overlay/feedback components, captures a console-error
// log and writes screenshots to /tmp for review.
import { mkdir } from 'node:fs/promises'

const base = process.env.WEMUX_VERIFY_BASE ?? 'http://127.0.0.1:4175'
const out = process.env.WEMUX_VERIFY_OUT ?? '/tmp/wemux-component-library'
const chrome = process.env.WEMUX_CHROME ?? '/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome'
const playwrightEntry = process.env.WEMUX_PLAYWRIGHT ?? '/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs'

let chromium
for (const candidate of ['playwright-core', playwrightEntry]) {
  try { ({ chromium } = await import(candidate)); break } catch (cause) { if (candidate === playwrightEntry) throw cause }
}

await mkdir(out, { recursive: true })
const browser = await chromium.launch({ headless: true, executablePath: chrome, args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: 'dark' })
const errors = []
const failedRequests = []
page.on('pageerror', error => errors.push(`pageerror: ${error.message}`))
page.on('response', response => { if (response.status() >= 400) failedRequests.push(`${response.status()} ${response.url()}`) })
page.on('console', message => {
  // Chromium asks for /favicon.ico on every navigation; the console surfaces it
  // as a 404 even though nothing in the app references it.
  if (message.type() === 'error' && !message.location().url.endsWith('/favicon.ico')) errors.push(`console: ${message.text()}`)
})

await page.goto(`${base}/components`, { waitUntil: 'networkidle' })
const structure = {
  url: page.url(),
  h1: await page.locator('h1').allTextContents(),
  showcases: await page.locator('.component-showcase').count(),
  catalogLinks: await page.locator('.component-library-index a').count(),
  swatches: await page.locator('.token-swatch').count(),
  taskColumns: await page.locator('.component-task-demo .task-column').count(),
}
await page.screenshot({ path: `${out}/components-dark.png`, fullPage: true })

// Every catalog anchor must resolve to a rendered section.
const anchors = await page.locator('.component-library-index a').evaluateAll(items => items.map(item => item.getAttribute('href')))
const missingAnchors = []
for (const anchor of anchors) {
  if (!(await page.locator(`${anchor}`).count())) missingAnchors.push(anchor)
}

// Overlays, menus and notifications use real portals, so drive them for real.
const interactions = {}
const dialog = page.getByRole('button', { name: '打开对话框' })
await dialog.scrollIntoViewIfNeeded()
await dialog.click()
interactions.dialog = await page.locator('[data-slot="dialog-content"]').isVisible()
await page.screenshot({ path: `${out}/dialog.png` })
await page.keyboard.press('Escape')
interactions.dialogClosed = await page.locator('[data-slot="dialog-content"]').count() === 0

const sheet = page.getByRole('button', { name: '打开抽屉' })
await sheet.scrollIntoViewIfNeeded()
await sheet.click()
interactions.sheet = await page.getByRole('dialog').filter({ hasText: '检查器' }).isVisible()
await page.screenshot({ path: `${out}/sheet.png` })
await page.getByRole('button', { name: '关闭', exact: true }).click()

const bottomSheet = page.getByRole('button', { name: '底部抽屉' })
await bottomSheet.scrollIntoViewIfNeeded()
await bottomSheet.click()
interactions.bottomSheet = await page.getByRole('dialog').filter({ hasText: '选择工作区' }).isVisible()
await page.getByRole('button', { name: '关闭', exact: true }).click()

const menu = page.getByRole('button', { name: '更多操作' })
await menu.scrollIntoViewIfNeeded()
await menu.click()
interactions.menu = await page.getByRole('menuitem', { name: '新建资源' }).isVisible()
await page.keyboard.press('Escape')

const toast = page.getByRole('button', { name: '成功通知' })
await toast.scrollIntoViewIfNeeded()
await toast.click()
interactions.toast = await page.getByRole('status').filter({ hasText: '组件状态已更新' }).isVisible()
await page.screenshot({ path: `${out}/toast.png` })
await page.getByRole('button', { name: '关闭通知' }).click()

const tab = page.getByRole('tab', { name: '活动' })
await tab.scrollIntoViewIfNeeded()
await tab.click()
interactions.tabs = await page.locator('.component-inline-panel', { hasText: '活动时间线区域' }).isVisible()

// 导入的 AI 提示输入组件（Motoko UI）同样真跑：发状态机、模型浮层、工具 chip 与听写。
const composer = page.locator('#components-composer [data-slot="ai-prompt-input"]')
await composer.scrollIntoViewIfNeeded()
interactions.composer = await composer.isVisible()
const composerTextarea = composer.locator('textarea')
await composerTextarea.click()
await composerTextarea.fill('验收提示输入')
await composer.locator('button[aria-label="Send message"]').click()
await page.waitForTimeout(150)
interactions.composerSending = await composer.getAttribute('data-status')
await page.waitForTimeout(2400)
interactions.composerSettled = `${await composer.getAttribute('data-status')}|${((await page.locator('#components-composer p[aria-live]').textContent()) ?? '').slice(0, 28)}`
await composer.locator('[data-slot="model-selector-trigger"]').click()
await page.waitForTimeout(250)
interactions.composerSelectorOptions = await page.locator('[data-slot="model-selector-item"]').count()
await page.screenshot({ path: `${out}/composer-selector.png` })
await page.keyboard.press('Escape')
await page.waitForTimeout(400)
interactions.composerSelectorClosed = (await page.locator('[data-slot="model-selector-content"]').count()) === 0
await composer.locator('button[aria-label="Open actions"]').click()
await page.locator('[role="menuitemcheckbox"]').first().click()
await page.waitForTimeout(300)
interactions.composerToolChip = (await page.locator('#components-composer button[aria-label="Disable Deep research"]').count()) === 1
await page.locator('#components-composer button[aria-label="Disable Deep research"]').click()
await composer.locator('button[aria-label="Start dictation"]').click()
await page.waitForTimeout(200)
await composer.locator('button[aria-label="Stop recording"]').click()
await page.waitForTimeout(1500)
interactions.composerDictation = (await composerTextarea.inputValue()).length > 10
await page.screenshot({ path: `${out}/composer.png` })

// Light theme keeps the same surfaces (the app defaults to dark).
await page.emulateMedia({ colorScheme: 'light' })
await page.screenshot({ path: `${out}/components-light.png`, fullPage: true })

const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' })
await mobile.goto(`${base}/components`, { waitUntil: 'networkidle' })
await mobile.screenshot({ path: `${out}/components-mobile.png`, fullPage: true })
const overflow = await mobile.evaluate(() => Math.max(document.documentElement.scrollWidth - document.documentElement.clientWidth, ...['.component-library', '.component-library-index', '.token-grid', '.component-task-demo'].map(selector => { const element = document.querySelector(selector); return element ? Math.round(element.scrollWidth - element.clientWidth) : 0 })))

console.log(JSON.stringify({ structure, anchors: anchors.length, missingAnchors, interactions, mobileOverflowPx: overflow, failedRequests, errors }, null, 2))
await browser.close()
if (missingAnchors.length || errors.length || Object.values(interactions).some(value => value !== true)) process.exitCode = 1