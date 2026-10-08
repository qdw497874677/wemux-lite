/** 02-02 受控浏览器双视口验收：真实 Server + 真实账号 + Chromium desktop/mobile。
 * Team 范围协调入口必须可见但处于可诊断禁用态；无任何发送/上传控件；
 * 直接 HTTP enqueue 在资格门 FAIL 下必须得到 403 coordination_gate_closed。
 * 不涉及真实 Worker 或任何协调执行（02-04 才做配对观测）。
 * WEMUX_NEXT_TEST_DIST=/tmp/... node --import tsx apps/e2e/next-coordination-entry-browser.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createWemuxServer } from '../server/src/server.ts'
import { provisionAdministrator } from './session.ts'

assert.ok(process.env.WEMUX_NEXT_TEST_DIST?.startsWith('/tmp/'), 'owned temporary build required')
const { chromium } = await import(process.env.PLAYWRIGHT_CORE_PATH ?? '/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs')
const evidence = await mkdtemp(join(tmpdir(), 'wemux-next-coordination-'))
const shots = resolve('.scratch/web-next-project-agent-platform/evidence/02-02')
await mkdir(shots, { recursive: true })
const email = 'coordination-owner@example.test', password = 'coordination-browser-test-password'
const app = createWemuxServer({ databasePath: join(evidence, 'server.sqlite'), administratorEmails: [email], mail: {}, google: {}, webNextStaticPath: resolve(process.env.WEMUX_NEXT_TEST_DIST) })
const origin = await app.listen(0)
const checks = [], errors = [], contexts = []
let browser, step = 'setup'
const check = name => { checks.push(`${step}: ${name}`); console.log(`check ${step}: ${name}`) }
try {
  const owner = await provisionAdministrator({ store: app.store, baseUrl: origin, email, password })
  const api = owner.api
  await api('/bootstrap', 'POST', {})
  // 独立账号另建一个 Team，用于验证跨 Team 不可见（非成员 403/404，不泄漏存在性）。
  const outsider = await provisionAdministrator({ store: app.store, baseUrl: origin, email: 'coordination-outsider@example.test', password: 'coordination-outsider-password' })
  const team = await api('/teams', 'POST', { name: '协调入口验收团队' })

  // 服务端投影先于浏览器验证：可用性端点与关闭态 enqueue 的裁决唯一来自资格门。
  step = 'http'
  const availability = await api(`/teams/${team.id}/coordination/availability`)
  assert.equal(availability.status, 'disabled')
  assert.equal(availability.gate.verdict, 'FAIL')
  assert.ok(availability.gate.reasons.length >= 2, 'OS 隔离与网络出口收敛原因都要呈现')
  assert.match(availability.gate.evidencePath, /ticket-05-runtime-isolation-gate\.md$/)
  assert.match(availability.gate.remediationSection, /^五$/)
  assert.ok(availability.gate.reopenConditions.length >= 3)
  const availabilityJson = JSON.stringify(availability)
  for (const secret of [password, 'coordination-outsider-password', email]) assert.ok(!availabilityJson.includes(secret), '投影不得泄漏凭据')
  check('availability projection: disabled + FAIL + 证据路径 + 解除条件 + 无凭据泄漏')
  let enqueueRejected
  try { await api(`/teams/${team.id}/coordination/sessions`, 'POST', {}); enqueueRejected = { status: 200 } } catch (error) { enqueueRejected = { status: Number(/: (\d{3}) /.exec(error.message)?.[1]), message: error.message } }
  assert.equal(enqueueRejected.status, 403, `直接 enqueue 必须被拒：${enqueueRejected.message}`)
  assert.match(enqueueRejected.message, /coordination_gate_closed/)
  check('direct HTTP enqueue: 403 coordination_gate_closed（UI 禁用不是安全边界）')
  let outsiderView
  try { await outsider.api(`/teams/${team.id}/coordination/availability`); outsiderView = 200 } catch (error) { outsiderView = Number(/: (\d{3}) /.exec(error.message)?.[1]) }
  assert.ok(outsiderView === 403 || outsiderView === 404, `非成员不可见（得到 ${outsiderView}）`)
  check(`outsider availability: ${outsiderView} 不泄漏 Team 存在性`)

  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    step = `${name}: entry`
    const context = await browser.newContext({ viewport, isMobile: name === 'mobile', hasTouch: name === 'mobile' })
    contexts.push(context)
    assert.equal((await context.request.post(`${origin}/api/auth/login`, { data: { login: email, password } })).status(), 200)
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    page.on('pageerror', error => errors.push({ name, step, message: error.message }))
    // Team 范围直达（无需选择 Project）。
    await page.goto(`${origin}/next/teams`)
    const card = page.getByRole('region', { name: '协调资格门状态' })
    await card.waitFor()
    check('team scope entry visible without selecting a project')
    const text = await card.innerText()
    assert.match(text, /协调入口不可用/)
    assert.match(text, /FAIL/)
    for (const reason of availability.gate.reasons) assert.ok(text.includes(reason), `原因呈现：${reason}`)
    assert.match(text, /ticket-05-runtime-isolation-gate\.md/)
    assert.match(text, /coordination-write-channel-matrix\.md/)
    assert.ok((await card.getByRole('list').count()) >= 2, '原因与解除条件两个列表都要渲染')
    for (const condition of availability.gate.reopenConditions) assert.ok(text.includes(condition), `解除条件呈现：${condition}`)
    check('disabled card: verdict + reasons + evidence path + reopen conditions')
    const interactive = page.locator('section[aria-labelledby="team-coordination-heading"] button, section[aria-labelledby="team-coordination-heading"] input, section[aria-labelledby="team-coordination-heading"] textarea, section[aria-labelledby="team-coordination-heading"] [contenteditable="true"]')
    assert.equal(await interactive.count(), 0, '禁用态不得出现任何发送/上传可点控件')
    check('no send/upload controls rendered')
    // 视口截图（脱敏：只截应用视口，无凭据输入）。
    await page.screenshot({ path: join(shots, `coordination-${name}.png`), fullPage: true })
    check('screenshot captured')
    // 页面内 fetch 直接 enqueue（绕过组件层）也必须被服务端拒绝。
    const inPage = await page.evaluate(async teamId => {
      const me = await fetch('/api/auth/me').then(response => response.json())
      const response = await fetch(`/api/teams/${teamId}/coordination/sessions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': me.csrfToken }, body: '{}' })
      return { status: response.status, body: await response.json() }
    }, team.id)
    assert.equal(inPage.status, 403)
    assert.equal(inPage.body?.error?.code ?? inPage.body?.code, 'coordination_gate_closed')
    check('in-page fetch enqueue rejected: 403 coordination_gate_closed')
  }
  assert.deepEqual(errors, [], '浏览器页面不得出现未处理异常')
  check('zero pageerror across viewports')
  console.log(JSON.stringify({ ok: true, origin: origin.replace(/:\d+$/, ':PORT'), checks, errors, screenshots: `${shots}/coordination-{desktop,mobile}.png` }, null, 2))
} catch (error) {
  console.error(JSON.stringify({ ok: false, step, checks, errors, message: error.message }, null, 2))
  process.exitCode = 1
} finally {
  for (const context of contexts) await context.close().catch(() => {})
  await browser?.close().catch(() => {})
  await app.close()
  await rm(evidence, { recursive: true, force: true }).catch(() => {})
}
