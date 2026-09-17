import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Timestamp, WorkerId } from '@wemux/domain'
import { SqliteWorkerStore } from '../src/storage/sqlite-store.js'
import { createLocalAdmin, ensureLocalInstallation } from '../src/application/local-installation.js'
import { ClusterLifecycle } from '../src/application/cluster-lifecycle.js'
import { createLocalWorkbenchService } from '../src/application/local-workbench.js'
import { startLocalControlServer } from '../src/local-control/server.js'
import { TestAgent } from '../src/agents/test-agent.js'

// Opt-in browser acceptance without adding a production or test dependency.
// WEMUX_PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs node --import tsx --test apps/worker/test/cluster-lifecycle.browser.test.ts
const playwrightModule = process.env.WEMUX_PLAYWRIGHT_MODULE
test('browser can use local sessions after failed connect, pause and unreachable Server leave', { skip: !playwrightModule }, async () => {
  const { chromium } = await import(playwrightModule!)
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] })
  const home = await mkdtemp(join(tmpdir(), 'wemux-lifecycle-browser-'))
  const store = new SqliteWorkerStore(join(home, 'worker.sqlite'))
  ensureLocalInstallation(store, 'browser-node')
  await createLocalAdmin(store, { username: 'owner', password: 'browser-test-password' })
  store.saveIdentity({ workerId: 'browser-worker' as WorkerId, serverUrl: 'ws://127.0.0.1:1/worker/ws', credentialRef: 'credential', enrolledAt: new Date().toISOString() as Timestamp })
  const lifecycle = new ClusterLifecycle(store, [new TestAgent(1)], { home, name: 'browser-node', enrollmentPath: '/workers/enroll', socketPath: '/worker/ws', prefer: 'any' })
  await assert.rejects(lifecycle.connect(), /ENOENT/)
  const server = await startLocalControlServer({ host: '127.0.0.1', port: 0, state: store }, { shutdown: async () => {}, cluster: lifecycle, workbench: createLocalWorkbenchService(store, lifecycle) })
  try {
    const page = await browser.newPage()
    await page.goto(server.url)
    await page.locator('#login input[name=username]').fill('owner')
    await page.locator('#login input[name=password]').fill('browser-test-password')
    await page.locator('#login button').click()
    await page.locator('#status').waitFor({ state: 'visible' })
    await page.locator('#directory-form input').fill(home)
    await page.locator('#directory-form button').click()
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#session-form button')!.disabled)
    await page.locator('#session-form button').click()
    await page.locator('#conversation').waitFor({ state: 'visible' })
    const sessionId = await page.locator('#session-select').inputValue()
    await page.locator('#message-form textarea').fill('before pause')
    await page.locator('#send-message').click()
    await page.waitForFunction(() => document.querySelector('#timeline')!.textContent!.includes('运行完成'))
    await page.locator('#cluster-pause').click()
    await page.waitForFunction(() => document.querySelector('#cluster')!.textContent!.includes('offline'))
    await writeFile(join(home, 'credential'), 'unreachable-credential')
    page.on('dialog', (dialog: { accept(): Promise<void> }) => dialog.accept())
    await page.locator('#cluster-leave').click()
    await page.waitForFunction(() => document.querySelector('#cluster-error')!.textContent!.includes('远端凭据撤销未确认'))
    await page.reload()
    await page.locator('#conversation').waitFor({ state: 'visible' })
    assert.equal(await page.locator('#session-select').inputValue(), sessionId)
    assert.equal(await page.locator('#cluster').textContent(), '未加入集群')
    await page.locator('#message-form textarea').fill('after leave')
    await page.locator('#send-message').click()
    await page.waitForFunction(() => {
      const text = document.querySelector('#timeline')!.textContent!
      return text.includes('after leave') && text.split('运行完成').length >= 3
    })
    assert.equal(store.identity(), null)
  } finally {
    await browser.close()
    await server.close()
    await lifecycle.close()
    store.close()
    await rm(home, { recursive: true, force: true })
  }
})
