#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const root = process.cwd(), require = createRequire(import.meta.url)
const playwrightRoot = process.env.WEMUX_PLAYWRIGHT_ROOT ?? '/tmp/wemux-tailnet-pw'
const { chromium } = require(join(playwrightRoot, 'node_modules/playwright-core'))
const { createWemuxServer } = await import(pathToFileURL(join(root, 'apps/server/dist/server.js')).href)
const { seedLocalAccount } = await import(pathToFileURL(join(root, 'apps/server/dist/test/fixtures/administrator.js')).href)
const { IdentityService } = await import(pathToFileURL(join(root, 'apps/server/dist/application/identity-service.js')).href)
const { AdministratorDirectory } = await import(pathToFileURL(join(root, 'apps/server/dist/application/administrator-directory.js')).href)

const dir = await mkdtemp(join(tmpdir(), 'wemux-ticket14-'))
const email = 'owner@example.com', password = 'correct horse battery staple'
const app = createWemuxServer({ databasePath: join(dir, 'server.sqlite'), administratorEmails: [email], webStaticPath: join(root, 'apps/web/dist') })
const owner = await seedLocalAccount(app.store, { username: 'owner', email, password })
const base = await app.listen(0)
let browser
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH })
  const context = await browser.newContext()
  const identity = IdentityService.fromEnvironment(app.store, new AdministratorDirectory(app.store.identity, [email]))
  const issued = await identity.issue(owner, 'Ticket 14 Browser')
  await context.addCookies([{ name: identity.cookieName, value: issued.token, domain: new URL(base).hostname, path: '/', httpOnly: true, sameSite: 'Lax' }])
  const page = await context.newPage()
  await page.goto(`${base}/settings`)
  await page.getByText('个人访问令牌').waitFor()
  await page.getByLabel('名称').fill('浏览器验收')
  await page.getByLabel('有效期（天）').fill('7')
  await page.getByRole('button', { name: '创建令牌' }).click()
  const secret = page.locator('code').filter({ hasText: 'wmx_pat_' })
  await secret.waitFor()
  const token = (await secret.textContent())?.trim()
  assert.match(token ?? '', /^wmx_pat_/)
  await page.getByRole('button', { name: '我已保存' }).click()
  await page.getByText('浏览器验收').waitFor()
  assert.equal(await page.locator('body').innerText().then(text => text.includes(token ?? 'missing')), false, '列表不能再次显示明文')
  await page.getByRole('button', { name: '轮换' }).click()
  const rotated = (await page.locator('code').filter({ hasText: 'wmx_pat_' }).textContent())?.trim()
  assert.ok(rotated && rotated !== token)
  await page.getByRole('button', { name: '我已保存' }).click()
  const activeTokenRow = page.locator('li').filter({ hasText: '浏览器验收' }).filter({ has: page.getByRole('button', { name: '撤销' }) })
  await activeTokenRow.getByRole('button', { name: '撤销' }).click()
  await page.locator('li').filter({ hasText: '浏览器验收' }).filter({ hasText: '已撤销' }).first().waitFor()
  console.log(JSON.stringify({ ok: true, checkpoint: 'ticket-14-browser', tokenListedAgain: false, rotationChangedSecret: true, revokedVisible: true }))
} finally {
  await browser?.close()
  await app.close()
}
