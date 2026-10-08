import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { adminRouteFixture } from '../../server/src/test/fixtures/admin-route-fixture.ts'
import { launchAcceptanceBrowser } from './acceptance-runtime.mjs'

// Real application, routing and authentication; only Run history is synthetic.
// This UI regression does not claim Worker execution or attention API coverage.
const root = await mkdtemp(join(tmpdir(), 'wemux-run-deep-link-'))
const result = { passed: false, checks: [] as string[], failureStep: '', cleanupFailures: [] as string[] }
let f: Awaited<ReturnType<typeof adminRouteFixture>> | undefined, browser: any, step = 'setup'
try {
  assert.ok(process.env.WEMUX_NEXT_TEST_DIST?.startsWith('/tmp/'))
  f = await adminRouteFixture(resolve(process.env.WEMUX_NEXT_TEST_DIST!)); const fixture = f
  browser = await launchAcceptanceBrowser()
  const other = (await f.request(`/projects/${f.project.id}/tasks`, { body: { title: '另一个任务' } })).data
  for (const [viewport, size] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]] as const) {
    const context = await browser.newContext({ viewport: size }), page = await context.newPage()
    page.setDefaultTimeout(8000); page.setDefaultNavigationTimeout(15000)
    const waitForHistoryRequest = (request: Promise<void>) => Promise.race([request, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(Error('History request timed out')), 10000); timer.unref() })])
    const pageErrors: string[] = []; page.on('pageerror', () => pageErrors.push('pageerror'))
    const base = `/next/projects/${f.project.id}`, targetId = 'run-attempt-2'
    const history = [3, 2, 1].map(attempt => ({
      id: `run-attempt-${attempt}`, taskId: fixture.task.id, projectId: fixture.project.id, attempt,
      sessionId: fixture.sessionId, status: attempt === 2 ? 'failed' : 'succeeded',
      startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:01:00Z',
      resultSummary: `尝试 ${attempt}`, failure: attempt === 2 ? { code: 'fixture', message: '测试运行失败' } : null,
    }))
    let hold: Promise<void> = Promise.resolve(), entered = () => {}, member = false
    await page.route((url: URL) => url.pathname.startsWith(`/api/projects/${fixture.project.id}/tasks/`) && url.pathname.endsWith('/runs'), async (route: any) => {
      const items = member ? [] : history
      entered(); await hold
      await route.fulfill({ json: { items } }).catch(() => {})
    })
    const login = async (key: 'owner' | 'member') => {
      await page.getByLabel('邮箱或用户名', { exact: true }).fill(fixture.accounts[key].email)
      await page.getByLabel('密码', { exact: true }).fill(fixture.accounts[key].password)
      await page.getByRole('button', { name: '登录', exact: true }).click()
    }
    const logout = async () => {
      if (viewport === 'mobile') await page.getByRole('button', { name: '打开导航', exact: true }).click()
      await page.getByRole('button', { name: '退出登录', exact: true }).filter({ visible: true }).click()
      await page.getByRole('button', { name: '登录', exact: true }).waitFor()
    }
    const selected = page.locator('.task-run-row[aria-current="true"]')
    const missing = page.getByRole('status').filter({ hasText: '当前任务的执行记录中未找到链接指定的 Run' })
    step = `${viewport}: initial URL selects exact older attempt after delayed history`
    let release!: () => void, markEntered!: () => void
    hold = new Promise<void>(resolve => { release = resolve })
    let requested = new Promise<void>(resolve => { markEntered = resolve }); entered = () => markEntered()
    await page.goto(`${f.origin}${base}?task=${f.task.id}&run=${targetId}&keep=retained`)
    await login('owner'); await waitForHistoryRequest(requested)
    assert.equal(await selected.count(), 0); assert.equal(await missing.count(), 0)
    release(); await selected.waitFor()
    assert.equal(await selected.getAttribute('data-run-id'), targetId)
    assert.match(await selected.innerText(), /第 2 次执行：失败/)
    assert.equal(await selected.evaluate((node: HTMLElement) => document.activeElement === node), true)
    assert.equal(await page.locator('.task-run-row').count(), 3)
    assert.equal(await selected.evaluate((node: HTMLElement) => getComputedStyle(node).outlineStyle), 'solid')
    assert.ok(await selected.evaluate((node: HTMLElement) => node.getBoundingClientRect().top < innerHeight && node.getBoundingClientRect().bottom > 0))
    await page.screenshot({ path: join(root, `${viewport}-selected-run.png`), fullPage: true })
    result.checks.push(`${viewport}: initial URL waits for history, focuses and highlights attempt 2 rather than latest attempt 3`)

    step = `${viewport}: session preserves run, task change and close clear run`
    await selected.getByRole('button', { name: '查看关联会话', exact: true }).click()
    await page.waitForURL((url: URL) => url.searchParams.get('session') === fixture.sessionId)
    assert.equal(new URL(page.url()).searchParams.get('run'), targetId)
    assert.equal(new URL(page.url()).searchParams.get('keep'), 'retained')
    await page.getByRole('button', { name: other.title, exact: true }).click()
    await page.waitForURL((url: URL) => url.searchParams.get('task') === other.id)
    assert.equal(new URL(page.url()).searchParams.has('run'), false)
    assert.equal(new URL(page.url()).searchParams.has('session'), false)
    assert.equal(await selected.count(), 0)
    result.checks.push(`${viewport}: associated Session keeps run and unrelated query; selecting another Task clears run and Session`)

    step = `${viewport}: absent run and wrong-task run never select a fallback`
    for (const [taskId, runId] of [[f.task.id, 'missing-run'], [other.id, targetId]]) {
      await page.goto(`${f.origin}${base}?task=${taskId}&run=${runId}`)
      await missing.waitFor(); assert.equal(await selected.count(), 0)
    }
    await page.getByRole('button', { name: '关闭详情', exact: true }).click()
    await page.waitForURL((url: URL) => !url.searchParams.has('task'))
    assert.equal(new URL(page.url()).searchParams.has('run'), false)
    result.checks.push(`${viewport}: missing ID and even a returned wrong-task Run show no-match without selecting latest; closing clears run`)

    step = `${viewport}: held history cannot resurrect selection after identity switch`
    hold = new Promise<void>(resolve => { release = resolve })
    requested = new Promise<void>(resolve => { markEntered = resolve })
    await page.goto(`${f.origin}${base}?task=${f.task.id}&run=${targetId}`, { waitUntil: 'domcontentloaded' }); await waitForHistoryRequest(requested)
    await logout(); member = true
    release(); hold = Promise.resolve()
    await login('member'); await missing.waitFor()
    assert.equal(await selected.count(), 0); assert.equal(await page.locator('.task-run-row').count(), 0)
    assert.deepEqual(pageErrors, [])
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
    result.checks.push(`${viewport}: late previous-account history cannot select or display a Run for the new identity; no page errors or horizontal overflow`)
    await context.close()
  }
  result.passed = true
} catch { result.failureStep = step }
finally {
  try { await browser?.close() } catch { result.passed = false; result.cleanupFailures.push('browser') }
  try { await f?.close() } catch { result.passed = false; result.cleanupFailures.push('fixture') }
  await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2))
}
console.log(JSON.stringify({ ...result, evidence: root })); process.exitCode = result.passed ? 0 : 1
