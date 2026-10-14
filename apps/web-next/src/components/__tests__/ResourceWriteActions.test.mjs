import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { launchAcceptanceBrowser } from '../../../tests/acceptance-runtime.mjs'

/**
 * 真实浏览器组件行为：管理员在资源管理面里的写入动作。
 * 假 client 记录每一次调用，用来证明写操作只走既有受审计路径、携带幂等/CAS 字段、
 * 冲突与校验失败都显示具体原因，且写后重新核验投影。
 */
test('resource management write actions use audited APIs, report concrete failures and re-verify the projection', async t => {
  const bundle = await build({
    stdin: { contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { flushSync } from 'react-dom';
      import { ResourceManagement } from './ResourceManagement.tsx';
      import { ApiError } from '@wemux/web-client';
      window.calls = [];
      window.failures = {};
      window.resources = [];
      window.bindings = [];
      window.presets = [];
      window.revisions = [];
      const now = '2026-05-01T12:00:00.000Z';
      const axis = (state, detail, extra = {}) => ({ state, detail, observedAt: null, ...extra });
      const inventory = {
        generatedAt: now,
        workers: [{
          class: 'worker', id: 'w-1', name: '工作节点 01', description: '', workerId: 'w-1', workerName: '工作节点 01',
          connectionState: 'online', agentKey: null, modelId: null, version: '2.0.0',
          configuration: axis('configured', '已注册到集群', { revision: null }),
          authentication: axis('authenticated', '已通过 Worker 凭据认证'),
          distribution: axis('not-distributed', '没有分发给该 Worker 的资源', { setRevision: null }),
          execution: axis('executable', '1 个 Agent 报告可执行'), targets: [],
        }],
        agents: [], models: [], skills: [], presets: [], providers: [],
      };
      function call(method, path, body, result) {
        window.calls.push({ method, path, body });
        const failure = window.failures[method + ' ' + path] ?? window.failures[path];
        if (failure) return Promise.reject(new ApiError(failure.message ?? ('请求失败（HTTP ' + failure.status + '）：' + failure.code), failure.status, undefined, failure.code));
        return Promise.resolve(typeof result === 'function' ? result() : result);
      }
      const client = {
        controlIdentity: { accountId: 'user-1' },
        resourceInventory: () => call('GET', '/api/resource-inventory', undefined, inventory),
        resourceList: () => call('GET', '/api/resources', undefined, () => window.resources.map(resource => ({ ...resource }))),
        resourceBindings: () => call('GET', '/api/resource-bindings', undefined, () => window.bindings.map(item => ({ ...item }))),
        resourcePresets: () => call('GET', '/api/resource-presets', undefined, () => window.presets.map(preset => ({ ...preset }))),
        resourceDetail: id => call('GET', '/api/resources/' + id, undefined, () => ({
          resource: window.resources.find(resource => resource.id === id),
          revisions: window.revisions.filter(revision => revision.resourceId === id),
        })),
        createResource: body => call('POST', '/api/resources', body, () => { const created = { ...body, createdBy: 'user-1' }; window.resources.push(created); return created }),
        updateResource: body => call('PATCH', '/api/resources/' + body.id, body, () => body),
        deleteResource: id => call('DELETE', '/api/resources/' + id, undefined, () => ({ ok: true })),
        putResourceBlob: (sha256, base64Content) => call('PUT', '/api/resource-blobs/' + sha256, { base64Content }, () => ({ sha256, deduplicated: false })),
        publishResourceRevision: (resourceId, revision) => call('POST', '/api/resources/' + resourceId + '/revisions', revision, () => { window.revisions.push(revision); return revision }),
        publishProviderRevision: (resourceId, input) => call('POST', '/api/resources/' + resourceId + '/provider-revisions', input, () => input.revision),
        createResourceBinding: body => call('POST', '/api/resource-bindings', body, () => {
          const binding = { ...body, resourceId: window.revisions.find(revision => revision.id === body.resourceRevisionId)?.resourceId ?? 'r-1', kind: 'skill', status: 'assigned', revision: 1, createdBy: 'user-1', createdAt: now, updatedAt: now };
          window.bindings.push({ binding, reconcile: null });
          return binding;
        }),
        revokeResourceBinding: (id, expectedRevision) => call('PATCH', '/api/resource-bindings/' + id, { status: 'pending-gc', expectedRevision }, () => {
          const item = window.bindings.find(candidate => candidate.binding.id === id);
          item.binding = { ...item.binding, status: 'pending-gc', revision: expectedRevision + 1 };
          return item.binding;
        }),
        resourceSet: workerId => call('GET', '/api/workers/' + workerId + '/resource-set', undefined, () => ({ workerId, revision: 0, fingerprint: 'f', bindings: [], createdAt: now })),
        createResourcePreset: body => call('POST', '/api/resource-presets', body, () => {
          const preset = { ...body, revision: body.expectedRevision + 1, scope: { kind: 'instance' }, autoApply: { enabled: false }, createdBy: 'user-1', createdAt: now };
          window.presets.push(preset);
          return preset;
        }),
        applyResourcePreset: (presetId, input) => call('POST', '/api/resource-presets/' + presetId + '/applications', input, () => ({
          id: 'app-1', presetId, presetRevision: input.presetRevision, workerId: input.workerId, bindingIds: ['b-1'],
          requestId: input.requestId, fingerprint: 'f', createdBy: 'user-1', createdAt: now,
        })),
      };
      const root = createRoot(document.getElementById('root'));
      window.renderResources = administrator => flushSync(() => root.render(<ResourceManagement api={client} administrator={administrator} />));
      window.callsOf = (method, prefix) => window.calls.filter(entry => entry.method === method && entry.path.startsWith(prefix));
    `, resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', format: 'esm', jsx: 'automatic',
  })
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/component.js' ? 'text/javascript' : 'text/html')
    res.end(req.url === '/component.js' ? bundle.outputFiles[0].text : '<div id="root"></div><script type="module" src="/component.js"></script>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let browser
  try {
    browser = await launchAcceptanceBrowser()
    const page = await browser.newPage()
    page.setDefaultTimeout(8000)
    page.on('dialog', dialog => void dialog.accept())
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.waitForFunction(() => typeof window.renderResources === 'function')
    const callsOf = (method, prefix) => page.evaluate(([m, p]) => window.callsOf(m, p), [method, prefix])

    await t.test('a non-administrator has no write entry point and issues no request', async () => {
      await page.evaluate(() => window.renderResources(false))
      const view = page.getByRole('region', { name: '资源管理' })
      await view.getByRole('alert').waitFor()
      assert.equal(await page.getByRole('button', { name: '管理动作' }).count(), 0)
      assert.equal(await page.evaluate(() => window.calls.length), 0)
    })

    await t.test('an administrator expands the actions, which then load only their own reads', async () => {
      await page.evaluate(() => window.renderResources(true))
      await page.waitForFunction(() => window.calls.length === 1)
      await page.getByRole('button', { name: '管理动作' }).click()
      await page.waitForFunction(() => window.calls.length === 4)
      const paths = (await page.evaluate(() => window.calls.map(entry => `${entry.method} ${entry.path}`))).sort()
      assert.deepEqual(paths, ['GET /api/resource-bindings', 'GET /api/resource-inventory', 'GET /api/resource-presets', 'GET /api/resources'])
      for (const name of ['新建资源', '资源清单与修改', '发布技能修订', '发布 Provider 修订', '资源绑定', '资源预设']) {
        assert.equal(await page.getByRole('region', { name, exact: true }).count(), 1, `${name} 区块缺失`)
      }
    })

    await t.test('creating a resource sends timestamps and never claims attribution, then re-verifies the projection', async () => {
      const create = page.getByRole('region', { name: '新建资源' })
      await create.getByLabel('名称').fill('示例技能')
      await create.getByRole('button', { name: '新建资源' }).click()
      await page.waitForFunction(() => window.calls.some(entry => entry.method === 'POST' && entry.path === '/api/resources'))
      const [call] = await callsOf('POST', '/api/resources')
      assert.equal(call.body.kind, 'skill')
      assert.equal(call.body.name, '示例技能')
      assert.deepEqual(call.body.definition, { entryFile: 'SKILL.md', compatibleAgents: ['pi'], containsExecutableFiles: false })
      assert.match(call.body.createdAt, /^\d{4}-\d{2}-\d{2}T/)
      assert.equal(call.body.createdAt, call.body.updatedAt)
      assert.equal(Object.hasOwn(call.body, 'createdBy'), false)
      await create.getByRole('status').filter({ hasText: '已创建技能资源「示例技能」' }).waitFor()
      // 写后重新核验四态投影：清单被再次读取，且列表里出现新资源。
      await page.waitForFunction(() => window.callsOf('GET', '/api/resource-inventory').length === 2)
      await page.getByRole('article', { name: '管理资源 示例技能' }).waitFor()
    })

    await t.test('publishing a skill revision uploads the sha256 blob first and then the immutable revision', async () => {
      const content = '# 示例技能\n\n步骤一。'
      const sha256 = createHash('sha256').update(content, 'utf8').digest('hex')
      const publish = page.getByRole('region', { name: '发布技能修订' })
      await publish.getByLabel('技能资源').selectOption({ label: '示例技能' })
      await page.waitForFunction(() => window.callsOf('GET', '/api/resources/').length > 0)
      await publish.getByLabel('SKILL.md 内容').fill(content)
      await publish.getByRole('button', { name: '发布技能修订' }).click()
      await page.waitForFunction(() => window.callsOf('POST', '/api/resources/').length > 0)
      const [blob] = await callsOf('PUT', '/api/resource-blobs/')
      assert.equal(blob.path, `/api/resource-blobs/${sha256}`)
      assert.equal(Buffer.from(blob.body.base64Content, 'base64').toString('utf8'), content)
      const [revision] = await callsOf('POST', '/api/resources/')
      assert.match(revision.path, /\/revisions$/)
      assert.equal(revision.body.kind, 'skill')
      assert.equal(revision.body.version, 1)
      assert.equal(revision.body.state, 'published')
      assert.equal(revision.body.payload.files[0].path, 'SKILL.md')
      assert.equal(revision.body.payload.files[0].blobSha256, sha256)
      assert.equal(revision.body.contentSha256, revision.body.manifest.sha256)
      await publish.getByRole('status').filter({ hasText: '已发布技能修订 v1' }).waitFor()
    })

    await t.test('a 409 conflict on revoke asks for a refresh and retry instead of failing silently', async () => {
      const binding = page.getByRole('region', { name: '资源绑定' })
      await binding.getByLabel('工作节点').selectOption('w-1')
      await binding.getByLabel('资源').selectOption({ label: '技能｜示例技能' })
      await page.waitForFunction(() => window.callsOf('GET', '/api/resources/').length > 0)
      await binding.getByLabel('已发布修订').selectOption({ index: 1 })
      await binding.getByRole('button', { name: '创建绑定' }).click()
      await page.waitForFunction(() => window.calls.some(entry => entry.method === 'POST' && entry.path === '/api/resource-bindings'))
      const [created] = await callsOf('POST', '/api/resource-bindings')
      assert.equal(created.body.workerId, 'w-1')
      assert.match(created.body.id, /^[0-9a-zA-Z-]+$/)
      await page.getByRole('article', { name: `绑定 ${created.body.id}` }).waitFor()
      await page.evaluate(id => { window.failures[`PATCH /api/resource-bindings/${id}`] = { status: 409, code: 'resource_binding_revision_conflict' } }, created.body.id)
      await page.getByRole('button', { name: '撤销绑定' }).click()
      await binding.getByRole('alert').waitFor()
      assert.equal(await binding.getByRole('alert').innerText(), '资源状态已被其他操作改变，请刷新后重试。')
      await page.evaluate(id => { delete window.failures[`PATCH /api/resource-bindings/${id}`] }, created.body.id)
      await page.getByRole('button', { name: '撤销绑定' }).click()
      await page.waitForFunction(() => window.callsOf('PATCH', '/api/resource-bindings/').length === 2)
      const revokes = await callsOf('PATCH', '/api/resource-bindings/')
      assert.deepEqual(revokes[1].body, { status: 'pending-gc', expectedRevision: 1 })
      // 撤销是状态迁移：列表重新核验后该绑定转为待回收，而不是从列表消失。
      const row = page.getByRole('article', { name: `绑定 ${created.body.id}` })
      await row.getByText('该绑定已撤销，等待 Worker 回收。').waitFor()
      assert.match(await row.innerText(), /状态 pending-gc/)
    })

    await t.test('a 400 validation failure names the concrete reason', async () => {
      await page.evaluate(() => { window.failures['POST /api/resources'] = { status: 400, code: 'invalid_provider_config' } })
      const create = page.getByRole('region', { name: '新建资源' })
      await create.getByLabel('资源类型').selectOption('model-provider')
      await create.getByLabel('名称').fill('示例 Provider')
      await create.getByLabel('HTTPS 端点').fill('https://api.example.com/v1')
      await create.getByLabel('模型 ID').fill('gpt-4o-mini')
      await create.getByLabel('凭据引用').fill('openai-default')
      await create.getByRole('button', { name: '新建资源' }).click()
      await create.getByRole('alert').waitFor()
      assert.match(await create.getByRole('alert').innerText(), /Provider 配置不符合要求/)
      assert.match(await create.getByRole('alert').innerText(), /invalid_provider_config/)
      await page.evaluate(() => { delete window.failures['POST /api/resources'] })
    })

    await t.test('a preset is saved with expectedRevision and applied with a replayed requestId', async () => {
      const preset = page.getByRole('region', { name: '资源预设' })
      const entries = page.getByRole('region', { name: '预设条目' })
      await entries.getByLabel('资源').selectOption({ index: 1 })
      await page.waitForFunction(() => window.callsOf('GET', '/api/resources/').length > 0)
      await entries.getByLabel('已发布修订').selectOption({ index: 1 })
      await entries.getByRole('button', { name: '添加条目' }).click()
      await preset.getByLabel('预设名称').fill('示例预设')
      await preset.getByRole('button', { name: '创建预设' }).click()
      await page.waitForFunction(() => window.callsOf('POST', '/api/resource-presets').length === 1)
      const [saved] = await callsOf('POST', '/api/resource-presets')
      assert.equal(saved.body.name, '示例预设')
      assert.equal(saved.body.expectedRevision, 0)
      assert.equal(saved.body.entries.length, 1)
      assert.equal(saved.body.entries[0].agentKey, null)
      assert.equal(saved.body.entries[0].required, true)
      assert.equal(typeof saved.body.id, 'string')

      await preset.getByRole('combobox', { name: '预设' }).selectOption({ index: 1 })
      await preset.getByLabel('工作节点').selectOption('w-1')
      const applications = `/api/resource-presets/${saved.body.id}/applications`
      await page.evaluate(path => { window.failures[path] = { status: 409, code: 'resource_set_revision_conflict' } }, applications)
      await preset.getByRole('button', { name: '应用预设' }).click()
      await preset.getByRole('alert').waitFor()
      assert.equal(await preset.getByRole('alert').innerText(), '资源状态已被其他操作改变，请刷新后重试。')
      await page.evaluate(path => { delete window.failures[path] }, applications)
      await preset.getByRole('button', { name: '应用预设' }).click()
      await page.waitForFunction(path => window.callsOf('POST', path).length === 2, applications)
      const applied = await callsOf('POST', applications)
      assert.equal(applied[0].body.presetRevision, 1)
      assert.equal(applied[0].body.expectedSetRevision, 0)
      assert.equal(typeof applied[0].body.requestId, 'string')
      // 重放必须复用同一个 requestId：Server 才能识别为同一意图而不重复建绑定。
      assert.equal(applied[1].body.requestId, applied[0].body.requestId)
      await preset.getByRole('status').filter({ hasText: '已应用预设「示例预设」到 工作节点 01' }).waitFor()
    })

    assert.deepEqual(errors, [])
  } finally {
    await browser?.close()
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
