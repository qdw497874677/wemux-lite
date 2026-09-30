// Browser acceptance: production Web served by a real Server, with isolated API
// responses to verify the Preset management interaction and administrator gate.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
const { chromium } = await import(process.env.PLAYWRIGHT_CORE_PATH ?? '/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs')
const root = resolve(new URL('../..', import.meta.url).pathname), output = join(root, '.scratch/r2-presets')
await mkdir(output, { recursive: true })
const temp = await mkdtemp(join(tmpdir(), 'wemux-preset-browser-'))
const port = await new Promise(resolvePort => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const address = server.address(); server.close(() => resolvePort(address.port)) }) })
const base = `http://127.0.0.1:${port}`
const server = spawn(process.execPath, ['apps/server/dist/main.js'], { cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), WEMUX_ADMIN_EMAILS: 'admin@example.com', WEMUX_DATABASE_PATH: join(temp, 'server.sqlite'), WEMUX_WEB_DIST: join(root, 'apps/web/dist') }, stdio: 'ignore' })
let browser
try {
  let healthy = false
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/health`)).ok) { healthy = true; break } } catch {} await delay(100) }
  assert.ok(healthy, 'real Server serves production Web')
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
  const errors = [], writes = [], presets = [], applications = [], publishedProviders = [], publishedRevisions = []
  let administrator = true
  page.on('pageerror', error => errors.push(error.stack ?? error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`) })
  const now = new Date().toISOString()
  const account = { user: { id: 'preset-admin', username: 'preset-admin', email: 'admin@example.com', createdAt: now, status: 'active' }, teamId: 'team', session: { id: 'login', current: true, authenticationMethod: 'password', client: 'Playwright', authenticatedAt: now, createdAt: now, lastSeenAt: now, idleExpiresAt: now, absoluteExpiresAt: null, revokedAt: null }, csrfToken: 'preset-csrf', instanceAdministrator: true }
  const worker = { id: 'worker-1', teamId: 'team', ownerId: 'preset-admin', name: '预设工作节点', shareScope: 'team', accessRole: 'owner', connectionState: 'online', capabilities: [], lastSeenAt: now }
  const resource = { id: 'skill-1', kind: 'skill', name: '审核 Skill', description: '' }
  const revision = { id: 'skill-rev-1', resourceId: resource.id, kind: 'skill', version: 1, state: 'published', manifest: { bytes: 128 } }
  const provider = { id: 'provider-1', kind: 'model-provider', name: '受限模型供应商', description: '' }
  const providerRevision = { id: 'provider-rev-1', resourceId: provider.id, kind: 'model-provider', version: 1, state: 'published', payload: { mode: 'inline-config', config: { providerKey: 'openai-compatible', endpoint: 'https://models.example.test/v1', modelIds: ['test-model'], agentKeys: ['pi'], credential: { kind: 'worker-credential', credentialRef: 'local-ref', variableNames: ['OPENAI_API_KEY'] } } }, manifest: { bytes: 64 } }
  const fulfill = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method()
    if (path === '/api/host') return fulfill(route, { hostKind: 'cluster', contractVersion: 1, capabilities: ['cluster-session', 'projects', 'workers'] })
    if (path === '/api/auth/me') return fulfill(route, { ...account, instanceAdministrator: administrator })
    if (path === '/api/workers') return fulfill(route, { items: [worker] })
    if (path === '/api/workers/worker-1/capabilities') return fulfill(route, { workerId: worker.id, capabilities: [] })
    if (path === '/api/projects' || path === '/api/workspaces' || path === '/api/sessions' || path === '/api/commands' || path === '/api/workers/worker-1/grants' || path === '/api/teams/team/members') return fulfill(route, { items: [] })
    if (path === '/api/resources' && method === 'POST') { const body = request.postDataJSON(); publishedProviders.push(body); return fulfill(route, body, 201) }
    if (path === '/api/resources') return fulfill(route, { items: [resource, provider, ...publishedProviders] })
    if (path === '/api/resources/skill-1') return fulfill(route, { resource, revisions: [revision] })
    if (path === '/api/resources/provider-1') return fulfill(route, { resource: provider, revisions: [providerRevision] })
    if (path.startsWith('/api/resources/') && path.endsWith('/revisions') && method === 'POST') { const body = request.postDataJSON(); publishedRevisions.push(body); return fulfill(route, body, 201) }
    const published = publishedProviders.find(item => path === `/api/resources/${item.id}`)
    if (published) return fulfill(route, { resource: published, revisions: publishedRevisions.filter(item => item.resourceId === published.id) })
    if (path === '/api/resource-presets') {
      if (method === 'POST') {
        const body = request.postDataJSON()
        writes.push({ path, csrf: request.headers()['x-csrf-token'], body })
        const value = { ...body, revision: body.expectedRevision + 1, createdBy: 'preset-admin', createdAt: now }
        presets.push(value)
        return fulfill(route, value, 201)
      }
      return fulfill(route, { items: presets })
    }
    if (path === '/api/resource-preset-applications') return fulfill(route, { items: applications })
    if (path === '/api/workers/worker-1/resource-set') return fulfill(route, { workerId: worker.id, revision: 0, bindings: [] })
    if (path.startsWith('/api/resource-presets/') && path.endsWith('/applications') && method === 'POST') {
      const body = request.postDataJSON()
      writes.push({ path, csrf: request.headers()['x-csrf-token'], body })
      const application = { id: 'application-1', presetId: presets.at(-1).id, presetRevision: body.presetRevision, workerId: worker.id, bindingIds: ['binding-1'], requestId: body.requestId, createdBy: 'preset-admin', createdAt: now }
      applications.push({ application, items: [{ binding: { id: 'binding-1', resourceId: resource.id, resourceRevisionId: revision.id, workerId: worker.id, status: 'notified' }, reconcile: { phase: 'queued', errorCode: null } }] })
      return fulfill(route, application, 201)
    }
    return fulfill(route, { items: [] })
  })
  await page.goto(`${base}/cluster`)
  await page.getByRole('heading', { name: '集群运行状态' }).waitFor()
  await page.getByRole('button', { name: /节点预设/ }).click({ timeout: 10000 }).catch(async error => { console.error('browser diagnostics:', await page.locator('#root').innerText(), errors); throw error })
  await page.getByLabel('供应商名称').fill('新建供应商')
  await page.getByLabel('供应商 HTTPS 端点').fill('https://models.example.test/v1')
  await page.getByLabel('供应商模型 ID').fill('offline-model')
  await page.getByLabel('供应商本机凭据引用').fill('local-model-ref')
  await page.getByRole('button', { name: '发布非秘密版本' }).click()
  await page.getByText(/已发布非秘密模型供应商版本/).waitFor()
  assert.equal(publishedProviders.length, 1)
  assert.equal(publishedRevisions.length, 1)
  assert.equal(publishedProviders[0].definition.credential.credentialRef, 'local-model-ref')
  assert.equal(publishedRevisions[0].contentSha256, publishedRevisions[0].manifest.sha256)
  assert.doesNotMatch(JSON.stringify({ publishedProviders, publishedRevisions }), /ciphertext|apiKey|secret|password/)
  await page.getByLabel('预设资源').selectOption(provider.id)
  await page.getByLabel('预设版本').selectOption(providerRevision.id)
  await page.getByLabel('预设 Agent').selectOption('claude-code')
  await page.getByRole('button', { name: '添加资源' }).click()
  await page.getByText('所选 Agent 不在模型供应商版本的适配范围内').waitFor()
  await page.getByLabel('预设 Agent').selectOption('pi')
  await page.getByRole('button', { name: '添加资源' }).click()
  await page.getByLabel('预设资源').selectOption(resource.id)
  await page.getByLabel('预设版本').selectOption(revision.id)
  await page.getByRole('button', { name: '添加资源' }).click()
  await page.getByLabel('预设名称').fill('标准工作节点')
  await page.getByRole('button', { name: '发布预设', exact: true }).click()
  await page.getByText('已发布预设 v1').waitFor()
  assert.equal(writes[0].csrf, 'preset-csrf')
  assert.deepEqual(writes[0].body.autoApply, { enabled: false })
  assert.equal(writes[0].body.entries[0].resourceRevisionId, providerRevision.id)
  assert.equal(writes[0].body.entries[0].agentKey, 'pi')
  assert.equal(writes[0].body.entries[1].resourceRevisionId, revision.id)
  await page.getByLabel('应用工作节点').selectOption(worker.id)
  await page.getByRole('button', { name: '应用到节点' }).click()
  await page.getByRole('dialog').waitFor({ timeout: 5000 }).catch(async error => { console.error('apply diagnostics:', await page.locator('#root').innerText(), errors); throw error })
  await page.getByRole('dialog').getByText(/审核 Skill v1.*128 字节/).waitFor()
  await page.getByRole('dialog').getByText(/受限模型供应商 v1.*凭据须在 Worker 本地录入或预置环境变量.*待认证/).waitFor()
  assert.equal(writes.length, 1, 'confirmation must precede application write')
  await page.getByRole('dialog').getByRole('button', { name: '确认应用' }).click()
  await page.getByText('已提交手工应用').waitFor()
  await page.getByLabel('预设应用进度').getByText('排队中').waitFor()
  assert.equal(writes[1].csrf, 'preset-csrf')
  assert.equal(writes[1].body.expectedSetRevision, 0)
  await page.screenshot({ path: join(output, 'preset-studio.png'), fullPage: true })
  await page.getByLabel('编辑预设').selectOption(presets[0].id)
  await page.getByRole('button', { name: '发布新版本' }).click()
  await page.getByText('已发布预设 v2').waitFor()
  assert.equal(writes[2].body.expectedRevision, 1)
  assert.equal(writes[2].body.id, presets[0].id)
  administrator = false
  await page.reload()
  await page.getByRole('heading', { name: '集群运行状态' }).waitFor()
  assert.equal(await page.getByRole('button', { name: /节点预设/ }).count(), 0)
  assert.deepEqual(errors, [])
  await writeFile(join(output, 'browser-result.json'), JSON.stringify({ passed: true, checked: ['生产集群路由与资源表单', '非秘密 Provider 创建与不可变 v1 发布', 'Provider 版本 Agent 适配检查、仅引用本地密钥的说明', 'CSRF 发布不可变 v1/v2', '展示版本、大小与副作用的确认', '手工应用 CAS', '应用进度', '非管理员不可访问预设入口', '无页面异常'], screenshot: 'preset-studio.png' }, null, 2))
  console.log('Preset Studio browser acceptance passed')
} finally { await browser?.close(); server.kill('SIGTERM'); await rm(temp, { recursive: true, force: true }) }
