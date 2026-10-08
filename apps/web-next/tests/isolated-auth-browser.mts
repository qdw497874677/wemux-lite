// Real HTTP + explicitly selected new-UI dist, synthetic identities only. No deployed instance is contacted.
// Run: node --import tsx apps/web-next/tests/isolated-auth-browser.mts
// --negative-control deliberately grants the private project to the viewer; the exact-ID gate must fail.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve, relative, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { ProjectId, TeamId, Timestamp } from '@wemux/domain'
import { createWemuxServer } from '../../server/src/server.ts'
import { administratorEmail, seedLocalAccount } from '../../server/src/test/fixtures/administrator.ts'
import { launchAcceptanceBrowser } from './acceptance-runtime.mjs'
import { runBrowserAcceptance } from './browser-cleanup.mjs'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const dist = resolve(root, process.env.WEMUX_NEXT_DIST_PATH ?? 'apps/web-next/dist')
const distKey = relative(root, dist)
const distKind = process.env.WEMUX_NEXT_DIST_PATH ? 'explicit-dist-override' : 'existing-dist-default'
const evidence = process.env.WEMUX_NEXT_EVIDENCE ?? '/tmp/wemux-ticket01-isolated-auth/browser'
// Keep even synthetic screenshots/results outside the repository.
assert.ok(resolve(evidence).startsWith('/tmp/'), 'Evidence must be under /tmp/')
await mkdir(evidence, { recursive: true, mode: 0o700 })
const negativeControl = process.argv.includes('--negative-control')
const ttlMs = 3000
const password = 'synthetic-isolated-browser-password'
const checks: string[] = [], responses: { path: string; status: number }[] = []
const diagnostics: { type: string; path?: string; message?: string; status?: number; expected: boolean }[] = []
const fingerprints: Record<string, string> = {}
const cleanup = { browserClosed: false, serverClosed: false }
let app: ReturnType<typeof createWemuxServer> | undefined
let browser: Awaited<ReturnType<typeof launchAcceptanceBrowser>> | undefined
let step = 'setup'
async function fingerprint(directory: string) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await fingerprint(path)
    else fingerprints[relative(root, path)] = createHash('sha256').update(await readFile(path)).digest('hex')
  }
}
await runBrowserAcceptance({
  runScenarios: async () => {
    await fingerprint(dist)
    for (const path of ['apps/web-next/src', 'apps/server/src', 'packages/web-client/src']) await fingerprint(resolve(root, path))
    app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [administratorEmail], webNextStaticPath: dist, adminSessionTtlMs: ttlMs, mail: {}, google: {} })
    const owner = await seedLocalAccount(app.store, { username: 'isolated-owner', email: 'owner@fixture.invalid', password })
    const viewer = await seedLocalAccount(app.store, { username: 'isolated-viewer', email: 'viewer@fixture.invalid', password })
    const outsider = await seedLocalAccount(app.store, { username: 'isolated-outsider', email: 'outsider@fixture.invalid', password })
    const teamId = randomUUID() as TeamId, foreignTeamId = randomUUID() as TeamId
    const at = new Date().toISOString() as Timestamp
    const projects = [
      { id: randomUUID() as ProjectId, teamId, ownerId: owner.id, name: '隔离验收 私有项目', shareScope: 'owner-only' as const, deletedAt: null },
      { id: randomUUID() as ProjectId, teamId, ownerId: owner.id, name: '隔离验收 显式授权', shareScope: 'selected-members' as const, deletedAt: null },
      { id: randomUUID() as ProjectId, teamId, ownerId: owner.id, name: '隔离验收 团队共享', shareScope: 'team' as const, deletedAt: null },
      { id: randomUUID() as ProjectId, teamId: foreignTeamId, ownerId: outsider.id, name: '隔离验收 外部项目', shareScope: 'team' as const, deletedAt: null },
    ]
    const [privateProject, granted, shared, foreign] = projects
    await app.store.transaction(async tx => {
      await tx.identity.saveTeam({ id: teamId, name: 'Synthetic Alpha', createdAt: at })
      await tx.identity.saveTeam({ id: foreignTeamId, name: 'Synthetic Beta', createdAt: at })
      await tx.identity.saveMembership({ teamId, userId: owner.id, role: 'owner', joinedAt: at })
      await tx.identity.saveMembership({ teamId, userId: viewer.id, role: 'member', joinedAt: at })
      await tx.identity.saveMembership({ teamId: foreignTeamId, userId: outsider.id, role: 'owner', joinedAt: at })
      for (const project of projects) await tx.resources.saveProject(project)
      await tx.identity.saveProjectGrant({ projectId: granted!.id, userId: viewer.id, role: 'viewer' })
      if (negativeControl) {
        await tx.resources.saveProject({ ...privateProject!, shareScope: 'selected-members' })
        await tx.identity.saveProjectGrant({ projectId: privateProject!.id, userId: viewer.id, role: 'viewer' })
      }
    })
    const base = await app.listen(0, '127.0.0.1')
    assert.notEqual(new URL(base).port, '8010')
    assert.notEqual(new URL(base).port, '8004')
    const html = await fetch(`${base}/next/`)
    assert.equal(html.status, 200)
    assert.equal(createHash('sha256').update(Buffer.from(await html.arrayBuffer())).digest('hex'), fingerprints[`${distKey}/index.html`])
    for (const path of Object.keys(fingerprints).filter(path => path.startsWith(`${distKey}/assets/`))) {
      const response = await fetch(`${base}/next/${path.slice(distKey.length + 1)}`)
      assert.equal(response.status, 200)
      assert.equal(createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'), fingerprints[path])
    }
    checks.push('Real server /next/ HTML and assets equal fingerprinted selected dist; no deployment')
    browser = await launchAcceptanceBrowser()
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page = await context.newPage()
    page.setDefaultTimeout(8000)
    const statuses = new WeakMap()
    page.on('response', response => {
      const path = new URL(response.url()).pathname
      statuses.set(response.request(), response.status())
      responses.push({ path, status: response.status() })
    })
    page.on('pageerror', error => diagnostics.push({ type: 'pageerror', message: error.message, expected: false }))
    page.on('console', message => {
      if (message.type() === 'error') diagnostics.push({ type: 'console', message: message.text(), expected: /Failed to load resource: the server responded with a status of 401/.test(message.text()) })
    })
    page.on('requestfailed', request => {
      const path = new URL(request.url()).pathname, status = statuses.get(request), reason = request.failure()?.errorText
      const expected = reason === 'net::ERR_ABORTED' && ((status === 401 && ['/api/auth/me', '/api/projects'].includes(path)) || (status === 204 && path === '/api/auth/logout'))
      diagnostics.push({ type: 'requestfailed', path, status, message: reason, expected })
    })
    async function settle() { await page.waitForLoadState('networkidle') }
    async function login(username: string, heading = '项目') {
      await page.getByRole('heading', { name: '登录控制台' }).waitFor()
      await page.getByLabel('邮箱或用户名').fill(username)
      await page.getByLabel('密码', { exact: true }).fill(password)
      const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/login' && response.request().method() === 'POST')
      await page.getByRole('button', { name: '登录', exact: true }).click()
      const account = await response
      assert.equal(account.status(), 200)
      const payload = await account.json()
      await page.getByRole('heading', { name: heading, exact: true }).waitFor()
      await settle()
      // Do not call /auth/me here: it rotates CSRF and would invalidate the UI's write token.
      assert.equal(payload.user.username, username)
      assert.equal(payload.instanceAdministrator, false)
    }
    async function exactProjects(expected: typeof projects) {
      for (const query of ['', `?teamId=${teamId}`]) {
        const response = await context.request.get(`${base}/api/projects${query}`)
        assert.equal(response.status(), 200)
        const payload = await response.json()
        assert.deepEqual(payload.items.map((project: { id: string }) => project.id).sort(), expected.map(project => project.id).sort(), `Exact authorized IDs at ${step}`)
      }
      assert.deepEqual((await page.locator('.project-list .project-name strong').allTextContents()).sort(), expected.map(project => project.name).sort())
      for (const project of projects.filter(project => !expected.includes(project))) assert.equal(await page.getByText(project.name, { exact: true }).count(), 0)
    }
    step = 'owner'
    await page.goto(`${base}/next/projects`)
    await page.getByRole('heading', { name: '登录控制台' }).waitFor()
    await settle()
    assert.equal(await page.getByRole('status').filter({ hasText: '登录会话已过期' }).count(), 0)
    checks.push('Fresh anonymous first visit has no expiry warning')
    await login(owner.username)
    await exactProjects(projects.slice(0, 3))
    assert.equal((await context.request.get(`${base}/api/projects/${privateProject!.id}`)).status(), 200)
    assert.equal((await context.request.get(`${base}/api/projects/${foreign!.id}`)).status(), 404)
    checks.push('Owner: exact three authorized API IDs and UI projects, private detail 200, foreign detail 404')
    await page.getByRole('button', { name: '退出登录', exact: true }).click()
    await page.getByRole('heading', { name: '登录控制台' }).waitFor()
    await settle()
    assert.equal(await page.locator('.project-list').count(), 0)
    await page.reload()
    await page.getByRole('heading', { name: '登录控制台' }).waitFor()
    await settle()
    assert.equal(await page.getByRole('status').filter({ hasText: '登录会话已过期' }).count(), 0)
    checks.push('Explicit logout then reload has no expiry warning')
    step = 'viewer'
    await login(viewer.username)
    await exactProjects([granted!, shared!])
    for (const project of [granted!, shared!]) assert.equal((await context.request.get(`${base}/api/projects/${project.id}`)).status(), 200)
    await page.screenshot({ path: `${evidence}/viewer-projects.png`, fullPage: true })
    checks.push('Same browser owner→logout→viewer: exact granted/shared API IDs and rendered names, no stale owner-only or foreign content')
    for (const project of [privateProject!, foreign!]) {
      step = `concealed-${project === privateProject ? 'private' : 'foreign'}`
      const detail = await context.request.get(`${base}/api/projects/${project.id}?teamId=${project.teamId}`)
      assert.equal(detail.status(), 404)
      assert.equal(JSON.stringify(await detail.json()).includes(project.name), false)
      await page.goto(`${base}/next/projects/${project.id}`)
      await page.getByRole('heading', { name: '项目不存在或当前账号无权访问' }).waitFor()
      assert.equal(await page.getByRole('heading', { name: project.name, exact: true }).count(), 0)
      await settle()
    }
    checks.push('Known private/foreign details concealed with real HTTP 404; new-UI direct deep links reject both')
    const returnPath = `/next/projects/${granted!.id}?from=expiry#details`
    await page.goto(`${base}${returnPath}`)
    await page.getByRole('heading', { name: granted!.name, exact: true }).waitFor()
    await settle()
    step = 'expiry'
    assert.equal((await context.request.get(`${base}/api/auth/me`)).status(), 200)
    const cookieBefore = (await context.cookies()).find(cookie => cookie.name === 'wemux_login_session')
    assert.ok(cookieBefore, 'A real issued Cookie is present before idle expiry')
    const idleStart = Date.now()
    await delay(ttlMs + 500)
    assert.ok(Date.now() - idleStart >= ttlMs)
    // Chromium honors the real server's cookie expiry. Also replay the original issued
    // cookie over HTTP to prove server-side rejection, not merely browser deletion.
    assert.equal((await context.cookies()).some(cookie => cookie.name === cookieBefore.name), false, 'Browser honored the real cookie expiry')
    for (const path of ['/api/auth/me', '/api/projects']) {
      assert.equal((await fetch(`${base}${path}`, { headers: { Cookie: `${cookieBefore.name}=${cookieBefore.value}` } })).status, 401)
      assert.equal((await context.request.get(`${base}${path}`)).status(), 401)
    }
    checks.push('Expired original-cookie replay and browser APIs: /api/auth/me and /api/projects each return 401')
    step = 'expired-ui-notice'
    await page.reload()
    await page.getByRole('heading', { name: '登录控制台' }).waitFor()
    assert.equal(await page.locator('.project-list').count(), 0)
    assert.equal(await page.getByRole('button', { name: '退出登录', exact: true }).count(), 0)
    await settle()
    await page.screenshot({ path: `${evidence}/expired-login.png`, fullPage: true })
    checks.push('Expired UI reload is anonymous with no project list or logout button')
    await page.getByRole('status').filter({ hasText: '登录会话已过期' }).waitFor()
    checks.push(`Actual ${ttlMs}ms idle TTL with wall-clock wait: original issued cookie replay and browser /api/auth/me and /api/projects all 401; UI anonymous with expiry notice`)
    step = 'relogin'
    await login(viewer.username, granted!.name)
    assert.equal(page.url(), `${base}${returnPath}`, 'Re-login returns to the exact deep link with query/hash')
    assert.equal(await page.getByRole('status').filter({ hasText: '登录会话已过期' }).count(), 0)
    checks.push('Fresh login returns to the preserved project deep link including query and hash')
    await page.goto(`${base}/next/projects`)
    await page.getByRole('heading', { name: '项目', exact: true }).waitFor()
    await settle()
    await exactProjects([granted!, shared!])
    const recoveredCookie = (await context.cookies()).find(cookie => cookie.name === cookieBefore.name)
    assert.ok(recoveredCookie && recoveredCookie.value !== cookieBefore.value, 'Re-login issued a fresh cookie')
    await page.screenshot({ path: `${evidence}/recovered-projects.png`, fullPage: true })
    checks.push('Fresh UI login recovers viewer identity and exact authorized projects with a newly issued cookie')
  },
  closeBrowser: async () => { await browser?.close(); cleanup.browserClosed = true },
  closeServer: async () => { await app?.close(); cleanup.serverClosed = true },
  verifyDiagnostics: () => assert.deepEqual(diagnostics.filter(item => !item.expected), []),
  evidence: [{ stage: 'fingerprints', write: () => writeFile(`${evidence}/fingerprints.json`, JSON.stringify({ kind: 'local-source-and-selected-dist-not-release-provenance', dist, distKind, fingerprints }, null, 2)) }],
  writeResult: ({ passed, failures }) => writeFile(`${evidence}/result.json`, JSON.stringify({ kind: 'isolated-real-http-selected-new-ui-dist', dist, distKind, passed, negativeControl, step, ttlMs, checks, responses, diagnostics, cleanup, failures: failures.map(({ stage, error }) => ({ stage, message: String(error) })) }, null, 2)),
})
console.log(`PASS ${checks.length} isolated real-HTTP browser checks; evidence: ${evidence}`)
