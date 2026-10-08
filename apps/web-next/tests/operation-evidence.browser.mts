import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { adminRouteFixture } from '../../server/src/test/fixtures/admin-route-fixture.ts'
import { launchAcceptanceBrowser } from './acceptance-runtime.mjs'

// Operation evidence only: public writes and real Next controls; no production changes or response mocks.
const root = await mkdtemp(join(tmpdir(), 'wemux-operation-browser-'))
const result = { passed: false, checks: [] as string[], failureStep: null as string | null, cleanupFailures: [] as string[] }
let fixture: Awaited<ReturnType<typeof adminRouteFixture>> | undefined, browser: any, step = 'setup'
const check = (condition: unknown, message: string) => { assert.ok(condition, message); result.checks.push(message) }
try {
  assert.ok(process.env.WEMUX_NEXT_TEST_DIST?.startsWith('/tmp/'), 'Private current-source UI required')
  fixture = await adminRouteFixture(resolve(process.env.WEMUX_NEXT_TEST_DIST!)); const f = fixture
  browser = await launchAcceptanceBrowser()
  for (const [viewport, size] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]] as const) {
    const ownerContext = await browser.newContext({ viewport: size }), viewerContext = await browser.newContext({ viewport: size }), outsiderContext = await browser.newContext({ viewport: size })
    const owner = await ownerContext.newPage(), viewer = await viewerContext.newPage(), outsider = await outsiderContext.newPage()
    const errors: string[] = []
    for (const page of [owner, viewer, outsider]) { page.setDefaultTimeout(10000); page.on('pageerror', () => errors.push('pageerror')); page.on('dialog', (dialog: any) => dialog.accept()) }
    const project = (await f.request('/projects', { body: { name: `Operations ${viewport}` } })).data
    assert.equal((await f.request(`/projects/${project.id}/grants`, { body: { userId: f.accounts.member.id, role: 'viewer' } })).status, 201)
    const projectPath = `/next/projects/${project.id}`
    const login = async (page: any, key: keyof typeof f.accounts, path: string) => {
      await page.goto(`${f.origin}${path}`)
      await page.getByLabel('邮箱或用户名', { exact: true }).fill(f.accounts[key].email)
      await page.getByLabel('密码', { exact: true }).fill(f.accounts[key].password)
      await page.getByRole('button', { name: '登录', exact: true }).click()
      await page.getByRole('button', { name: '登录', exact: true }).waitFor({ state: 'hidden' })
    }
    const browserApi = (page: any, path: string, method = 'GET', body?: unknown) => page.evaluate(async ({ path, method, body }: { path: string; method: string; body?: unknown }) => {
      const account = method === 'GET' ? null : await (await fetch('/api/auth/me')).json()
      const response = await fetch(`/api${path}`, { method, headers: { 'Content-Type': 'application/json', ...(account?.csrfToken ? { 'x-csrf-token': account.csrfToken } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
      return { status: response.status, data: response.status === 204 ? null : await response.json() }
    }, { path, method, body })
    const submit = async (page: any, label: string, values: Record<string, string>) => {
      const form = page.getByRole('button', { name: label, exact: true }).locator('xpath=ancestor::form')
      for (const [name, value] of Object.entries(values)) {
        const field = form.locator(`[name="${name}"]`)
        if (await field.evaluate((element: Element) => element.tagName === 'SELECT')) await field.selectOption(value)
        else await field.fill(value)
      }
      await form.getByRole('button', { name: label, exact: true }).click()
      return form
    }
    const responseFor = (page: any, path: string, method: string, status: number) => {
      const pending = page.waitForResponse((response: any) => new URL(response.url()).pathname === `/api${path}` && response.request().method() === method && response.status() === status)
      pending.catch(() => {}) // Observe failures even if a preceding locator fails.
      return pending
    }
    step = `${viewport}: create Task through UI`
    await login(owner, 'owner', projectPath)
    await owner.getByRole('heading', { name: project.name, exact: true }).waitFor()
    await submit(owner, '创建任务', { title: `Evidence task ${viewport}`, description: 'Original description', acceptanceCriteria: 'Verify operations' })
    await owner.getByRole('heading', { name: '任务详情', exact: true }).waitFor()
    const taskId = new URL(owner.url()).searchParams.get('task')!
    assert.ok(taskId)
    const taskPath = `/projects/${project.id}/tasks/${taskId}`
    const readTask = async () => (await f.request(taskPath)).data
    const readActivity = async () => (await f.request(`${taskPath}/activity`)).data.items
    const initial = await readActivity()
    assert.deepEqual(initial.map((item: any) => item.type), ['task.created'])
    assert.deepEqual(initial[0].payload, { title: `Evidence task ${viewport}` })
    // Check visible semantic type/payload/time against authority; expected operation sequence is specified below,
    // not computed from the component. No row count-only proxy for correct activity.
    const assertVisibleActivity = async (page: any, activity: any[], timeout = 10000) => {
      const list = page.getByRole('heading', { name: '活动', exact: true }).locator('xpath=following-sibling::ol[1]')
      await list.waitFor({ state: 'visible', timeout })
      for (let index = 0; index < activity.length; index++) {
        await list.locator(':scope > li').nth(index).waitFor({ state: 'visible', timeout })
      }
      await page.waitForFunction((expected: any[]) => {
        const rows = [...document.querySelectorAll('#main-content ol > li')]
        return rows.length === expected.length && rows.every((row, index) => {
          const event = expected[index]
          const payload = row.querySelector('pre')?.textContent
          return !!payload && JSON.stringify(JSON.parse(payload)) === JSON.stringify(event.payload) && row.querySelector('time')?.textContent === event.occurredAt && row.textContent?.includes(event.type)
        })
      }, activity, { timeout })
    }
    await assertVisibleActivity(owner, initial)

    step = `${viewport}: valid URL syntax but rejected external host`
    const invalidUrl = 'https://example.test/not-a-github-issue'
    const invalidResponse = responseFor(owner, `${taskPath}/links`, 'POST', 400)
    const linkForm = await submit(owner, '添加外部关联', { url: invalidUrl })
    const invalid = await (await invalidResponse).json()
    assert.equal(invalid.error.code, 'invalid_request')
    await linkForm.getByRole('alert').filter({ hasText: 'Expected a GitHub issue or pull request URL' }).waitFor()
    assert.equal(await linkForm.locator('[name=url]').inputValue(), invalidUrl)
    assert.deepEqual((await readTask()).links, [])
    assert.deepEqual(await readActivity(), initial)
    check(true, `${viewport}: real invalid-URL400 is visible, retains correction input, writes no link or activity`)

    step = `${viewport}: correct rejected URL then remove actual link through UI`
    const issueUrl = 'https://github.com/example/operation-fixture/issues/17'
    const addResponse = responseFor(owner, `${taskPath}/links`, 'POST', 200)
    await submit(owner, '添加外部关联', { url: issueUrl }); await addResponse
    await owner.getByRole('link', { name: issueUrl, exact: true }).waitFor()
    assert.equal(await linkForm.getByRole('alert').count(), 0)
    const firstLink = (await readTask()).links[0]
    assert.equal(firstLink.url, issueUrl)
    let activity = await readActivity()
    assert.deepEqual(activity.map((item: any) => item.type), ['task.created', 'link.changed'])
    assert.deepEqual(activity[1].payload, { action: 'added', linkId: firstLink.id })
    await assertVisibleActivity(owner, activity)
    const removedResponse = responseFor(owner, `${taskPath}/links/${firstLink.id}`, 'DELETE', 200)
    await owner.getByRole('button', { name: '移除关联', exact: true }).click(); await removedResponse
    await owner.getByRole('link', { name: issueUrl, exact: true }).waitFor({ state: 'hidden' })
    assert.deepEqual((await readTask()).links, [])
    activity = await readActivity()
    assert.deepEqual(activity[2].payload, { action: 'removed', linkId: firstLink.id })
    await assertVisibleActivity(owner, activity)
    check(true, `${viewport}: correction recovers, real UI add/remove use matching link identity and matching visible activity`)

    step = `${viewport}: activity content/status causality and retained read-only link`
    const editResponse = responseFor(owner, taskPath, 'PATCH', 200)
    await submit(owner, '保存任务内容', { title: `Edited task ${viewport}` }); await editResponse
    await owner.getByText('任务内容已保存。', { exact: true }).waitFor()
    const current = await readTask()
    await owner.getByText(`版本 ${current.version}，待规划`, { exact: true }).waitFor()
    const transitionResponse = responseFor(owner, taskPath, 'PATCH', 200)
    await submit(owner, '更新任务状态', { status: 'todo' }); await transitionResponse
    await owner.getByText('任务状态已更新。', { exact: true }).waitFor()
    const prUrl = 'https://github.com/example/operation-fixture/pull/23'
    const prResponse = responseFor(owner, `${taskPath}/links`, 'POST', 200)
    await submit(owner, '添加外部关联', { url: prUrl }); await prResponse
    await owner.getByRole('link', { name: prUrl, exact: true }).waitFor()
    const retained = (await readTask()).links[0]
    activity = await readActivity()
    assert.deepEqual(activity.map((item: any) => item.type), ['task.created', 'link.changed', 'link.changed', 'task.updated', 'task.transitioned', 'link.changed'])
    assert.deepEqual(activity.map((item: any) => item.seq), [1, 2, 3, 4, 5, 6])
    assert.deepEqual(activity[3].payload, { fields: ['title'], from: 'backlog', to: 'backlog' })
    assert.deepEqual(activity[4].payload, { fields: [], from: 'backlog', to: 'todo' })
    assert.deepEqual(activity[5].payload, { action: 'added', linkId: retained.id })
    assert.ok(activity.every((item: any) => item.actor === f.accounts.owner.id))
    await assertVisibleActivity(owner, activity)
    step = `${viewport}: activity visibility negative probes`
    const activityList = owner.getByRole('heading', { name: '活动', exact: true }).locator('xpath=following-sibling::ol[1]')
    // Transient owned-page probe only. Restore the exact inline style even if the assertion fails.
    // Content/count/order remain unchanged while visibility alone is made false.
    for (const probe of ['list', 'row'] as const) {
      const target = probe === 'list' ? activityList : activityList.locator(':scope > li').nth(activity.length - 1)
      const element = await target.elementHandle()
      assert.ok(element)
      const priorStyle = await element.getAttribute('style')
      try {
        await element.evaluate((node: HTMLElement, probe: string) => {
          node.style.setProperty(probe === 'list' ? 'display' : 'visibility', probe === 'list' ? 'none' : 'hidden', 'important')
        }, probe)
        assert.equal(await target.isVisible(), false)
        await assert.rejects(assertVisibleActivity(owner, activity, 350), (error: unknown) => error instanceof Error && error.name === 'TimeoutError')
      } finally {
        await element.evaluate((node: HTMLElement, style: string | null) => {
          if (style === null) node.removeAttribute('style')
          else node.setAttribute('style', style)
        }, priorStyle)
        assert.equal(await element.getAttribute('style'), priorStyle)
        await element.dispose()
      }
      await assertVisibleActivity(owner, activity)
      check(true, `${viewport}: hidden activity ${probe} rejected by waited helper; exact styles restored and visible content/order revalidated`)
    }
    step = `${viewport}: refreshed activity stays visible and unchanged`
    for (let attempt = 0; attempt < 2; attempt++) {
      const refreshed = responseFor(owner, `${taskPath}/activity`, 'GET', 200)
      await owner.getByRole('button', { name: '加载最新版本', exact: true }).click(); await refreshed
      await assertVisibleActivity(owner, activity); assert.deepEqual(await readActivity(), activity)
    }
    await owner.reload(); await owner.getByRole('heading', { name: '任务详情', exact: true }).waitFor()
    await assertVisibleActivity(owner, activity); assert.deepEqual(await readActivity(), activity)
    check(true, `${viewport}: exact six-event actor/type/payload/sequence matches real operations; refresh and reload add no duplicate events`)
    await owner.screenshot({ path: join(root, `${viewport}-task-activity.png`), fullPage: true })

    step = `${viewport}: Workspace rename list, manual refresh and reload`
    await owner.getByRole('button', { name: '工作区', exact: true }).click()
    await submit(owner, '创建工作区', { name: `Original workspace ${viewport}` })
    const oldHeading = owner.getByRole('heading', { name: `Original workspace ${viewport}`, exact: true })
    await oldHeading.waitFor()
    const workspace = (await f.request(`/workspaces?projectId=${project.id}`)).data.items[0]
    const article = owner.locator('article').filter({ has: oldHeading })
    const renameResponse = responseFor(owner, `/workspaces/${workspace.id}`, 'PATCH', 200)
    const renameForm = article.getByRole('button', { name: '保存工作区名称', exact: true }).locator('xpath=ancestor::form')
    await renameForm.locator('[name=name]').fill(`Renamed workspace ${viewport}`)
    await renameForm.getByRole('button', { name: '保存工作区名称', exact: true }).click(); await renameResponse
    const newHeading = owner.getByRole('heading', { name: `Renamed workspace ${viewport}`, exact: true })
    await newHeading.waitFor(); assert.equal(await oldHeading.count(), 0)
    assert.equal((await f.request(`/workspaces/${workspace.id}`)).data.name, `Renamed workspace ${viewport}`)
    const refreshedWorkspaces = responseFor(owner, '/workspaces', 'GET', 200)
    await owner.getByRole('button', { name: '刷新准备状态', exact: true }).click(); await refreshedWorkspaces
    await newHeading.waitFor(); assert.equal(await oldHeading.count(), 0)
    await owner.reload(); await owner.getByRole('button', { name: '工作区', exact: true }).click()
    await newHeading.waitFor(); assert.equal(await oldHeading.count(), 0)
    assert.equal((await f.request(`/workspaces?projectId=${project.id}`)).data.items.filter((item: any) => item.id === workspace.id && item.name === `Renamed workspace ${viewport}`).length, 1)
    check(true, `${viewport}: Workspace rename updates same identity in visible list and survives refresh/full reload without stale name`)
    await owner.screenshot({ path: join(root, `${viewport}-workspace-renamed.png`), fullPage: true })

    step = `${viewport}: read-only and unauthorized negative operations`
    await login(viewer, 'member', `${projectPath}?task=${taskId}`)
    await viewer.getByRole('link', { name: prUrl, exact: true }).waitFor()
    await assertVisibleActivity(viewer, activity)
    assert.equal(await viewer.getByRole('button', { name: '添加外部关联', exact: true }).count(), 0)
    assert.equal(await viewer.getByRole('button', { name: '移除关联', exact: true }).count(), 0)
    assert.ok(await viewer.getByRole('button', { name: '保存任务内容', exact: true }).isDisabled())
    assert.equal((await browserApi(viewer, `${taskPath}/links`, 'POST', { url: issueUrl })).status, 403)
    assert.equal((await browserApi(viewer, `${taskPath}/links/${retained.id}`, 'DELETE')).status, 403)
    await viewer.getByRole('button', { name: '工作区', exact: true }).click()
    await viewer.getByRole('heading', { name: `Renamed workspace ${viewport}`, exact: true }).waitFor()
    assert.equal(await viewer.getByRole('button', { name: '保存工作区名称', exact: true }).count(), 0)
    assert.equal((await browserApi(viewer, `/workspaces/${workspace.id}`, 'PATCH', { name: 'viewer denied' })).status, 403)
    check(true, `${viewport}: viewer reads retained link/activity/Workspace but UI and public API refuse link/rename writes`)
    await login(outsider, 'admin', `${projectPath}?task=${taskId}`)
    await outsider.getByText('项目不存在或当前账号无权访问', { exact: true }).waitFor()
    assert.equal(await outsider.getByRole('link', { name: prUrl, exact: true }).count(), 0)
    assert.equal(await outsider.getByRole('heading', { name: `Edited task ${viewport}`, exact: true }).count(), 0)
    for (const [path, method, body] of [[taskPath, 'GET', undefined], [`${taskPath}/activity`, 'GET', undefined], [`${taskPath}/links`, 'POST', { url: issueUrl }], [`${taskPath}/links/${retained.id}`, 'DELETE', undefined], [`/workspaces/${workspace.id}`, 'PATCH', { name: 'outsider denied' }]] as const) {
      const denied = await browserApi(outsider, path, method, body)
      assert.ok([403, 404].includes(denied.status))
      const message = JSON.stringify(denied.data)
      assert.ok(!message.includes(prUrl) && !message.includes(`Renamed workspace ${viewport}`) && !message.includes(`Edited task ${viewport}`))
    }
    assert.equal((await readTask()).links[0].id, retained.id)
    assert.equal((await f.request(`/workspaces/${workspace.id}`)).data.name, `Renamed workspace ${viewport}`)
    assert.deepEqual(await readActivity(), activity)
    check(true, `${viewport}: ungranted admin cannot read private activity or mutate links/Workspace; denied writes change no history/content`)
    for (const page of [owner, viewer, outsider]) assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1))
    assert.deepEqual(errors, [])
    await viewer.screenshot({ path: join(root, `${viewport}-readonly-workspace.png`), fullPage: true })
    await outsider.screenshot({ path: join(root, `${viewport}-unauthorized.png`), fullPage: true })
    await ownerContext.close(); await viewerContext.close(); await outsiderContext.close()
  }
  result.passed = true
} catch { result.failureStep = step }
finally {
  try { await browser?.close() } catch { result.cleanupFailures.push('browser'); result.passed = false }
  try { await fixture?.close() } catch { result.cleanupFailures.push('fixture'); result.passed = false }
  await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2))
}
console.log(JSON.stringify({ ...result, evidence: root })); process.exitCode = result.passed ? 0 : 1
