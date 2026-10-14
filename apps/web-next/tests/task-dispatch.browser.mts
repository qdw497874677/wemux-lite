import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { adminRouteFixture } from '../../server/src/test/fixtures/admin-route-fixture.ts'
import { launchAcceptanceBrowser } from './acceptance-runtime.mjs'

// 真实应用、真实登录、真实 SQLite 与真实 Worker 凭证申领；只有 Worker 能力清单是夹具合成的，
// 因此本用例只主张「机器范围与派发」界面确实展示服务端判定并驱动真实接口。
const root = await mkdtemp(join(tmpdir(), 'wemux-dispatch-panel-'))
const result = { passed: false, checks: [] as string[] }
let f: Awaited<ReturnType<typeof adminRouteFixture>> | undefined, browser: any
const capabilities = [{ agentKey: 'fixture', displayName: '夹具执行 Agent', mode: 'execution' as const, availability: { status: 'available' as const }, models: [{ modelId: 'fixture-model', displayName: '夹具模型', source: 'configured' as const }] }]
async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string) {
  let latest: T
  for (let attempt = 0; attempt < 100; attempt += 1) { latest = await read(); if (accept(latest)) return latest; await new Promise(resolve => setTimeout(resolve, 100)) }
  throw Error(`超时：${label}`)
}
try {
  assert.ok(process.env.WEMUX_NEXT_TEST_DIST?.startsWith('/tmp/'))
  f = await adminRouteFixture(resolve(process.env.WEMUX_NEXT_TEST_DIST!)); const fixture = f
  const taskUrl = `/projects/${fixture.project.id}/tasks/${fixture.task.id}`
  // 任务进入待处理即建立执行意图，不需要额外的入队开关。
  await fixture.request(taskUrl, { body: { status: 'todo', version: fixture.task.version }, method: 'PATCH' })
  await fixture.app.store.transaction(async tx => { const node = (await tx.resources.getWorker(fixture.worker.workerId))!; await tx.resources.saveWorker({ ...node, connectionState: 'online', capabilities }) })
  const enrollment = (await fixture.request('/enrollment-tokens', { body: {} })).data
  const second = (await fixture.request('/workers/enroll', { body: { token: enrollment.token, name: '票据01 第二台机器' } })).data
  await fixture.app.store.transaction(async tx => { const node = (await tx.resources.getWorker(second.workerId))!; await tx.resources.saveWorker({ ...node, connectionState: 'online' }) })
  const dispatch = async () => (await fixture.request(`${taskUrl}/dispatch`)).data
  const taskOf = async () => (await fixture.app.store.tasks.get(fixture.task.id as never))!
  const sessionOf = async () => (await fixture.app.store.resources.getSession(fixture.sessionId as never))!

  browser = await launchAcceptanceBrowser()
  for (const [viewport, size] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]] as const) {
    // 每个视口从「任意获权机器」开始，避免上一轮写下的范围影响本轮断言。
    const current = await dispatch()
    await fixture.request(`${taskUrl}/dispatch/machine-scope`, { body: { requestId: `reset-${viewport}`, version: current.version, scope: { kind: 'any' } }, method: 'PUT' })
    const context = await browser.newContext({ viewport: size }), page = await context.newPage()
    page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(20000)
    await page.goto(`${fixture.origin}/next/projects/${fixture.project.id}?task=${fixture.task.id}`)
    await page.getByLabel('邮箱或用户名', { exact: true }).fill(fixture.accounts.owner.email)
    await page.getByLabel('密码', { exact: true }).fill(fixture.accounts.owner.password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    const panel = page.locator('.task-dispatch')
    await page.getByRole('heading', { name: '机器范围与派发' }).waitFor()
    assert.match(await panel.innerText(), /机器范围：任意获权机器/)
    assert.match(await panel.innerText(), /执行意图：第 1 次安排/)
    assert.match(await panel.innerText(), /等待派发：当前没有合格且有余量的候选机器/)
    result.checks.push(`${viewport}: 任务详情展示机器范围、执行意图与保持 todo 的等待原因`)

    // 固定机器：范围写入真实生效，已建 Session 不换绑，任务状态不变。
    await page.locator('select[name="kind"]').selectOption('fixed')
    await page.locator('select[name="workerIds"]').selectOption([fixture.worker.workerId])
    await page.getByRole('button', { name: '提交机器范围与派发操作', exact: true }).click()
    await eventually(dispatch, view => view.machineScope.kind === 'fixed' && view.machineScope.workerId === fixture.worker.workerId, '固定机器范围生效')
    assert.equal((await taskOf()).status, 'todo'); assert.equal((await sessionOf()).binding.agent.workerId, fixture.worker.workerId)
    // 面板刷新到新版本后表单才带新 version，后续操作不能被状态竞争误判为版本冲突。
    await eventually(async () => await panel.innerText(), text => /^机器范围：固定机器：Idle metadata fixture$/m.test(text), '面板刷新固定机器范围')
    result.checks.push(`${viewport}: 固定机器范围真实写入，任务状态与既有 Session 绑定不受影响`)

    // 候选集合：多选写入真实生效，入队序号不因范围修改而重排。
    const before = await dispatch()
    await page.locator('select[name="kind"]').selectOption('candidates')
    await page.locator('select[name="workerIds"]').selectOption([fixture.worker.workerId, second.workerId])
    await page.getByRole('button', { name: '提交机器范围与派发操作', exact: true }).click()
    const candidates = await eventually(dispatch, view => view.machineScope.kind === 'candidates' && view.machineScope.workerIds.length === 2, '候选集合范围生效')
    assert.deepEqual([...candidates.machineScope.workerIds].sort(), [fixture.worker.workerId, second.workerId].sort())
    assert.equal(candidates.intent.queueOrder, before.intent.queueOrder); assert.equal(candidates.intent.generation, before.intent.generation)
    await eventually(async () => await panel.innerText(), text => /^机器范围：候选机器：/m.test(text), '面板刷新候选集合范围')
    if (viewport === 'mobile') assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), '移动端不得横向溢出')
    result.checks.push(`${viewport}: 候选集合范围多选写入；重复修改范围不重排入队序号、不推进代次`)
    await page.screenshot({ path: join(root, `${viewport}-scope.png`), fullPage: true })
    await context.close()
  }

  // 机器以自身凭证申领后，界面必须按服务端记录展示承接，而不是自己推导。
  const intent = (await dispatch()).intent
  const claim = await fetch(`${fixture.origin}/api/workers/${fixture.worker.workerId}/dispatch-claims`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fixture.worker.credential}` }, body: JSON.stringify({ requestId: 'panel-claim-1', intentId: intent.intentId, generation: intent.generation }) })
  assert.equal(claim.status, 200)
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }), page = await context.newPage()
  page.setDefaultTimeout(10000)
  await page.goto(`${fixture.origin}/next/projects/${fixture.project.id}?task=${fixture.task.id}`)
  await page.getByLabel('邮箱或用户名', { exact: true }).fill(fixture.accounts.owner.email)
  await page.getByLabel('密码', { exact: true }).fill(fixture.accounts.owner.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  const panel = page.locator('.task-dispatch')
  await page.getByRole('heading', { name: '机器范围与派发' }).waitFor()
  await eventually(async () => await panel.innerText(), text => /执行承接：Idle metadata fixture · 已预约未确认/.test(text), '承接记录展示')
  const claimText = await panel.innerText()
  assert.match(claimText, /执行承接：Idle metadata fixture · 已预约未确认/)
  assert.doesNotMatch(claimText, /等待派发/)
  result.checks.push('真实 Worker 凭证申领后，任务详情按服务端记录展示承接方与承接状态，并撤下等待原因')
  await page.screenshot({ path: join(root, 'claimed.png'), fullPage: true })
  await context.close()
  result.passed = true
} catch (error) {
  console.error('浏览器验收失败：', error instanceof Error ? error.message : '未知错误')
} finally {
  await browser?.close().catch(() => {})
  await f?.close().catch(() => {})
}
console.log(JSON.stringify(result, null, 2))
process.exitCode = result.passed ? 0 : 1
