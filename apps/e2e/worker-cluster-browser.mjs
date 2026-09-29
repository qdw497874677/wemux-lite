// Real Server + Worker process + Chromium cluster lifecycle, not an HTTP fixture.
// Run after build:packages, server/worker/web builds and pack:worker:
//   node --import tsx apps/e2e/worker-cluster-browser.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWemuxServer } from '../server/src/server.ts'
import { provisionAdministrator } from './session.ts'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const cli = join(root, 'apps/worker/dist/cli.js')
const { chromium } = await import(process.env.PLAYWRIGHT_CORE_PATH ?? '/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs')
const directory = await mkdtemp(join(tmpdir(), 'wemux-cluster-browser-'))
const home = join(directory, 'worker')
const server = createWemuxServer({ databasePath: join(directory, 'server.sqlite'), administratorEmails: ['cluster-owner@example.test'] })
let worker, browser, serverStarted = false

function execute(args, env) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', data => { stdout += data })
    child.stderr.on('data', data => { stderr += data })
    child.once('error', reject).once('close', code => code === 0 ? done(stdout) : reject(new Error(`Worker CLI exit ${code}: ${stderr}`)))
  })
}
async function eventually(label, condition, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    try { if (await condition()) return } catch (error) { last = String(error) }
    await new Promise(done => setTimeout(done, 150))
  }
  throw new Error(`Timed out waiting for ${label}: ${last}`)
}

try {
  const serverUrl = await server.listen(0)
  serverStarted = true
  const admin = await provisionAdministrator({ store: server.store, baseUrl: serverUrl, email: 'cluster-owner@example.test' })
  const { token } = await admin.api('/enrollment-tokens', 'POST', {})
  const env = { ...process.env, WEMUX_LOCAL_ADMIN_PASSWORD: 'cluster-browser-local-passphrase-729' }
  await execute(['admin', 'init', '--home', home, '--username', 'local-owner'], env)
  // Bind port zero by CLI: local control reports the chosen address on stderr.
  let output = ''
  worker = spawn(process.execPath, [cli, 'start', '--home', home, '--host', '127.0.0.1', '--port', '0'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  worker.stdout.on('data', data => { output += data })
  worker.stderr.on('data', data => { output += data })
  await eventually('local Worker listener', () => /http:\/\/127\.0\.0\.1:\d+/.test(output) || worker.exitCode !== null)
  assert.equal(worker.exitCode, null, `Worker exited: ${output}`)
  const workerUrl = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]
  assert.ok(workerUrl, `Worker did not report local URL: ${output}`)
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${workerUrl}/local/cluster`)
  await page.getByRole('heading', { name: '管理员登录' }).waitFor()
  await page.getByLabel('用户名').fill('local-owner')
  await page.getByLabel('密码').fill(env.WEMUX_LOCAL_ADMIN_PASSWORD)
  await page.getByRole('button', { name: '登录' }).click()
  await page.getByText('未加入集群，本地对话仍可使用。').waitFor()
  const status = async () => {
    const response = await page.request.get(`${workerUrl}/api/local/status`)
    assert.equal(response.status(), 200)
    return response.json()
  }
  const workers = async () => (await admin.api('/workers')).items
  const directory = await page.request.post(`${workerUrl}/api/local/workbench/directories`, { headers: { 'x-wemux-csrf': (await status()).csrf }, data: { path: home } })
  assert.equal(directory.status(), 201, `failed to authorize local directory: ${await directory.text()}`)
  const authorized = (await directory.json()).workspaceId
  const sessionResponse = await page.request.post(`${workerUrl}/api/local/workbench/sessions`, { headers: { 'x-wemux-csrf': (await status()).csrf }, data: { workspaceId: authorized, agentKey: 'test', modelId: 'test', requestId: 'cluster-local-session' } })
  assert.equal(sessionResponse.status(), 201, `failed to create local session: ${await sessionResponse.text()}`)
  const localSessionId = (await sessionResponse.json()).sessionId
  const name = 'browser-cluster-worker'
  await page.getByLabel('Server 地址').fill(serverUrl)
  await page.getByLabel('Worker 名称').fill(name)
  await page.getByRole('button', { name: '探测 Server' }).click()
  await page.getByText(/探测成功：/).waitFor()
  await page.getByRole('checkbox', { name: /我已核对目标 Server 地址和证书/ }).check()
  await page.getByLabel('一次性注册口令').fill(token)
  await page.getByRole('button', { name: '确认加入集群' }).click()
  await eventually('Server Worker online', async () => (await workers()).some(item => item.name === name && item.connectionState === 'online'))
  const workerId = (await workers()).find(item => item.name === name)?.id
  assert.ok(workerId)
  await eventually('Web online', async () => (await status()).cluster.connection.phase === 'online')
  assert.equal((await status()).cluster.enrolled, true)
  await page.getByRole('button', { name: '暂停连接' }).click()
  await eventually('Server Worker offline after pause', async () => (await workers()).find(item => item.id === workerId)?.connectionState === 'offline')
  assert.equal((await status()).cluster.connection.phase, 'offline')
  await page.getByRole('button', { name: '重连' }).click()
  await eventually('same Worker online after resume', async () => (await workers()).find(item => item.id === workerId)?.connectionState === 'online')
  await page.getByRole('button', { name: '退出集群' }).click()
  await page.getByRole('button', { name: '确认退出' }).click()
  await eventually('local enrollment removed', async () => !(await status()).cluster.enrolled)
  const final = (await workers()).find(item => item.id === workerId)
  assert.equal(final?.connectionState, 'revoked', 'leave must revoke the remote identity, not merely drop the WebSocket')
  const sessions = await page.request.get(`${workerUrl}/api/local/workbench/sessions`)
  assert.equal(sessions.status(), 200)
  assert.ok((await sessions.json()).items.some(item => item.sessionId === localSessionId), 'local session must survive cluster join, pause and leave')
  await page.goto(`${workerUrl}/local`)
  await page.getByRole('button', { name: '新建会话' }).waitFor()
  assert.deepEqual(errors, [])
  console.log('PASS real Worker Web discover/enroll/online/pause/offline/resume/online/leave and local Web remains usable')
} finally {
  await browser?.close()
  if (worker && worker.exitCode === null) {
    worker.kill('SIGTERM')
    await Promise.race([new Promise(done => worker.once('exit', done)), new Promise(done => setTimeout(done, 4000))])
    if (worker.exitCode === null) worker.kill('SIGKILL')
  }
  if (serverStarted) await server.close()
  await rm(directory, { recursive: true, force: true })
}
