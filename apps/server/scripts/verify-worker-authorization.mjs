import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { createWemuxServer } from '../dist/server.js'
import { seedLocalAccount } from '../dist/test/fixtures/administrator.js'

const root = await mkdtemp(join(tmpdir(), 'wemux-worker-access-browser-'))
const password = 'correct horse battery staple'
const app = createWemuxServer({ databasePath: join(root, 'server.sqlite'), webStaticPath: new URL('../../web/dist', import.meta.url).pathname, administratorEmails: ['owner@example.com'] })
const owner = await seedLocalAccount(app.store, { username: 'owner', email: 'owner@example.com', password })
const user = await seedLocalAccount(app.store, { username: 'worker-user', email: 'worker-user@example.com', password })
const manager = await seedLocalAccount(app.store, { username: 'worker-manager', email: 'worker-manager@example.com', password })
const outsider = await seedLocalAccount(app.store, { username: 'outsider', email: 'outsider@example.com', password })
const at = new Date().toISOString()
const teamId = crypto.randomUUID(), foreignTeamId = crypto.randomUUID(), projectId = crypto.randomUUID(), workerId = crypto.randomUUID()
await app.store.transaction(async tx => {
  await tx.identity.saveTeam({ id: teamId, name: 'Worker Access Team', createdAt: at })
  await tx.identity.saveTeam({ id: foreignTeamId, name: 'Foreign Team', createdAt: at })
  for (const account of [owner, user, manager]) await tx.identity.saveMembership({ teamId, userId: account.id, role: account.id === owner.id ? 'owner' : 'member', joinedAt: at })
  await tx.identity.saveMembership({ teamId: foreignTeamId, userId: outsider.id, role: 'owner', joinedAt: at })
  await tx.resources.saveProject({ id: projectId, teamId, ownerId: owner.id, name: 'Execution Project', shareScope: 'selected-members', deletedAt: null })
  await tx.identity.saveProjectGrant({ projectId, userId: user.id, role: 'contributor' })
  await tx.resources.saveWorker({
    id: workerId, teamId, ownerId: owner.id, name: 'Authorized Worker', shareScope: 'selected-members', connectionState: 'online', version: '1.0.0', platform: 'linux', lastSeenAt: at,
    capabilities: [{ agentKey: 'test', displayName: 'Test Agent', version: '1', mode: 'execution', availability: { status: 'available' }, models: [{ modelId: 'model', displayName: 'Test Model', source: 'configured' }] }],
  })
  await tx.identity.saveWorkerGrant({ workerId, userId: user.id, role: 'use' })
  await tx.identity.saveWorkerGrant({ workerId, userId: manager.id, role: 'manage' })
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
async function api(page, path, method = 'GET', body) {
  return page.evaluate(async ({ path, method, body }) => {
    const account = await fetch('/api/auth/me').then(response => response.json())
    const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json', ...(method === 'GET' ? {} : { 'X-CSRF-Token': account.csrfToken }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, text: await response.text() }
  }, { path, method, body })
}
try {
  const ownerPage = await login('owner')
  await ownerPage.goto(`${base}/cluster`)
  await ownerPage.getByText('Authorized Worker', { exact: true }).waitFor()
  await ownerPage.getByText('权限 owner', { exact: false }).waitFor()
  await ownerPage.getByText('节点访问权限', { exact: true }).click()
  await ownerPage.getByText('共享范围', { exact: true }).waitFor()
  await ownerPage.getByRole('button', { name: '撤销' }).waitFor()

  const userPage = await login('worker-user')
  await userPage.goto(`${base}/cluster`)
  await userPage.getByText('Authorized Worker', { exact: true }).waitFor()
  await userPage.getByText('你拥有 use 权限，可以选择该节点执行，但不能管理共享范围或成员授权。', { exact: true }).waitFor()
  assert.equal(await userPage.getByRole('button', { name: '撤销' }).count(), 0)
  assert.equal(await userPage.getByRole('button', { name: '添加工作节点' }).count(), 0)
  assert.equal(await userPage.getByRole('tab', { name: /命令交付/ }).count(), 0)

  const managerPage = await login('worker-manager')
  await managerPage.goto(`${base}/cluster`)
  await managerPage.getByText('Authorized Worker', { exact: true }).waitFor()
  await managerPage.getByText('节点访问权限', { exact: true }).click()
  await managerPage.getByText('worker-user', { exact: true }).waitFor()
  await managerPage.getByRole('button', { name: '撤销' }).waitFor()

  const outsiderPage = await login('outsider')
  await outsiderPage.goto(`${base}/cluster`)
  await outsiderPage.getByText('当前账号没有可使用的工作节点。请联系节点 owner 或 manager 授予 use 权限。', { exact: true }).waitFor()
  assert.equal(await outsiderPage.getByText('Authorized Worker', { exact: true }).count(), 0)

  const allowed = await api(userPage, '/api/workspaces', 'POST', { projectId, workerId, name: 'Allowed browser placement', source: 'empty' })
  assert.equal(allowed.status, 201, allowed.text)
  const revoked = await api(ownerPage, `/api/workers/${workerId}/grants/${user.id}`, 'DELETE')
  assert.equal(revoked.status, 204, revoked.text)
  const denied = await api(userPage, '/api/workspaces', 'POST', { projectId, workerId, name: 'Denied browser placement', source: 'empty' })
  assert.equal(denied.status, 404, denied.text)

  console.log(JSON.stringify({ ok: true, checkpoints: ['owner manages Worker access', 'use member sees only authorized Worker', 'use member has no management controls', 'manager sees grants and management controls', 'outsider sees no Worker metadata', 'Project contributor plus Worker use creates placement', 'revoked Worker use blocks placement'] }, null, 2))
} finally {
  await browser.close()
  await app.close()
  await rm(root, { recursive: true, force: true })
}
