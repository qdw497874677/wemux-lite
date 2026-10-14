// 双宿主 03 资源管理写路径验收：真 Server 服务真 web-next，真 Worker 接收并物化绑定。
// 管理员在 /next/resources 的「管理动作」里完成 新建/修改/删除资源 -> 发布技能修订（blob sha256 去重）
// -> 发布 Provider 修订（首个走通用修订，后续 expectedVersion CAS）-> 绑定 -> 撤销（转待回收）
// -> 创建并应用预设（requestId 幂等 + expectedSetRevision CAS），并断言真实 409 冲突提示、
// requestId 重放不重复、写后重新核验投影不闪空、非管理员零写入口零请求。
// WEMUX_NEXT_TEST_DIST=/tmp/... node --import tsx apps/e2e/next-resource-management-write-browser.mjs
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
const evidence = await mkdtemp(join(evidenceRoot, 'wemux-next-resource-write-'))
const sha = value => createHash('sha256').update(value).digest('hex')
const email = 'resource-writer@example.test', password = 'owned-writer-password'
const memberEmail = 'resource-writer-member@example.test'
const app = createWemuxServer({
  databasePath: join(evidence, 'server.sqlite'),
  administratorEmails: [email], mail: {}, google: {},
  webNextStaticPath: resolve(process.env.WEMUX_NEXT_TEST_DIST),
})
let browser, worker, activePage, step = 'setup', applicationLog = []
const checks = [], errors = [], screenshots = []

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
const written = (label, value) => { checks.push(`${label}: ${value}`) }

try {
  const origin = await app.listen(0)
  const owner = await provisionAdministrator({ store: app.store, baseUrl: origin, email, password })
  const api = owner.api
  await api('/bootstrap', 'POST', {})
  const member = await seedLocalAccount(app.store, { username: 'resource-writer-member', email: memberEmail, password })
  await app.store.transaction(async tx => {
    await tx.identity.saveMembership({ teamId: 'default-team', userId: member.id, role: 'member', joinedAt: new Date().toISOString() })
  })

  step = 'real Worker registers and starts so bindings have a real target'
  const workerHome = join(evidence, 'worker')
  const token = await api('/enrollment-tokens', 'POST', { expiresInSeconds: 3600 })
  const registration = launchWorker(['register', '--home', workerHome, `--token=${token.token}`, '--name', '写路径验收节点'], origin, workerHome)
  assert.equal((await registration.done).code, 0, 'Worker registers against the owned Server')
  worker = launchWorker(['start', '--home', workerHome, '--name', '写路径验收节点'], origin, workerHome)
  const workers = await eventually(() => api('/workers'), value => value.items.some(item => item.name === '写路径验收节点' && item.connectionState === 'online'), 'online Worker visible')
  const workerId = workers.items.find(item => item.name === '写路径验收节点').id
  await eventually(() => api(`/workers/${workerId}/capabilities`), value => value.capabilities.length > 0, 'real capability probe reported')
  written(step, `在线节点 ${workerId}`)

  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })

  for (const [name, viewport] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
    const skillName = `验收技能-${name}`, providerName = `验收提供方-${name}`, tempName = `验收临时-${name}`, presetName = `验收预设-${name}`
    const context = await browser.newContext({ viewport, isMobile: name === 'mobile', hasTouch: name === 'mobile' })
    assert.equal((await context.request.post(`${origin}/api/auth/login`, { data: { login: email, password } })).status(), 200)
    const page = await context.newPage(); activePage = page; page.setDefaultTimeout(20000)
    const view = page.getByRole('region', { name: '资源管理' })
    const shot = async label => { const path = join(evidence, `${name}-${label}.png`); await page.screenshot({ path, fullPage: true }); screenshots.push(path) }
    page.on('pageerror', error => errors.push({ name, step, message: error.message }))
    // 预期的 4xx 会被 Chromium 记成 "Failed to load resource" 控制台错误，这里只收集真正的页面异常。
    page.on('console', message => { if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) errors.push({ name, step, message: message.text() }) })
    page.on('dialog', dialog => void dialog.accept())
    // 记录浏览器自己发出的预设应用请求：状态码、错误码与请求体（requestId / expectedSetRevision 幂等依据）。
    const applications = []
    applicationLog = applications
    page.on('response', async response => {
      const request = response.request(), url = new URL(response.url())
      if (request.method() !== 'POST' || !/^\/api\/resource-presets\/[^/]+\/applications$/.test(url.pathname)) return
      let code = null, body = null, text = ''
      try { text = await response.text() } catch (error) { text = `unreadable: ${error.message}` }
      try { code = JSON.parse(text)?.error?.code ?? null } catch { /* 不是 JSON */ }
      try { body = request.postDataJSON() } catch { /* 非 JSON 请求体 */ }
      applications.push({ status: response.status(), code, text: text.slice(0, 300), body })
    })

    step = `${name}: 只读投影先就位，随后展开管理动作`
    await page.goto(`${origin}/next/resources`)
    for (const label of ['工作节点', 'Agent', '模型', '技能', '预设', 'Provider']) await page.getByRole('region', { name: label, exact: true }).waitFor()
    await view.getByRole('article', { name: '工作节点 写路径验收节点' }).waitFor()
    await view.getByRole('article', { name: `技能 ${skillName}` }).count() === 0
    // 观察四态投影的最小轴数：写操作触发的重新核验不得闪回空态。
    await page.evaluate(() => {
      window.__axisMin = document.querySelectorAll('[data-axis]').length
      new MutationObserver(() => {
        const count = document.querySelectorAll('[data-axis]').length
        if (count < window.__axisMin) window.__axisMin = count
      }).observe(document.body, { childList: true, subtree: true, characterData: true })
    })
    await page.getByRole('button', { name: '管理动作' }).click()
    const panel = page.getByRole('region', { name: '资源管理动作' })
    await panel.getByRole('heading', { name: '管理动作' }).waitFor()
    for (const label of ['新建资源', '资源清单与修改', '发布技能修订', '发布 Provider 修订', '资源绑定', '资源预设']) {
      assert.equal(await page.getByRole('region', { name: label, exact: true }).count(), 1, `${label} 区块缺失`)
    }
    written(`${step}（${name}）`, '六类只读分区 + 六个写区块')

    step = `${name}: 管理员新建技能资源，写后投影重新核验`
    const create = page.getByRole('region', { name: '新建资源' })
    await create.getByLabel('名称').fill(skillName)
    await create.getByLabel('描述').fill('写路径验收资源')
    await create.getByRole('button', { name: '新建资源' }).click()
    await create.getByRole('status').filter({ hasText: `已创建技能资源「${skillName}」` }).waitFor()
    const skill = await eventually(async () => (await api('/resources')).items.find(item => item.name === skillName), Boolean, 'created skill visible through the API')
    assert.equal(skill.kind, 'skill')
    assert.deepEqual(skill.definition, { entryFile: 'SKILL.md', compatibleAgents: ['pi'], containsExecutableFiles: false })
    assert.ok(typeof skill.createdBy === 'string' && skill.createdBy.length > 0, '归属由 Server 按当前管理员注入')
    await view.getByRole('article', { name: `技能 ${skillName}` }).waitFor()
    assert.equal(await view.getByRole('article', { name: '工作节点 写路径验收节点' }).count(), 1, '写后既有卡片不得消失')
    written(step, `资源 ${skill.id}（${skill.createdBy}）`)

    step = `${name}: 修改资源描述，删除临时资源（撤销不是物理删除的反例对照）`
    const skillRow = page.getByRole('article', { name: `管理资源 ${skillName}` })
    await skillRow.getByLabel('描述').fill('写路径验收资源（已修改）')
    await skillRow.getByRole('button', { name: '保存名称与描述' }).click()
    await skillRow.getByRole('status').filter({ hasText: `已更新资源「${skillName}」` }).waitFor()
    await eventually(async () => (await api(`/resources/${skill.id}`)).resource.description, value => value === '写路径验收资源（已修改）', 'updated description read back from the Server')
    await create.getByLabel('名称').fill(tempName)
    await create.getByRole('button', { name: '新建资源' }).click()
    const temp = await eventually(async () => (await api('/resources')).items.find(item => item.name === tempName), Boolean, 'temporary resource created')
    const tempRow = page.getByRole('article', { name: `管理资源 ${tempName}` })
    await tempRow.getByRole('button', { name: '删除资源' }).click()
    await tempRow.waitFor({ state: 'detached' })
    assert.equal((await owner.raw(`/resources/${temp.id}`, 'GET')).status, 404, '删除后资源不可再读取')
    // 其余可写资源类型（Agent 运行时、连接器配置）同样在管理面内建/删，覆盖四类可写资源的建与删。
    for (const [kind, kindLabel] of [['agent-runtime', 'Agent 运行时'], ['connector-config', '连接器配置']]) {
      const extraName = `${kindLabel}验收-${name}`
      await create.getByLabel('资源类型').selectOption(kind)
      await create.getByLabel('名称').fill(extraName)
      await create.getByRole('button', { name: '新建资源' }).click()
      await create.getByRole('status').filter({ hasText: `已创建${kindLabel}资源「${extraName}」` }).waitFor()
      const extra = await eventually(async () => (await api('/resources')).items.find(item => item.name === extraName), Boolean, `${kind} resource created through the UI`)
      assert.equal(extra.kind, kind)
      const extraRow = page.getByRole('article', { name: `管理资源 ${extraName}` })
      await extraRow.getByRole('button', { name: '删除资源' }).click()
      await extraRow.waitFor({ state: 'detached' })
      assert.equal((await owner.raw(`/resources/${extra.id}`, 'GET')).status, 404, `${kind} 删除后不可再读取`)
    }
    await create.getByLabel('资源类型').selectOption('skill')
    written(step, `修改 ${skill.id}，删除 ${temp.id}（404），并验证 Agent 运行时与连接器配置可建可删`)

    step = `${name}: 发布技能修订，先按 sha256 上传 blob 再发布不可变修订`
    const content = `# ${skillName}\n\n写路径验收技能内容。`
    const blobSha = sha(content)
    const publish = page.getByRole('region', { name: '发布技能修订' })
    await publish.getByLabel('技能资源').selectOption({ label: skillName })
    await eventually(() => publish.getByLabel('SKILL.md 内容').isVisible(), Boolean, 'skill content field')
    await publish.getByLabel('SKILL.md 内容').fill(content)
    await publish.getByRole('button', { name: '发布技能修订' }).click()
    await publish.getByRole('status').filter({ hasText: '已发布技能修订 v1' }).waitFor()
    const detail = await eventually(async () => (await api(`/resources/${skill.id}`)).revisions.length, length => length === 1, 'skill revision published')
    assert.ok(detail)
    const revision = (await api(`/resources/${skill.id}`)).revisions[0]
    assert.equal(revision.state, 'published')
    assert.equal(revision.payload.files[0].path, 'SKILL.md')
    assert.equal(revision.payload.files[0].blobSha256, blobSha, '界面算出的 sha256 与 Server 的去重键一致')
    assert.equal(revision.payload.files[0].size, Buffer.byteLength(content))
    assert.equal(revision.contentSha256, revision.manifest.sha256)
    const dedup = await owner.raw(`/resource-blobs/${blobSha}`, 'PUT', { base64Content: Buffer.from(content).toString('base64') })
    assert.equal(dedup.status, 200, '相同内容再次上传必须命中 sha256 去重')
    assert.equal(dedup.data.deduplicated, true)
    written(step, `修订 ${revision.id} v${revision.version}，blob ${blobSha.slice(0, 12)}… 去重`)

    step = `${name}: 绑定已发布修订到真节点，真 Worker 物化后投影显示已分发`
    const binding = page.getByRole('region', { name: '资源绑定' })
    await binding.getByLabel('工作节点').selectOption(workerId)
    await binding.getByLabel('资源').selectOption({ label: `技能｜${skillName}` })
    await eventually(() => binding.getByLabel('已发布修订').locator('option').count(), count => count > 1, 'published revision option')
    await binding.getByLabel('已发布修订').selectOption(revision.id)
    await binding.getByLabel('Agent（可选）').fill('pi')
    await binding.getByRole('button', { name: '创建绑定' }).click()
    await binding.getByRole('status').filter({ hasText: '已创建绑定' }).waitFor()
    const projection = await eventually(async () => (await api(`/resource-bindings?workerId=${workerId}`)).items.find(item => item.binding.resourceRevisionId === revision.id), Boolean, 'binding created through the UI')
    const bindingId = projection.binding.id
    assert.equal(projection.binding.workerId, workerId)
    assert.equal(projection.binding.agentKey, 'pi')
    await eventually(() => api(`/resource-bindings?workerId=${workerId}`), value => value.items.find(item => item.binding.id === bindingId)?.binding.status === 'installed', 'real Worker materialized the skill revision', 90000)
    await page.getByRole('button', { name: '刷新资源清单' }).click()
    const skillCard = view.getByRole('article', { name: `技能 ${skillName}` })
    await eventually(() => skillCard.locator('[data-axis="distribution"] dd').innerText(), text => text.startsWith('已分发｜'), 'distribution axis shows 已分发')
    assert.equal(await skillCard.locator('[data-axis]').count(), 4)
    written(step, `绑定 ${bindingId} 已由真 Worker 物化`)

    step = `${name}: 应用预设遇到真实 409（已存在有效绑定），提示刷新重试且同一意图复用 requestId`
    const preset = page.getByRole('region', { name: '资源预设' })
    const entries = page.getByRole('region', { name: '预设条目' })
    await entries.getByLabel('资源').selectOption({ label: `技能｜${skillName}` })
    await eventually(() => entries.getByLabel('已发布修订').locator('option').count(), count => count > 1, 'entry revision option')
    await entries.getByLabel('已发布修订').selectOption(revision.id)
    await entries.getByLabel('Agent').fill('pi')
    await entries.getByRole('button', { name: '添加条目' }).click()
    await preset.getByLabel('预设名称').fill(presetName)
    await preset.getByRole('button', { name: '创建预设' }).click()
    await preset.getByRole('status').filter({ hasText: `预设「${presetName}」已保存` }).waitFor()
    const saved = await eventually(async () => (await api('/resource-presets')).items.find(item => item.name === presetName), Boolean, 'preset saved through the UI')
    assert.equal(saved.revision, 1, '新预设用 expectedRevision 0 提交')
    assert.deepEqual(saved.entries, [{ resourceId: skill.id, resourceRevisionId: revision.id, agentKey: 'pi', projectId: null, required: true }])
    await preset.getByRole('combobox', { name: '预设' }).selectOption({ label: `${presetName}（revision 1）` })
    await preset.getByLabel('工作节点').selectOption(workerId)
    const setBefore = await api(`/workers/${workerId}/resource-set`)
    await preset.getByRole('button', { name: '应用预设' }).click()
    await preset.getByRole('alert').waitFor()
    assert.equal(await preset.getByRole('alert').innerText(), '资源状态已被其他操作改变，请刷新后重试。', '409 冲突必须提示刷新重试')
    await eventually(() => applications.length, count => count >= 1, 'first application attempt recorded')
    assert.equal(applications[0].status, 409, 'Server 用 409 拒绝重复绑定')
    assert.equal(applications[0].body.expectedSetRevision, setBefore.revision, '界面必须先读当前集合修订再提交')
    // 冲突码由 Server 明确给出：浏览器响应体可能已被回收，用同参数的直连请求取回确定结果。
    const conflictProbe = await owner.raw(`/resource-presets/${saved.id}/applications`, 'POST', { presetRevision: 1, workerId, requestId: 'e2e-conflict-probe', expectedSetRevision: setBefore.revision })
    assert.equal(conflictProbe.status, 409)
    assert.equal(conflictProbe.data.error.code, 'preset_binding_conflict')
    // 同一意图重试（表单与集合修订都没变）必须复用同一个 requestId，Server 才能识别为同一意图。
    // 只断言状态码与请求体：响应体在重放场景下可能已被浏览器回收，Playwright 读不到。
    await preset.getByRole('button', { name: '应用预设' }).click()
    await eventually(() => applications.length, count => count >= 2, 'retry recorded')
    assert.equal(applications[1].status, 409)
    assert.equal(applications[1].body.requestId, applications[0].body.requestId, '同一意图重试必须复用 requestId')
    assert.equal(applications[1].body.expectedSetRevision, applications[0].body.expectedSetRevision)
    assert.equal(await preset.getByRole('alert').innerText(), '资源状态已被其他操作改变，请刷新后重试。')
    written(step, `409 preset_binding_conflict，requestId ${applications[0].body.requestId}`)

    step = `${name}: 撤销绑定只转入待回收，随后发布技能 v2 并应用预设成功，requestId 重放不重复`
    const bindingRow = page.getByRole('article', { name: `绑定 ${bindingId}` })
    await bindingRow.getByRole('button', { name: '撤销绑定' }).click()
    await eventually(() => api(`/resource-bindings?workerId=${workerId}`), value => value.items.find(item => item.binding.id === bindingId)?.binding.status === 'pending-gc', 'binding transitioned to pending-gc')
    const revoked = (await api(`/resource-bindings?workerId=${workerId}`)).items.find(item => item.binding.id === bindingId)
    assert.equal(revoked.binding.status, 'pending-gc', '撤销是状态迁移，绑定记录仍然存在')
    assert.ok(revoked.binding.id === bindingId)
    await bindingRow.getByText('该绑定已撤销，等待 Worker 回收。').waitFor()
    // 已撤销的绑定行仍占用 (workerId, resourceRevisionId) 唯一约束，因此成功应用预设必须换用同一技能的第二个修订。
    const contentV2 = `# ${skillName}\n\n写路径验收技能内容（第二版）。`
    await publish.getByLabel('SKILL.md 内容').fill(contentV2)
    await publish.getByRole('button', { name: '发布技能修订' }).click()
    await publish.getByRole('status').filter({ hasText: '已发布技能修订 v2' }).waitFor()
    const revisionV2 = await eventually(async () => (await api(`/resources/${skill.id}`)).revisions.find(revision => revision.version === 2), Boolean, 'second skill revision published')
    assert.equal(revisionV2.payload.files[0].blobSha256, sha(contentV2))
    // 载入既有预设、换成 v2 条目、以 expectedRevision 1 保存为新修订（revision 2）。
    await preset.getByRole('article', { name: `预设 ${presetName}` }).getByRole('button', { name: '载入到编辑器' }).click()
    await entries.getByRole('button', { name: '移除' }).click()
    await entries.getByLabel('资源').selectOption({ label: `技能｜${skillName}` })
    await eventually(() => entries.getByLabel('已发布修订').locator('option').count(), count => count > 1, 'entry revision option')
    await entries.getByLabel('已发布修订').selectOption(revisionV2.id)
    await entries.getByLabel('Agent').fill('pi')
    await entries.getByRole('button', { name: '添加条目' }).click()
    await preset.getByRole('button', { name: '保存为新修订' }).click()
    await preset.getByRole('status').filter({ hasText: `预设「${presetName}」已保存为 revision 2` }).waitFor()
    const updatedRevisions = await eventually(async () => (await api('/resource-presets')).items.filter(item => item.id === saved.id).map(item => item.revision).sort((left, right) => left - right), value => value.length === 2 && value[1] === 2, 'preset saved as revision 2 through expectedRevision CAS')
    assert.deepEqual(updatedRevisions, [1, 2], 'Server 逐行保存每个预设修订')
    const latestPreset = (await api('/resource-presets')).items.filter(item => item.id === saved.id).sort((left, right) => right.revision - left.revision)[0]
    assert.deepEqual(latestPreset.entries, [{ resourceId: skill.id, resourceRevisionId: revisionV2.id, agentKey: 'pi', projectId: null, required: true }])
    await preset.getByRole('combobox', { name: '预设' }).selectOption({ label: `${presetName}（revision 2）` })
    await preset.getByRole('button', { name: '应用预设' }).click()
    await preset.getByRole('status').filter({ hasText: `已应用预设「${presetName}」到` }).waitFor()
    await eventually(() => applications.length, count => count >= 3, 'successful application recorded')
    assert.equal(applications[2].status, 201)
    const requestId = applications[2].body.requestId
    const applied = await eventually(async () => (await api(`/resource-preset-applications?workerId=${workerId}`)).items.filter(item => item.application.requestId === requestId), items => items.length === 1, 'one application recorded for the requestId')
    const application = applied[0].application
    assert.equal(application.presetId, saved.id)
    assert.equal(application.presetRevision, 2)
    assert.equal(application.bindingIds.length, 1)
    const bindingCount = (await api(`/resource-bindings?workerId=${workerId}`)).items.length
    // 重放同一 requestId + 同一 expectedSetRevision：Server 必须返回既有 application，不重复建绑定。
    const replay = await owner.raw(`/resource-presets/${saved.id}/applications`, 'POST', { presetRevision: 2, workerId, requestId, expectedSetRevision: applications[2].body.expectedSetRevision })
    assert.equal(replay.status, 201, `重放应返回既有 application：${JSON.stringify(replay.data)}`)
    assert.equal(replay.data.id, application.id)
    assert.deepEqual(replay.data.bindingIds, application.bindingIds)
    assert.equal((await api(`/resource-bindings?workerId=${workerId}`)).items.length, bindingCount, '重放不得新增绑定')
    // 过期 expectedSetRevision 必须被 CAS 拒绝，而不是静默覆盖。
    const staleSet = await owner.raw(`/resource-presets/${saved.id}/applications`, 'POST', { presetRevision: 2, workerId, requestId: 'e2e-stale-set-revision', expectedSetRevision: 0 })
    assert.equal(staleSet.status, 409)
    assert.equal(staleSet.data.error.code, 'resource_set_revision_conflict')
    written(step, `application ${application.id}（revision 2），重放同 id，绑定数 ${bindingCount} 不变`)

    step = `${name}: 发布 Provider 修订（首个走通用修订，后续 expectedVersion CAS）`
    await create.getByLabel('资源类型').selectOption('model-provider')
    await create.getByLabel('名称').fill(providerName)
    await create.getByLabel('HTTPS 端点').fill(`https://api.example.test/${name}/v1`)
    await create.getByLabel('模型 ID').fill(`gpt-${name}-v1`)
    await create.getByLabel('凭据引用').fill(`${name}-credential`)
    await create.getByRole('button', { name: '新建资源' }).click()
    await create.getByRole('status').filter({ hasText: `已创建模型 Provider资源「${providerName}」` }).waitFor()
    const provider = await eventually(async () => (await api('/resources')).items.find(item => item.name === providerName), Boolean, 'provider resource created through the UI')
    const providerPublish = page.getByRole('region', { name: '发布 Provider 修订' })
    await providerPublish.getByLabel('Provider 资源').selectOption({ label: providerName })
    await eventually(() => providerPublish.getByRole('button', { name: '发布 Provider 修订' }).isEnabled(), Boolean, 'provider publish enabled')
    await providerPublish.getByRole('button', { name: '发布 Provider 修订' }).click()
    await providerPublish.getByRole('status').filter({ hasText: '已发布 Provider 修订 v1' }).waitFor()
    await eventually(() => providerPublish.getByLabel('HTTPS 端点').isVisible(), Boolean, 'second provider revision fields')
    await providerPublish.getByLabel('HTTPS 端点').fill(`https://api.example.test/${name}/v2`)
    await providerPublish.getByLabel('模型 ID').fill(`gpt-${name}-v2`)
    await providerPublish.getByLabel('凭据引用').fill(`${name}-credential`)
    await providerPublish.getByRole('button', { name: '发布 Provider 修订' }).click()
    await providerPublish.getByRole('status').filter({ hasText: '已发布 Provider 修订 v2' }).waitFor()
    const providerDetail = await eventually(async () => (await api(`/resources/${provider.id}`)).revisions.length, length => length === 2, 'two provider revisions published')
    assert.ok(providerDetail)
    const providerRevisions = (await api(`/resources/${provider.id}`)).revisions
    assert.deepEqual(providerRevisions.map(revision => revision.version).sort(), [1, 2])
    const current = (await api(`/resources/${provider.id}`)).resource
    assert.equal(current.definition.endpoint, `https://api.example.test/${name}/v2`, 'CAS 发布同时更新非秘密定义')
    assert.equal(current.definition.modelIds[0], `gpt-${name}-v2`)
    const latest = providerRevisions.find(revision => revision.version === 2)
    const stale = await owner.raw(`/resources/${provider.id}/provider-revisions`, 'POST', { expectedVersion: 1, revision: latest })
    assert.equal(stale.status, 409)
    assert.equal(stale.data.error.code, 'provider_version_conflict')
    written(step, `Provider ${provider.id} v1→v2，过期 expectedVersion 得 409 provider_version_conflict`)

    step = `${name}: 写后四态投影没有闪回空态，六类分区仍然齐全`
    assert.ok(await page.evaluate(() => window.__axisMin) > 0, '写操作重新核验期间不得闪回空投影')
    for (const label of ['工作节点', 'Agent', '模型', '技能', '预设', 'Provider']) assert.equal(await page.getByRole('region', { name: label, exact: true }).count(), 1)
    assert.equal(await view.getByRole('article', { name: `技能 ${skillName}` }).locator('[data-axis]').count(), 4)
    assert.equal(await view.getByRole('article', { name: `Provider ${providerName}` }).locator('[data-axis]').count(), 4)
    await shot('administrator-writes')
    written(step, `最小轴数 ${await page.evaluate(() => window.__axisMin)}`)
    await context.close()
  }

  step = 'non-administrator has zero write entry points, zero requests and no Server-side authority'
  const memberContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const memberLogin = await memberContext.request.post(`${origin}/api/auth/login`, { data: { login: 'resource-writer-member', password } })
  assert.equal(memberLogin.status(), 200)
  const denied = await memberContext.request.get(`${origin}/api/resource-inventory`)
  assert.equal(denied.status(), 403, '非管理员读取资源清单必须被拒')
  assert.equal((await denied.json()).error.code, 'admin_required')
  const memberPage = await memberContext.newPage(); activePage = memberPage; memberPage.setDefaultTimeout(20000)
  memberPage.on('pageerror', error => errors.push({ name: 'member', step, message: error.message }))
  let memberRequests = 0
  await memberPage.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname
    if (/^\/api\/(resource-inventory|resources|resource-bindings|resource-presets|resource-blobs)/.test(pathname)) memberRequests += 1
    await route.continue()
  })
  await memberPage.goto(`${origin}/next/resources`)
  const memberView = memberPage.getByRole('region', { name: '资源管理' })
  await memberView.getByRole('alert').waitFor()
  assert.match(await memberView.getByRole('alert').innerText(), /只对实例管理员开放/)
  assert.equal(await memberView.getByRole('button').count(), 0, '非管理员不渲染任何写入入口')
  assert.equal(await memberView.locator('[data-axis]').count(), 0, '非管理员不渲染任何状态轴')
  assert.equal(await memberPage.getByRole('button', { name: /管理动作|新建资源|发布技能修订|发布 Provider 修订|创建绑定|应用预设|删除资源/ }).count(), 0)
  assert.doesNotMatch(await memberPage.locator('body').innerText(), /管理动作/)
  assert.equal(memberRequests, 0, '非管理员页面不得请求任何资源写入或读取接口')
  const memberText = await memberPage.locator('body').innerText()
  assert.equal(memberText.includes('写路径验收节点'), false, '非管理员不得看到节点名')
  // 页面加载会让应用自己调 /api/auth/me 并轮换 CSRF；写入前重新取当前令牌，才能断言「授权拒绝」而不是「CSRF 拒绝」。
  const memberCsrf = (await (await memberContext.request.get(`${origin}/api/auth/me`)).json()).csrfToken
  assert.ok(memberCsrf, '会话必须下发 CSRF 明文')
  const memberWrite = await memberContext.request.post(`${origin}/api/resources`, {
    headers: { 'x-csrf-token': memberCsrf },
    data: { id: 'e2e-member-attempt', kind: 'skill', name: '越权技能', description: '', definition: { entryFile: 'SKILL.md', compatibleAgents: ['pi'], containsExecutableFiles: false }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
  })
  assert.equal(memberWrite.status(), 403, '授权只由 Server 判定：非管理员直连写入接口也被拒')
  assert.equal((await memberWrite.json()).error.code, 'admin_required')
  assert.equal((await api('/resources')).items.some(item => item.name === '越权技能'), false)
  await memberPage.screenshot({ path: join(evidence, 'member-denied.png'), fullPage: true }); screenshots.push(join(evidence, 'member-denied.png'))
  await memberContext.close()
  written(step, '403 admin_required（带 CSRF 的直连写入也被拒）、零写入口、零请求')

  assert.deepEqual(errors, [])
  await writeFile(join(evidence, 'checks.json'), JSON.stringify({ passed: true, checks, screenshots, errors }, null, 2))
  console.log(JSON.stringify({ passed: true, checks, errors, evidence }, null, 2))
} catch (error) {
  if (activePage) { try { await activePage.screenshot({ path: join(evidence, 'failure.png'), fullPage: true }) } catch { /* page may be gone */ } }
  console.error(JSON.stringify({ failed: step, message: error instanceof Error ? error.message : String(error), workerDiagnostics: worker?.readOutput(), applicationLog, checks, errors, evidence }, null, 2))
  process.exitCode = 1
} finally {
  await stopWorker(worker)
  await browser?.close()
  await app.close()
}
