import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { createWemuxServer } from '../dist/server.js'
import { seedLocalAccount } from '../dist/test/helpers/account.js'

const root = await mkdtemp(join(tmpdir(), 'wemux-team-browser-'))
const outbox = join(root, 'outbox')
const app = createWemuxServer({ databasePath: join(root, 'server.sqlite'), webDistPath: new URL('../../web/dist', import.meta.url).pathname, administratorEmails: ['admin@example.com'], mail: { WEMUX_MAIL_OUTBOX: outbox, WEMUX_PUBLIC_URL: 'http://127.0.0.1', WEMUX_SMTP_FROM: 'Wemux <wemux@example.com>' } })
await seedLocalAccount(app.store, { username: 'owner', email: 'owner@example.com', password: 'correct horse battery staple' })
const base = await app.listen(0)
app.registration.configure({ WEMUX_MAIL_OUTBOX: outbox, WEMUX_PUBLIC_URL: base, WEMUX_SMTP_FROM: 'Wemux <wemux@example.com>' })
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage()
  await page.goto(base)
  await page.getByLabel('用户名或邮箱').fill('owner')
  await page.locator('#auth-password').fill('correct horse battery staple')
  await page.getByRole('button', { name: '登录' }).click()
  await page.waitForURL(/\/projects/)
  await page.goto(`${base}/teams`)
  await page.getByPlaceholder('团队名称').fill('Agent Network')
  await page.getByRole('button', { name: '创建' }).click()
  await page.getByPlaceholder('member@example.com').fill('invitee@example.com')
  await page.getByRole('button', { name: '发送邀请' }).click()
  await page.getByText('invitee@example.com', { exact: true }).waitFor()
  const names = (await readdir(outbox)).filter(name => name.endsWith('.eml'))
  const entries = await Promise.all(names.map(async name => ({ name, written: (await stat(join(outbox, name))).mtimeMs })))
  entries.sort((a, b) => b.written - a.written || b.name.localeCompare(a.name))
  const raw = await readFile(join(outbox, entries[0].name), 'utf8')
  const text = Buffer.from(raw.slice(raw.indexOf('\r\n\r\n') + 4).replace(/\r\n/g, ''), 'base64').toString('utf8')
  const token = /\/join\?token=([A-Za-z0-9_-]+)/.exec(text)?.[1]
  assert.ok(token)
  const guest = await browser.newPage()
  await guest.goto(`${base}/join?token=${token}`)
  await guest.getByText('Agent Network', { exact: true }).waitFor()
  await guest.getByText('仅限 invitee@example.com').waitFor()
  const registerEmail = guest.getByLabel('邮箱').last()
  await registerEmail.waitFor()
  assert.equal(await registerEmail.isEditable(), false)
  console.log(JSON.stringify({ ok: true, checkpoints: ['owner login', 'team creation', 'email invitation', 'outbox delivery', 'anonymous invitation preview', 'locked invitation email'] }, null, 2))
} finally {
  await browser.close()
  await app.close()
  await rm(root, { recursive: true, force: true })
}
