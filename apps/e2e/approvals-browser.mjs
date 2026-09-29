import { chromium } from '/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs'
import { mkdir, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

const evidence = new URL('../../.scratch/feature-suite-b1/', import.meta.url)
await mkdir(evidence, { recursive: true })
const port = await new Promise(resolve => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const address = server.address(); const value = typeof address === 'object' && address ? address.port : 0; server.close(() => resolve(value)) }) })
const baseUrl = `http://127.0.0.1:${port}`
const child = spawn(process.execPath, ['apps/server/dist/main.js'], { cwd: new URL('../..', import.meta.url), env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), WEMUX_ADMIN_EMAILS: 'admin@example.com', WEMUX_DATABASE_PATH: new URL('../../.scratch/feature-suite-b1/browser.sqlite', import.meta.url).pathname, WEMUX_PUBLIC_URL: baseUrl, WEMUX_SMTP_FROM: 'Wemux <no-reply@example.com>', WEMUX_MAIL_OUTBOX: new URL('../../.scratch/feature-suite-b1/outbox', import.meta.url).pathname, WEMUX_WEB_DIST: new URL('../web/dist', import.meta.url).pathname }, stdio: 'ignore' })
const now = new Date().toISOString()
const account = { user: { id: 'user-browser', username: 'browser', email: 'browser@example.com', createdAt: now, status: 'active' }, teamId: 'team-browser', session: { id: 'login-browser', current: true, authenticationMethod: 'password', client: 'Playwright', authenticatedAt: now, createdAt: now, lastSeenAt: now, idleExpiresAt: now, absoluteExpiresAt: now, revokedAt: null }, csrfToken: 'browser-csrf', instanceAdministrator: true }
const approval = { projectionKey: 'task_review:task:run:review', projectId: 'project-browser', source: { kind: 'task_review', taskId: 'task', runId: 'run', reviewId: 'review' }, status: 'pending', title: '浏览器审批验收', reason: '检查聚合页交互', requestedBy: { kind: 'user', id: 'reviewer' }, requestedAt: now, decidedAt: null, decisionCapabilities: ['approve', 'deny'], sourceRevision: '1:pending', freshness: { status: 'current', observedAt: now } }
const timeline = { cursor: 'cursor', sourceKind: 'task_activity', sourceId: 'event', sourceKey: 'event', occurredAt: now, projectId: 'project-browser', actor: { kind: 'user', id: 'reviewer', label: '验收用户' }, action: 'approval.requested', subject: { kind: 'task', id: 'task', label: '浏览器审批验收' }, summary: '浏览器审批验收：review.requested', result: 'informational', href: '/projects/project-browser/tasks/task', freshness: { status: 'current', observedAt: now } }
const browser = await chromium.launch({ headless: true, executablePath: '/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' })
try {
  for (let count = 0; count < 80; count += 1) { try { if ((await fetch(`${baseUrl}/api/health`)).ok) break } catch {} await delay(100) }
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors = [], decisions = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname
    if (path === '/api/host') { await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ hostKind: 'cluster', contractVersion: 1, capabilities: ['cluster-session', 'projects', 'workers'] }) }); return }
    if (path === '/api/auth/me') { await route.fulfill({ contentType: 'application/json', body: JSON.stringify(account) }); return }
    if (path === '/api/projects') { await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [{ id: 'project-browser', name: '浏览器项目', teamId: 'team-browser', shareScope: 'team', accessRole: 'owner' }] }) }); return }
    if (path === '/api/workers') { await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [] }) }); return }
    if (path === '/api/approvals' && request.method() === 'GET') { await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [approval], nextCursor: null }) }); return }
    if (path.endsWith('/decisions') && request.method() === 'POST') { decisions.push({ csrf: request.headers()['x-csrf-token'], body: request.postDataJSON() }); await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ approval: { ...approval, status: 'approved', decidedAt: now, decisionCapabilities: [] } }) }); return }
    if (path === '/api/timeline') { await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [timeline], nextCursor: null }) }); return }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [] }) })
  })
  await page.goto(`${baseUrl}/approvals`)
  await page.getByRole('heading', { name: '待审批' }).waitFor()
  await page.getByText('浏览器审批验收', { exact: true }).click()
  await page.getByRole('heading', { name: '审批详情' }).waitFor()
  await page.getByRole('button', { name: '批准' }).click()
  await page.getByText('已批准', { exact: true }).waitFor()
  await page.screenshot({ path: new URL('approvals.png', evidence).pathname, fullPage: true })
  await page.goto(`${baseUrl}/timeline`)
  await page.getByRole('heading', { name: '时间线' }).waitFor()
  await page.getByText('浏览器审批验收：review.requested', { exact: true }).waitFor()
  await page.screenshot({ path: new URL('timeline.png', evidence).pathname, fullPage: true })
  const passed = errors.length === 0 && decisions.length === 1 && decisions[0].csrf === 'browser-csrf' && decisions[0].body.decision === 'approve'
  await writeFile(new URL('browser-result.json', evidence), JSON.stringify({ passed, pageErrors: errors, decisions, checked: ['审批聚合页', 'InspectorHost 详情', '单条批准操作', 'CSRF 请求头', '时间线分组与事件'] }, null, 2))
  if (!passed) process.exitCode = 1
} finally { await browser.close(); child.kill('SIGTERM') }
