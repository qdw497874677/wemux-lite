import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { adminRouteFixture } from '../../server/src/test/fixtures/admin-route-fixture.ts'
import { launchAcceptanceBrowser } from './acceptance-runtime.mjs'
const root = await mkdtemp(join(tmpdir(), 'wemux-list-evidence-'))
const result = { passed: false, checks: [] as string[], failureStep: '', cleanupFailures: [] as string[] }
let fixture: Awaited<ReturnType<typeof adminRouteFixture>> | undefined, browser: any, step = 'setup'
const check = (value: unknown, label: string) => { assert.ok(value, label); result.checks.push(label) }
try {
  assert.ok(process.env.WEMUX_NEXT_TEST_DIST?.startsWith('/tmp/'))
  fixture = await adminRouteFixture(resolve(process.env.WEMUX_NEXT_TEST_DIST!)); const f = fixture
  browser = await launchAcceptanceBrowser()
  for (const [viewport, size] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]] as const) {
    const context = await browser.newContext({ viewport: size }), page = await context.newPage()
    page.setDefaultTimeout(7000); const errors: string[] = []; page.on('pageerror', () => errors.push('pageerror'))
    const prefix = `Discovery ${viewport}`
    const createProject = async (name: string, role?: string) => {
      const project = (await f.request('/projects', { body: { name: `${prefix} ${name}` } })).data
      if (role) await f.request(`/projects/${project.id}/grants`, { body: { userId: f.accounts.member.id, role } })
      return project
    }
    const main = await createProject('Alpha', 'contributor'), twinA = await createProject('Same', 'viewer'), twinB = await createProject('Same', 'manager'), zebra = await createProject('Zebra', 'viewer'), hidden = await createProject('Hidden')
    const twins = [twinA.id, twinB.id].sort() // Tie specification: ascending opaque ID, independent of display comparator.
    const createTask = async (p: string, title: string, priority: string) => (await f.request(`/projects/${p}/tasks`, { body: { title, priority, description: 'not a title search target' } })).data
    const a = await createTask(main.id, 'Alpha fix', 'low'), b = await createTask(main.id, 'Beta FIX', 'high'), c = await createTask(main.id, 'Same title', 'high'), d = await createTask(main.id, 'Same title', 'none')
    await f.request(`/projects/${main.id}/tasks/${b.id}`, { method: 'PATCH', body: { status: 'todo', version: b.version } })
    await createTask(hidden.id, 'Hidden fix', 'high')
    // Owned synthetic rows fix timestamps for deterministic ordering ties; real API/UI reads, no response mocks.
    await f.app.store.transaction(async tx => {
      for (const [task, time] of [[a, '2026-01-01T00:00:00Z'], [b, '2026-01-03T00:00:00Z'], [c, '2026-01-03T00:00:00Z'], [d, '2026-01-02T00:00:00Z']] as const) {
        const current = (await tx.tasks.get(task.id))!; await tx.tasks.save({ ...current, updatedAt: time })
      }
    })
    const newTie = [b.id, c.id].sort(), nameTie = [c.id, d.id].sort()
    const login = async (email: string, password: string, target: string) => {
      await page.goto(`${f.origin}${target}`); await page.getByLabel('邮箱或用户名', { exact: true }).fill(email); await page.getByLabel('密码', { exact: true }).fill(password); await page.getByRole('button', { name: '登录', exact: true }).click(); await page.getByRole('button', { name: '登录', exact: true }).waitFor({ state: 'hidden' })
    }
    await login(f.accounts.member.email, f.accounts.member.password, `/next/projects/${main.id}`)
    step = `${viewport}: title search available and live filtering`
    const search = page.getByRole('searchbox', { name: '搜索任务标题', exact: true })
    await page.getByText('显示 4 / 4 个任务', { exact: true }).waitFor()
    await search.fill('fIx') // Red on previous implementation: no Task search field.
    const rows = () => page.locator('[data-task-id]')
    const ids = async () => rows().evaluateAll((nodes: HTMLElement[]) => nodes.map(node => node.dataset.taskId))
    step = `${viewport}: search result ordering`; assert.deepEqual(await ids(), [b.id, a.id])
    step = `${viewport}: combined status search`; await page.getByLabel('状态筛选', { exact: true }).selectOption('todo'); assert.deepEqual(await ids(), [b.id])
    await search.fill('Same'); assert.deepEqual(await ids(), [])
    await page.getByText('没有匹配的任务。', { exact: true }).waitFor()
    await page.getByRole('button', { name: '清除任务筛选', exact: true }).click()
    assert.equal(await search.inputValue(), ''); assert.equal(await page.getByLabel('状态筛选', { exact: true }).inputValue(), '')
    assert.deepEqual(await ids(), [...newTie, d.id, a.id])
    await search.fill('not a title search target'); assert.deepEqual(await ids(), [], 'description is not title search')
    await page.getByRole('button', { name: '清除任务筛选', exact: true }).click()
    assert.equal(await page.getByText('Hidden fix', { exact: true }).count(), 0)
    await page.getByText('显示 4 / 4 个任务', { exact: true }).waitFor()
    check(true, `${viewport}: case-insensitive title/status intersection, no-results and clearing use authorized Tasks only`)
    step = `${viewport}: exact Task ordering`; const expected = { updated: [...newTie, d.id, a.id], title: [a.id, b.id, ...nameTie], priority: [...newTie, a.id, d.id] }
    for (const [sort, order] of Object.entries(expected)) {
      await page.getByLabel('任务排序', { exact: true }).selectOption(sort)
      assert.deepEqual(await ids(), order, sort)
    }
    await page.screenshot({ path: join(root, `${viewport}-task-list.png`), fullPage: true })
    await page.getByLabel('任务视图', { exact: true }).selectOption('board')
    await search.fill('fix'); await page.getByLabel('状态筛选', { exact: true }).selectOption('todo'); assert.deepEqual(await ids(), [b.id])
    await page.getByRole('button', { name: '清除任务筛选', exact: true }).click()
    for (const [sort, order] of Object.entries(expected)) {
      await page.getByLabel('任务排序', { exact: true }).selectOption(sort)
      // Board groups by status; within each column ordering must match the list order.
      assert.deepEqual(await page.getByRole('region', { name: '待规划任务', exact: true }).locator('[data-task-id]').evaluateAll((nodes: HTMLElement[]) => nodes.map(node => node.dataset.taskId)), order.filter(id => id !== b.id))
      assert.deepEqual(await page.getByRole('region', { name: '待处理任务', exact: true }).locator('[data-task-id]').evaluateAll((nodes: HTMLElement[]) => nodes.map(node => node.dataset.taskId)), [b.id])
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true)
    await page.screenshot({ path: join(root, `${viewport}-task-board.png`), fullPage: true })
    check(true, `${viewport}: updated/name/priority actual list and board order, deterministic ties and status grouping`)
    step = `${viewport}: focus and dirty editor`; await page.getByLabel('任务视图', { exact: true }).selectOption('list')
    await search.fill(''); await search.focus(); const element = await search.elementHandle()
    await search.pressSequentially('Alpha')
    assert.equal(await element.evaluate((node: HTMLInputElement) => node.isConnected && node === document.activeElement && node.value === 'Alpha'), true)
    assert.deepEqual(await ids(), [a.id])
    await page.getByRole('button', { name: '刷新任务', exact: true }).click(); await search.focus()
    const response = page.waitForResponse((r: any) => new URL(r.url()).pathname === '/api/projects' && r.status() === 200)
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await response
    await search.waitFor({ state: 'visible' })
    assert.equal(await element.evaluate((node: HTMLInputElement) => node.isConnected && node.value === 'Alpha'), true)
    await rows().getByRole('button', { name: 'Alpha fix', exact: true }).click()
    await page.getByLabel('编辑描述', { exact: true }).fill('dirty detail must survive list filtering')
    let prompts = 0; const deny = async (dialog: any) => { prompts++; await dialog.dismiss() }; page.on('dialog', deny)
    await search.fill('Beta'); await page.getByLabel('状态筛选', { exact: true }).selectOption('todo')
    assert.equal(await page.getByLabel('编辑描述', { exact: true }).inputValue(), 'dirty detail must survive list filtering'); assert.equal(prompts, 0)
    page.off('dialog', deny); page.on('dialog', (dialog: any) => dialog.accept())
    check(true, `${viewport}: typing preserves input node/focus, authority refresh preserves filter, filtering preserves dirty selected detail`)
    step = `${viewport}: exact Project ordering`; await page.getByRole('button', { name: '返回项目列表', exact: true }).click()
    await page.locator('#project-search').fill(prefix)
    const projectIds = () => page.locator('a.project-row').evaluateAll((nodes: HTMLAnchorElement[]) => nodes.map(node => decodeURIComponent(new URL(node.href).pathname.split('/').at(-1)!)))
    await page.getByLabel('项目排序', { exact: true }).selectOption('name')
    assert.deepEqual(await projectIds(), [main.id, ...twins, zebra.id])
    await page.getByLabel('项目排序', { exact: true }).selectOption('role')
    assert.deepEqual(await projectIds(), [main.id, twinB.id, ...[twinA.id, zebra.id].sort()])
    assert.equal(await page.getByText(hidden.name, { exact: true }).count(), 0)
    await page.screenshot({ path: join(root, `${viewport}-project-order.png`), fullPage: true })
    check(true, `${viewport}: Project name/role ordering has deterministic ID ties and excludes hidden Project`)
    step = `${viewport}: Project scope isolation`; await page.locator(`a.project-row[href$="${twinB.id}"]`).click()
    await page.getByRole('searchbox', { name: '搜索任务标题', exact: true }).waitFor()
    assert.equal(await search.inputValue(), ''); assert.equal(await page.getByLabel('状态筛选', { exact: true }).inputValue(), '')
    await page.getByText('还没有任务。', { exact: true }).waitFor()
    check(true, `${viewport}: another Project does not inherit previous title/status filters or Task rows`)
    step = `${viewport}: Team scope isolation`
    await page.goto(`${f.origin}/next/projects/${main.id}`); await search.fill('team-filter')
    const memberTeam = (await f.request('/teams', { token: f.accounts.member.token, body: { name: `Own ${viewport}` } })).data
    if (viewport === 'mobile') await page.getByRole('button', { name: '打开导航', exact: true }).click()
    await page.getByRole('navigation', { name: '主导航' }).filter({ visible: true }).getByRole('link', { name: '团队', exact: true }).click()
    await page.locator('select').first().selectOption(memberTeam.id)
    await page.getByRole('button', { name: '将此团队设为当前项目范围', exact: true }).click()
    if (viewport === 'mobile') await page.getByRole('button', { name: '打开导航', exact: true }).click()
    await page.getByRole('navigation', { name: '主导航' }).filter({ visible: true }).getByRole('link', { name: '项目', exact: true }).click()
    await page.getByRole('heading', { name: '还没有可访问的项目', exact: true }).waitFor()
    assert.equal(await search.count(), 0); assert.equal(await rows().count(), 0)
    check(true, `${viewport}: Team scope transition cannot retain former Project Tasks or filter controls`)
    step = `${viewport}: identity isolation`
    await page.goto(`${f.origin}/next/projects/${main.id}`); await search.fill('private-filter')
    if (viewport === 'mobile') await page.getByRole('button', { name: '打开导航', exact: true }).click()
    await page.getByRole('button', { name: '退出登录', exact: true }).filter({ visible: true }).click()
    await page.getByRole('button', { name: '登录', exact: true }).waitFor()
    assert.equal(await search.count(), 0)
    await login(f.accounts.admin.email, f.accounts.admin.password, `/next/projects/${main.id}`)
    await page.getByText('项目不存在或当前账号无权访问', { exact: true }).waitFor()
    assert.equal(await search.count(), 0); assert.equal(await rows().count(), 0)
    check(true, `${viewport}: identity retirement clears filters/results and inaccessible deep link cannot restore old list`)
    await page.goto(`${f.origin}/next/projects`)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true)
    assert.deepEqual(errors, [])
    await page.screenshot({ path: join(root, `${viewport}-isolated.png`), fullPage: true })
    await context.close()
  }
  result.passed = true
} catch { result.failureStep = step }
finally {
  try { await browser?.close() } catch { result.cleanupFailures.push('browser'); result.passed = false }
  try { await fixture?.close() } catch { result.cleanupFailures.push('fixture'); result.passed = false }
  await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2))
}
console.log(JSON.stringify({ ...result, evidence: root })); process.exitCode = result.passed ? 0 : 1
