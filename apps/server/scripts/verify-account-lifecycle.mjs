import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWemuxServer } from '../dist/server.js'
import { chromium } from 'playwright-core'

const directory = await mkdtemp(join(tmpdir(), 'wemux-ticket-15-'))
const password = 'correct-horse-battery-staple'
const administratorEmail = 'deployer@wemux.test'
let app, browser
try {
  app = createWemuxServer({ databasePath: join(directory, 'server.sqlite'), administratorEmails: [administratorEmail], webStaticPath: new URL('../../web/dist', import.meta.url).pathname, capabilitySecret: 'ticket-15-capability-secret-32-bytes' })
  const base = await app.listen(0)
  // Production registration requires mail delivery; seed through the same durable identity port for browser-only presentation checks.
  const now = new Date().toISOString()
  const { hashPassword } = await import('../dist/application/password.js')
  const { normalizeEmail } = await import('../dist/application/email-address.js')
  const seed = async (id, username, email, administrator = false) => app.store.transaction(async tx => {
    await tx.identity.saveUser({ id, username, email, createdAt: now, status: 'active', authVersion: 0, statusChangedAt: now, deletedAt: null })
    await tx.identity.saveUserEmail({ emailNormalized: normalizeEmail(email).normalized, emailDisplay: email, userId: id, createdAt: now })
    await tx.identity.saveLocalAccountCredential({ userId: id, passwordHash: await hashPassword(password), updatedAt: now })
    if (administrator) await tx.identity.saveInstanceAdministrator({ userId: id, email, assignedAt: now, source: 'declared' })
  })
  await seed('ticket15-admin', 'deployer', administratorEmail, true)
  await seed('ticket15-member', 'member', 'member@example.com')

  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  await page.goto(base)
  await page.getByLabel(/账号或邮箱/).fill(administratorEmail)
  await page.getByRole('textbox', { name: '密码' }).fill(password)
  await page.getByRole('button', { name: '登录' }).click()
  await page.waitForURL(/\/projects/)
  await page.goto(`${base}/settings`)
  await page.getByRole('heading', { name: '安全审计' }).waitFor()
  await page.getByRole('heading', { name: '账号治理' }).waitFor()
  await page.getByText('member@example.com').waitFor()
  await page.getByRole('button', { name: '停用' }).click()
  await page.getByText(/disabled/).waitFor()
  await page.screenshot({ path: join(directory, 'ticket-15-settings.png'), fullPage: true })

  const report = { ok: true, checkpoint: 'ticket-15-browser', auditVisible: true, governanceVisible: true, memberDisabled: true, screenshot: join(directory, 'ticket-15-settings.png') }
  console.log(JSON.stringify(report, null, 2))
} finally {
  if (browser) await browser.close()
  if (app) await app.close()
  if (process.env.KEEP_WEMUX_EVIDENCE !== '1') await rm(directory, { recursive: true, force: true })
}
