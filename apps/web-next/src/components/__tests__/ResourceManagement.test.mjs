import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { launchAcceptanceBrowser } from '../../../tests/acceptance-runtime.mjs'

// 独立真实浏览器组件行为：四态分离展示与无权限不请求。不是全应用验收。
test('resource management renders four independent axes and never fetches without administrator rights', async t => {
  const bundle = await build({
    stdin: { contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { flushSync } from 'react-dom';
      import { ResourceManagement } from './ResourceManagement.tsx';
      window.requests = [];
      function client(id) {
        return { resourceInventory(signal) { return new Promise((resolve, reject) => window.requests.push({ id, signal, resolve, reject })); } };
      }
      const clients = new Map();
      const api = id => { if (!clients.has(id)) clients.set(id, client(id)); return clients.get(id); };
      const root = createRoot(document.getElementById('root'));
      window.renderResources = (id = 'a', administrator = true) => flushSync(() => root.render(<ResourceManagement api={api(id)} administrator={administrator} />));
      window.unmount = () => flushSync(() => root.render(<p>已卸载</p>));
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
    page.setDefaultTimeout(5000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.waitForFunction(() => typeof window.renderResources === 'function')

    const axis = (name, state, detail, observedAt, extra = {}) => ({ state, detail, observedAt, ...extra })
    const inventory = {
      generatedAt: '2026-05-01T12:00:00.000Z',
      workers: [{
        class: 'worker', id: 'w-1', name: '工作节点 01', description: 'linux｜Worker 2.0.0', workerId: 'w-1', workerName: '工作节点 01',
        connectionState: 'online', agentKey: null, modelId: null, version: '2.0.0',
        configuration: axis('configuration', 'configured', '已注册到集群', null, { revision: null }),
        authentication: axis('authentication', 'authenticated', '已通过 Worker 凭据认证', null),
        distribution: axis('distribution', 'not-distributed', '没有分发给该 Worker 的资源', null, { setRevision: null }),
        execution: axis('execution', 'executable', '1 个 Agent 报告可执行', '2026-05-01T11:00:00.000Z'),
        targets: [],
      }],
      agents: [{
        class: 'agent', id: 'w-1:pi', name: 'Pi', description: 'Pi', workerId: 'w-1', workerName: '工作节点 01',
        connectionState: 'online', agentKey: 'pi', modelId: null, version: null,
        configuration: axis('configuration', 'unconfigured', '集群未分发托管安装，本机也没有选择路径', null, { revision: null }),
        authentication: axis('authentication', 'unknown', 'Worker 未上报认证探测结果', null),
        distribution: axis('distribution', 'not-distributed', '集群未向该 Worker 分发托管安装', null, { setRevision: null }),
        execution: axis('execution', 'unavailable', '可用性探测通过，但没有版本探测结果，不能声称可执行', null),
        targets: [],
      }],
      models: [], skills: [], presets: [], providers: [],
    }

    await t.test('a non-administrator sees an explicit limitation and issues no request at all', async () => {
      await page.evaluate(() => window.renderResources('a', false))
      const view = page.getByRole('region', { name: '资源管理' })
      await view.getByRole('alert').waitFor()
      assert.match(await view.getByRole('alert').innerText(), /只对实例管理员开放/)
      assert.equal(await page.evaluate(() => window.requests.length), 0)
      assert.equal(await view.locator('dl').count(), 0)
      assert.equal(await view.getByRole('button').count(), 0)
      assert.match(await view.innerText(), /不能修改管理面配置/)
    })

    await t.test('an administrator sees every axis separately with its own evidence time', async () => {
      await page.evaluate(() => window.renderResources('a', true))
      await page.waitForFunction(() => window.requests.length === 1)
      await page.evaluate(inventory => window.requests[0].resolve(inventory), inventory)
      const view = page.getByRole('region', { name: '资源管理' })
      for (const name of ['工作节点', 'Agent', '模型', '技能', '预设', 'Provider']) {
        const section = page.getByRole('region', { name, exact: true })
        assert.ok(await section.count() === 1, `${name} 分区缺失`)
      }
      const worker = view.getByRole('article', { name: '工作节点 工作节点 01' })
      assert.equal(await worker.locator('[data-axis="configuration"] dd').innerText(), '已配置｜无已发布修订｜已注册到集群｜无探测证据')
      assert.equal(await worker.locator('[data-axis="authentication"] dd').innerText(), '已认证｜已通过 Worker 凭据认证｜无探测证据')
      assert.equal(await worker.locator('[data-axis="distribution"] dd').innerText(), '未分发｜无期望态版本｜没有分发给该 Worker 的资源｜无探测证据')
      assert.match(await worker.locator('[data-axis="execution"] dd').innerText(), /^可执行｜1 个 Agent 报告可执行｜探测于 /)
      const pi = view.getByRole('article', { name: 'Agent Pi' })
      assert.equal(await pi.getByText('版本：无版本探测结果', { exact: true }).count(), 1)
      assert.equal(await pi.locator('[data-axis="execution"] dd').innerText(), '不可执行｜可用性探测通过，但没有版本探测结果，不能声称可执行｜无探测证据')
      assert.equal(await pi.locator('[data-axis="authentication"] dd').innerText(), '认证未知｜Worker 未上报认证探测结果｜无探测证据')
    })

    await t.test('refresh re-reads the projection and unmount aborts the in-flight request', async () => {
      await page.getByRole('button', { name: '刷新资源清单' }).click()
      await page.waitForFunction(() => window.requests.length === 2)
      assert.equal(await page.evaluate(() => window.requests[1].signal.aborted), false)
      await page.evaluate(() => window.unmount())
      assert.equal(await page.evaluate(() => window.requests[1].signal.aborted), true)
    })

    await t.test('a stale account request never publishes into the new account view', async () => {
      await page.evaluate(() => window.renderResources('b', true))
      await page.waitForFunction(() => window.requests.length === 3)
      assert.equal(await page.evaluate(() => window.requests[2].id), 'b')
      await page.evaluate(inventory => window.requests[2].resolve(inventory), inventory)
      const view = page.getByRole('region', { name: '资源管理' })
      await view.getByRole('article', { name: '工作节点 工作节点 01' }).waitFor()
      await page.evaluate(() => window.renderResources('c', false))
      await page.getByRole('region', { name: '资源管理' }).getByRole('alert').waitFor()
      assert.equal(await page.getByText('工作节点 01', { exact: true }).count(), 0)
    })

    assert.deepEqual(errors, [])
  } finally {
    await browser?.close()
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
