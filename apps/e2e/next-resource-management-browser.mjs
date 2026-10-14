// 双宿主 01 资源管理面验收：真 Server 服务真 web-next，真 Worker 上报能力与物化回执，
// 断言六类资源与四态（已配置/已认证/已分发/可执行）分离展示、管理员门与凭据不回显。
// WEMUX_NEXT_TEST_DIST=/tmp/... node --import tsx apps/e2e/next-resource-management-browser.mjs
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { createWemuxServer } from '../server/src/server.ts'
import { provisionAdministrator } from './session.ts'
import { seedLocalAccount } from '../server/src/test/fixtures/administrator.ts'
import { ownedWorkerLaunch } from './owned-worker-fixture.mjs'

assert.ok(process.env.WEMUX_NEXT_TEST_DIST?.startsWith('/tmp/'), 'owned temporary build required: WEMUX_NEXT_TEST_DIST must point at a /tmp copy of the web-next dist')
const { chromium } = await import(process.env.PLAYWRIGHT_CORE_PATH ?? '/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs')
const evidenceRoot = process.env.EVIDENCE_ROOT ?? tmpdir()
await mkdir(evidenceRoot, { recursive: true })
const evidence = await mkdtemp(join(evidenceRoot, 'wemux-next-resource-management-'))
const sha = (value) => createHash('sha256').update(value).digest('hex')
const email = 'resource-owner@example.test', password = 'owned-resource-password'
const app = createWemuxServer({
  databasePath: join(evidence, 'server.sqlite'),
  administratorEmails: [email], mail: {}, google: {},
  webNextStaticPath: resolve(process.env.WEMUX_NEXT_TEST_DIST),
})
let browser, worker, activePage, step = 'setup'
const checks = [], errors = [], screenshots = []
async function expectStatus(result, status, label) {
  assert.equal(result.status, status, `${label}: 期望 ${status}，实际 ${result.status} ${JSON.stringify(result.data)?.slice(0, 400)}`)
  return result.data
}
function launchWorker(args, origin, home) {
  const owned = ownedWorkerLaunch(args, origin)
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/worker/src/cli.ts', ...owned.args], { cwd: process.cwd(), env: { ...owned.env, WEMUX_WORKER_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.setEncoding('utf8').on('data', text => { output = (output + text).slice(-4000) })
  const done = new Promise((resolveDone, reject) => { child.once('error', reject); child.once('close', code => resolveDone({ code, output })) })
  void done.catch(() => {})
  return { child, done, readOutput: () => output }
}
async function stopWorker(current) {
  if (!current) return
  if (current.child.exitCode === null && current.child.signalCode === null) { current.child.kill('SIGCONT'); current.child.kill('SIGTERM') }
  const timer = setTimeout(() => current.child.kill('SIGKILL'), 10000)
  try { assert.equal((await current.done).code, 0, `owned Worker closes gracefully: ${current.readOutput()}`) } finally { clearTimeout(timer) }
}
async function eventually(read, accept, label, timeout = 60000) {
  const deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) { last = await read(); if (accept(last)) return last; await delay(100) }
  throw Error(`Timed out: ${label} — last=${JSON.stringify(last)?.slice(0, 600)}`)
}
function skillRevision(resourceId, id, version, content, declaredBlob) {
  const blobHash = declaredBlob ?? sha(content)
  const manifestHash = sha(`manifest-${id}`)
  return {
    blobHash, content,
    revision: {
      id, resourceId, kind: 'skill', version, state: 'published',
      manifest: {
        schemaVersion: 1, name: '验收资源', description: '',
        compatibility: { workerProtocol: '2', platforms: ['linux'], architectures: ['x64'], agentKeys: ['pi'] },
        bytes: Buffer.byteLength(content), fileCount: 1, sha256: manifestHash, materializerVersion: 1, restartPolicy: 'none',
      },
      payload: { mode: 'blobs', files: [{ path: 'SKILL.md', size: Buffer.byteLength(content), mediaType: 'text/markdown', sha256: blobHash, blobSha256: blobHash }] },
      contentSha256: manifestHash, supplyChain: { mode: 'static-content', manifestSha256: manifestHash },
      createdBy: 'e2e-administrator', createdAt: new Date().toISOString(),
    },
  }
}
try {
  const origin = await app.listen(0)
  const owner = await provisionAdministrator({ store: app.store, baseUrl: origin, email, password })
  const api = owner.api
  await api('/bootstrap', 'POST', {})
  const member = await seedLocalAccount(app.store, { username: 'resource-member', email: 'resource-member@example.test', password })
  await app.store.transaction(async tx => {
    await tx.identity.saveMembership({ teamId: 'default-team', userId: member.id, role: 'member', joinedAt: new Date().toISOString() })
  })

  step = 'real Worker registers, starts and reports its own capability probe'
  const onlineHome = join(evidence, 'worker-online'), offlineHome = join(evidence, 'worker-offline')
  const onlineToken = await api('/enrollment-tokens', 'POST', { expiresInSeconds: 3600 })
  const registration = launchWorker(['register', '--home', onlineHome, `--token=${onlineToken.token}`, '--name', '资源验收节点'], origin, onlineHome)
  assert.equal((await registration.done).code, 0, 'Worker registers against the owned Server')
  worker = launchWorker(['start', '--home', onlineHome, '--name', '资源验收节点'], origin, onlineHome)
  const workers = await eventually(() => api('/workers'), value => value.items.some(item => item.name === '资源验收节点' && item.connectionState === 'online'), 'online Worker visible')
  const workerId = workers.items.find(item => item.name === '资源验收节点').id
  await eventually(() => api(`/workers/${workerId}/capabilities`), value => value.capabilities.length > 0, 'real capability probe reported')
  // 第二台 Worker 只注册不启动：未连接、无能力探测，用于验证“探测失败如实上报不可用”。
  const offlineToken = await api('/enrollment-tokens', 'POST', { expiresInSeconds: 3600 })
  const offlineRegistration = launchWorker(['register', '--home', offlineHome, `--token=${offlineToken.token}`, '--name', '资源验收离线节点'], origin, offlineHome)
  const offlineRegistered = await offlineRegistration.done
  assert.equal(offlineRegistered.code, 0, `offline Worker registers against the owned Server: ${offlineRegistered.output}`)
  const offlineWorkerId = (await eventually(() => api('/workers'), value => value.items.some(item => item.name === '资源验收离线节点'), 'offline Worker visible')).items.find(item => item.name === '资源验收离线节点').id
  const offlineState = await eventually(() => api('/workers'), value => value.items.find(item => item.id === offlineWorkerId)?.connectionState !== 'online' && value.items.find(item => item.id === offlineWorkerId), 'offline Worker is not online')
  assert.notEqual(offlineState.connectionState, 'online')
  checks.push(`${step}: 在线节点 ${workerId}，离线节点 ${offlineWorkerId}`)

  step = 'administrator authors real 技能 and model-provider resources and binds them to the online Worker'
  const skillId = 'e2e-resource-skill', brokenSkillId = 'e2e-resource-broken-skill', providerId = 'e2e-resource-provider'
  const now = new Date().toISOString()
  const resource = (id, kind, name, definition) => ({ id, kind, name, description: `${name} 验收资源`, definition, createdBy: 'e2e-administrator', createdAt: now, updatedAt: now })
  await expectStatus(await owner.raw('/resources', 'POST', resource(skillId, 'skill', '验收技能', { entryFile: 'SKILL.md', compatibleAgents: ['pi'], containsExecutableFiles: false })), 201, "'/resources', 'POST', resource(skillId, 'skill', '验收技能', { e")
  await expectStatus(await owner.raw('/resources', 'POST', resource(brokenSkillId, 'skill', '异常技能', { entryFile: 'SKILL.md', compatibleAgents: ['pi'], containsExecutableFiles: false })), 201, "'/resources', 'POST', resource(brokenSkillId, 'skill', '异常技能")
  const providerDefinition = {
    providerKey: 'openai-compatible', endpoint: 'https://api.example.test/v1', modelIds: ['gpt-acceptance'],
    agentKeys: ['pi'], credential: { kind: 'environment', variableNames: ['OPENAI_API_KEY'] },
  }
  // Provider 资源体不允许携带 createdBy：路由按当前管理员注入归属，多余字段会被拒绝。
  await expectStatus(await owner.raw('/resources', 'POST', { ...resource(providerId, 'model-provider', '验收提供方', providerDefinition), createdBy: undefined }), 201, "'/resources', 'POST', resource(providerId, 'model-provider',")
  const good = skillRevision(skillId, 'e2e-skill-rev-1', 1, '# 验收技能\n\n这是一份真实验收技能。')
  await expectStatus(await owner.raw(`/resource-blobs/${good.blobHash}`, 'PUT', { base64Content: Buffer.from(good.content).toString('base64') }), 201, "`/resource-blobs/${good.blobHash}`, 'PUT', { base64Content: ")
  await expectStatus(await owner.raw(`/resources/${skillId}/revisions`, 'POST', good.revision), 201, "`/resources/${skillId}/revisions`, 'POST', good.revision")
  const broken = skillRevision(brokenSkillId, 'e2e-broken-rev-1', 1, '# 异常技能\n\n这一份声明的内容从未上传。', sha('never-uploaded-content'))
  await expectStatus(await owner.raw(`/resources/${brokenSkillId}/revisions`, 'POST', broken.revision), 201, "`/resources/${brokenSkillId}/revisions`, 'POST', broken.revi")
  // Provider 修订的哈希必须自洽：bytes 取配置 JSON 的字节数，sha256/contentSha256/manifestSha256 同源。
  const providerConfigJson = JSON.stringify(providerDefinition), providerHash = sha(providerConfigJson)
  const providerRevision = {
    id: 'e2e-provider-rev-1', resourceId: providerId, kind: 'model-provider', version: 1, state: 'published',
    manifest: {
      schemaVersion: 1, name: '验收提供方', description: '', compatibility: { workerProtocol: '2', platforms: ['linux'], architectures: ['x64'], agentKeys: ['pi'] },
      bytes: Buffer.byteLength(providerConfigJson), fileCount: 0, sha256: providerHash, materializerVersion: 1, restartPolicy: 'none',
    },
    payload: { mode: 'inline-config', contentSha256: providerHash, config: providerDefinition },
    contentSha256: providerHash, supplyChain: { mode: 'static-content', manifestSha256: providerHash },
    createdBy: 'e2e-administrator', createdAt: now,
  }
  // 首个 Provider 修订走通用修订入口：provider-revisions 要求 expectedVersion ≥ 1，只用于后续发布。
  await expectStatus(await owner.raw(`/resources/${providerId}/revisions`, 'POST', providerRevision), 201, "`/resources/${providerId}/provider-revisions`, 'POST', { exp")
  await expectStatus(await owner.raw('/resource-bindings', 'POST', { id: 'e2e-binding-good', workerId, resourceRevisionId: good.revision.id, agentKey: 'pi' }), 201, "'/resource-bindings', 'POST', { id: 'e2e-binding-good', work")
  await expectStatus(await owner.raw('/resource-bindings', 'POST', { id: 'e2e-binding-provider', workerId, resourceRevisionId: providerRevision.id, agentKey: 'pi' }), 201, "'/resource-bindings', 'POST', { id: 'e2e-binding-provider', ")
  const installed = await eventually(() => api('/resource-bindings'), value => value.items.some(item => item.binding.id === 'e2e-binding-good' && item.binding.status === 'installed' && item.reconcile?.phase === 'ready'), 'real Worker materialized and confirmed the 技能 revision')
  assert.equal(installed.items.find(item => item.binding.id === 'e2e-binding-good').reconcile.integrity, good.revision.contentSha256, 'installation receipt carries the real integrity identifier')
  checks.push(`${step}: 技能已由真 Worker 物化并回执，提供方回执 ${JSON.stringify(installed.items.find(item => item.binding.id === 'e2e-binding-provider')?.reconcile?.phase)}`)

  step = 'administrator view separates 已配置/已认证/已分发/可执行 for all six classes'
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const inventory = await owner.api('/resource-inventory')
  assert.deepEqual(Object.keys(inventory), ['generatedAt', 'workers', 'agents', 'models', 'skills', 'presets', 'providers'])
  // 不变量：Agent 宣称可执行时必须有真实版本探测且 Worker 在线；模型没有自己的版本，
  // 它的可执行必须由同节点同 Agent 的真实探测支撑，不能由集群声明推断。
  for (const entry of inventory.agents) {
    if (entry.execution.state === 'executable') { assert.notEqual(entry.version, null, `可执行必须有版本探测：${entry.id}`); assert.equal(entry.connectionState, 'online', `可执行必须来自在线 Worker：${entry.id}`) }
    if (entry.authentication.state === 'authenticated') assert.notEqual(entry.authentication.observedAt, null, `认证必须有探测时间：${entry.id}`)
  }
  for (const entry of inventory.models) {
    if (entry.execution.state !== 'executable') continue
    const agent = inventory.agents.find(candidate => candidate.workerId === entry.workerId && candidate.agentKey === entry.agentKey)
    assert.equal(agent?.execution.state, 'executable', `模型可执行必须由同节点同 Agent 的真实探测支撑：${entry.id}`)
  }
  const offlineNode = inventory.workers.find(entry => entry.id === offlineWorkerId)
  assert.equal(offlineNode.authentication.state, 'unknown', '离线 Worker 的认证不得冒充已认证')
  assert.equal(offlineNode.execution.state, 'unknown', '离线 Worker 的可执行必须如实未知')
  const offlineAgents = inventory.agents.filter(entry => entry.workerId === offlineWorkerId)
  assert.ok(offlineAgents.length > 0, '离线 Worker 也要列出 Agent 条目')
  assert.ok(offlineAgents.every(entry => entry.execution.state === 'unknown'), '离线 Worker 的 Agent 不得宣称可执行')
  assert.equal(inventory.skills.find(entry => entry.id === skillId).distribution.state, 'distributed')
  const providerEntry = inventory.providers.find(entry => entry.id === providerId)
  assert.match(providerEntry.configuration.detail, /环境变量 OPENAI_API_KEY/, '管理面只展示声明过的变量名')
  assert.doesNotMatch(JSON.stringify(inventory), /OPENAI_API_KEY\s*[=:]\s*["']?[A-Za-z0-9]/, '管理面永不回显凭据取值')
  assert.ok(providerEntry.authentication.state !== 'authenticated', '本地未配置的提供方不得显示为已认证')
  checks.push(`${step}: 六类 ${[inventory.workers, inventory.agents, inventory.models, inventory.skills, inventory.presets, inventory.providers].map(list => list.length).join('/')}，提供方认证 ${providerEntry.authentication.state}`)

  for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport, isMobile: name === 'mobile', hasTouch: name === 'mobile' })
    assert.equal((await context.request.post(`${origin}/api/auth/login`, { data: { login: email, password } })).status(), 200)
    const page = await context.newPage(); activePage = page; page.setDefaultTimeout(20000)
    const view = page.getByRole('region', { name: '资源管理' })
    const shot = async label => { const path = join(evidence, `${name}-${label}.png`); await page.screenshot({ path, fullPage: true }); screenshots.push(path) }
    page.on('pageerror', error => errors.push({ name, step, message: error.message }))
    page.on('console', message => { if (message.type() === 'error') errors.push({ name, step, message: message.text() }) })

    step = `${name}: 管理员在 /next/resources 看到六类分区与逐条四态`
    await page.goto(`${origin}/next/resources`)
    for (const label of ['工作节点', 'Agent', '模型', '技能', '预设', 'Provider']) await page.getByRole('region', { name: label, exact: true }).waitFor()
    const nodeCard = view.getByRole('article', { name: '工作节点 资源验收节点' })
    assert.match(await nodeCard.locator('[data-axis="configuration"] dd').innerText(), /^已配置｜无已发布修订｜已注册到集群｜(无探测证据|探测于 )/)
    assert.match(await nodeCard.locator('[data-axis="authentication"] dd').innerText(), /^已认证｜已通过 Worker 凭据认证｜(无探测证据|探测于 )/)
    assert.equal(await nodeCard.locator('[data-axis="execution"] dd').count(), 1)
    const offlineCard = view.getByRole('article', { name: '工作节点 资源验收离线节点' })
    assert.match(await offlineCard.locator('[data-axis="authentication"] dd').innerText(), /^认证未知｜/)
    assert.match(await offlineCard.locator('[data-axis="execution"] dd').innerText(), /^执行未知｜/)
    const skillCard = view.getByRole('article', { name: '技能 验收技能' })
    assert.match(await skillCard.locator('[data-axis="configuration"] dd').innerText(), /^已配置｜修订 v1｜/)
    assert.match(await skillCard.locator('[data-axis="authentication"] dd').innerText(), /^无需认证｜静态内容，不需要凭据｜/)
    assert.match(await skillCard.locator('[data-axis="distribution"] dd').innerText(), /^已分发｜期望态 v\d+｜.+｜探测于 /)
    assert.match(await skillCard.locator('[data-axis="execution"] dd').innerText(), /^不直接执行｜/)
    assert.equal(await skillCard.locator('[data-axis]').count(), 4, '每条资源必须分别展示四条状态轴')
    const providerCard = view.getByRole('article', { name: 'Provider 验收提供方' })
    assert.match(await providerCard.locator('[data-axis="configuration"] dd').innerText(), /凭据来源：环境变量 OPENAI_API_KEY/)
    assert.match(await providerCard.locator('[data-axis="authentication"] dd').innerText(), /^未认证｜/)
    assert.match(await providerCard.locator('[data-axis="execution"] dd').innerText(), /^不直接执行｜/)
    const bodyText = await page.locator('body').innerText()
    assert.doesNotMatch(bodyText, /OPENAI_API_KEY\s*[=:]/, '页面不得回显凭据取值')
    assert.doesNotMatch(bodyText, /sk-[A-Za-z0-9]{8,}/, '页面不得回显任何密钥样式取值')
    await shot('administrator-inventory')
    checks.push(`${step}: 六分区 + 四轴分离 + 凭据只有变量名`)

    step = `${name}: 未探测到能力的 Agent 如实显示不可执行而不是隐藏`
    const unbound = inventory.agents.filter(entry => entry.workerId === workerId && entry.execution.state !== 'executable')
    for (const entry of unbound.slice(0, 2)) {
      // 两个 Worker 可能上报同名 Agent，必须按节点名区分，不能靠条目名唯一。
      const card = view.getByRole('article', { name: `Agent ${entry.name}` }).filter({ hasText: '资源验收节点' })
      const execution = await card.locator('[data-axis="execution"] dd').innerText()
      assert.match(execution, /^不可执行｜|^执行未知｜/, `${entry.name} 必须如实展示不可用`)
    }
    if (unbound.length === 0) checks.push(`${name}: 该节点所有 Agent 均报告可执行，未安装分支由离线节点与未绑定 Agent 覆盖`)
    const offlineAgent = offlineAgents[0]
    const offlineAgentCard = view.getByRole('article', { name: `Agent ${offlineAgent.name}` }).filter({ hasText: '资源验收离线节点' })
    assert.match(await offlineAgentCard.locator('[data-axis="execution"] dd').innerText(), /^执行未知｜/)

    step = `${name}: 安装失败如实上报失败原因，且不冒充已分发`
    // 失败绑定只创建一次；第二轮只复验展示，避免重复绑定撞唯一约束。
    const brokenExists = (await api('/resource-bindings')).items.some(item => item.binding.id === 'e2e-binding-broken')
    if (!brokenExists) await expectStatus(await owner.raw('/resource-bindings', 'POST', { id: 'e2e-binding-broken', workerId, resourceRevisionId: broken.revision.id, agentKey: 'pi' }), 201, "'/resource-bindings', 'POST', { id: 'e2e-binding-broken', workerId, resourceRevisionId: broken.revision.id, agentKey: 'pi' }")
    await eventually(() => api('/resource-bindings'), value => value.items.some(item => item.binding.id === 'e2e-binding-broken' && item.binding.status === 'failed'), 'real Worker reported the failed installation')
    await page.getByRole('button', { name: '刷新资源清单' }).click()
    const brokenCard = view.getByRole('article', { name: '技能 异常技能' })
    await eventually(async () => brokenCard.locator('[data-axis="distribution"] dd').innerText(), text => text.startsWith('分发失败｜'), 'failure is shown as 分发失败')
    const failedText = await brokenCard.locator('[data-axis="distribution"] dd').innerText()
    assert.match(failedText, /^分发失败｜期望态 v\d+｜.+｜探测于 /, `失败必须带 Worker 给出的原因与回执时间：${failedText}`)
    const failedNode = view.getByRole('article', { name: '工作节点 资源验收节点' })
    assert.match(await failedNode.locator('[data-axis="distribution"] dd').innerText(), /^分发失败｜/, '有目标安装失败时节点聚合也必须显示失败')
    await shot('installation-failure')
    checks.push(`${step}: ${failedText.slice(0, 160)}`)
    await context.close()
  }

  step = 'non-administrator cannot read or change the management surface'
  const memberContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  assert.equal((await memberContext.request.post(`${origin}/api/auth/login`, { data: { login: 'resource-member', password } })).status(), 200)
  const denied = await memberContext.request.get(`${origin}/api/resource-inventory`)
  assert.equal(denied.status(), 403, '非管理员读取资源清单必须被拒')
  assert.equal((await denied.json()).error.code, 'admin_required')
  const memberPage = await memberContext.newPage(); activePage = memberPage; memberPage.setDefaultTimeout(20000)
  memberPage.on('pageerror', error => errors.push({ name: 'member', step, message: error.message }))
  let memberRequests = 0
  await memberPage.route('**/api/resource-inventory*', async route => { memberRequests += 1; await route.continue() })
  await memberPage.goto(`${origin}/next/resources`)
  const memberView = memberPage.getByRole('region', { name: '资源管理' })
  await memberView.getByRole('alert').waitFor()
  assert.match(await memberView.getByRole('alert').innerText(), /只对实例管理员开放/)
  assert.equal(await memberView.locator('[data-axis]').count(), 0, '非管理员不渲染任何状态轴')
  assert.equal(await memberView.getByRole('button').count(), 0, '非管理员不渲染配置动作')
  assert.equal(memberRequests, 0, '非管理员页面不得请求资源清单')
  const memberText = await memberPage.locator('body').innerText()
  assert.equal(memberText.includes('资源验收节点'), false, '非管理员不得看到节点名')
  await memberPage.screenshot({ path: join(evidence, 'member-denied.png'), fullPage: true }); screenshots.push(join(evidence, 'member-denied.png'))
  await memberContext.close()
  checks.push(`${step}: 403 admin_required 且界面零请求零状态轴`)

  await writeFile(join(evidence, 'checks.json'), JSON.stringify({ passed: true, checks, screenshots, errors }, null, 2))
  console.log(JSON.stringify({ passed: true, checks, errors, evidence }, null, 2))
} catch (error) {
  if (activePage) { try { await activePage.screenshot({ path: join(evidence, 'failure.png'), fullPage: true }) } catch { /* page may be gone */ } }
  console.error(JSON.stringify({ failed: step, message: error instanceof Error ? error.message : String(error), workerDiagnostics: worker?.readOutput(), checks, errors, evidence }, null, 2))
  process.exitCode = 1
} finally {
  await stopWorker(worker)
  await browser?.close()
  await app.close()
}
