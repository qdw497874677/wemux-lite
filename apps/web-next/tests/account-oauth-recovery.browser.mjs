// Local provider only: verifies Next/legacy callback recovery, never contacts Google.
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWemuxServer } from '../../server/src/server.ts'
import { seedLocalAccount } from '../../server/src/test/fixtures/administrator.ts'
import { fakeGoogle, googleProviderSettings, handoff } from '../../server/src/test/fixtures/google-provider.ts'
import { launchAcceptanceBrowser } from './acceptance-runtime.mjs'
const dist = process.env.WEMUX_NEXT_TEST_DIST
assert.ok(dist?.startsWith('/tmp/'))
const root = await mkdtemp(join(tmpdir(), 'wemux-next-oauth-recovery-'))
const result = { passed: false, checks: [], failureStep: null }
let app, provider, browser, step = 'setup'
try {
  provider = await fakeGoogle()
  step = 'server setup'
  app = createWemuxServer({ databasePath: join(root, 'db.sqlite'), administratorEmails: ['admin@example.test'], capabilitySecret: 'synthetic-ticket02-capability-secret', mail: {}, webNextStaticPath: dist, ...googleProviderSettings(provider, 'http://localhost') })
  step = 'seed account'
  await seedLocalAccount(app.store, { username: 'synthetic-user', email: 'member@example.test', password: 'synthetic-password-long-enough' })
  step = 'server listen'
  const origin = await app.listen(0)
  step = 'browser launch'
  browser = await launchAcceptanceBrowser()
  for (const [name, viewport] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport }), page = await context.newPage()
    page.setDefaultTimeout(12000)
    // Replace external navigation only. Requests to our real callback/server remain untouched.
    let behavior = 'cancel'
    await page.route('https://accounts.google.com/**', async route => {
      const auth = handoff(provider, route.request().url())
      provider.setBehavior(behavior === 'verification' ? 'bad-audience' : 'ok')
      const suffix = behavior === 'cancel' ? 'error=access_denied' : 'code=authorization-code'
      await route.fulfill({ status: 302, headers: { location: `${origin}/api/auth/oauth/google/callback?${suffix}&state=${auth.state}` }, body: '' })
    })
    for (behavior of ['cancel', 'verification']) {
      step = `${name}: login ${behavior}`
      await page.goto(`${origin}/next/login`)
      if (behavior === 'cancel') { await page.getByText('未配置 WEMUX_SMTP_URL，也未配置本地出件箱 WEMUX_MAIL_OUTBOX', { exact: true }).waitFor(); result.checks.push(`${name}: unconfigured mail reason displayed`) }
      await page.getByRole('button', { name: '使用 Google 登录', exact: true }).click()
      await page.waitForURL(url => url.pathname === '/next/login')
      await page.getByRole('alert').filter({ hasText: behavior === 'cancel' ? '缺少必要参数' : '身份校验失败' }).waitFor()
      assert.equal(new URL(page.url()).pathname, '/next/login')
      result.checks.push(step)
    }
    await page.getByLabel('邮箱或用户名', { exact: true }).fill('synthetic-user')
    await page.getByLabel('密码', { exact: true }).fill('synthetic-password-long-enough')
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.getByRole('heading', { name: '项目', exact: true }).waitFor()
    for (behavior of ['cancel', 'verification']) {
      step = `${name}: link ${behavior}`
      await page.goto(`${origin}/next/settings`)
      await page.getByRole('button', { name: '绑定 Google 登录', exact: true }).click()
      await page.waitForURL(url => url.pathname === '/next/settings')
      await page.getByRole('alert').filter({ hasText: behavior === 'cancel' ? '缺少必要参数' : '身份校验失败' }).waitFor()
      assert.equal(new URL(page.url()).pathname, '/next/settings')
      result.checks.push(step)
    }
    step = `${name}: local-provider successful link`
    behavior = 'success'
    await page.goto(`${origin}/next/settings`)
    await page.getByRole('button', { name: '绑定 Google 登录', exact: true }).click()
    await page.getByText('Google 登录已绑定：现在可以用它登录这个账号。', { exact: true }).waitFor()
    const security = await context.request.get(`${origin}/api/auth/account/security`).then(response => response.json())
    assert.ok(security.methods.some(method => method.kind === 'google' && method.removable))
    result.checks.push(step)
    // Authenticate with the linked identity through the local signed-token/PKCE provider.
    const me = await context.request.get(`${origin}/api/auth/me`).then(response => response.json())
    await context.request.post(`${origin}/api/auth/logout`, { headers: { Origin: origin, 'x-csrf-token': me.csrfToken }, data: {} })
    await page.goto(`${origin}/next/login`)
    await page.getByRole('button', { name: '使用 Google 登录', exact: true }).click()
    await page.getByRole('heading', { name: '项目', exact: true }).waitFor()
    const account = await context.request.get(`${origin}/api/auth/me`).then(response => response.json())
    assert.equal(account.user.username, 'synthetic-user')
    result.checks.push(`${name}: local-provider linked identity signs into same account`)
    step = `${name}: local-provider successful unlink`
    await page.goto(`${origin}/next/settings`)
    const unlink = page.getByRole('button', { name: /^解绑 Google/ })
    await unlink.locator('xpath=ancestor::form').locator('[name="currentPassword"]').fill('synthetic-password-long-enough')
    page.once('dialog', dialog => dialog.accept())
    await unlink.click()
    await unlink.waitFor({ state: 'hidden' })
    const after = await context.request.get(`${origin}/api/auth/account/security`).then(response => response.json())
    assert.ok(after.methods.length === 1 && after.methods[0].kind === 'password' && !after.methods[0].removable)
    await page.getByText('最后一种登录方式，不可移除', { exact: false }).waitFor()
    result.checks.push(step)
    await context.close()
  }
  result.passed = true
} catch { result.failureStep = step; process.exitCode = 1 }
finally {
  await browser?.close(); await app?.close(); await provider?.close()
  const output = process.env.WEMUX_TICKET02_OAUTH_EVIDENCE ?? `${root}-result.json`
  await writeFile(output, JSON.stringify(result, null, 2))
  await rm(root, { recursive: true, force: true })
  console.log(JSON.stringify(result))
}
