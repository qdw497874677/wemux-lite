import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { adminRouteFixture } from '../../server/src/test/fixtures/admin-route-fixture.ts'
import { defaultTaskMetadataJson } from '../src/lib/task-metadata.ts'
import { launchAcceptanceBrowser } from './acceptance-runtime.mjs'
const root = await mkdtemp(join(tmpdir(), 'wemux-create-draft-evidence-'))
const result = { passed: false, checks: [] as string[], failureStep: '', cleanupFailures: [] as string[] }
let f: Awaited<ReturnType<typeof adminRouteFixture>> | undefined, browser: any, step = 'setup'
const check = (value: unknown, label: string) => { assert.ok(value, label); result.checks.push(label) }
try {
  assert.ok(process.env.WEMUX_NEXT_TEST_DIST?.startsWith('/tmp/'))
  f = await adminRouteFixture(resolve(process.env.WEMUX_NEXT_TEST_DIST!)); const fixture = f
  browser = await launchAcceptanceBrowser()
  for (const [viewport, size] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]] as const) {
    const context = await browser.newContext({ viewport: size }), page = await context.newPage(); page.setDefaultTimeout(7000)
    const pageErrors: string[] = []; page.on('pageerror', () => pageErrors.push('pageerror'))
    const project: { id: string } = (await f.request('/projects', { body: { name: `Create drafts ${viewport}` } })).data
    const task = (await f.request(`/projects/${project.id}/tasks`, { body: { title: 'Existing target' } })).data
    const taskPath: string = `/projects/${project.id}/tasks`, base: string = `/next/projects/${project.id}`
    await page.goto(`${f.origin}${base}`)
    await page.getByLabel('邮箱或用户名', { exact: true }).fill(f.accounts.owner.email)
    await page.getByLabel('密码', { exact: true }).fill(f.accounts.owner.password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    const form = page.getByRole('button', { name: '创建任务', exact: true }).locator('xpath=ancestor::form')
    await form.locator('summary').click()
    const metadata = form.locator('[name=metadataJson]'), metadataRaw = '{"schemaVersion":1,"values":{"private":[null,"",{"x":true}]}}'
    const title = form.locator('[name=title]'), description = form.locator('[name=description]'), criteria = form.locator('[name=acceptanceCriteria]'), priority = form.locator('[name=priority]')
    await title.waitFor()
    let prompts = 0, allow = false
    page.on('dialog', async (dialog: any) => { prompts++; if (allow) await dialog.accept(); else await dialog.dismiss() })
    const fill = async () => { await form.locator('details').evaluate((node: HTMLDetailsElement) => { node.open = true }); await metadata.fill(metadataRaw); await title.fill('Private create draft'); await description.fill('line one\nline two\n'); await criteria.fill('criteria\n'); await priority.selectOption('high') }
    const retained = async () => { assert.equal(await metadata.inputValue(), metadataRaw); assert.equal(await title.inputValue(), 'Private create draft'); assert.equal(await description.inputValue(), 'line one\nline two\n'); assert.equal(await criteria.inputValue(), 'criteria\n'); assert.equal(await priority.inputValue(), 'high') }
    const empty = async () => { assert.equal(await metadata.inputValue(), defaultTaskMetadataJson); assert.equal(await title.inputValue(), ''); assert.equal(await description.inputValue(), ''); assert.equal(await criteria.inputValue(), ''); assert.equal(await priority.inputValue(), 'none') }
    const locationIs = (path: string) => page.waitForFunction((expected: string) => location.pathname + location.search === expected, path)
    step = `${viewport}: reject Task selection retains creation draft`
    await fill(); await page.getByRole('button', { name: 'Existing target', exact: true }).click()
    assert.equal(prompts, 1); assert.equal(new URL(page.url()).search, ''); await retained()
    for (const name of ['工作区', '项目设置', '返回项目列表']) { const before: number = prompts, url = page.url(); await page.getByRole('button', { name, exact: true }).click(); assert.equal(prompts, before + 1); assert.equal(page.url(), url); await retained() }
    const shell = async (name: string) => { if (viewport === 'mobile') await page.getByRole('button', { name: '打开导航', exact: true }).click(); await page.getByRole('navigation', { name: '主导航' }).filter({ visible: true }).getByRole('link', { name, exact: true }).click(); if (viewport === 'mobile') await page.keyboard.press('Escape') }
    for (const name of ['设置', '团队']) { const before: number = prompts, url = page.url(); await shell(name); assert.equal(prompts, before + 1); assert.equal(page.url(), url); await retained() }
    const beforeRefresh = prompts
    await page.getByRole('button', { name: '刷新任务', exact: true }).click()
    await page.getByRole('searchbox', { name: '搜索任务标题', exact: true }).fill('Existing')
    await page.getByLabel('状态筛选', { exact: true }).selectOption('todo')
    await page.getByLabel('任务排序', { exact: true }).selectOption('priority')
    await page.getByLabel('任务视图', { exact: true }).selectOption('board')
    await retained(); assert.equal(prompts, beforeRefresh)
    await page.getByRole('button', { name: '清除任务筛选', exact: true }).click()
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await title.waitFor({ state: 'visible' }); await retained(); assert.equal(prompts, beforeRefresh)
    check(true, `${viewport}: selection/tab/Project/shell/Team departure refusal retains all fields; filter/sort/refresh do not prompt or discard`)
    allow = true; await page.getByRole('button', { name: 'Existing target', exact: true }).click()
    await page.getByRole('heading', { name: '任务详情', exact: true }).waitFor(); assert.equal(await title.inputValue(), '')
    await fill(); allow = false; const beforeClose = prompts
    await page.getByRole('button', { name: '关闭详情', exact: true }).click(); assert.equal(prompts, beforeClose + 1); await retained()
    const beforeBack = prompts; await page.evaluate(() => history.back())
    await page.waitForFunction((id: string) => new URL(location.href).searchParams.get('task') === id, task.id)
    for (let i = 0; i < 100 && prompts === beforeBack; i++) await page.waitForTimeout(10)
    assert.equal(prompts, beforeBack + 1); await retained()
    allow = true; await page.getByRole('button', { name: '关闭详情', exact: true }).click()
    await page.getByRole('heading', { name: '任务详情', exact: true }).waitFor({ state: 'hidden' }); assert.equal(await title.inputValue(), '')
    await title.fill('reverted'); await title.fill(''); const beforePristine = prompts
    await page.getByRole('button', { name: 'Existing target', exact: true }).click(); assert.equal(prompts, beforePristine)
    check(true, `${viewport}: confirmed selection/close discards, rejected history preserves, reverted pristine does not prompt`)

    step = `${viewport}: each field and accepted departures`
    await page.getByRole('button', { name: '关闭详情', exact: true }).click(); await locationIs(base)
    for (const field of [title, description, criteria, priority, metadata]) {
      allow = false
      await form.locator('details').evaluate((node: HTMLDetailsElement) => { node.open = true })
      if (field === priority) await field.selectOption('low'); else await field.fill('changed')
      const before: number = prompts
      await page.getByRole('button', { name: 'Existing target', exact: true }).click()
      assert.equal(prompts, before + 1); assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, base)
      assert.equal(await field.inputValue(), field === priority ? 'low' : 'changed')
      if (field === priority) await field.selectOption('none'); else await field.fill(field === metadata ? defaultTaskMetadataJson : '')
      await page.getByRole('button', { name: 'Existing target', exact: true }).click(); assert.equal(prompts, before + 1)
      await page.getByRole('button', { name: '关闭详情', exact: true }).click(); await locationIs(base); await empty()
    }
    allow = true
    for (const name of ['工作区', '项目设置']) {
      await fill(); const before: number = prompts
      await page.getByRole('button', { name, exact: true }).click(); assert.equal(prompts, before + 1); await form.waitFor({ state: 'hidden' })
      await page.getByRole('button', { name: '任务', exact: true }).click(); await title.waitFor(); await empty()
    }
    for (const name of ['返回项目列表', '设置', '团队']) {
      await fill(); const before: number = prompts
      if (name === '返回项目列表') await page.getByRole('button', { name, exact: true }).click(); else await shell(name)
      await locationIs(name === '返回项目列表' ? '/next/projects' : name === '设置' ? '/next/settings' : '/next/teams')
      assert.equal(prompts, before + 1); await form.waitFor({ state: 'hidden' })
      await page.evaluate(() => history.back()); await locationIs(base); await title.waitFor(); await empty()
    }
    await page.getByRole('button', { name: 'Existing target', exact: true }).click(); await locationIs(`${base}?task=${task.id}`)
    await fill(); let beforeHistory: number = prompts
    await page.evaluate(() => history.back()); await locationIs(base); assert.equal(prompts, beforeHistory + 1); await empty()
    await fill(); allow = false; beforeHistory = prompts
    await page.evaluate(() => history.forward())
    for (let i = 0; i < 100 && prompts === beforeHistory; i++) await page.waitForTimeout(10)
    assert.equal(prompts, beforeHistory + 1); await locationIs(base); await retained()
    allow = true; beforeHistory = prompts
    await page.evaluate(() => history.forward()); await locationIs(`${base}?task=${task.id}`); assert.equal(prompts, beforeHistory + 1); await empty()
    check(true, `${viewport}: all five fields independently dirty/revert; accepted tabs/Project/shell/Team/back/forward discard; rejected forward restores URL and fields`)

    step = `${viewport}: real failure correction and lost success retry`
    await fill(); await title.fill('x'.repeat(201))
    const rejectedIds: string[] = []
    for (let retry = 0; retry < 2; retry++) {
      const invalid = page.waitForResponse((r: any) => new URL(r.url()).pathname === `/api${taskPath}` && r.request().method() === 'POST' && r.status() === 400)
      await form.getByRole('button', { name: '创建任务', exact: true }).click()
      rejectedIds.push((await invalid).request().postDataJSON().requestId)
      await form.getByRole('alert').waitFor(); assert.equal((await title.inputValue()).length, 201)
      assert.equal(await description.inputValue(), 'line one\nline two\n'); assert.equal(await criteria.inputValue(), 'criteria\n'); assert.equal(await priority.inputValue(), 'high')
    }
    assert.equal(rejectedIds[0], rejectedIds[1])
    await fill()
    let first = true; const ids: string[] = []
    const matcher = (url: URL) => url.pathname === `/api${taskPath}`
    let accepted!: () => void, release!: () => void
    const acceptedPromise = new Promise<void>(resolve => { accepted = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const handler = async (route: any) => {
      if (route.request().method() !== 'POST') return route.continue()
      const response = await route.fetch(); if (!response.ok()) return route.fulfill({ response })
      ids.push(route.request().postDataJSON().requestId)
      if (first) { first = false; accepted(); await gate; await route.abort('failed') } else await route.fulfill({ response })
    }
    await page.route(matcher, handler)
    await form.getByRole('button', { name: '创建任务', exact: true }).click(); await acceptedPromise
    assert.ok(await title.isDisabled()); assert.ok(await description.isDisabled()); assert.ok(await criteria.isDisabled()); assert.ok(await priority.isDisabled()); assert.ok(await metadata.isDisabled())
    await form.evaluate((node: HTMLFormElement) => node.requestSubmit()) // Duplicate pending submit is ignored synchronously.
    release(); await form.getByRole('alert').filter({ hasText: '连接失败' }).waitFor(); await retained()
    const beforeSuccess = prompts
    await form.getByRole('button', { name: '创建任务', exact: true }).click()
    await page.getByRole('heading', { name: 'Private create draft', exact: true }).waitFor()
    assert.equal(prompts, beforeSuccess); assert.equal(await title.inputValue(), ''); assert.equal(await description.inputValue(), ''); assert.equal(await criteria.inputValue(), ''); assert.equal(await priority.inputValue(), 'none')
    assert.equal(ids.length, 2); assert.equal(ids[0], ids[1]); assert.notEqual(ids[0], rejectedIds[0])
    const created: { id: string; title: string }[] = (await f.request(taskPath)).data.items.filter((item: any) => item.title === 'Private create draft'); assert.equal(created.length, 1)
    assert.equal(await metadata.inputValue(), defaultTaskMetadataJson)
    assert.deepEqual((await f.request(`${taskPath}/${created[0].id}`)).data.metadataJson, JSON.parse(metadataRaw))
    await page.unroute(matcher, handler)
    check(true, `${viewport}: actual400 and lost-response errors retain input; pending edits disabled/duplicate ignored; exact retry creates once and clears before prompt-free navigation`)

    step = `${viewport}: late success and role retirement`
    await f.request(`/projects/${project.id}/grants`, { body: { userId: f.accounts.member.id, role: 'contributor' } })
    if (viewport === 'mobile') await page.getByRole('button', { name: '打开导航', exact: true }).click()
    await page.getByRole('button', { name: '退出登录', exact: true }).filter({ visible: true }).click()
    await page.getByRole('button', { name: '登录', exact: true }).waitFor()
    await page.getByLabel('邮箱或用户名', { exact: true }).fill(f.accounts.member.email); await page.getByLabel('密码', { exact: true }).fill(f.accounts.member.password); await page.getByRole('button', { name: '登录', exact: true }).click(); await title.waitFor()
    await fill()
    let commit!: () => void, deliver!: () => void, done!: () => void
    const committed = new Promise<void>(resolve => { commit = resolve }), delivery = new Promise<void>(resolve => { deliver = resolve }), finished = new Promise<void>(resolve => { done = resolve })
    const late = async (route: any) => { if (route.request().method() !== 'POST') return route.continue(); const response = await route.fetch(); if (!response.ok()) return route.fulfill({ response }); commit(); await delivery; await route.fulfill({ response }).catch(() => {}); done() }
    await page.route(matcher, late); await form.getByRole('button', { name: '创建任务', exact: true }).click(); await committed
    const beforeRetirement = prompts, retiredUrl = page.url()
    await f.request(`/projects/${project.id}/grants`, { body: { userId: f.accounts.member.id, role: 'viewer' } })
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await form.waitFor({ state: 'hidden' }); deliver(); await finished
    assert.equal(page.url(), retiredUrl); assert.equal(prompts, beforeRetirement); assert.equal(await form.count(), 0)
    await page.unroute(matcher, late)
    await f.request(`/projects/${project.id}/grants`, { body: { userId: f.accounts.member.id, role: 'contributor' } }); await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await title.waitFor(); assert.equal(await title.inputValue(), '')
    await fill(); const logoutPrompts = prompts
    const logoutCommitted = new Promise<void>(resolve => { commit = resolve }), logoutDelivery = new Promise<void>(resolve => { deliver = resolve }), logoutFinished = new Promise<void>(resolve => { done = resolve })
    const logoutLate = async (route: any) => { if (route.request().method() !== 'POST') return route.continue(); const response = await route.fetch(); assert.ok(response.ok()); commit(); await logoutDelivery; await route.fulfill({ response }).catch(() => {}); done() }
    await page.route(matcher, logoutLate); await form.getByRole('button', { name: '创建任务', exact: true }).click(); await logoutCommitted
    if (viewport === 'mobile') await page.getByRole('button', { name: '打开导航', exact: true }).click()
    await page.getByRole('button', { name: '退出登录', exact: true }).filter({ visible: true }).click(); await page.getByRole('button', { name: '登录', exact: true }).waitFor(); assert.equal(prompts, logoutPrompts); assert.equal(await title.count(), 0)
    const loggedOutUrl = page.url(); deliver(); await logoutFinished
    assert.equal(page.url(), loggedOutUrl); assert.equal(await title.count(), 0); assert.equal(prompts, logoutPrompts)
    await page.unroute(matcher, logoutLate)
    await page.getByLabel('邮箱或用户名', { exact: true }).fill(f.accounts.member.email); await page.getByLabel('密码', { exact: true }).fill(f.accounts.member.password); await page.getByRole('button', { name: '登录', exact: true }).click(); await title.waitFor(); await empty()
    await page.screenshot({ path: join(root, `${viewport}-form.png`), fullPage: true })
    check(true, `${viewport}: role retirement and logout discard privately without confirmation; held create success cannot resurrect or navigate; restored role starts empty`)

    step = `${viewport}: authentication retirement with committed response held`
    await fill(); const authPrompts: number = prompts
    const authCommitted = new Promise<void>(resolve => { commit = resolve }), authDelivery = new Promise<void>(resolve => { deliver = resolve }), authFinished = new Promise<void>(resolve => { done = resolve })
    const authLate = async (route: any) => { if (route.request().method() !== 'POST') return route.continue(); const response = await route.fetch(); assert.ok(response.ok()); commit(); await authDelivery; await route.fulfill({ response }).catch(() => {}); done() }
    await page.route(matcher, authLate); await form.getByRole('button', { name: '创建任务', exact: true }).click(); await authCommitted
    // A separate actual login revokes other login sessions; no forged 401 or test-only endpoint.
    step = `${viewport}: auth separate login and logout-all`
    const otherLogin = await fixture.login('member')
    assert.equal((await fixture.request('/auth/logout-all', { ...otherLogin, body: {} })).status, 200)
    step = `${viewport}: auth revalidation observes401`
    const expired = page.waitForResponse((response: any) => new URL(response.url()).pathname === '/api/teams' && response.status() === 401)
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await expired
    step = `${viewport}: auth401 renders login without prompt`
    await page.getByRole('button', { name: '登录', exact: true }).waitFor(); assert.equal(await title.count(), 0); assert.equal(prompts, authPrompts)
    step = `${viewport}: release auth-retired response`
    const expiredUrl = page.url(); deliver(); await authFinished
    assert.equal(page.url(), expiredUrl); assert.equal(await title.count(), 0); assert.equal(prompts, authPrompts)
    await page.unroute(matcher, authLate)
    step = `${viewport}: logout secondary fixture login`
    assert.equal((await fixture.request('/auth/logout', { ...otherLogin, body: {} })).status, 204)
    assert.deepEqual(pageErrors, [])
    check(true, `${viewport}: actual authentication401 retires dirty pending creation without prompt or late success resurrection; no pageerror`)
    await page.screenshot({ path: join(root, `${viewport}-retired.png`), fullPage: true }); await context.close()
  }
  result.passed = true
} catch { result.failureStep = step }
finally { try { await browser?.close() } catch { result.passed = false; result.cleanupFailures.push('browser') }; try { await f?.close() } catch { result.passed = false; result.cleanupFailures.push('fixture') }; await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2)) }
console.log(JSON.stringify({ ...result, evidence: root })); process.exitCode = result.passed ? 0 : 1
