import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import test from 'node:test'
import { build } from 'esbuild'
import { chromium } from '/opt/data/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs'

import { executePaletteItem, filterPaletteItems, nextPaletteSelection, orderCommandsByRecent, paletteTextSegments, readRecentCommandIds, sessionPaletteItems } from '../src/features/command-palette/model.ts'

const storage = (initial = {}) => {
  const values = new Map(Object.entries(initial))
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), value: key => values.get(key) }
}

test('palette filters commands and current-project session titles', () => {
  const sessions = [
    { id: 's-new', projectId: 'p1', title: '发布检查', updatedAt: '2026-04-02T00:00:00Z', canRead: true, archivedAt: null },
    { id: 's-old', projectId: 'p1', title: '登录修复', updatedAt: '2026-04-01T00:00:00Z', canRead: true, archivedAt: null },
    { id: 'foreign', projectId: 'p2', title: '其他项目', updatedAt: '2026-04-03T00:00:00Z', canRead: true, archivedAt: null },
  ]
  const opened = []
  const items = sessionPaletteItems(sessions, 'p1', id => opened.push(id))
  assert.deepEqual(items.map(item => item.id), ['session:s-new', 'session:s-old'])
  assert.deepEqual(filterPaletteItems(items, '登录').map(item => item.id), ['session:s-old'])
  items[1].run()
  assert.deepEqual(opened, ['s-old'])
})

test('keyboard selection wraps and executing commands records five recent ids', () => {
  assert.equal(nextPaletteSelection(0, -1, 3), 2)
  assert.equal(nextPaletteSelection(2, 1, 3), 0)
  const memory = storage()
  const ran = []
  let recent = []
  for (let index = 0; index < 6; index++) recent = executePaletteItem({ id: `c${index}`, kind: 'command', label: '', description: '', run: () => ran.push(index) }, memory, recent)
  assert.deepEqual(ran, [0, 1, 2, 3, 4, 5])
  assert.deepEqual(readRecentCommandIds(memory), ['c5', 'c4', 'c3', 'c2', 'c1'])
  assert.deepEqual(orderCommandsByRecent([{ id: 'c1' }, { id: 'c5' }, { id: 'other' }], recent).map(item => item.id), ['c5', 'c1', 'other'])
})

test('session title matches expose highlight segments for the visible query', () => {
  assert.deepEqual(paletteTextSegments('登录修复登录', '登录'), [
    { text: '登录', highlighted: true },
    { text: '修复', highlighted: false },
    { text: '登录', highlighted: true },
  ])
  assert.deepEqual(paletteTextSegments('Release Check', 'check'), [
    { text: 'Release ', highlighted: false },
    { text: 'Check', highlighted: true },
  ])
})

test('disabled palette commands do not execute or alter recents', () => {
  let ran = false
  const memory = storage()
  const recent = executePaletteItem({ id: 'disabled', kind: 'command', label: '', description: '', disabled: true, run: () => { ran = true } }, memory, ['kept'])
  assert.equal(ran, false)
  assert.deepEqual(recent, ['kept'])
})

test('rendered palette opens, selects and executes commands and sessions from the keyboard', async () => {
  const bundle = await build({
    entryPoints: [new URL('./command-palette-rendered.tsx', import.meta.url).pathname],
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
  })
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', request.url === '/test.js' ? 'text/javascript' : 'text/html')
    response.end(request.url === '/test.js' ? bundle.outputFiles[0].text : '<div id="root"></div><script src="/test.js"></script>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const browser = await chromium.launch({ headless: true, executablePath: '/opt/data/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome' })
  try {
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.keyboard.press('Control+K')
    const input = page.getByRole('textbox', { name: '搜索命令或会话' })
    await input.waitFor()
    assert.equal(await input.evaluate(element => element === document.activeElement), true)
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await page.getByTestId('result').getByText('command:second').waitFor()

    await page.keyboard.press('Control+K')
    await input.fill('登录')
    assert.equal(await page.getByRole('option', { name: /登录修复/ }).count(), 1)
    await page.keyboard.press('Enter')
    await page.getByTestId('result').getByText('session:session-login').waitFor()

    await page.keyboard.press('Control+K')
    await page.keyboard.press('Escape')
    assert.equal(await page.getByRole('dialog').count(), 0)
  } finally {
    await browser.close()
    await new Promise(resolve => server.close(resolve))
  }
})

test('workbench registers Cmd+K and exposes palette commands and honest search scope', async () => {
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
  const palette = await readFile(new URL('../src/features/command-palette/command-palette.tsx', import.meta.url), 'utf8')
  assert.match(app, /combo: 'Mod\+K'/)
  for (const label of ['新会话', '会话信息', '画布', '文件', '终端', '智能体', '折叠或展开侧栏']) assert.match(app, new RegExp(label))
  assert.match(palette, /ArrowDown/)
  assert.match(palette, /ArrowUp/)
  assert.match(palette, /event\.key === 'Enter'/)
  assert.match(palette, /时间线文本搜索尚未接入/)
})
