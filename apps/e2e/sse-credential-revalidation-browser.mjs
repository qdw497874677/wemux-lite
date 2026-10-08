// Run: node --import tsx apps/e2e/sse-credential-revalidation-browser.mjs
// Real Server/SQLite/Cookie/Chromium; no route mocks, external network or Agent calls.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { sseCredentialFixture, password } from '../server/src/test/fixtures/sse-credential.ts'
import { seedLocalAccount } from '../server/src/test/fixtures/administrator.ts'
const { chromium } = await import(process.env.PLAYWRIGHT_CORE_PATH ?? '/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs')
const output = '/tmp/wemux-09e2-browser'
await mkdir(output, { recursive: true })
const f = await sseCredentialFixture()
let browser
const results = [], network = []
try {
  const member = await seedLocalAccount(f.app.store, { username: 'sse-reader', email: 'sse-reader@example.test', password })
  await f.app.store.transaction(async tx => {
    await tx.identity.saveMembership({ teamId: f.project.teamId, userId: member.id, role: 'member', joinedAt: new Date().toISOString() })
    await tx.identity.saveProjectGrant({ projectId: f.project.id, userId: member.id, role: 'contributor' })
    await tx.identity.saveSessionGrant({ sessionId: f.session.id, userId: member.id })
    await tx.resources.saveSession({ ...f.session, shareScope: 'selected-members' })
  })
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome', headless: true, args: ['--no-sandbox'] })
  const api = (page, path, method = 'GET', body) => page.evaluate(async ({ path, method, body }) => {
    const me = await fetch('/api/auth/me').then(r => r.json())
    const response = await fetch(path, { method, headers: { 'content-type': 'application/json', 'x-csrf-token': me.csrfToken ?? '' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, data: response.status === 204 ? null : await response.json() }
  }, { path, method, body })
  async function login(page, username) {
    await page.goto(`${f.base}/next/`)
    await page.getByLabel('邮箱或用户名').fill(username)
    await page.getByLabel('密码', { exact: true }).fill(password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.waitForURL('**/next/projects')
  }
  for (const [viewportName, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    for (const mutation of ['device-revoke', 'disable']) {
      const victimContext = await browser.newContext({ viewport }), deviceContext = await browser.newContext({ viewport })
      try {
        const page = await victimContext.newPage(), device = await deviceContext.newPage()
        page.on('response', response => { if (new URL(response.url()).pathname.startsWith('/api/')) network.push({ at: new Date().toISOString(), viewport: viewportName, mutation, path: new URL(response.url()).pathname + new URL(response.url()).search, status: response.status() }) })
        await login(page, 'sse-reader')
        await login(device, mutation === 'disable' ? 'deployer' : 'sse-reader')
        const current = await api(page, '/api/auth/me')
        const originalId = current.data.session.id
        await page.goto(`${f.base}/next/projects/${f.project.id}?task=${f.session.taskId}`)
        await page.getByText('当前获权会话：1 个', { exact: true }).waitFor()
        const row = page.locator(`[data-session-id="${f.session.id}"]`)
        await row.getByText('可写会话', { exact: true }).waitFor()
        assert.match(await row.innerText(), /历史新鲜度：.*连续序号/)
        await row.getByRole('button', { name: `查看会话：${f.session.title}`, exact: true }).click()
        await page.waitForFunction(() => document.querySelector('[data-conversation-session]')?.textContent.includes('监听更新中'))
        await page.waitForFunction(() => document.querySelector('[data-conversation-session]')?.textContent.includes('元数据新鲜度'))
        assert.ok(network.some(entry => entry.viewport === viewportName && entry.mutation === mutation && entry.path.includes('/stream?fromSeq=') && entry.status === 200), 'UI subscribed through shared web-client')
        await page.screenshot({ path: `${output}/${viewportName}-${mutation}-session.png`, fullPage: true })
        await page.evaluate(paths => {
          window.sseEvidence = {}
          for (const [kind, path] of Object.entries(paths)) {
            const state = window.sseEvidence[kind] = { status: null, type: '', text: '', ended: false, failed: false }
            void (async () => {
              try {
                const response = await fetch(path)
                state.status = response.status; state.type = response.headers.get('content-type')
                const reader = response.body.getReader()
                for (;;) { const part = await reader.read(); if (part.done) break; state.text += new TextDecoder().decode(part.value) }
              } catch { state.failed = true }
              finally { state.ended = true }
            })()
          }
        }, f.paths)
        await page.waitForFunction(() => Object.values(window.sseEvidence).every(s => s.status === 200 && s.text.length > 0))
        const identitiesBefore = await f.app.store.identity.getIdentityRecords()
        const before = Date.now()
        const result = mutation === 'device-revoke'
          ? await api(device, `/api/auth/sessions/${originalId}`, 'DELETE')
          : await api(device, `/api/auth/account/users/${member.id}/disable`, 'POST', {})
        assert.equal(result.status, mutation === 'device-revoke' ? 204 : 200)
        await page.waitForFunction(() => Object.values(window.sseEvidence).every(s => s.ended), { timeout: 22_000 })
        const streams = await page.evaluate(() => window.sseEvidence)
        for (const [kind, state] of Object.entries(streams)) {
          assert.match(state.type, /text\/event-stream/)
          assert.equal(state.failed, kind === 'session' || kind === 'project')
          if (kind === 'canvas') assert.equal(state.text.match(/event: authorization\ndata: {"status":"revoked"}/g)?.length, 1)
        }
        // Observe automatic UI invalidation before any manual reconnect request.
        await page.getByRole('heading', { name: '登录控制台' }).waitFor({ timeout: 20_000 })
        const uiFailures = network.filter(entry => entry.viewport === viewportName && entry.mutation === mutation && entry.status === 401 && Date.parse(entry.at) >= before)
        assert.ok(uiFailures.length > 0, 'automatic UI request observed revoked credential')
        if (mutation === 'disable') {
          assert.ok(uiFailures.some(entry => entry.path.includes('/stream?fromSeq=')), 'UI Session subscription retried and received 401')
          const identitiesAfter = await f.app.store.identity.getIdentityRecords()
          assert.deepEqual(identitiesAfter.memberships, identitiesBefore.memberships)
          assert.deepEqual(identitiesAfter.projectGrants, identitiesBefore.projectGrants)
          assert.deepEqual(identitiesAfter.sessionGrants, identitiesBefore.sessionGrants)
        }
        const uiStreamRequests = () => network.filter(entry => entry.viewport === viewportName && entry.mutation === mutation && entry.path.includes('/stream?fromSeq=')).length
        const disposedCount = uiStreamRequests()
        await page.waitForTimeout(1600)
        assert.equal(uiStreamRequests(), disposedCount, 'disposed UI did not reconnect during observation window')
        const reconnect = await page.evaluate(async paths => Promise.all(Object.values(paths).map(async path => (await fetch(path)).status)), f.paths)
        assert.deepEqual(reconnect, [401, 401, 401, 401])
        assert.equal(await page.locator('[data-session-id]').count(), 0)
        assert.equal(await page.getByText('SSE credential', { exact: true }).count(), 0)
        const screenshot = `${output}/${viewportName}-${mutation}-closed.png`
        await page.screenshot({ path: screenshot, fullPage: true })
        if (mutation === 'device-revoke') assert.equal((await api(device, '/api/auth/me')).status, 200)
        else {
          assert.equal((await api(device, `/api/auth/account/users/${member.id}/restore`, 'POST', {})).status, 200)
          assert.equal((await page.evaluate(() => fetch('/api/auth/me').then(r => r.status))), 401)
          await login(page, 'sse-reader')
          assert.equal((await api(page, `/api/sessions/${f.session.id}`)).status, 200)
        }
        results.push({ viewport: viewportName, mutation, passed: true, closedAfterMs: Date.now() - before, screenshot, uiFailures, disposedObservationMs: 1600, streams })
        console.log(`PASS ${viewportName} ${mutation}: four SSE contracts, reconnect 401, UI cache retired`)
      } finally { await victimContext.close(); await deviceContext.close() }
    }
  }
  await writeFile(`${output}/result.json`, JSON.stringify({ utc: new Date().toISOString(), pass: results.length, results, network }, null, 2))
  console.log(`pass ${results.length}; screenshots and sanitized network/frames: ${output}`)
} finally { await browser?.close(); await f.app.close() }
