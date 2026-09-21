#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const root = process.cwd()
const playwrightEntry = process.env.WEMUX_PLAYWRIGHT ?? '/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs'
const { chromium } = await import(pathToFileURL(playwrightEntry).href)
const { createWemuxServer } = await import(pathToFileURL(join(root, 'apps/server/dist/server.js')).href)
const { seedLocalAccount } = await import(pathToFileURL(join(root, 'apps/server/dist/test/fixtures/administrator.js')).href)
const { IdentityService } = await import(pathToFileURL(join(root, 'apps/server/dist/application/identity-service.js')).href)
const { AdministratorDirectory } = await import(pathToFileURL(join(root, 'apps/server/dist/application/administrator-directory.js')).href)
const password = 'correct horse battery staple'
const dir = await mkdtemp(join(tmpdir(), 'wemux-ticket13-'))
const app = createWemuxServer({ databasePath: join(dir, 'server.sqlite'), administratorEmails: ['owner@example.com'], webStaticPath: join(root, 'apps/web/dist') })
const ownerUser = await seedLocalAccount(app.store, { username: 'owner', email: 'owner@example.com', password })
const member = await seedLocalAccount(app.store, { username: 'member', email: 'member@example.com', password })
const base = await app.listen(0)
let browser
try {
  const login = async (context, user) => { const identity = IdentityService.fromEnvironment(app.store, new AdministratorDirectory(app.store, ['owner@example.com'])); const session = await identity.issue(user, 'browser-smoke'); const host = new URL(base).hostname; await context.addCookies([{ name: identity.cookieName, value: session.token, domain: host, path: '/', httpOnly: true, sameSite: 'Lax' }]); const page = await context.newPage(); await page.goto(`${base}/projects`); return page }
  const ownerContext = await chromium.launch({ headless: true }).then(value => { browser = value; return value.newContext() })
  const ownerPage = await login(ownerContext, ownerUser)
  await ownerPage.goto(`${base}/teams`)
  await ownerPage.getByPlaceholder('团队名称').fill('Governance team')
  await ownerPage.getByRole('button', { name: '创建' }).click()
  await ownerPage.locator('select option').filter({ hasText: 'Governance team · 1 人' }).waitFor({ state: 'attached' })
  const selected = await ownerPage.locator('select').first().inputValue()
  await app.store.transaction(tx => tx.identity.saveMembership({ teamId: selected, userId: member.id, role: 'member', joinedAt: new Date().toISOString() }))
  await ownerPage.reload()
  await ownerPage.locator('select').first().selectOption(selected)
  await ownerPage.getByText('member@example.com').waitFor()
  const memberRow = ownerPage.getByText('member@example.com').locator('xpath=ancestor::article')
  await ownerPage.getByLabel('调整 member 的角色').selectOption('admin')
  await ownerPage.getByRole('status').filter({ hasText: '成员角色已调整为 admin' }).waitFor()
  await ownerPage.getByLabel('调整 member 的角色').selectOption('member')
  await ownerPage.getByRole('status').filter({ hasText: '成员角色已调整为 member' }).waitFor()
  ownerPage.once('dialog', dialog => dialog.accept())
  await memberRow.getByRole('button', { name: '移除' }).click()
  await ownerPage.getByRole('status').filter({ hasText: '停止命令可能仍在等待 Worker 上线送达' }).waitFor()
  assert.equal(await ownerPage.getByText('member@example.com').count(), 0)
  console.log(JSON.stringify({ ok: true, checkpoint: 'ticket-13-browser', team: selected, removedUser: member.id }))
} finally {
  await browser?.close()
  await app.close()
}
