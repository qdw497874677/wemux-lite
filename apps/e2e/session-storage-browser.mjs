// Browser acceptance for the R2 local-only Session storage boundary.
// Production Web is served by the real Server; auth and Session API responses are isolated fixtures.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { chromium } = await import(process.env.PLAYWRIGHT_CORE_PATH ?? '/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs')

const root = new URL('../..', import.meta.url).pathname, output = join(root, '.scratch/r2-storage-mode')
const temp = await mkdtemp(join(tmpdir(), 'wemux-storage-browser-'))
await mkdir(output, { recursive: true })
const port = await new Promise((resolve, reject) => { const s = createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const address = s.address(); if (!address || typeof address === 'string') return reject(new Error('no port')); const port = address.port; s.close(() => resolve(port)) }) })
const base = `http://127.0.0.1:${port}`
const server = spawn(process.execPath, ['apps/server/dist/main.js'], { cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), WEMUX_DATABASE_PATH: join(temp, 'server.sqlite'), WEMUX_ADMIN_EMAILS: 'browser@example.com', WEMUX_WEB_DIST: join(root, 'apps/web/dist'), WEMUX_CAPABILITY_SECRET: 'storage-browser-capability-secret-long-enough' }, stdio: 'ignore' })
let browser
try {
  const deadline = Date.now() + 15_000
  while (true) { try { if ((await fetch(`${base}/health`)).ok) break } catch {} if (Date.now() > deadline) throw new Error('Server did not start'); await new Promise(resolve => setTimeout(resolve, 100)) }
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome', headless: true, args: ['--no-sandbox'] })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    const headers = { 'content-type': 'application/json' }
    const fulfill = body => route.fulfill({ status: 200, headers, body: JSON.stringify(body) })
    if (path === '/api/host') return fulfill({ hostKind: 'cluster', contractVersion: 1, capabilities: ['cluster-session', 'projects', 'workers'] })
    if (path === '/api/auth/me') return fulfill({ user: { id: 'owner', username: 'owner', email: 'browser@example.com' }, teamId: 'team', session: { id: 'login', current: true, authenticationMethod: 'password', client: 'Playwright', authenticatedAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z', lastSeenAt: '2026-01-01T00:00:00Z', idleExpiresAt: '2026-01-01T00:00:00Z', absoluteExpiresAt: null, revokedAt: null }, instanceAdministrator: true, csrfToken: 'csrf' })
    if (path === '/api/projects') return fulfill({ items: [{ id: 'project', teamId: 'team', ownerId: 'owner', name: '存储模式项目', shareScope: 'team', accessRole: 'owner', createdAt: '2026-01-01T00:00:00Z' }] })
    if (path === '/api/workers') return fulfill({ items: [] })
    if (path === '/api/workspaces') return fulfill({ items: [{ id: 'workspace', projectId: 'project', name: '测试工作区', workerId: 'worker', status: 'ready', placements: [], createdAt: '2026-01-01T00:00:00Z' }] })
    if (path === '/api/sessions') return fulfill({ items: [{ id: 'session', projectId: 'project', ownerId: 'owner', workspaceId: 'workspace', title: '旧会话', runtimeState: 'idle', binding: { workspaceId: 'workspace', agent: { workerId: 'worker', agentKey: 'test' }, modelId: null }, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }] })
    if (path === '/api/sessions/session') return fulfill({ id: 'session', projectId: 'project', ownerId: 'owner', workspaceId: 'workspace', title: '旧会话', runtimeState: 'idle', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', binding: { workspaceId: 'workspace', agent: { workerId: 'worker', agentKey: 'test' }, modelId: null } })
    if (path === '/api/sessions/session/events') return fulfill({ events: [], nextSeq: null, freshness: { status: 'synced', throughSeq: 0 } })
    return fulfill({ items: [] })
  })
  await page.goto(`${base}/projects/project/sessions/session`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: '切换右侧面板' }).click()
  await page.getByText('节点本地', { exact: true }).waitFor({ timeout: 15_000 })
  await page.getByText('Server 仅保存事件投影', { exact: false }).waitFor()
  assert.equal(await page.getByText('API 契约错误', { exact: false }).count(), 0)
  assert.deepEqual(errors, [])
  await page.screenshot({ path: join(output, 'session-storage-local.png'), fullPage: true })
  await writeFile(join(output, 'browser-result.json'), JSON.stringify({ passed: true, checked: ['生产 Web 会话路由', '旧 Session 默认 local 展示', 'Server 投影非恢复承诺', '无页面异常及 events API 契约错误'] }, null, 2))
  console.log('Session storageMode browser acceptance passed')
} finally { await browser?.close(); server.kill('SIGTERM'); await rm(temp, { recursive: true, force: true }) }
