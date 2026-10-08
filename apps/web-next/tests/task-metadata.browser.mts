import type { TaskDetail } from '@wemux/web-contract/task-platform'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { adminRouteFixture } from '../../server/src/test/fixtures/admin-route-fixture.ts'
import { launchAcceptanceBrowser } from './acceptance-runtime.mjs'
const root = await mkdtemp(join(tmpdir(), 'wemux-task-metadata-browser-'))
const result = { passed: false, checks: [] as string[], failureStep: '', cleanupFailures: [] as string[] }
let f: Awaited<ReturnType<typeof adminRouteFixture>> | undefined, browser: any, step = 'setup'
const metadata = (values: Record<string, unknown>) => ({ schemaVersion: 1, values })
const check = (label: string) => result.checks.push(label)
try {
  assert.ok(process.env.WEMUX_NEXT_TEST_DIST?.startsWith('/tmp/'))
  f = await adminRouteFixture(resolve(process.env.WEMUX_NEXT_TEST_DIST!)); const fixture = f
  browser = await launchAcceptanceBrowser()
  for (const [viewport, size] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]] as const) {
    const context = await browser.newContext({ viewport: size }), page = await context.newPage(); page.setDefaultTimeout(8000)
    const pageErrors: string[] = []; page.on('pageerror', () => pageErrors.push('pageerror'))
    const project: { id: string } = (await f.request('/projects', { body: { name: `Metadata ${viewport}` } })).data
    const base: string = `/projects/${project.id}/tasks`, url = `/next/projects/${project.id}`
    const login = async (key: 'owner' | 'member') => {
      await page.getByLabel('邮箱或用户名', { exact: true }).fill(fixture.accounts[key].email)
      await page.getByLabel('密码', { exact: true }).fill(fixture.accounts[key].password)
      await page.getByRole('button', { name: '登录', exact: true }).click()
    }
    const logout = async () => { if (viewport === 'mobile') await page.getByRole('button', { name: '打开导航', exact: true }).click(); await page.getByRole('button', { name: '退出登录', exact: true }).filter({ visible: true }).click(); await page.getByRole('button', { name: '登录', exact: true }).waitFor() }
    await page.goto(`${f.origin}${url}`); await login('owner')
    const create = page.getByRole('button', { name: '创建任务', exact: true }).locator('xpath=ancestor::form')
    await create.locator('summary').click()
    const createRaw = create.locator('[name=metadataJson]')
    await create.locator('[name=title]').fill('Metadata Task')
    const writes: { method: string; body: any }[] = []
    page.on('request', (request: any) => { if (new URL(request.url()).pathname.startsWith(`/api${base}`) && ['POST', 'PATCH'].includes(request.method())) writes.push({ method: request.method(), body: request.postDataJSON() }) })
    step = `${viewport}: invalid create JSON/schema are editable and make no request`
    for (const [raw, reason] of [['{', /JSON|property|Expected/i], ['null', /Expected an object/], ['{"schemaVersion":2,"values":{}}', /schemaVersion 1/], ['{"schemaVersion":1,"values":null}', /Expected an object/], ['', /JSON/i]] as const) {
      await createRaw.fill(raw); await create.getByRole('button', { name: '创建任务', exact: true }).click()
      await create.getByRole('alert').filter({ hasText: reason }).waitFor(); assert.equal(await createRaw.inputValue(), raw); assert.equal(writes.length, 0)
    }
    const initial = metadata({ nested: { null: null, empty: '', array: [1, false, {}, []] }, unknownKey: 'preserved' })
    await createRaw.fill(JSON.stringify(initial, null, 2)); await create.getByRole('button', { name: '创建任务', exact: true }).click()
    await page.getByRole('heading', { name: 'Metadata Task', exact: true }).waitFor()
    const id = new URL(page.url()).searchParams.get('task')!, path = `${base}/${id}`
    const current = async (): Promise<TaskDetail> => (await fixture.request(path)).data
    assert.deepEqual((await current()).metadataJson, initial); assert.equal((await current()).acceptanceCriteria, null)
    assert.equal(writes.length, 1); assert.deepEqual(writes[0].body.metadataJson, initial)
    check(`${viewport}: invalid create syntax/schema/null/empty blocked without writes; correction creates exact nested values and keeps criteria null`)
    const edit = page.getByRole('button', { name: '保存任务内容', exact: true }).locator('xpath=ancestor::form'), raw = edit.locator('[name=metadataJson]'), save = edit.getByRole('button', { name: '保存任务内容', exact: true })
    const open = async () => { await edit.waitFor(); await edit.locator('details').evaluate((node: HTMLDetailsElement) => { node.open = true }) }
    await open(); assert.deepEqual(JSON.parse(await raw.inputValue()), initial)
    await page.reload(); await open(); assert.deepEqual(JSON.parse(await raw.inputValue()), initial)
    step = `${viewport}: invalid edits, structural no-op, unrelated merge and dirty-only PATCH`
    const beforeInvalid = writes.length
    for (const [text, reason] of [['{bad', /JSON|property|Expected/i], ['{"schemaVersion":1,"values":{},"extra":1}', /schemaVersion 1/], [JSON.stringify(metadata({ text: 'x'.repeat(16000) })), /Metadata too large/]] as const) {
      await raw.fill(text); await save.click(); await edit.getByRole('alert').filter({ hasText: reason }).waitFor(); assert.equal(await raw.inputValue(), text); assert.equal(writes.length, beforeInvalid)
    }
    await raw.fill(JSON.stringify({ values: { unknownKey: 'preserved', nested: { array: [1, false, {}, []], empty: '', null: null } }, schemaVersion: 1 }))
    await save.click(); await edit.getByRole('status').filter({ hasText: '没有需要保存' }).waitFor(); assert.equal(writes.length, beforeInvalid)
    const local = metadata({ nested: { null: null, empty: '', array: [2, false, {}, []] }, untouched: { k: 'v' } })
    await raw.fill(JSON.stringify(local)); const remoteBefore = await current()
    assert.equal((await f.request(path, { method: 'PATCH', body: { description: 'Remote unrelated\nline two', version: remoteBefore.version } })).status, 200)
    await save.click(); await edit.getByRole('status').filter({ hasText: '任务内容已保存' }).waitFor()
    assert.deepEqual(Object.keys(writes.at(-1)!.body).sort(), ['metadataJson', 'version']); assert.equal(writes.at(-1)!.body.version, remoteBefore.version + 1)
    assert.deepEqual((await current()).metadataJson, local); assert.equal(await edit.locator('[name=description]').inputValue(), 'Remote unrelated\nline two')
    await page.reload(); await open(); assert.deepEqual(JSON.parse(await raw.inputValue()), local)
    check(`${viewport}: editable validation recovery; reordered object is no-op; metadata-only versioned PATCH merges unrelated remote description; persisted reload exact`)

    step = `${viewport}: metadata conflicts require both explicit choices`
    const localConflict = metadata({ local: [null, '', 'choice'] }), remoteConflict = metadata({ remote: true })
    await raw.fill(JSON.stringify(localConflict)); await f.request(path, { method: 'PATCH', body: { metadataJson: remoteConflict, version: (await current()).version } })
    const beforeConflict = writes.length
    await save.click(); await edit.getByRole('button', { name: '保留本地编辑 Metadata JSON（schemaVersion 1）', exact: true }).waitFor()
    assert.equal(writes.length, beforeConflict); assert.deepEqual(JSON.parse(await raw.inputValue()), localConflict)
    await edit.getByRole('button', { name: '采用远端编辑 Metadata JSON（schemaVersion 1）', exact: true }).click(); assert.deepEqual(JSON.parse(await raw.inputValue()), remoteConflict)
    await raw.fill(JSON.stringify(localConflict)); await f.request(path, { method: 'PATCH', body: { metadataJson: metadata({ remote: 2 }), version: (await current()).version } })
    await save.click(); await edit.getByRole('button', { name: '保留本地编辑 Metadata JSON（schemaVersion 1）', exact: true }).click()
    await save.click(); await edit.getByRole('status').filter({ hasText: '任务内容已保存' }).waitFor(); assert.deepEqual((await current()).metadataJson, localConflict)
    check(`${viewport}: same metadata field never key-merges silently; local and remote explicit choices both work`)

    step = `${viewport}: actual outgoing metadata CAS conflict retains draft`
    const matcher = (u: URL) => u.pathname === `/api${path}`
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const hold = async (route: any) => { if (route.request().method() !== 'PATCH') return route.continue(); enter(); await gate; await route.continue() }
    const beforeRace = writes.length
    const raced = metadata({ race: 'local' }); await raw.fill(JSON.stringify(raced)); await page.route(matcher, hold)
    await save.click(); await entered
    assert.ok(await raw.isDisabled()); await edit.evaluate((node: HTMLFormElement) => node.requestSubmit())
    await f.request(path, { method: 'PATCH', body: { metadataJson: metadata({ race: 'remote' }), version: (await current()).version } })
    const rejected = page.waitForResponse((r: any) => new URL(r.url()).pathname === `/api${path}` && r.request().method() === 'PATCH' && r.status() === 409)
    assert.equal(writes.length, beforeRace + 1)
    release(); await rejected; await edit.getByRole('button', { name: '重新加载内容版本', exact: true }).waitFor(); await page.unroute(matcher, hold)
    assert.equal(writes.length, beforeRace + 1)
    assert.deepEqual(JSON.parse(await raw.inputValue()), raced); assert.ok(await save.isDisabled())
    await edit.getByRole('button', { name: '重新加载内容版本', exact: true }).click(); await edit.getByRole('button', { name: '保留本地编辑 Metadata JSON（schemaVersion 1）', exact: true }).click()
    await save.click(); await edit.getByRole('status').filter({ hasText: '任务内容已保存' }).waitFor(); assert.deepEqual((await current()).metadataJson, raced)
    check(`${viewport}: genuine409 after preflight, pending duplicate ignored, raw retained, explicit reload/choice/retry succeeds`)

    step = `${viewport}: lost PATCH acknowledgement and edit navigation`
    const lost = metadata({ accepted: 'response lost' }); await raw.fill(JSON.stringify(lost))
    const drop = async (route: any) => { if (route.request().method() !== 'PATCH') return route.continue(); const response = await route.fetch(); assert.ok(response.ok()); await route.abort('failed') }
    await page.route(matcher, drop); await save.click(); await edit.getByRole('alert').filter({ hasText: '连接失败' }).waitFor(); await page.unroute(matcher, drop)
    assert.deepEqual(JSON.parse(await raw.inputValue()), lost); assert.deepEqual((await current()).metadataJson, lost)
    const beforeRetry = writes.length; await save.click(); await edit.getByRole('status').filter({ hasText: '没有需要保存' }).waitFor(); assert.equal(writes.length, beforeRetry)
    let allow = false, prompts = 0
    const dialog = async (d: any) => { prompts++; allow ? await d.accept() : await d.dismiss() }; page.on('dialog', dialog)
    await raw.fill('{unsaved'); await page.getByRole('button', { name: '关闭详情', exact: true }).click(); assert.equal(prompts, 1); assert.equal(await raw.inputValue(), '{unsaved')
    allow = true; await page.getByRole('button', { name: '关闭详情', exact: true }).click(); await edit.waitFor({ state: 'hidden' }); assert.equal(prompts, 2)
    await page.getByRole('button', { name: 'Metadata Task', exact: true }).click(); await open(); assert.deepEqual(JSON.parse(await raw.inputValue()), lost)
    page.off('dialog', dialog)
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
    await page.screenshot({ path: join(root, `${viewport}-metadata.png`), fullPage: true })
    check(`${viewport}: lost committed PATCH retains raw; retry converges without write; rejected close retains invalid raw, accepted close discards; no horizontal overflow`)

    step = `${viewport}: viewer UI and unauthorized metadata API`
    await f.request(`/projects/${project.id}/grants`, { body: { userId: f.accounts.member.id, role: 'viewer' } }); await logout(); await login('member'); step = `${viewport}: viewer disabled controls`; await open()
    assert.ok(await raw.isDisabled()); assert.ok(await save.isDisabled()); assert.equal(await create.count(), 0)
    assert.equal((await f.request(path, { token: f.accounts.member.token, method: 'PATCH', body: { metadataJson: metadata({ forbidden: true }), version: (await current()).version } })).status, 403)
    assert.equal((await f.request(base, { token: f.accounts.member.token, body: { title: 'Forbidden', metadataJson: metadata({}) } })).status, 403)
    step = `${viewport}: noGrant API403`
    const noGrant: { id: string } = (await f.request('/projects', { body: { name: 'Hidden metadata' } })).data
    assert.equal((await f.request(`/projects/${noGrant.id}/tasks`, { token: f.accounts.member.token, body: { title: 'Forbidden', metadataJson: metadata({}) } })).status, 403)
    check(`${viewport}: viewer reads exact metadata but cannot edit/create; actual viewer403/noGrant403 enforce authority`)

    for (const retirement of ['role', 'logout', 'authentication'] as const) {
      step = `${viewport}: held metadata PATCH success across ${retirement} retirement`
      await f.request(`/projects/${project.id}/grants`, { body: { userId: f.accounts.member.id, role: 'contributor' } })
      if (await page.getByRole('button', { name: '登录', exact: true }).count()) await login('member')
      await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await open(); await raw.waitFor();
      // Role revalidation remounts the editor; wait for its actual write permission.
      await page.waitForFunction(() => !document.querySelector<HTMLTextAreaElement>('textarea[aria-label="编辑 Metadata JSON（schemaVersion 1）"]')?.matches(':disabled'))
      await open()
      step = `${viewport}: ${retirement} submit held PATCH`
      const retired = metadata({ retired: retirement }); await raw.fill(JSON.stringify(retired))
      let commit!: () => void, deliver!: () => void, done!: () => void
      const committed = new Promise<void>(resolve => { commit = resolve }), delivery = new Promise<void>(resolve => { deliver = resolve }), finished = new Promise<void>(resolve => { done = resolve })
      const late = async (route: any) => { if (route.request().method() !== 'PATCH') return route.continue(); const response = await route.fetch(); assert.ok(response.ok()); commit(); await delivery; await route.fulfill({ response }).catch(() => {}); done() }
      await page.route(matcher, late); await save.click(); await committed
      let privateReads = 0; const observe = (request: any) => { if (new URL(request.url()).pathname.startsWith(`/api/projects/${project.id}`)) privateReads++ }
      let otherLogin: Awaited<ReturnType<typeof fixture.login>> | undefined
      step = `${viewport}: ${retirement} retire pending editor`
      if (retirement === 'role') {
        await f.request(`/projects/${project.id}/grants`, { body: { userId: f.accounts.member.id, role: 'viewer' } })
        await page.evaluate(() => window.dispatchEvent(new Event('focus')))
        step = `${viewport}: role wait viewer remount`
        await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="编辑 Metadata JSON（schemaVersion 1）"]')?.matches(':disabled') && ![...document.querySelectorAll('button')].some(node => node.textContent === '创建任务'))
        step = `${viewport}: role open viewer metadata`
        await open(); assert.equal(await edit.getByText('正在处理…', { exact: true }).count(), 0)
      } else if (retirement === 'logout') await logout()
      else {
        otherLogin = await f.login('member'); assert.equal((await f.request('/auth/logout-all', { ...otherLogin, body: {} })).status, 200)
        await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await page.getByRole('button', { name: '登录', exact: true }).waitFor()
      }
      step = `${viewport}: ${retirement} release retired PATCH`
      const retiredUrl = page.url(); page.on('request', observe); deliver(); await finished
      // A real UI operation after release lets the browser drain retired callbacks, without timing sleeps.
      if (retirement === 'role') { await page.getByRole('button', { name: '关闭详情', exact: true }).click(); await edit.waitFor({ state: 'hidden' }); assert.equal(await page.getByText('任务内容已保存。', { exact: true }).count(), 0) }
      else { await page.getByLabel('邮箱或用户名', { exact: true }).fill(''); assert.equal(page.url(), retiredUrl); assert.equal(await edit.count(), 0) }
      assert.equal(privateReads, 0); page.off('request', observe); await page.unroute(matcher, late)
      assert.deepEqual((await current()).metadataJson, retired)
      if (otherLogin) assert.equal((await f.request('/auth/logout', { ...otherLogin, body: {} })).status, 204)
      if (retirement === 'role') { await page.getByRole('button', { name: 'Metadata Task', exact: true }).click(); await open() }
      check(`${viewport}: ${retirement} retires held committed metadata response without stale notice/private reload/resurrection; server commit retained`)
    }
    assert.deepEqual(pageErrors, []); await context.close()
  }
  result.passed = true
} catch { result.failureStep = step }
finally { try { await browser?.close() } catch { result.passed = false; result.cleanupFailures.push('browser') }; try { await f?.close() } catch { result.passed = false; result.cleanupFailures.push('fixture') }; await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2)) }
console.log(JSON.stringify({ ...result, evidence: root })); process.exitCode = result.passed ? 0 : 1
