// 双宿主 04 远程托管 Agent 安装验收：真 Server 服务真 web-next，管理员在 /next/resources
// 经浏览器发起托管安装。在线节点由真 Worker 物化并回执：npm 的代理指向必然拒绝连接的端口，
// 所以「取包」是真实发生、真实失败、且原因必须如实透出，绝不冒充已分发；另有与固定目录不符的
// 修订验证 unapproved_runtime_artifact 拒绝路径。离线节点只展示可粘贴的一键命令，并在真实的
// 非安全上下文（局域网明文 HTTP）验证复制降级。
// WEMUX_NEXT_TEST_DIST=/tmp/... node --import tsx apps/e2e/next-managed-agent-install-browser.mjs
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { networkInterfaces, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { createWemuxServer } from '../server/src/server.ts'
import { provisionAdministrator } from './session.ts'
import { seedLocalAccount } from '../server/src/test/fixtures/administrator.ts'
import { ownedWorkerLaunch } from './owned-worker-fixture.mjs'
import { installCatalog } from '../worker/src/runtimes/management.ts'

assert.ok(process.env.WEMUX_NEXT_TEST_DIST?.startsWith('/tmp/'), 'owned temporary build required: WEMUX_NEXT_TEST_DIST must point at a /tmp copy of the web-next dist')
const { chromium } = await import(process.env.PLAYWRIGHT_CORE_PATH ?? '/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs')
const evidenceRoot = process.env.EVIDENCE_ROOT ?? tmpdir()
await mkdir(evidenceRoot, { recursive: true })
const evidence = await mkdtemp(join(evidenceRoot, 'wemux-managed-agent-install-'))
const sha = (value) => createHash('sha256').update(value).digest('hex')
const email = 'agent-owner@example.test', password = 'owned-agent-install-password'
const catalog = installCatalog
const agentKeys = Object.keys(catalog)
const registryOrigin = 'https://registry.npmjs.org'
// 托管物化用真 npm；本机沙箱没有公网 registry，让 npm 的代理指向一个必然拒绝连接的端口，
// 既不依赖外网、也不需要下载上百 MB 的 pi 包，同时保证“安装真的被尝试过并真的失败”。
const deadProxy = { npm_config_proxy: 'http://127.0.0.1:9', npm_config_https_proxy: 'http://127.0.0.1:9' }
const app = createWemuxServer({
  databasePath: join(evidence, 'server.sqlite'),
  administratorEmails: [email], mail: {}, google: {},
  webNextStaticPath: resolve(process.env.WEMUX_NEXT_TEST_DIST),
})
let browser, worker, activePage, step = 'setup'
const checks = [], errors = [], screenshots = [], notes = [], dialogs = []
async function expectStatus(result, status, label) {
  assert.equal(result.status, status, `${label}: 期望 ${status}，实际 ${result.status} ${JSON.stringify(result.data)?.slice(0, 400)}`)
  return result.data
}
function launchWorker(args, origin, home, extraEnv = {}) {
  const owned = ownedWorkerLaunch(args, origin)
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/worker/src/cli.ts', ...owned.args], { cwd: process.cwd(), env: { ...owned.env, ...extraEnv, WEMUX_WORKER_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.setEncoding('utf8').on('data', text => { output = (output + text).slice(-4000) })
  const done = new Promise((resolveDone, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolveDone({ code, signal, output })) })
  void done.catch(() => {})
  return { child, done, readOutput: () => output }
}
async function stopWorker(current) {
  if (!current) return
  if (current.child.exitCode === null && current.child.signalCode === null) { current.child.kill('SIGCONT'); current.child.kill('SIGTERM') }
  let killed = false
  const timer = setTimeout(() => { killed = true; current.child.kill('SIGKILL') }, 10000)
  try {
    const { code, signal } = await current.done
    if (code === 0) return
    // Worker 在 npm 子进程里时可能来不及收尾；被 SIGKILL 清理仍算可接受的拆除结果，但留记录。
    assert.ok(killed || signal === 'SIGKILL', `owned Worker closes gracefully: code=${code} signal=${signal} ${current.readOutput()}`)
    notes.push({ step: 'teardown', note: `Worker 被 SIGKILL 拆除（code=${code} signal=${signal}）：仍可能有 npm 子进程` })
  } finally { clearTimeout(timer) }
}
async function eventually(read, accept, label, timeout = 60000) {
  const deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) { last = await read(); if (accept(last)) return last; await delay(200) }
  throw Error(`Timed out: ${label} — last=${JSON.stringify(last)?.slice(0, 600)}`)
}
/** 局域网/直连地址：非安全上下文（明文 HTTP 的非环回地址）才是真实的复制降级场景。 */
function nonLoopbackAddress() {
  const addresses = Object.values(networkInterfaces()).flat().filter(entry => entry && !entry.internal).map(entry => entry.address)
  return addresses.find(address => address.startsWith('192.168.')) ?? addresses.find(address => /^(10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address)) ?? null
}
try {
  // listen 只能调用一次，且监听 0.0.0.0 时返回的 origin 含 0.0.0.0（Worker 侧要求环回），所以自己拼环回地址。
  const bound = await app.listen(0, '0.0.0.0')
  const port = new URL(bound).port
  const loopback = `http://127.0.0.1:${port}`
  const owner = await provisionAdministrator({ store: app.store, baseUrl: loopback, email, password })
  const api = owner.api
  await api('/bootstrap', 'POST', {})
  const member = await seedLocalAccount(app.store, { username: 'agent-member', email: 'agent-member@example.test', password })
  await app.store.transaction(async tx => {
    await tx.identity.saveMembership({ teamId: 'default-team', userId: member.id, role: 'member', joinedAt: new Date().toISOString() })
  })
  const bindingFor = async (workerId, agentKey) => (await api('/resource-bindings')).items.find(item => item.binding.workerId === workerId && item.binding.agentKey === agentKey) ?? null

  step = '公开脚本与管理员固定版本清单同源，且无需集群会话即可下载'
  const catalogResponse = await api('/managed-agent-catalog')
  assert.deepEqual(catalogResponse.agents.map(agent => agent.key), agentKeys, '管理面清单必须与 Worker 共用目录同序同源')
  for (const agent of catalogResponse.agents) {
    const spec = catalog[agent.key]
    assert.equal(agent.packageName, spec.name, `${agent.key} 包名必须与 Worker 目录一致`)
    assert.equal(agent.packageVersion, spec.version, `${agent.key} 版本必须与 Worker 目录一致`)
    assert.equal(agent.packageIntegrity, spec.integrity, `${agent.key} 完整性摘要必须与 Worker 目录一致`)
    assert.equal(agent.bin, spec.bin, `${agent.key} 入口必须与 Worker 目录一致`)
  }
  assert.equal(catalogResponse.registryOrigin, registryOrigin)
  assert.equal(catalogResponse.installerPath, '/downloads/install-agent.sh')
  const { generatedAt, ...manifestOnly } = catalogResponse
  assert.ok(typeof generatedAt === 'string')
  const publicManifest = await (await fetch(`${loopback}/downloads/agent-manifest.json`)).json()
  assert.deepEqual(publicManifest, manifestOnly, '公开清单必须与管理面清单逐字一致')
  const scriptResponse = await fetch(`${loopback}/downloads/install-agent.sh`)
  assert.equal(scriptResponse.status, 200, '安装脚本必须匿名可下载（自托管节点没有集群会话）')
  assert.equal(scriptResponse.headers.get('content-type'), 'text/x-shellscript; charset=utf-8')
  assert.equal(scriptResponse.headers.get('cache-control'), 'no-store')
  const scriptText = await scriptResponse.text()
  assert.ok(scriptText.startsWith('#!/bin/sh'), '脚本必须是 POSIX sh')
  for (const key of agentKeys) {
    assert.ok(scriptText.includes(catalog[key].version), `脚本必须内嵌 ${key} 的固定版本`)
    assert.ok(scriptText.includes(catalog[key].integrity), `脚本必须内嵌 ${key} 的完整性摘要`)
  }
  assert.ok(scriptText.includes('WEMUX_WORKER_HOME') && scriptText.includes('WEMUX_AGENT_KEY') && scriptText.includes('WEMUX_INSTALL_DIR'))
  checks.push(`${step}: ${agentKeys.join('/')} 三键同源，清单与脚本零漂移`)

  step = 'real Worker registers, starts and reports its own capability probe'
  const onlineHome = join(evidence, 'worker-online'), offlineHome = join(evidence, 'worker-offline')
  const onlineToken = await api('/enrollment-tokens', 'POST', { expiresInSeconds: 3600 })
  const registration = launchWorker(['register', '--home', onlineHome, `--token=${onlineToken.token}`, '--name', '托管安装在线节点'], loopback, onlineHome)
  assert.equal((await registration.done).code, 0, 'Worker registers against the owned Server')
  worker = launchWorker(['start', '--home', onlineHome, '--name', '托管安装在线节点'], loopback, onlineHome, deadProxy)
  const workers = await eventually(() => api('/workers'), value => value.items.some(item => item.name === '托管安装在线节点' && item.connectionState === 'online'), 'online Worker visible')
  const workerId = workers.items.find(item => item.name === '托管安装在线节点').id
  await eventually(() => api(`/workers/${workerId}/capabilities`), value => value.capabilities.length > 0, 'real capability probe reported')
  // 第二台 Worker 只注册不启动：离线节点只能给一键命令，集群不得声称远程安装。
  const offlineToken = await api('/enrollment-tokens', 'POST', { expiresInSeconds: 3600 })
  const offlineRegistration = launchWorker(['register', '--home', offlineHome, `--token=${offlineToken.token}`, '--name', '托管安装离线节点'], loopback, offlineHome)
  assert.equal((await offlineRegistration.done).code, 0, 'offline Worker registers against the owned Server')
  const offlineWorkerId = (await eventually(() => api('/workers'), value => value.items.some(item => item.name === '托管安装离线节点'), 'offline Worker visible')).items.find(item => item.name === '托管安装离线节点').id
  const offlineState = await eventually(() => api('/workers'), value => value.items.find(item => item.id === offlineWorkerId)?.connectionState !== 'online' && value.items.find(item => item.id === offlineWorkerId), 'offline Worker is not online')
  assert.notEqual(offlineState.connectionState, 'online')
  checks.push(`${step}: 在线节点 ${workerId}，离线节点 ${offlineWorkerId}`)

  step = '管理员在浏览器里发起托管安装，界面只读取 Server 的四态投影'
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] })
  assert.equal((await context.request.post(`${loopback}/api/auth/login`, { data: { login: email, password } })).status(), 200)
  const page = await context.newPage(); activePage = page; page.setDefaultTimeout(20000)
  page.on('pageerror', error => errors.push({ name: 'desktop', step, message: error.message }))
  page.on('console', message => { if (message.type() === 'error') errors.push({ name: 'desktop', step, message: message.text() }) })
  let dialogMode = 'accept'
  page.on('dialog', async dialog => { dialogs.push({ step, message: dialog.message() }); if (dialogMode === 'accept') await dialog.accept(); else await dialog.dismiss() })
  const install = page.getByRole('region', { name: '托管 Agent 安装' })
  const online = install.getByRole('region', { name: '在线托管下发' })
  const receipt = install.getByRole('region', { name: '托管安装回执' })
  const offline = install.getByRole('region', { name: '离线与自托管一键命令' })
  const workerSelect = install.getByLabel('托管安装目标工作节点')
  const agentSelect = install.getByLabel('托管安装 Agent')
  const refresh = page.getByRole('button', { name: '刷新资源清单' })
  const shot = async label => { const path = join(evidence, `desktop-${label}.png`); await page.screenshot({ path, fullPage: true }); screenshots.push(path) }
  const distributionText = async () => (await receipt.locator('dl dd').nth(1).innerText()).trim()

  await page.goto(`${loopback}/next/resources`)
  await install.getByRole('heading', { name: '托管安装 Agent' }).waitFor()
  await install.getByText('固定版本：', { exact: false }).waitFor()
  const catalogText = await install.getByText('固定版本：', { exact: false }).innerText()
  for (const key of agentKeys) assert.ok(catalogText.includes(`${key}@${catalog[key].version}`), `界面必须展示固定版本 ${key}`)
  assert.match(catalogText, /registry\.npmjs\.org/, '界面必须声明注册源')
  await eventually(() => workerSelect.locator('option').allInnerTexts(), options => options.some(text => text.includes('托管安装在线节点')) && options.some(text => text.includes('托管安装离线节点')), 'both Workers are offered as targets')
  checks.push(`${step}: 目录 ${catalogText.slice(0, 120)}`)

  step = 'desktop: 离线节点只给一键命令，且「展示命令」绝不等于「已安装」'
  await workerSelect.selectOption(offlineWorkerId)
  await agentSelect.selectOption('pi')
  await eventually(() => online.innerText(), text => text.includes('当前不在线'), 'offline Worker cannot be pushed remotely')
  assert.equal(await online.getByRole('button', { name: '托管安装' }).count(), 0, '离线节点不得提供远程安装按钮')
  const command = await offline.getByLabel('一键安装命令').innerText()
  assert.match(command, /^curl -fsSL --connect-timeout 5 'http:\/\/127\.0\.0\.1:\d+\/downloads\/install-agent\.sh' --noproxy '127\.0\.0\.1' \\$/m, `命令第一行必须按既有规则生成（含内网 --noproxy）：${command}`)
  assert.match(command, /WEMUX_AGENT_KEY='pi' WEMUX_INSTALL_DIR="\$HOME"'\/\.wemux-lite\/agents\/pi' WEMUX_WORKER_HOME="\$HOME"'\/\.wemux-lite' sh$/m, `命令必须以环境变量管道收尾，且缺省目录为 <home>/agents/<key>：${command}`)
  assert.equal((command.match(/\n/g) ?? []).length, 1, '单候选命令只应有两行')
  assert.doesNotMatch(command, /sed |\$\{.*\}|;\s*rm /, '脚本契约必须只有环境变量，不得拼接命令或做额外动作')
  const before = await bindingFor(offlineWorkerId, 'pi')
  assert.equal(before, null, '只展示命令时不得创建任何托管绑定')
  await install.getByRole('button', { name: '复制一键命令' }).click()
  await eventually(() => install.getByRole('status').allInnerTexts(), texts => texts.some(text => text.includes('已复制一键安装命令')), 'secure context copy succeeds')
  const clipboard = await page.evaluate(() => navigator.clipboard.readText())
  assert.equal(clipboard, command, '安全上下文下复制内容必须与展示的命令逐字一致')
  assert.equal(await bindingFor(offlineWorkerId, 'pi'), null, '复制命令仍然不得触发安装')
  await shot('offline-command')
  checks.push(`${step}: 离线节点命令 ${command.split('\n').length} 行，无绑定创建`)

  step = 'desktop: 未显式确认前绝不安装，确认后只创建托管修订与绑定'
  await workerSelect.selectOption(workerId)
  await agentSelect.selectOption('opencode')
  await online.getByRole('button', { name: '托管安装' }).waitFor()
  dialogMode = 'dismiss'
  await online.getByRole('button', { name: '托管安装' }).click()
  await eventually(() => dialogs.length, length => length > 0, 'confirmation dialog shown')
  assert.match(dialogs.at(-1).message, /确认让 托管安装在线节点 托管安装 opencode@1\.18\.31/, '确认文案必须点名节点与固定版本')
  await delay(500)
  assert.equal(await bindingFor(workerId, 'opencode'), null, '取消确认后不得创建托管绑定')
  assert.equal((await install.getByRole('status').allInnerTexts()).some(text => text.includes('已提交托管安装请求')), false, '取消确认后界面不得声称已提交')
  dialogMode = 'accept'
  await online.getByRole('button', { name: '托管安装' }).click()
  const submittedText = await eventually(() => install.getByRole('status').allInnerTexts(), texts => texts.find(text => text.includes('已提交托管安装请求')), 'submission acknowledged')
  const submitted = submittedText.find(text => text.includes('已提交托管安装请求'))
  assert.match(submitted, /已提交托管安装请求：opencode-ai@1\.18\.31（绑定 notified）/, `提交回执必须只声明创建了绑定：${submitted}`)
  const notified = await eventually(() => bindingFor(workerId, 'opencode'), item => item?.binding.status === 'notified', 'binding notified to the real Worker')
  assert.equal(notified.binding.agentKey, 'opencode')
  const pendingInventory = await api('/resource-inventory')
  const pendingEntry = pendingInventory.agents.find(entry => entry.workerId === workerId && entry.agentKey === 'opencode')
  assert.equal(pendingEntry.configuration.state, 'configured', '托管修订必须体现在已配置轴上')
  assert.match(pendingEntry.configuration.detail, /集群托管修订 v\d+/, '托管修订必须写入已配置轴')
  await refresh.click()
  const progressText = await eventually(distributionText, text => text.startsWith('分发待确认｜') || text.startsWith('分发失败｜'), 'receipt renders for the online pair')
  assert.doesNotMatch(progressText, /^已分发｜/, '提交后不得立刻显示已分发')
  notes.push({ step, progressText })
  checks.push(`${step}: 取消确认零写入；确认后绑定 notified，界面 ${progressText.slice(0, 120)}`)

  step = 'desktop: Worker 的真实取包失败必须透出，且永远不冒充已分发'
  // 沙箱没有公网 registry：npm 的代理指向必然拒绝连接的端口，所以这次安装是真实发生的
  // npm 取包、真实失败，并且必须等 Worker 回执结论（不预设结果）。
  const settled = await eventually(() => bindingFor(workerId, 'opencode'), item => item && item.binding.status !== 'notified', 'real Worker settles the managed install', 240000)
  notes.push({ step, bindingStatus: settled.binding.status, result: settled.reconcile?.result, errorCode: String(settled.reconcile?.errorCode ?? '').slice(0, 300) })
  if (settled.binding.status === 'failed') {
    assert.ok(settled.reconcile?.errorCode, '失败必须带 Worker 给出的原因')
    await refresh.click()
    const failedText = await eventually(distributionText, text => text.startsWith('分发失败｜'), 'failure is shown as 分发失败')
    assert.match(failedText, /已保留当前激活版本/, `失败原因必须来自 Worker 回执：${failedText.slice(0, 200)}`)
    assert.doesNotMatch(failedText, /^已分发｜/)
    assert.equal(await receipt.locator('dl dd').count(), 3, '四条状态轴中该 Agent 只投影已配置/已分发/可执行三轴')
    checks.push(`${step}: ${failedText.slice(0, 200)}`)
    await shot('online-install-failure')
  } else {
    // 若沙箱真的连上公网 registry 并装成，仍必须由回执决定展示，绝不越权声称。
    const entry = (await api('/resource-inventory')).agents.find(item => item.workerId === workerId && item.agentKey === 'opencode')
    assert.equal(settled.binding.status, 'installed', `绑定终态只能是 installed 或 failed：${settled.binding.status}`)
    assert.equal(entry.distribution.state, 'distributed', '真装上了才允许显示已分发')
    checks.push(`${step}: 沙箱实际取包成功，绑定 ${settled.binding.status}，分发态 ${entry.distribution.state}`)
  }

  step = 'desktop: 与固定目录不符的托管修订被 Worker 拒绝，失败原因 unapproved_runtime_artifact 透出'
  const unapprovedResourceId = 'e2e-managed-unapproved', unapprovedRevisionId = 'e2e-managed-unapproved-v1'
  const spec = catalog['claude-code']
  const forgedIntegrity = `sha512-${Buffer.alloc(64, 7).toString('base64')}`
  const contentSha256 = sha(`unapproved:${spec.name}@${spec.version}`)
  const now = new Date().toISOString()
  await expectStatus(await owner.raw('/resources', 'POST', { id: unapprovedResourceId, kind: 'agent-runtime', name: '验收托管运行时（claude-code）', description: `${spec.name}@${spec.version}`, definition: {}, createdBy: 'e2e-administrator', createdAt: now, updatedAt: now }), 201, "'/resources', 'POST', { id: unapprovedResourceId, kind: 'agent-runtime'")
  await expectStatus(await owner.raw(`/resources/${unapprovedResourceId}/revisions`, 'POST', {
    id: unapprovedRevisionId, resourceId: unapprovedResourceId, kind: 'agent-runtime', version: 1, state: 'published',
    manifest: { schemaVersion: 1, name: '验收托管运行时（claude-code）', description: '', compatibility: { workerProtocol: '2', platforms: ['linux'], architectures: ['x64'], agentKeys: ['claude-code'] }, bytes: 0, fileCount: 0, sha256: contentSha256, materializerVersion: 1, restartPolicy: 'worker' },
    payload: { mode: 'artifact', packageName: spec.name, packageVersion: spec.version, registryOrigin, packageIntegrity: forgedIntegrity },
    contentSha256, supplyChain: { mode: 'registry-package', packageName: spec.name, packageVersion: spec.version, registryOrigin, packageIntegrity: forgedIntegrity },
    createdBy: 'e2e-administrator', createdAt: now,
  }), 201, "`/resources/${unapprovedResourceId}/revisions`, 'POST'")
  await expectStatus(await owner.raw('/resource-bindings', 'POST', { id: 'e2e-binding-unapproved', workerId, resourceRevisionId: unapprovedRevisionId, agentKey: 'claude-code' }), 201, "'/resource-bindings', 'POST', { id: 'e2e-binding-unapproved'")
  const rejected = await eventually(() => bindingFor(workerId, 'claude-code'), item => item?.binding.status === 'failed', 'real Worker rejects the artifact that is not the pinned one', 90000)
  assert.equal(rejected.reconcile?.errorCode, 'unapproved_runtime_artifact', `必须报告未批准的运行时来源：${JSON.stringify(rejected.reconcile)?.slice(0, 200)}`)
  await agentSelect.selectOption('claude-code')
  await refresh.click()
  const rejectedText = await eventually(distributionText, text => text.startsWith('分发失败｜'), 'rejection is shown as 分发失败')
  assert.match(rejectedText, /unapproved_runtime_artifact/, `界面必须透出真实原因：${rejectedText}`)
  assert.match(await receipt.locator('dl dd').nth(0).innerText(), /^已配置｜/, '托管修订仍必须显示为已配置')
  assert.equal(await receipt.locator('dl dd').nth(2).isVisible(), true)
  await shot('unapproved-artifact-rejected')
  checks.push(`${step}: ${rejectedText.slice(0, 200)}`)

  step = 'admin API 只接受管理员，且非管理员不能创建托管安装'
  const memberApi = await context.request.post(`${loopback}/api/managed-agent-installs`, { data: { workerId, agentKey: 'pi' } })
  assert.equal(memberApi.status(), 403, '非管理员提交托管安装必须被拒')
  assert.equal(await bindingFor(workerId, 'pi'), null, '被拒的提交不得创建绑定')
  checks.push(`${step}: 非管理员提交 403，且零写入`)
  await context.close()
  checks.push(`会话中出现的确认对话框：${dialogs.map(entry => entry.message).join('｜')}`)

  step = 'non-administrator cannot read or change the management surface'
  const memberContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  assert.equal((await memberContext.request.post(`${loopback}/api/auth/login`, { data: { login: 'agent-member', password } })).status(), 200)
  const denied = await memberContext.request.get(`${loopback}/api/managed-agent-catalog`)
  assert.equal(denied.status(), 403, '非管理员读取固定版本清单必须被拒')
  assert.equal((await denied.json()).error.code, 'admin_required')
  const memberPage = await memberContext.newPage(); activePage = memberPage; memberPage.setDefaultTimeout(20000)
  memberPage.on('pageerror', error => errors.push({ name: 'member', step, message: error.message }))
  let catalogRequests = 0
  await memberPage.route('**/api/managed-agent-catalog*', async route => { catalogRequests += 1; await route.continue() })
  await memberPage.goto(`${loopback}/next/resources`)
  const memberView = memberPage.getByRole('region', { name: '资源管理' })
  await memberView.getByRole('alert').waitFor()
  assert.match(await memberView.getByRole('alert').innerText(), /只对实例管理员开放/)
  assert.equal(await memberView.getByRole('region', { name: '托管 Agent 安装' }).count(), 0, '非管理员不得渲染托管安装入口')
  assert.equal(await memberView.getByRole('button').count(), 0, '非管理员不渲染任何配置动作')
  assert.equal(catalogRequests, 0, '非管理员页面不得请求固定版本清单')
  assert.equal(await memberView.getByText('托管安装 Agent').count(), 0, '非管理员不得看到托管安装文案')
  checks.push(`${step}: 403 admin_required，界面零请求零动作`)
  await memberContext.close()

  step = 'mobile: 非安全上下文（明文 HTTP 局域网地址）必须降级为全选 + 提示，不能假称已复制'
  const address = nonLoopbackAddress()
  const insecureBase = address ? `http://${address}:${port}` : null
  const insecureReachable = insecureBase ? await fetch(`${insecureBase}/health`).then(response => response.ok).catch(() => false) : false
  if (insecureReachable) {
    const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    assert.equal((await mobileContext.request.post(`${insecureBase}/api/auth/login`, { data: { login: email, password } })).status(), 200)
    const mobilePage = await mobileContext.newPage(); activePage = mobilePage; mobilePage.setDefaultTimeout(20000)
    mobilePage.on('pageerror', error => errors.push({ name: 'mobile-insecure', step, message: error.message }))
    await mobilePage.goto(`${insecureBase}/next/resources`)
    assert.equal(await mobilePage.evaluate(() => window.isSecureContext), false, '该地址必须是真实的非安全上下文')
    assert.equal(await mobilePage.evaluate(() => typeof navigator.clipboard), 'undefined', '非安全上下文里 navigator.clipboard 必须不存在')
    const mobileInstall = mobilePage.getByRole('region', { name: '托管 Agent 安装' })
    await mobileInstall.getByRole('heading', { name: '托管安装 Agent' }).waitFor()
    await mobileInstall.getByLabel('托管安装目标工作节点').selectOption(offlineWorkerId)
    const mobileOffline = mobileInstall.getByRole('region', { name: '离线与自托管一键命令' })
    const mobileCommand = await mobileOffline.getByLabel('一键安装命令').innerText()
    assert.match(mobileCommand, /\/downloads\/install-agent\.sh/)
    await mobileInstall.getByRole('button', { name: '复制一键命令' }).click()
    const fallback = await eventually(() => mobileInstall.getByRole('status').allInnerTexts(), texts => texts.find(text => text.includes('无法自动复制')), 'insecure context copy falls back')
    assert.ok(fallback.find(text => text.includes('已选中命令') && text.includes('Ctrl+C')), `必须说明已全选并引导手动复制：${fallback.join('｜')}`)
    const selection = await mobilePage.evaluate(() => document.getSelection()?.toString() ?? '')
    assert.ok(selection.includes('/downloads/install-agent.sh'), `降级路径必须真的选中命令文本：${selection.slice(0, 120)}`)
    assert.equal(await bindingFor(offlineWorkerId, 'pi'), null, '非安全上下文展示命令同样不得创建绑定')
    const mobilePath = join(evidence, 'mobile-insecure-copy-fallback.png'); await mobilePage.screenshot({ path: mobilePath, fullPage: true }); screenshots.push(mobilePath)
    checks.push(`${step}: ${insecureBase} 上复制降级为全选（选中 ${selection.length} 字符）`)
    await mobileContext.close()
  } else {
    notes.push({ step, message: `没有可用非环回地址（${address ?? '无'}），非安全上下文复制降级未在浏览器中实测` })
  }

  await writeFile(join(evidence, 'checks.json'), JSON.stringify({ passed: true, checks, notes, dialogs, screenshots, errors }, null, 2))
  console.log(JSON.stringify({ passed: true, checks, notes, dialogs, errors, evidence }, null, 2))
} catch (error) {
  if (activePage) { try { await activePage.screenshot({ path: join(evidence, 'failure.png'), fullPage: true }) } catch { /* page may be gone */ } }
  console.error(JSON.stringify({ failed: step, message: error instanceof Error ? error.message : String(error), workerDiagnostics: worker?.readOutput(), checks, notes, errors, evidence }, null, 2))
  process.exitCode = 1
} finally {
  await stopWorker(worker)
  await browser?.close()
  await app.close()
}
