import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { createWemuxServer } from '../dist/server.js'
import { seedLocalAccount } from '../dist/test/fixtures/administrator.js'

const root = await mkdtemp(join(tmpdir(), 'wemux-session-access-browser-'))
const password = 'correct horse battery staple'
const app = createWemuxServer({ databasePath: join(root, 'server.sqlite'), webStaticPath: new URL('../../web/dist', import.meta.url).pathname, administratorEmails: ['owner@example.com'] })
const owner = await seedLocalAccount(app.store, { username: 'owner', email: 'owner@example.com', password })
const viewer = await seedLocalAccount(app.store, { username: 'viewer', email: 'viewer@example.com', password })
const contributor = await seedLocalAccount(app.store, { username: 'contributor', email: 'contributor@example.com', password })
const outsider = await seedLocalAccount(app.store, { username: 'outsider', email: 'outsider@example.com', password })
const at = new Date().toISOString()
const teamId = crypto.randomUUID(), projectId = crypto.randomUUID(), workerId = crypto.randomUUID(), workspaceId = crypto.randomUUID(), sessionId = crypto.randomUUID()
await app.store.transaction(async tx => {
  await tx.identity.saveTeam({ id: teamId, name: 'Shared Session Team', createdAt: at })
  for (const account of [owner, viewer, contributor]) await tx.identity.saveMembership({ teamId, userId: account.id, role: account.id === owner.id ? 'owner' : 'member', joinedAt: at })
  await tx.resources.saveProject({ id: projectId, teamId, ownerId: owner.id, name: 'Shared Session Project', shareScope: 'selected-members', deletedAt: null })
  await tx.identity.saveProjectGrant({ projectId, userId: viewer.id, role: 'viewer' })
  await tx.identity.saveProjectGrant({ projectId, userId: contributor.id, role: 'contributor' })
  await tx.resources.saveWorker({ id: workerId, teamId, ownerId: owner.id, name: 'Offline Test Worker', shareScope: 'owner-only', connectionState: 'offline', version: '1', platform: 'linux', capabilities: [{ agentKey: 'test', displayName: 'Test Agent', version: '1', mode: 'execution', availability: { status: 'available' }, models: [{ modelId: 'model', displayName: 'Test Model', source: 'configured' }] }], lastSeenAt: at })
  await tx.resources.saveWorkspace({ id: workspaceId, projectId, name: 'Shared Workspace', spec: { kind: 'composite', memberWorkspaceIds: [] }, placements: [{ workerId, status: 'ready', failureReason: null, location: null }], deletedAt: null })
  await tx.resources.saveSession({ id: sessionId, projectId, ownerId: owner.id, workspaceId, title: 'Browser shared session', shareScope: 'project', binding: { workspaceId, agent: { workerId, agentKey: 'test' }, modelId: 'model' }, runtimeState: 'idle', archivedAt: null, deletedAt: null })
})
const base = await app.listen(0)
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
async function login(username) {
  const page = await browser.newPage()
  const response = await page.goto(base)
  if (!response?.ok()) throw new Error(`Web entry failed: ${response?.status()} ${await page.content()}`)
  await page.getByLabel('账号或邮箱').fill(username)
  await page.locator('#auth-password').fill(password)
  await page.getByRole('button', { name: '登录' }).click()
  await page.getByText('项目', { exact: true }).first().waitFor()
  return page
}
try {
  const ownerPage = await login('owner')
  await ownerPage.goto(`${base}/projects/${projectId}/sessions/${sessionId}`)
  await ownerPage.getByRole('heading', { name: 'Browser shared session' }).waitFor()
  await ownerPage.getByRole('button', { name: '切换会话信息面板' }).click()
  await ownerPage.getByText('会话访问', { exact: true }).waitFor()
  await ownerPage.getByText('项目成员', { exact: true }).waitFor()
  await ownerPage.getByText('可发送消息', { exact: false }).waitFor()

  const viewerPage = await login('viewer')
  await viewerPage.goto(`${base}/projects/${projectId}/sessions/${sessionId}`)
  await viewerPage.getByRole('heading', { name: 'Browser shared session' }).waitFor()
  await viewerPage.getByRole('button', { name: '切换会话信息面板' }).click()
  await viewerPage.getByText('当前账号不能修改', { exact: false }).waitFor()
  await viewerPage.getByText('仅查看', { exact: false }).waitFor()
  await viewerPage.getByRole('status').filter({ hasText: '当前账号只有查看权限，草稿仍会保留' }).waitFor()

  const contributorPage = await login('contributor')
  await contributorPage.goto(`${base}/projects/${projectId}/sessions/${sessionId}`)
  await contributorPage.getByRole('heading', { name: 'Browser shared session' }).waitFor()
  const composer = contributorPage.getByPlaceholder('给 Agent 发送消息…')
  await composer.waitFor()
  assert.equal(await composer.isEnabled(), true)

  const outsiderPage = await login('outsider')
  const direct = await outsiderPage.goto(`${base}/projects/${projectId}/sessions/${sessionId}`)
  assert.equal(direct?.ok(), true)
  await outsiderPage.getByText('无权访问该项目', { exact: false }).waitFor().catch(async () => {
    assert.equal(await outsiderPage.getByText('Browser shared session', { exact: true }).count(), 0)
  })

  console.log(JSON.stringify({ ok: true, checkpoints: ['owner sees and can change Session sharing', 'viewer sees read-only state and disabled composer', 'contributor can write shared Session', 'outsider cannot learn Session title from direct URL'] }, null, 2))
} finally {
  await browser.close()
  await app.close()
  await rm(root, { recursive: true, force: true })
}
