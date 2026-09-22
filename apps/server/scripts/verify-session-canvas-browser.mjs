import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { hashSecret } from '../dist/application/auth.js'
import { hashPassword } from '../dist/application/password.js'
import { createWemuxServer } from '../dist/server.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const evidenceDir = path.join(root, '.scratch/product-convergence/evidence')
await mkdir(evidenceDir, { recursive: true })
const temp = await mkdtemp(path.join(tmpdir(), 'wemux-session-canvas-browser-'))
const server = createWemuxServer({ databasePath: path.join(temp, 'server.sqlite'), administratorEmails: ['admin@example.com'], webStaticPath: path.join(root, 'apps/web/dist') })
let browser
try {
  const now = new Date().toISOString()
  const token = 'canvas-browser-session-token'
  const ids = { user: randomUUID(), credential: randomUUID(), team: randomUUID(), project: randomUUID(), workspace: randomUUID(), worker: randomUUID(), root: randomUUID(), child: randomUUID(), fork: randomUUID() }
  await server.store.transaction(async tx => {
    await tx.identity.saveUser({ id: ids.user, username: 'admin', email: 'admin@example.com', createdAt: now, status: 'active', authVersion: 0, statusChangedAt: now, deletedAt: null })
    await tx.identity.saveUserEmail({ emailNormalized: 'admin@example.com', userId: ids.user, emailDisplay: 'admin@example.com', createdAt: now })
    await tx.identity.saveLocalAccountCredential({ userId: ids.user, passwordHash: await hashPassword('Canvas-browser-123!'), updatedAt: now })
    await tx.identity.savePersonalAccessToken({ id: randomUUID(), userId: ids.user, name: 'Ticket 18 browser', scopes: ['read', 'write', 'execute', 'admin'], tokenHash: hashSecret(token), authVersion: 0, createdAt: now, expiresAt: '2099-01-01T00:00:00.000Z', lastUsedAt: null, revokedAt: null })
    await tx.identity.saveInstanceAdministrator({ userId: ids.user, email: 'admin@example.com', assignedAt: now, source: 'declared' })
    await tx.identity.saveTeam({ id: ids.team, name: '画布团队', createdAt: now })
    await tx.identity.saveMembership({ teamId: ids.team, userId: ids.user, role: 'owner', joinedAt: now })
    await tx.resources.saveProject({ id: ids.project, teamId: ids.team, ownerId: ids.user, name: '发布协作', shareScope: 'team', deletedAt: null })
    await tx.resources.saveWorkspace({ id: ids.workspace, projectId: ids.project, name: '发布工作区', spec: { kind: 'composite', memberWorkspaceIds: [] }, placements: [], deletedAt: null })
    const binding = modelId => ({ workspaceId: ids.workspace, agent: { workerId: ids.worker, agentKey: 'pi' }, modelId })
    await tx.resources.saveSession({ id: ids.root, projectId: ids.project, ownerId: ids.user, workspaceId: ids.workspace, title: '规划发布', shareScope: 'project', binding: binding('gpt-5'), runtimeState: 'idle', archivedAt: null, deletedAt: null })
    await tx.resources.saveSession({ id: ids.child, projectId: ids.project, ownerId: ids.user, workspaceId: ids.workspace, title: '审查发布风险', shareScope: 'project', binding: binding('gpt-5-mini'), runtimeState: 'running', archivedAt: null, deletedAt: null })
    await tx.resources.saveSessionFork({ id: ids.fork, projectId: ids.project, sourceSessionId: ids.root, sourceEventCursor: 0, targetSessionId: ids.child, createdBy: ids.user, createdAt: now, contextPolicy: 'through_cursor', creation: { requestId: 'browser-canvas-fork', fingerprint: 'browser-canvas' } })
  })
  const baseUrl = await server.listen(0)
  browser = await chromium.launch({ headless: true, executablePath: '/opt/data/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome' })
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  await page.addInitScript(({ sessionId }) => {
    const original = window.fetch.bind(window)
    window.fetch = async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
      const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
      if (method === 'GET' && url.includes(`/api/sessions/${sessionId}/messages`)) return new Response(JSON.stringify({ items: [], nextCursor: null, freshness: { status: 'synced' } }), { status: 200, headers: { 'content-type': 'application/json' } })
      if (method === 'GET' && url.includes(`/api/sessions/${sessionId}/approvals`)) return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
      return original(input, init)
    }
  }, { sessionId: ids.child })
  await page.goto(baseUrl)
  await page.getByLabel('账号或邮箱').fill('admin')
  await page.locator('#auth-password').fill('Canvas-browser-123!')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.waitForURL(/\/projects|\/app/)
  await page.goto(`${baseUrl}/projects/${ids.project}/overview`)
  await page.waitForTimeout(1500)
  if (!await page.getByRole('region', { name: '会话画布' }).isVisible().catch(() => false)) {
    console.error(JSON.stringify({ url: page.url(), body: await page.locator('body').innerText() }, null, 2))
  }
  await page.getByRole('region', { name: '会话画布' }).waitFor()
  const flow = page.locator('.react-flow')
  await flow.getByText('规划发布', { exact: true }).waitFor()
  await flow.getByText('审查发布风险', { exact: true }).waitFor()
  const nodes = await page.locator('.react-flow__node').count()
  const edges = await page.locator('.react-flow__edge').count()
  assert.equal(nodes, 2)
  assert.equal(edges, 1)
  await page.goto(`${baseUrl}/projects/${ids.project}/overview?session=${ids.child}&view=canvas`)
  await page.waitForURL(url => url.pathname.endsWith('/overview') && url.searchParams.get('session') === ids.child)
  await page.waitForTimeout(1500)
  await page.locator('.session-flow-node-interactive').waitFor()
  const childNode = page.locator('.session-flow-node-interactive:visible')
  const composer = childNode.getByLabel('消息内容')
  await composer.waitFor()
  assert.ok(await childNode.getByRole('button', { name: '发送', exact: true }).isVisible())
  assert.ok(await childNode.getByRole('button', { name: '收起为摘要' }).isVisible())
  assert.ok(((await childNode.boundingBox())?.height ?? 0) > 500)
  await composer.fill('在画布内继续执行')
  await childNode.getByRole('button', { name: '进入专注视图' }).waitFor()
  const shotState = await childNode.evaluate(element => ({ className: element.className, text: element.textContent, html: element.outerHTML.slice(0, 500) }))
  console.log(JSON.stringify({ shotState }, null, 2))
  const screenshot = path.join(evidenceDir, 'ticket-19-interactive-session-surface.png')
  const clip = await childNode.boundingBox()
  console.log(JSON.stringify({ clip }, null, 2))
  await page.screenshot({ path: screenshot, clip })
  await childNode.getByRole('button', { name: '进入专注视图' }).click()
  await page.waitForTimeout(1500)
  assert.match(await page.locator('body').innerText(), /审查发布风险/)
  await page.getByRole('button', { name: '返回画布' }).click()
  await page.waitForURL(url => url.pathname.endsWith('/overview') && url.searchParams.get('session') === ids.child && url.searchParams.get('view') === 'canvas')
  await page.locator('.session-flow-node-interactive:visible').getByRole('button', { name: '收起为摘要' }).click({ force: true })
  await page.locator('.session-flow-node-interactive:visible').waitFor({ state: 'hidden' })
  await page.reload()
  assert.equal(await page.locator('.session-flow-node-interactive:visible').count(), 0)
  const visibleSummary = page.locator('.session-flow-node:visible').filter({ hasText: '审查发布风险' })
  assert.equal(await visibleSummary.getByRole('button', { name: '展开对话' }).isVisible(), true)
  console.log(JSON.stringify({ ok: true, nodes, edges, interactiveComposer: true, composerInput: true, focusRoundTrip: true, summaryPreference: true, screenshot }, null, 2))
} finally {
  await browser?.close()
  await server.close()
  await rm(temp, { recursive: true, force: true })
}
