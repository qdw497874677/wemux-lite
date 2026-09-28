import { mkdir, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import path from 'node:path'

const playwrightModule = process.env.PLAYWRIGHT_CORE_PATH ?? '/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs'
const { chromium } = await import(playwrightModule)
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome'
const root = path.resolve(new URL('../../..', import.meta.url).pathname)
const output = path.join(root, '.scratch/feature-suite-b2')
await mkdir(output, { recursive: true })
await rm(path.join(output, 'browser.sqlite'), { force: true })

const port = await new Promise(resolve => {
  const probe = createServer()
  probe.listen(0, '127.0.0.1', () => {
    const address = probe.address()
    probe.close(() => resolve(typeof address === 'object' && address ? address.port : 0))
  })
})
const baseURL = `http://127.0.0.1:${port}`
const child = spawn(process.execPath, ['apps/server/dist/main.js'], {
  cwd: root,
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), WEMUX_ADMIN_EMAILS: 'admin@example.com', WEMUX_DATABASE_PATH: path.join(output, 'browser.sqlite'), WEMUX_PUBLIC_URL: baseURL, WEMUX_SMTP_FROM: 'Wemux <no-reply@example.com>', WEMUX_MAIL_OUTBOX: path.join(output, 'outbox'), WEMUX_WEB_DIST: path.join(root, 'apps/web/dist') },
  stdio: 'ignore',
})
const now = new Date().toISOString()
const account = { user: { id: 'user-browser', username: 'browser', email: 'browser@example.com', createdAt: now, status: 'active' }, teamId: 'team-browser', session: { id: 'login-browser', current: true, authenticationMethod: 'password', client: 'Playwright', authenticatedAt: now, createdAt: now, lastSeenAt: now, idleExpiresAt: now, absoluteExpiresAt: now, revokedAt: null }, csrfToken: 'browser-csrf', instanceAdministrator: true }
const project = { id: 'project-browser', name: '批次二验收项目', teamId: 'team-browser', shareScope: 'team', accessRole: 'owner' }
const task = { id: 'task-browser', projectId: project.id, title: '交付物浏览器验收', description: '验证登记、预览和审查操作区。', acceptanceCriteria: '交付物区可见且操作完整。', status: 'in_review', priority: 'high', version: 3, assignee: null, origin: 'manual', activeRun: null, linkCount: 0, metadataJson: { schemaVersion: 1, values: {} }, blockedFrom: null, cancelledFrom: null, workspaces: [], links: [], capabilities: { transitions: {} }, createdAt: now, updatedAt: now, lastActivityAt: now }
const run = { id: 'run-browser', taskId: task.id, projectId: project.id, status: 'succeeded', createdAt: now, updatedAt: now }
const artifact = { id: 'artifact-browser', projectId: project.id, taskId: task.id, runId: run.id, sessionId: 'session-browser', workspaceId: 'workspace-browser', workerId: 'worker-browser', relativePath: 'reports/result.md', mimeType: 'text/markdown', size: 128, source: 'manual', reviewState: 'pending', revision: 1, createdBy: account.user.id, createdAt: now, updatedAt: now }
const attentionItems = [
  { projectionKey: 'approval:approval-browser', kind: 'approval', sourceId: 'approval-browser', projectId: project.id, title: '审批：交付物浏览器验收', summary: '等待你的审查决定', occurredAt: now, href: '/approvals', freshness: { status: 'current', observedAt: now } },
  { projectionKey: `task:${task.id}`, kind: 'task_assignment', sourceId: task.id, projectId: project.id, title: task.title, detail: '任务处于待审状态', occurredAt: now, href: `/projects/${project.id}/tasks/${task.id}?tab=runs`, freshness: { status: 'current', observedAt: now } },
  { projectionKey: `run:${run.id}`, kind: 'run_problem', sourceId: run.id, projectId: project.id, title: 'Run 需要处理', summary: '最近一次执行失败', occurredAt: now, href: `/projects/${project.id}/tasks/${task.id}?tab=runs&run=${run.id}`, freshness: { status: 'current', observedAt: now } },
]
const attention = { items: attentionItems, groups: [
  { kind: 'approval', label: '待审批', count: 1, items: attentionItems.filter(item => item.kind === 'approval') },
  { kind: 'task_assignment', label: '指派给我的任务', count: 1, items: attentionItems.filter(item => item.kind === 'task_assignment') },
  { kind: 'run_problem', label: '我创建的运行异常', count: 1, items: attentionItems.filter(item => item.kind === 'run_problem') },
  { kind: 'channel_dead_letter', label: '投递死信', count: 0, items: [] },
], total: 3, nextCursor: null }

const browser = await chromium.launch({ headless: true, executablePath })
try {
  for (let count = 0; count < 80; count += 1) { try { if ((await fetch(`${baseURL}/api/health`)).ok) break } catch {} await delay(100) }
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`) })
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), pathname = url.pathname
    if (pathname === '/api/auth/me') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(account) })
    if (pathname === '/api/projects') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [project] }) })
    if (pathname === '/api/workers') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [] }) })
    if (pathname === `/api/projects/${project.id}/workspaces` || pathname === `/api/projects/${project.id}/sessions` || pathname === `/api/projects/${project.id}/reviews` || pathname === `/api/projects/${project.id}/activity`) return route.fulfill({ contentType: 'application/json', body: JSON.stringify([]) })
    if (pathname === '/api/attention' || pathname === '/api/projections/attention') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(attention) })
    if (pathname === `/api/projects/${project.id}/tasks`) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [task] }) })
    if (pathname === `/api/projects/${project.id}/tasks/${task.id}`) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(task) })
    if (pathname === `/api/projects/${project.id}/tasks/${task.id}/runs`) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [run] }) })
    if (pathname === `/api/projects/${project.id}/tasks/${task.id}/artifacts`) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [artifact] }) })
    if (pathname === `/api/artifacts/${artifact.id}/content`) return route.fulfill({ contentType: artifact.mimeType, body: '# 浏览器预览\n\n交付物内容经 session-files 通道读取。' })
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [] }) })
  })
  await page.goto(`${baseURL}/attention`)
  await page.getByRole('heading', { name: '待办' }).waitFor()
  await page.getByText('待审批', { exact: true }).waitFor()
  await page.screenshot({ path: path.join(output, 'attention.png'), fullPage: true })
  await page.goto(`${baseURL}/projects/${project.id}/tasks/${task.id}?tab=runs`, { waitUntil: 'domcontentloaded' })
  await page.getByText(task.title, { exact: true }).first().waitFor()
  await page.getByTestId('artifacts-section').getByRole('heading', { name: '交付物', exact: true }).waitFor()
  await page.getByText('reports/result.md', { exact: true }).waitFor()
  await page.getByTestId('artifacts-section').scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(output, 'task-artifacts.png'), fullPage: true })
  await page.getByTestId('artifacts-section').screenshot({ path: path.join(output, 'task-artifacts-section.png') })
  const passed = errors.length === 0
  await writeFile(path.join(output, 'browser-result.json'), JSON.stringify({ passed, baseURL, pageErrors: errors, screenshots: ['attention.png', 'task-artifacts.png', 'task-artifacts-section.png'], checked: ['待办分组卡片', '待办跳转链接', '任务运行页交付物区', '登记表单', '预览与审查操作'] }, null, 2))
  if (!passed) process.exitCode = 1
  console.log(JSON.stringify({ passed, output, screenshots: ['attention.png', 'task-artifacts.png', 'task-artifacts-section.png'] }))
} finally {
  await browser.close()
  child.kill('SIGTERM')
}
