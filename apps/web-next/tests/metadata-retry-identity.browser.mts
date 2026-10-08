import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { adminRouteFixture } from '../../server/src/test/fixtures/admin-route-fixture.ts'
import { launchAcceptanceBrowser } from './acceptance-runtime.mjs'

const root = await mkdtemp(join(tmpdir(), 'wemux-metadata-retry-browser-'))
const result = { passed: false, failureStep: '', observations: [] as { viewport: string; sameRequestId: boolean; persistedTasks: number; rawAndPayloadPreserved: boolean }[], cleanupFailures: [] as string[] }
let f: Awaited<ReturnType<typeof adminRouteFixture>> | undefined, browser: any, step = 'setup'
try {
  assert.ok(process.env.WEMUX_NEXT_TEST_DIST?.startsWith('/tmp/'))
  f = await adminRouteFixture(resolve(process.env.WEMUX_NEXT_TEST_DIST!)); browser = await launchAcceptanceBrowser()
  for (const [viewport, size] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]] as const) {
    step = `${viewport}: private login and create draft`
    const context = await browser.newContext({ viewport: size }), page = await context.newPage(); page.setDefaultTimeout(8000)
    const errors: string[] = []; page.on('pageerror', () => errors.push('pageerror'))
    const project: { id: string } = (await f.request('/projects', { body: { name: `Retry metadata ${viewport}` } })).data
    const path = `/projects/${project.id}/tasks`
    await page.goto(`${f.origin}/next/projects/${project.id}`)
    await page.getByLabel('邮箱或用户名', { exact: true }).fill(f.accounts.owner.email)
    await page.getByLabel('密码', { exact: true }).fill(f.accounts.owner.password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    const form = page.getByRole('button', { name: '创建任务', exact: true }).locator('xpath=ancestor::form')
    await form.locator('[name=title]').fill('Uncertain metadata create')
    await form.locator('summary').click()
    const raw = form.locator('[name=metadataJson]')
    const original = '{"schemaVersion":1,"values":{"a":1,"nested":{"first":null,"second":{"x":"","y":true}},"array":[{"a":1,"b":2},null],"__proto__":{"z":3,"a":4}}}'
    const reordered = '{\n "values":{"__proto__":{"a":4,"z":3},"array":[{"b":2,"a":1},null],"nested":{"second":{"y":true,"x":""},"first":null},"a":1},"schemaVersion":1\n}'
    assert.deepEqual(JSON.parse(original), JSON.parse(reordered))
    await raw.fill(original)
    const bodies: any[] = []
    const matcher = (url: URL) => url.pathname === `/api${path}`
    let first = true
    const handler = async (route: any) => {
      if (route.request().method() !== 'POST') return route.continue()
      bodies.push(route.request().postDataJSON())
      const response = await route.fetch(); assert.equal(response.status(), 201)
      if (first) { first = false; await route.abort('failed') } else await route.fulfill({ response })
    }
    await page.route(matcher, handler)
    step = `${viewport}: commit then lose response`
    await form.getByRole('button', { name: '创建任务', exact: true }).click()
    await form.getByRole('alert').filter({ hasText: '连接失败' }).waitFor()
    assert.equal(await raw.inputValue(), original)
    assert.equal((await f.request(path)).data.items.length, 1)
    step = `${viewport}: reorder recursive object keys then retry`
    await raw.fill(reordered); assert.equal(await raw.inputValue(), reordered)
    await form.getByRole('button', { name: '创建任务', exact: true }).click()
    await page.getByRole('heading', { name: 'Uncertain metadata create', exact: true }).waitFor()
    const persisted: { id: string }[] = (await f.request(path)).data.items
    assert.equal(bodies.length, 2)
    // Identity canonicalization must not normalize the actual valid POST payload.
    assert.equal(JSON.stringify(bodies[0].metadataJson), JSON.stringify(JSON.parse(original)))
    assert.equal(JSON.stringify(bodies[1].metadataJson), JSON.stringify(JSON.parse(reordered)))
    for (const task of persisted) assert.deepEqual((await f.request(`${path}/${task.id}`)).data.metadataJson, JSON.parse(original))
    assert.deepEqual(errors, [])
    result.observations.push({ viewport, sameRequestId: bodies[0].requestId === bodies[1].requestId, persistedTasks: persisted.length, rawAndPayloadPreserved: true })
    await page.unroute(matcher, handler); await context.close()
  }
  step = 'same requestId and exactly one persisted Task on both viewports'
  assert.ok(result.observations.every(item => item.sameRequestId && item.persistedTasks === 1))
  result.passed = true
} catch { result.failureStep = step }
finally {
  try { await browser?.close() } catch { result.passed = false; result.cleanupFailures.push('browser') }
  try { await f?.close() } catch { result.passed = false; result.cleanupFailures.push('fixture') }
  await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2))
}
console.log(JSON.stringify({ ...result, evidence: root })); process.exitCode = result.passed ? 0 : 1
