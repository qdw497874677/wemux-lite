/** Owned temporary Server and synthetic capability acceptance; no Worker/Agent execution.
 * npm run build:packages
 * node_modules/.bin/vite build apps/web --outDir /tmp/wemux-task-session-web
 * WEMUX_TASK_SESSION_WEB=/tmp/wemux-task-session-web node --import tsx apps/e2e/task-session-client-browser.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClusterClient } from '@wemux/web-client'
import { createWemuxServer } from '../server/src/server.ts'
import { provisionAdministrator } from './session.ts'
const { chromium } = await import(process.env.PLAYWRIGHT_CORE_PATH ?? '/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs')
const evidence = await mkdtemp(join(tmpdir(), 'wemux-task-session-browser-'))
const email = 'task-session-browser@example.test'
const app = createWemuxServer({ databasePath: join(evidence, 'server.sqlite'), administratorEmails: [email], mail: {}, google: {}, webStaticPath: process.env.WEMUX_TASK_SESSION_WEB ?? '/tmp/wemux-task-session-web' })
const origin = await app.listen(0)
let browser
try {
  const admin = await provisionAdministrator({ store: app.store, baseUrl: origin, email })
  await admin.api('/bootstrap', 'POST', {})
  const project = await admin.api('/projects', 'POST', { name: 'Browser task sessions', teamId: 'default-team' })
  const task = await admin.api(`/projects/${project.id}/tasks`, 'POST', { title: '原任务标题' })
  const other = await admin.api(`/projects/${project.id}/tasks`, 'POST', { title: '其他任务' })
  const assignment = { workspaceId: 'browser-workspace', workerId: 'browser-worker', agentKey: 'test', modelId: 'model' }
  await app.store.transaction(async tx => {
    await tx.resources.saveWorker({ id: assignment.workerId, teamId: project.teamId, ownerId: project.ownerId, name: 'Synthetic Worker', shareScope: 'team', connectionState: 'online', version: '1', platform: 'linux', lastSeenAt: new Date().toISOString(), capabilities: [{ agentKey: 'test', displayName: 'Test', version: '1', mode: 'execution', modelSwap: true, availability: { status: 'available' }, models: [{ modelId: 'model', displayName: 'Model', source: 'configured' }, { modelId: 'second', displayName: 'Second', source: 'configured' }] }] })
    await tx.resources.saveWorkspace({ id: assignment.workspaceId, projectId: project.id, name: 'Browser Workspace', spec: { kind: 'composite', memberWorkspaceIds: [] }, placements: [{ workerId: assignment.workerId, status: 'ready', failureReason: null, location: null }], deletedAt: null })
    for (const t of [task, other]) await tx.tasks.save({ ...(await tx.tasks.get(t.id)), assignee: assignment })
  })
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const page = await browser.newPage(), errors = [], posts = []
  page.on('pageerror', e => errors.push(e.message))
  const login = await page.request.post(`${origin}/api/auth/login`, { data: { login: email, password: admin.password } })
  assert.equal(login.status(), 200)
  const path = `/projects/${project.id}/tasks/${task.id}?tab=runs`
  let lose = true, hold = false, release, arrived
  await page.route(`**/api/projects/${project.id}/tasks/${task.id}/sessions*`, async route => {
    if (route.request().method() !== 'POST') return route.continue()
    const body = route.request().postDataJSON(), reply = await route.fetch(), data = await reply.json()
    posts.push({ body, status: reply.status(), data })
    if (lose) { lose = false; await route.abort('failed'); return }
    if (hold) { arrived?.(); await new Promise(r => { release = r }) }
    await route.fulfill({ response: reply })
  })
  await page.goto(origin + path)
  const create = page.getByRole('button', { name: '创建独立任务会话（不启动 Run）', exact: true })
  await create.click()
  await page.getByRole('button', { name: '重试原任务会话请求', exact: true }).waitFor()
  assert.equal(posts.length, 1); assert.equal(posts[0].status, 201); assert.equal(posts[0].data.created, true)
  const saved = await page.evaluate(() => Object.entries(sessionStorage).filter(([key]) => key.startsWith('wemux.task-session:')))
  assert.equal(saved.length, 1); assert.deepEqual(JSON.parse(saved[0][1]), posts[0].body)
  // Public mutations change the current resource, not its immutable creation receipt.
  await admin.api(`/sessions/${posts[0].data.session.id}`, 'PATCH', { title: '会话已改名' })
  await admin.api(`/sessions/${posts[0].data.session.id}/runtime/commands`, 'POST', { commandId: 'browser-model-change', name: 'set_model', arguments: { modelId: 'second' } })
  await app.store.transaction(async tx => tx.tasks.save({ ...(await tx.tasks.get(task.id)), title: '更改后的标题', assignee: { ...assignment, modelId: 'second' } }))
  await page.reload()
  await page.getByRole('button', { name: '重试原任务会话请求', exact: true }).click()
  await page.getByText(`已创建独立会话：${posts[0].data.session.id}`, { exact: false }).waitFor()
  assert.equal(posts.length, 2); assert.deepEqual(posts[1].body, posts[0].body)
  assert.equal(posts[1].data.created, false); assert.equal(posts[1].data.session.id, posts[0].data.session.id); assert.equal(posts[1].data.commandId, posts[0].data.commandId)
  assert.equal(posts[1].data.session.title, '会话已改名'); assert.equal(posts[1].data.session.binding.modelId, 'second')
  assert.equal(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('wemux.task-session:')).length), 0)
  assert.equal((await app.store.resources.listSessions()).length, 1)
  const discovery = await page.request.get(`${origin}/api/projects/${project.id}/tasks/${task.id}/sessions?workspaceId=${assignment.workspaceId}&archived=false`)
  assert.equal(discovery.status(), 200)
  const listed = await discovery.json()
  assert.equal(listed.items.length, 1); assert.equal(listed.items[0].id, posts[0].data.session.id); assert.equal(listed.items[0].access.canRead, true)
  assert.equal(listed.items[0].freshness.sessionId, listed.items[0].id)
  const shared = createClusterClient({ username: email, teamId: project.teamId, csrfToken: admin.csrfToken, email, instanceAdministrator: true }, () => {}, { origin, fetcher: (url, init) => fetch(url, { ...init, headers: { ...init.headers, Cookie: admin.cookie } }) })
  assert.equal((await shared.taskSessions(project.id, task.id, { workspaceId: assignment.workspaceId, archived: false }))[0].id, listed.items[0].id)
  shared.dispose()
  await page.screenshot({ path: join(evidence, 'replayed.png'), fullPage: true })
  // A new explicit click is a new logical intent. Delay its response, then move to another Task.
  hold = true
  const reached = new Promise(r => { arrived = r })
  await create.click(); await reached
  assert.notEqual(posts[2].body.requestId, posts[0].body.requestId); assert.equal(posts[2].body.title, '更改后的标题'); assert.equal(posts[2].body.modelId, 'second')
  // SPA navigation leaves the old request alive; the new Task must not display its result.
  await page.evaluate(url => { history.pushState({}, '', url); window.dispatchEvent(new PopStateEvent('popstate')) }, `/projects/${project.id}/tasks/${other.id}?tab=runs`)
  await page.getByRole('heading', { name: '其他任务', exact: true }).waitFor()
  release()
  await page.waitForTimeout(200)
  assert.equal(await page.getByText(`已创建独立会话：${posts[2].data.session.id}`, { exact: false }).count(), 0)
  assert.equal((await app.store.resources.listSessions()).length, 2)
  assert.deepEqual(errors, [])
  await page.screenshot({ path: join(evidence, 'other-task.png'), fullPage: true })
  // Actual TaskRuns unmount/remount while the first click waits on its real capability response.
  await app.store.transaction(async tx => tx.tasks.save({ ...(await tx.tasks.get(other.id)), assignee: { ...assignment, modelId: null } }))
  // SSE intentionally stays open; wait for the concrete initial capability response, not networkidle.
  const mountedCapability = page.waitForResponse(reply => new URL(reply.url()).pathname === `/api/workers/${assignment.workerId}/capabilities`)
  await page.reload()
  await mountedCapability
  await create.waitFor()
  const beforeRemountSessions = (await app.store.resources.listSessions()).length
  const beforeRemountCommands = (await app.store.commands.list({ limit: 1000 })).length
  const remountPosts = []
  await page.route(`**/api/projects/${project.id}/tasks/${other.id}/sessions*`, async route => {
    if (route.request().method() !== 'POST') return route.continue()
    const reply = await route.fetch(), data = await reply.json()
    remountPosts.push({ body: route.request().postDataJSON(), status: reply.status(), data })
    await route.fulfill({ response: reply })
  })
  let releaseCapability, capabilityArrived, capabilityCalls = 0
  const capabilityReached = new Promise(resolve => { capabilityArrived = resolve })
  await page.route(`**/api/workers/${assignment.workerId}/capabilities*`, async route => {
    capabilityCalls++
    const reply = await route.fetch()
    if (capabilityCalls === 1) {
      capabilityArrived()
      await new Promise(resolve => { releaseCapability = resolve })
    }
    await route.fulfill({ response: reply })
  })
  await create.click(); await capabilityReached
  await page.getByRole('button', { name: '详情', exact: true }).click()
  await page.getByRole('button', { name: '运行', exact: true }).click()
  await create.click()
  await page.getByRole('button', { name: '正在创建任务会话…', exact: true }).waitFor()
  assert.equal(remountPosts.length, 0, 'remounted caller joins capability lookup, not a second write')
  releaseCapability()
  await page.getByText('已创建独立会话：', { exact: false }).waitFor()
  assert.equal(capabilityCalls, 1)
  assert.equal(remountPosts.length, 1); assert.equal(remountPosts[0].status, 201)
  assert.equal((await app.store.resources.listSessions()).length, beforeRemountSessions + 1)
  assert.equal((await app.store.commands.list({ limit: 1000 })).length, beforeRemountCommands + 1)
  const remountEvidence = { capabilityCalls, beforeRemountSessions, afterRemountSessions: beforeRemountSessions + 1, beforeRemountCommands, afterRemountCommands: beforeRemountCommands + 1, posts: remountPosts }
  await page.screenshot({ path: join(evidence, 'remount.png'), fullPage: true })
  assert.deepEqual(errors, [])
  await writeFile(join(evidence, 'result.json'), JSON.stringify({ posts, remountEvidence, errors, checks: ['legacy actual button -> real Server 201', 'lost response persisted before send', 'refresh after public Session title/model changes reconciles identical body/session/command and clears pending', 'actual TaskRuns remount during held capability lookup yields one Session/command', 'explicit next intent', 'late response does not update other Task'], runtime: 'synthetic capability only; no Worker execution' }, null, 2))
  console.log(`Task Session browser acceptance passed: ${evidence}`)
} catch (error) {
  await writeFile(join(evidence, 'failure.txt'), String(error.stack ?? error))
  console.error(`Browser evidence: ${evidence}`)
  throw error
} finally { await browser?.close(); await app.close() }
