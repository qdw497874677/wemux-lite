import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const { chromium } = await import(process.env.PLAYWRIGHT_CORE_PATH ?? '/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs')
const root = resolve(new URL('../..', import.meta.url).pathname)
const output = join(root, '.scratch/r1-stage3')
await mkdir(output, { recursive: true })
const temp = await mkdtemp(join(tmpdir(), 'wemux-skill-browser-'))
const port = await new Promise(resolvePort => {
  const probe = createServer()
  probe.listen(0, '127.0.0.1', () => { const address = probe.address(); probe.close(() => resolvePort(address.port)) })
})
const base = `http://127.0.0.1:${port}`
const server = spawn(process.execPath, ['apps/server/dist/main.js'], { cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), WEMUX_ADMIN_EMAILS: 'admin@example.com', WEMUX_DATABASE_PATH: join(temp, 'browser.sqlite'), WEMUX_WEB_DIST: join(root, 'apps/web/dist') }, stdio: 'ignore' })
let browser
try {
  let healthy = false
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/health`)).ok) { healthy = true; break } } catch {} await delay(100) }
  assert.ok(healthy, 'Server must serve the real Web build')
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
  const errors = [], writes = [], resources = [], revisions = [], bindings = []
  let administrator = true
  page.on('pageerror', error => errors.push(error.message))
  const now = new Date().toISOString()
  const account = { user: { id: 'user-browser', username: 'browser', email: 'browser@example.com', createdAt: now, status: 'active' }, teamId: 'team-browser', session: { id: 'login-browser', current: true, authenticationMethod: 'password', client: 'Playwright', authenticatedAt: now, createdAt: now, lastSeenAt: now, idleExpiresAt: now, absoluteExpiresAt: null, revokedAt: null }, csrfToken: 'browser-csrf', instanceAdministrator: true }
  const project = { id: 'project-browser', teamId: 'team-browser', ownerId: 'user-browser', name: '验收项目', shareScope: 'team', accessRole: 'owner' }
  const worker = { id: 'worker-browser', teamId: 'team-browser', ownerId: 'user-browser', name: '验收 Worker', shareScope: 'team', accessRole: 'owner', connectionState: 'online', version: '1', platform: 'linux', capabilities: [], lastSeenAt: now }
  const fulfill = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) })
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method()
    if (path === '/api/auth/me') return fulfill(route, { ...account, instanceAdministrator: administrator })
    if (path === '/api/projects') return fulfill(route, { items: [project] })
    if (path === '/api/workers') return fulfill(route, { items: [worker] })
    if (path === '/api/resources') {
      if (method === 'POST') { const body = request.postDataJSON(); writes.push({ path, method, csrf: request.headers()['x-csrf-token'] }); resources.push(body); return fulfill(route, body, 201) }
      return fulfill(route, { items: resources })
    }
    if (path === '/api/resource-bindings') {
      if (method === 'POST') { const body = request.postDataJSON(); writes.push({ path, method, body }); const binding = { ...body, resourceId: resources[0].id, status: 'assigned', revision: 1 }; bindings.push({ binding, reconcile: null }); return fulfill(route, binding, 201) }
      return fulfill(route, { items: bindings })
    }
    if (path.startsWith('/api/resource-bindings/') && method === 'PATCH') { const current = bindings[0]; current.binding = { ...current.binding, status: 'pending-gc', revision: 2 }; writes.push({ path, method, body: request.postDataJSON() }); return fulfill(route, current.binding) }
    if (path.startsWith('/api/resource-blobs/') && method === 'PUT') { const body = request.postDataJSON(); writes.push({ path, method, body }); return fulfill(route, { sha256: path.split('/').pop(), deduplicated: false }, 201) }
    if (path.startsWith('/api/resources/') && path.endsWith('/revisions') && method === 'POST') { const body = request.postDataJSON(); writes.push({ path, method, body }); revisions.push(body); return fulfill(route, body, 201) }
    if (path.startsWith('/api/resources/')) return fulfill(route, { resource: resources[0], revisions })
    return fulfill(route, { items: [] })
  })
  await page.goto(`${base}/projects/${project.id}/skills`)
  await page.getByRole('heading', { name: '技能工作室' }).waitFor()
  await page.getByLabel('名称', { exact: true }).fill('浏览器技能')
  await page.getByLabel('描述', { exact: true }).fill('测试分发')
  await page.getByLabel('SKILL.md').fill('# 浏览器技能\n执行说明')
  await page.getByRole('button', { name: '发布新版本' }).click()
  await page.getByText('已发布不可变 revision。').waitFor()
  assert.equal(writes.map(item => item.method).join(','), 'POST,PUT,POST')
  assert.equal(writes[0].csrf, 'browser-csrf')
  assert.equal(Buffer.from(writes[1].body.base64Content, 'base64').toString('utf8'), '# 浏览器技能\n执行说明')
  await page.getByRole('combobox', { name: /Worker/ }).selectOption(worker.id)
  await page.getByRole('button', { name: '绑定并分发' }).click()
  await page.getByText('已创建绑定').waitFor()
  assert.equal(writes.at(-1).body.projectId, project.id)
  await page.getByText('待通知', { exact: false }).waitFor()
  bindings[0].binding.status = 'installed'
  bindings[0].reconcile = { phase: 'ready', errorCode: null }
  await page.getByText('已安装 / 已就绪', { exact: true }).waitFor({ timeout: 9000 })
  await page.getByRole('button', { name: '绑定并分发' }).isDisabled().then(disabled => assert.ok(disabled))
  await page.getByText('此 Worker 已绑定该技能').waitFor()
  await page.screenshot({ path: join(output, 'skill-studio.png'), fullPage: true })
  await page.getByRole('button', { name: '撤销' }).click()
  await page.getByText('已撤销绑定').waitFor()
  await page.getByText('待回收', { exact: true }).waitFor()
  assert.equal(writes.at(-1).body.expectedRevision, 1)
  await page.getByLabel('SKILL.md').fill('# 浏览器技能\n修订说明')
  await page.getByRole('button', { name: '发布新版本' }).click()
  await page.getByText('已发布不可变 revision。').waitFor()
  assert.equal(revisions.length, 2)
  assert.equal(revisions[1].version, 2)
  assert.equal(revisions[1].resourceId, revisions[0].resourceId)
  administrator = false
  await page.reload()
  await page.getByText('当前资源 API 仅向实例管理员开放。').waitFor()
  assert.equal(errors.length, 0, errors.join('\n'))
  await writeFile(join(output, 'browser-result.json'), JSON.stringify({ passed: true, checked: ['真实构建页面路由', '发布 blob 与 revision', 'CSRF', '项目绑定', '轮询 ready', 'CAS 撤销', '第二版不可变 revision', '非管理员权限提示'], screenshot: 'skill-studio.png' }, null, 2))
  console.log('Skill Studio browser acceptance passed')
} finally { await browser?.close(); server.kill('SIGTERM'); await rm(temp, { recursive: true, force: true }) }
