import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { once } from 'node:events'

const root = resolve(new URL('../..', import.meta.url).pathname)
const dist = join(root, 'apps/web/dist')
const { chromium } = await import(process.env.PLAYWRIGHT_CORE_PATH ?? '/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs')
const host = { hostKind: 'local-worker', contractVersion: 1, capabilities: ['local-session'] }
let offline = false
const server = createServer(async (request, response) => {
  const path = request.url?.split('?')[0] ?? '/'
  if (path === '/api/host') {
    if (offline) { response.writeHead(503).end(); return }
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    response.end(JSON.stringify(host))
    return
  }
  if (path.startsWith('/api/')) {
    response.writeHead(404).end()
    return
  }
  const file = path.startsWith('/assets/') ? join(dist, path) : join(dist, 'index.html')
  try {
    const contents = await readFile(file)
    response.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' })[extname(file)] ?? 'application/octet-stream' }).end(contents)
  } catch { response.writeHead(404).end() }
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const base = `http://127.0.0.1:${server.address().port}`
try {
  const page = await browser.newPage()
  const errors = [], calls = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) calls.push(new URL(request.url()).pathname) })
  await page.goto(`${base}/projects`)
  await page.getByText('链接不存在。', { exact: false }).waitFor()
  assert.deepEqual(calls, ['/api/host'], 'forbidden local route must not even request local or cluster credentials')
  await page.goto(`${base}/local`)
  await page.getByRole('heading', { name: '本机工作台' }).waitFor()
  assert.deepEqual(errors, [])
  host.contractVersion = 99
  await page.reload()
  await page.getByRole('alert').getByText(/版本与服务端不兼容/).waitFor()
  host.contractVersion = 1
  await page.getByRole('button', { name: '重试' }).click()
  await page.getByRole('heading', { name: '本机工作台' }).waitFor()
  offline = true
  await page.reload()
  await page.getByRole('alert').getByText(/无法连接工作台宿主/).waitFor()
  assert.deepEqual(errors, [])
  offline = false
  await page.getByRole('button', { name: '重试' }).click()
  await page.getByRole('heading', { name: '本机工作台' }).waitFor()
  console.log('Host bootstrap browser acceptance passed')
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }
