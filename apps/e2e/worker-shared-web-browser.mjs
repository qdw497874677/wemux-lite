// Real Worker CLI + bundled shared Web, no HTTP fixture. Requires built worker/web and playwright-core.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const workerWeb = join(root, 'apps/worker/web')
const directory = await mkdtemp(join(tmpdir(), 'wemux-shared-web-'))
const cli = join(root, 'apps/worker/dist/cli.js')
const { chromium } = await import(process.env.PLAYWRIGHT_CORE_PATH ?? '/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs')

function execute(args, env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', data => { stdout += data })
    child.stderr.on('data', data => { stderr += data })
    child.on('error', reject).on('close', code => code === 0 ? resolveRun(stdout) : reject(new Error(`Worker exited ${code}: ${stderr}`)))
  })
}

let worker, browser
try {
  // pack:worker refreshes apps/worker/web from the built Web. Test what the
  // Worker CLI actually serves; never copy assets in the acceptance probe.
  const home = join(directory, 'worker')
  const env = { ...process.env, WEMUX_LOCAL_ADMIN_PASSWORD: 'shared-web-browser-passphrase-729' }
  await execute(['admin', 'init', '--home', home, '--username', 'browser-owner'], env)
  const socket = createServer()
  await new Promise(resolveListen => socket.listen(0, '127.0.0.1', resolveListen))
  const port = socket.address().port
  await new Promise(resolveClose => socket.close(resolveClose))
  let stderr = ''
  worker = spawn(process.execPath, [cli, 'start', '--home', home, '--host', '127.0.0.1', '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  worker.stderr.on('data', chunk => { stderr += chunk })
  const base = `http://127.0.0.1:${port}`
  let ready = false
  for (let attempt = 0; attempt < 100; attempt++) {
    if (worker.exitCode !== null) throw new Error(`Worker exited: ${stderr}`)
    try {
      const response = await fetch(`${base}/api/host`)
      if (response.ok) { ready = true; break }
    } catch { /* waiting for listener */ }
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  assert.ok(ready, `Worker did not listen: ${stderr}`)
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const page = await browser.newPage()
  const errors = []
  const failed = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('response', response => { if (response.status() >= 400 && !(response.status() === 401 && response.url().endsWith('/api/local/status'))) failed.push(`${response.status()} ${response.url()}`) })
  await page.goto(`${base}/local/settings`)
  await page.getByRole('heading', { name: '管理员登录' }).waitFor()
  assert.equal(await page.locator('script[src="/local.js"]').count(), 0, 'must show shared Web rather than inline fallback')
  await page.getByLabel('用户名').fill('browser-owner')
  await page.getByLabel('密码').fill(env.WEMUX_LOCAL_ADMIN_PASSWORD)
  await page.getByRole('button', { name: '登录' }).click()
  await page.getByRole('heading', { name: 'Agent 配置' }).waitFor()
  await page.goto(`${base}/local/cluster`)
  await page.getByText('未加入集群，本地对话仍可使用。').waitFor()
  await page.goto(`${base}/local`)
  await page.getByRole('button', { name: '新建会话' }).waitFor()
  const entry = await fetch(`${base}/local/sessions/example`, { headers: { accept: 'text/html' } })
  assert.equal(entry.status, 200)
  assert.equal(entry.headers.get('cache-control'), 'no-cache')
  const asset = await fetch(`${base}/assets/${(await readFile(join(workerWeb, 'index.html'), 'utf8')).match(/assets\/([^"']+\.js)/)?.[1]}`)
  assert.equal(asset.status, 200)
  assert.equal(asset.headers.get('cache-control'), 'public, max-age=3600')
  assert.deepEqual(errors, [], `browser errors: ${errors.join('; ')}`)
  assert.deepEqual(failed, [], `failed requests: ${failed.join('; ')}`)
  console.log('PASS real Worker shared Web login, local settings/cluster/workbench and deep-link/assets')
} finally {
  await browser?.close()
  if (worker && worker.exitCode === null) {
    worker.kill('SIGTERM')
    await Promise.race([new Promise(resolveExit => worker.once('exit', resolveExit)), new Promise(resolveTimeout => setTimeout(resolveTimeout, 3000))])
    if (worker.exitCode === null) worker.kill('SIGKILL')
  }
  await rm(directory, { recursive: true, force: true })
}
