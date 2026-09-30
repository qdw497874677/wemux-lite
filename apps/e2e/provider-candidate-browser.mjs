import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const { chromium } = await import(process.env.PLAYWRIGHT_CORE_PATH ?? '/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs')
const root = resolve(new URL('../..', import.meta.url).pathname)
const temp = await mkdtemp(join(tmpdir(), 'wemux-provider-candidate-browser-'))
const port = await new Promise(resolvePort => { const probe = createServer(); probe.listen(0, '127.0.0.1', () => { const address = probe.address(); probe.close(() => resolvePort(address.port)) }) })
const base = `http://127.0.0.1:${port}`
const server = spawn(process.execPath, ['apps/server/dist/main.js'], { cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), WEMUX_ADMIN_EMAILS: 'admin@example.test', WEMUX_DATABASE_PATH: join(temp, 'server.sqlite'), WEMUX_WEB_DIST: join(root, 'apps/web/dist') }, stdio: 'ignore' })
let browser
try {
  let healthy = false
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/health`)).ok) { healthy = true; break } } catch { /* startup */ } await delay(100) }
  assert.ok(healthy)
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 }, colorScheme: 'dark' })
  const errors = [], candidateQueries = [], creations = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  const now = new Date().toISOString()
  const user = { id: 'user-browser', username: 'browser', email: 'browser@example.test', createdAt: now, status: 'active' }
  const account = { user, teamId: 'team-browser', session: { id: 'login-browser', current: true, authenticationMethod: 'password', client: 'Playwright', authenticatedAt: now, createdAt: now, lastSeenAt: now, idleExpiresAt: now, absoluteExpiresAt: null, revokedAt: null }, csrfToken: 'browser-csrf', instanceAdministrator: false }
  const project = { id: 'project-browser', teamId: 'team-browser', ownerId: user.id, name: '验收项目', shareScope: 'team', accessRole: 'owner' }
  const agent = { agentKey: 'pi', displayName: 'Pi', mode: 'execution', version: '0.87.1', availability: { status: 'available' }, models: [{ modelId: 'pi::available', displayName: '可用模型' }] }
  const worker = { id: 'worker-browser', teamId: 'team-browser', ownerId: user.id, name: '验收 Worker', shareScope: 'team', accessRole: 'use', connectionState: 'online', version: '1', platform: 'linux', capabilities: [agent], lastSeenAt: now }
  const workspace = { id: 'workspace-browser', name: '演示工作区', workerId: worker.id, projectId: project.id, status: 'ready', placements: [{ workerId: worker.id, status: 'ready', failureReason: null, location: { rootPath: '/tmp/workspace-browser' } }], repositories: [] }
  const fulfill = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  await page.route('**/api/**', route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname
    if (path === '/api/host') return fulfill(route, { hostKind: 'cluster', contractVersion: 1, capabilities: ['cluster-session', 'projects', 'workers'] })
    if (path === '/api/bootstrap') return fulfill(route, { auth: { authenticated: true, user, csrfToken: 'browser-csrf' }, projects: [project], workers: [worker], team: { id: 'team-browser', name: '测试团队' } })
    if (path === '/api/auth/me') return fulfill(route, account)
    if (path === '/api/projects') return fulfill(route, { items: [project] })
    if (path === `/api/projects/${project.id}`) return fulfill(route, project)
    if (path === '/api/workers') return fulfill(route, { items: [worker] })
    if (path === `/api/workers/${worker.id}/capabilities`) return fulfill(route, { workerId: worker.id, capabilities: [agent] })
    if (path === `/api/projects/${project.id}/workspaces` || path === '/api/workspaces') return fulfill(route, { items: [workspace] })
    if (path.endsWith('/provider-candidates')) {
      candidateQueries.push({ path, agentKey: url.searchParams.get('agentKey') })
      return fulfill(route, { items: [
        { modelId: 'openai-compatible::candidate', resourceId: 'provider-1', bindingId: 'binding-1', status: 'not-verified' },
        { modelId: 'pi::available', resourceId: 'provider-2', bindingId: 'binding-2', status: 'not-verified' },
      ] })
    }
    if (path === '/api/sessions' && request.method() === 'POST') { creations.push(request.postDataJSON()); return fulfill(route, { error: { message: 'must not create' } }, 409) }
    return fulfill(route, { items: [] })
  })
  await page.goto(`${base}/projects/${project.id}/sessions`)
  try { await page.getByRole('heading', { name: '新对话' }).waitFor({ timeout: 7000 }) }
  catch (error) { console.log('PAGE:', (await page.locator('body').innerText()).slice(0, 2500), 'URL', page.url(), 'ERRORS', errors); throw error }
  await page.getByRole('button', { name: /模型/ }).click()
  const list = page.getByRole('dialog', { name: '选择模型' })
  const candidate = list.getByRole('button', { name: /openai-compatible::candidate/ })
  await candidate.waitFor({ timeout: 9000 })
  assert.equal(await candidate.isDisabled(), true)
  await list.getByText('已绑定，尚未验证模型与凭据；暂不可用于对话').waitFor()
  const available = list.getByRole('button', { name: /可用模型/ })
  assert.equal(await available.isDisabled(), false, 'authenticated Agent model remains selectable')
  assert.equal(await list.getByRole('button', { name: /pi::available/ }).count(), 0, 'an unverified duplicate must not shadow an advertised Agent model')
  await available.click()
  assert.equal(creations.length, 0)
  assert.ok(candidateQueries.some(item => item.path === `/api/workers/${worker.id}/projects/${project.id}/provider-candidates` && item.agentKey === 'pi'))
  assert.equal(creations.length, 0)
  assert.deepEqual(errors, [])
  console.log('Provider candidate browser: disabled and clearly marked; no Session creation')
} finally { await browser?.close(); server.kill('SIGTERM'); await rm(temp, { recursive: true, force: true }) }
