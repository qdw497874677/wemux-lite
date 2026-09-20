import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { createWemuxServer } from '../dist/server.js'
import { seedLocalAccount } from '../dist/test/fixtures/administrator.js'

const root = await mkdtemp(join(tmpdir(), 'wemux-project-access-browser-'))
const password = 'correct horse battery staple'
const app = createWemuxServer({ databasePath: join(root, 'server.sqlite'), webStaticPath: new URL('../../web/dist', import.meta.url).pathname, administratorEmails: ['owner@example.com'] })
const owner = await seedLocalAccount(app.store, { username: 'owner', email: 'owner@example.com', password })
const viewer = await seedLocalAccount(app.store, { username: 'viewer', email: 'viewer@example.com', password })
const contributor = await seedLocalAccount(app.store, { username: 'contributor', email: 'contributor@example.com', password })
const at = new Date().toISOString()
let teamId = '', projectId = ''
await app.store.transaction(async tx => {
  teamId = crypto.randomUUID(); projectId = crypto.randomUUID()
  await tx.identity.saveTeam({ id: teamId, name: 'Browser Team', createdAt: at })
  for (const user of [owner, viewer, contributor]) await tx.identity.saveMembership({ teamId, userId: user.id, role: user.id === owner.id ? 'owner' : 'member', joinedAt: at })
  await tx.resources.saveProject({ id: projectId, teamId, ownerId: owner.id, name: 'Authorization Project', shareScope: 'selected-members', deletedAt: null })
  await tx.identity.saveProjectGrant({ projectId, userId: viewer.id, role: 'viewer' })
  await tx.identity.saveProjectGrant({ projectId, userId: contributor.id, role: 'contributor' })
})
const base = await app.listen(0)
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
async function login(username) {
  const page = await browser.newPage()
  const response = await page.goto(base)
  if (!response?.ok()) throw new Error(`Web entry failed: ${response?.status()} ${await page.content()}`)
  await page.waitForTimeout(1000)
  const loginInput = page.getByLabel('账号或邮箱')
  if (!await loginInput.count()) throw new Error(`Login form missing at ${page.url()}: ${await page.content()}`)
  await loginInput.fill(username)
  await page.locator('#auth-password').fill(password)
  await page.getByRole('button', { name: '登录' }).click()
  await page.getByText('项目', { exact: true }).first().waitFor()
  return page
}
try {
  const ownerPage = await login('owner')
  await ownerPage.goto(`${base}/projects/${projectId}/settings`)
  await ownerPage.getByRole('heading', { name: '项目访问' }).waitFor()
  await ownerPage.getByText('指定成员', { exact: true }).waitFor()
  await ownerPage.getByText('viewer', { exact: true }).last().waitFor()
  await ownerPage.getByText('contributor', { exact: true }).last().waitFor()

  const viewerPage = await login('viewer')
  await viewerPage.goto(`${base}/projects/${projectId}/settings`)
  await viewerPage.getByText('你拥有 viewer 权限').waitFor()
  await viewerPage.goto(`${base}/projects/${projectId}/board`)
  const viewerResponse = await viewerPage.request.post(`${base}/api/projects/${projectId}/tasks?teamId=${teamId}`, { data: { title: 'Viewer denied' } })
  assert.equal(viewerResponse.status(), 403)

  const contributorPage = await login('contributor')
  await contributorPage.goto(`${base}/projects/${projectId}/board`)
  const contributorResponse = await contributorPage.evaluate(async ({ projectId, teamId }) => {
    const account = await fetch('/api/auth/me').then(response => response.json())
    const response = await fetch(`/api/projects/${projectId}/tasks?teamId=${teamId}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': account.csrfToken }, body: JSON.stringify({ title: 'Browser contributor task' }) })
    return { status: response.status, text: await response.text() }
  }, { projectId, teamId })
  assert.equal(contributorResponse.status, 201, contributorResponse.text)
  await contributorPage.reload()
  await contributorPage.getByText('Browser contributor task', { exact: true }).waitFor()
  console.log(JSON.stringify({ ok: true, checkpoints: ['owner access settings', 'viewer read-only', 'viewer write denied', 'contributor task create'] }, null, 2))
} finally {
  await browser.close()
  await app.close()
  await rm(root, { recursive: true, force: true })
}
