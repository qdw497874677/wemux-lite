import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { launchAcceptanceBrowser } from '../../../tests/acceptance-runtime.mjs'

// Isolated real React component behavior; the real Server path is proven by apps/e2e/canvas-fork-browser.mjs.
test('SessionCanvas projects authorized graph facts, forks at a fixed cursor and clears the cache on revocation', async t => {
  const bundle = await build({
    stdin: { contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { flushSync } from 'react-dom';
      import { SessionCanvas } from './SessionCanvas.tsx';
      window.requests = { graph: [], lineage: [], session: [], workspaces: [], workers: [], fork: [] };
      window.streams = []; window.disposed = 0;
      const pending = (bucket, payload) => new Promise((resolve, reject) => window.requests[bucket].push({ ...payload, resolve, reject }));
      function makeClient() {
        return {
          sessionGraph(projectId, query, signal) { return pending('graph', { projectId, query, signal }); },
          sessionLineage(sessionId, signal) { return pending('lineage', { sessionId, signal }); },
          getSession(sessionId, signal) { return pending('session', { sessionId, signal }); },
          workspaces(projectId, visibility) { return pending('workspaces', { projectId, visibility }); },
          workers() { return pending('workers', {}); },
          forkSession(projectId, body, signal) { return pending('fork', { projectId, body, signal }); }
        };
      }
      const clients = new Map();
      function client(id) { if (!clients.has(id)) clients.set(id, makeClient()); return clients.get(id); }
      const collaboration = (projectId, options) => { window.streams.push({ projectId, options }); return { done: new Promise(() => {}), dispose() { window.disposed++; } }; };
      const projects = { contributor: { id: 'p', teamId: 'team', ownerId: 'owner', name: '项目', shareScope: 'team', accessRole: 'contributor' }, viewer: { id: 'p', teamId: 'team', ownerId: 'owner', name: '项目', shareScope: 'team', accessRole: 'viewer' } };
      const root = createRoot(document.getElementById('root'));
      window.renderCanvas = (id = 'a', role = 'contributor') => flushSync(() => root.render(<SessionCanvas api={client(id)} project={projects[role]} collaboration={collaboration} />));
      window.unmountCanvas = () => flushSync(() => root.render(null));
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
    await page.waitForFunction(() => typeof window.renderCanvas === 'function')

    const summary = (title, branchCount) => ({ title, projectId: 'p', workspaceId: 'w', workerId: 'worker', agentKey: 'agent', modelId: 'model', runtimeState: 'idle', lastActivityAt: null, branchCount })
    const graphPayload = () => ({ revision: 'g1', nodes: [
      { sessionId: 's1', visibility: 'visible', summary: summary('会话 A', 1) },
      { sessionId: 's2', visibility: 'visible', summary: summary('会话 B', 0) },
      { sessionId: 's3', visibility: 'placeholder', summary: null },
    ], edges: [{ key: 'fork:f1', relation: { type: 'fork', forkId: 'f1' }, sourceSessionId: 's1', targetSessionId: 's2' }], hiddenRelationCount: 1 })
    const mount = (id = 'a', role = 'contributor') => page.evaluate(({ id, role }) => window.renderCanvas(id, role), { id, role })
    const count = (bucket) => page.evaluate(bucket => window.requests[bucket].length, bucket)
    const wait = (bucket, wanted) => page.waitForFunction(({ bucket, wanted }) => window.requests[bucket].length >= wanted, { bucket, wanted })
    const resolve = (bucket, index, payload) => page.evaluate(({ bucket, index, payload }) => window.requests[bucket][index].resolve(payload), { bucket, index, payload })
    const fail = (bucket, index, message = '请求失败（HTTP 404）：Session not found') => page.evaluate(({ bucket, index, message }) => window.requests[bucket][index].reject(Object.assign(new Error(message), { status: 404, kind: 'not-found' })), { bucket, index, message })
    const canvas = page.getByRole('region', { name: '会话画布' })
    const streamStatus = canvas.locator('[data-stream-status]')
    const emit = event => page.evaluate(event => window.streams[window.streams.length - 1].options.onEvent(event), event)

    await t.test('renders only the authorized nodes and edges the Server returned', async () => {
      await mount()
      await wait('graph', 1)
      assert.equal(await page.evaluate(() => window.requests.graph[0].projectId), 'p')
      assert.equal(await count('lineage'), 0)
      await resolve('graph', 0, graphPayload())
      await canvas.locator('[data-session-id="s1"]').waitFor()
      assert.equal(await canvas.locator('[data-session-id]').count(), 3)
      assert.equal(await canvas.locator('[data-edge-key="fork:f1"]').count(), 1)
      // 受限节点只说明存在，不给标题、成员或摘要。
      assert.equal(await canvas.locator('[data-session-id="s3"]').innerText(), '受限会话')
      assert.equal(await canvas.locator('[data-session-id="s3"]').getAttribute('data-visibility'), 'placeholder')
      assert.equal(await canvas.locator('[data-graph-revision]').innerText(), '画布版本 g1')
      assert.match(await canvas.innerText(), /已加载 3 个会话（2 个可读，1 个仅知存在）；显示 1 条 Fork 关系/)
      assert.match(await canvas.innerText(), /另有 1 条关系因权限未显示/)
      assert.equal(await canvas.locator('[data-stream-status]').getAttribute('data-stream-status'), 'connecting')
      assert.equal(await page.evaluate(() => window.streams.map(stream => stream.projectId).join(',')), 'p')
      await emit('snapshot')
      await page.waitForFunction(() => document.querySelector('[data-stream-status]').dataset.streamStatus === 'live')
      // 未选中会话时不读取血缘，也不提供任何 Fork 草稿。
      assert.equal(await count('lineage'), 0)
      assert.equal(await canvas.getByRole('form', { name: '从固定游标创建分支' }).count(), 0)
    })

    await t.test('loads lineage and durable cursor for the selected session and forks with a stable request identity', async () => {
      await canvas.locator('[data-session-id="s1"]').click()
      await wait('lineage', 1); await wait('session', 1)
      assert.equal(await page.evaluate(() => window.requests.lineage[0].sessionId), 's1')
      await resolve('session', 0, { id: 's1', freshness: { sessionId: 's1', contiguousSeq: 7, workerLastSeq: 7, status: 'synced' } })
      await resolve('lineage', 0, { sessionId: 's1', ancestors: [], children: [{ forkId: 'f1', sourceSessionId: 's1', sourceEventCursor: 0, targetSessionId: 's2' }], graphRevision: 'g1' })
      await wait('workspaces', 1); await wait('workers', 1)
      assert.equal(await page.evaluate(() => window.requests.workspaces[0].visibility), 'all')
      assert.match(await canvas.locator('[data-lineage]').innerText(), /子分支：1 个/)
      const form = canvas.getByRole('form', { name: '从固定游标创建分支' })
      await form.waitFor()
      // 默认分支点就是当前持久化上限，用户可以往前改，但不能越过它（服务端同样拒绝）。
      assert.equal(await form.getByLabel('分支点事件游标').inputValue(), '7')
      assert.match(await form.innerText(), /此会话当前持久化到游标 7/)
      await resolve('workspaces', 0, [{ id: 'w1', projectId: 'p', name: '工作区', placements: [{ workerId: 'worker1', status: 'ready', failureReason: null, location: null }] }])
      await resolve('workers', 0, [{ id: 'worker1', teamId: 'team', name: 'worker1', connectionState: 'online', capabilities: [{ agentKey: 'agent', displayName: 'Agent', mode: 'execution', availability: { status: 'available' }, models: [{ modelId: 'model', displayName: 'Model' }] }] }])
      await form.getByLabel('目标执行环境').selectOption({ index: 1 })
      await form.getByRole('button', { name: '创建分支' }).click()
      await wait('fork', 1)
      const body = await page.evaluate(() => window.requests.fork[0].body)
      // 固定游标 Fork 显式带 through_cursor：来源游标之后的消息不得进入目标上下文。
      assert.deepEqual({ ...body, requestId: undefined }, { sourceSessionId: 's1', sourceEventCursor: 7, contextPolicy: 'through_cursor', targetWorkspaceId: 'w1', targetWorkerId: 'worker1', targetAgentKey: 'agent', targetModelId: 'model', requestId: undefined })
      assert.ok(body.requestId)
      // 响应丢失后重试必须保留同一身份，避免重复创建目标会话。
      await fail('fork', 0)
      await canvas.getByRole('alert').waitFor()
      await form.getByRole('button', { name: '创建分支' }).click()
      await wait('fork', 2)
      assert.equal(await page.evaluate(() => window.requests.fork[1].body.requestId), body.requestId)
      await resolve('fork', 1, { fork: { forkId: 'f2', sourceSessionId: 's1', sourceEventCursor: 7, targetSessionId: 's4' }, targetSessionId: 's4', graphRevision: 'g2', replayed: false })
      await canvas.getByRole('status').filter({ hasText: '已在固定游标 7 创建分支会话' }).waitFor()
      // Fork 之后重新读取权威图与血缘，而不是本地先建节点。
      await wait('graph', 2)
      assert.equal(await count('fork'), 2)
      await resolve('graph', 1, { ...graphPayload(), revision: 'g2', nodes: [...graphPayload().nodes, { sessionId: 's4', visibility: 'visible', summary: { ...summary('会话 A（分支）', 0), workerId: 'worker1' } }] })
      await canvas.locator('[data-session-id="s4"]').waitFor()
      assert.equal(await canvas.locator('[data-graph-revision]').innerText(), '画布版本 g2')
    })

    await t.test('stops the realtime exit and clears cached content when authorization is gone', async () => {
      await emit('authorization')
      await page.waitForFunction(() => document.querySelector('[data-stream-status]').dataset.streamStatus === 'stopped')
      // 受控客户端缓存主动清空：图、血缘与选择全部丢弃，不保留已下载内容。
      assert.equal(await canvas.locator('[data-session-id]').count(), 0)
      assert.equal(await canvas.locator('[data-lineage]').count(), 0)
      assert.match(await canvas.innerText(), /已清除本地内容/)
      assert.match(await streamStatus.innerText(), /权限已撤销/)
      await canvas.getByRole('button', { name: '重新核验' }).click()
      await wait('graph', 3)
      await fail('graph', 2)
      await canvas.getByRole('alert').waitFor()
      assert.match(await canvas.getByRole('alert').innerText(), /Session not found/)
      assert.equal(await canvas.locator('[data-session-id]').count(), 0)
      assert.equal(await canvas.locator('[data-edge-key]').count(), 0)
    })

    await t.test('replacing the client scope releases the old stream and ignores its late responses', async () => {
      await mount('b')
      await page.waitForFunction(() => window.disposed === 1)
      assert.equal(await page.evaluate(() => window.streams.length), 2)
      await wait('graph', 4)
      assert.equal(await page.evaluate(() => window.requests.graph[2].signal.aborted), true)
      await resolve('graph', 2, graphPayload())
      await resolve('graph', 3, { ...graphPayload(), revision: 'g9', nodes: [graphPayload().nodes[1]] })
      await canvas.locator('[data-session-id="s2"]').waitFor()
      assert.equal(await canvas.locator('[data-graph-revision]').innerText(), '画布版本 g9')
      assert.equal(await canvas.locator('[data-session-id]').count(), 1)
    })

    await t.test('read-only project roles keep the graph readable but never offer a fork draft', async () => {
      await mount('c', 'viewer')
      await wait('graph', 5)
      await resolve('graph', 4, graphPayload())
      await canvas.locator('[data-session-id="s1"]').waitFor()
      await canvas.locator('[data-session-id="s1"]').click()
      await wait('lineage', 1)
      assert.equal(await canvas.getByRole('form', { name: '从固定游标创建分支' }).count(), 0)
      assert.match(await canvas.innerText(), /只读成员不能创建分支/)
      assert.equal(await page.evaluate(() => window.requests.fork.length), 2)
    })

    assert.deepEqual(errors, [])
  } finally {
    await browser?.close()
    await new Promise(resolve => server.close(resolve))
  }
})
