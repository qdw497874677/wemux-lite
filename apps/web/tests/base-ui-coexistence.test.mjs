import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { chromium } from '/opt/data/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs'

test('Base UI dialog and popover coexist with Radix dialog and AI Elements', async () => {
  const bundle = await build({
    entryPoints: [new URL('./base-ui-coexistence-rendered.tsx', import.meta.url).pathname],
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
  })
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/test.js' ? 'text/javascript' : 'text/html')
    res.end(req.url === '/test.js' ? bundle.outputFiles[0].text : '<div id="root"></div><script src="/test.js"></script>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const browser = await chromium.launch({ headless: true, executablePath: '/opt/data/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome' })
  try {
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.getByRole('button', { name: '打开 Radix 对话框' }).click()
    await page.getByRole('dialog').waitFor()
    assert.equal(await page.getByText('Radix 对话框', { exact: true }).count(), 1)
    await page.getByRole('button', { name: '关闭 Radix 对话框' }).click()

    await page.getByRole('button', { name: '打开 Base UI 对话框' }).click()
    await page.getByTestId('base-dialog').waitFor()
    await page.getByRole('button', { name: '关闭 Base UI 对话框' }).click()

    await page.getByRole('button', { name: '打开 Base UI 浮层' }).click()
    await page.getByTestId('base-popover').waitFor()
    assert.equal(await page.getByLabel('AI Elements 输入框').count(), 1)
  } finally {
    await browser.close()
    await new Promise(resolve => server.close(resolve))
  }
})
