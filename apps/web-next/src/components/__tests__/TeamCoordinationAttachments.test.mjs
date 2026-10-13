// 组件级浏览器验收：附件上传控件按真实 Agent 能力开启、两阶段状态如实呈现、
// 意外失败保留原意图重试、客户端上限先拒绝；不虚构首条消息。
// Run through scripts/test-with-browser.mjs (needs PLAYWRIGHT_* env).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { launchAcceptanceBrowser } from '../../../tests/acceptance-runtime.mjs'

test('Team coordination attachment upload gates on declared capability and reports the two phases honestly', async () => {
  const bundle = await build({
    stdin: { contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { TeamCoordination } from './TeamCoordination.tsx';
      const project = { id: 'project-1', teamId: 'team-1', accessRole: 'contributor' };
      // 两个 Worker：一个声明 attachments（能力来自 Test Agent 真实上报），一个未声明。
      const capableWorker = { id: 'worker-1', teamId: 'team-1', name: 'Capable Worker', connectionState: 'online', capabilities: [{ agentKey: 'test', displayName: 'Test Agent', mode: 'execution', availability: { status: 'available' }, attachments: true, models: [{ modelId: 'test-model', displayName: 'Test Model' }] }] };
      const plainWorker = { id: 'worker-2', teamId: 'team-1', name: 'Plain Worker', connectionState: 'online', capabilities: [{ agentKey: 'test', displayName: 'Test Agent', mode: 'execution', availability: { status: 'available' }, models: [{ modelId: 'test-model', displayName: 'Test Model' }] }] };
      const workspaceFor = (id, workerId) => ({ id, projectId: project.id, name: id, deletedAt: null, placements: [{ workerId, status: 'ready' }] });
      const workspaces = [workspaceFor('workspace-1', 'worker-1'), workspaceFor('workspace-2', 'worker-2')];
      window.uploads = []; window.views = []; window.failUploadOnce = true; window.sends = [];
      window.deliveryState = 'pending'; window.deliveryDetail = null; window.workerOnline = true;
      let sessions = [];
      const attachmentBase = { id: 'attachment-1', sessionId: 'session-1', taskId: 'coordination:task', workerId: 'worker-1', filename: '笔记.txt', subpath: 'attachments/0123456789ab-笔记.txt', contentType: 'text/plain', size: 0, sha256: '0'.repeat(64), uploadedBy: 'actor', createdAt: '2026-06-01T00:00:00Z' };
      const api = {
        projects: async () => [project], workers: async () => capableWorker.connectionState === 'online' && plainWorker.connectionState === 'online' ? [capableWorker, plainWorker] : [capableWorker, plainWorker].filter(w => w.connectionState === 'online'), workspaces: async () => workspaces,
        teamCoordinationSessions: async () => sessions,
        createTeamCoordinationSession: async (team, body) => { window.sends.push({ team, body }); throw Error('synthetic only: upload must not fabricate a first message'); },
        uploadTeamCoordinationAttachment: async (team, body) => {
          window.uploads.push({ team, requestId: body.requestId, workspaceId: body.workspaceId, workerId: body.workerId, agentKey: body.agentKey, modelId: body.modelId, name: body.file.name, size: body.file.size });
          if (window.failUploadOnce) { window.failUploadOnce = false; throw Error('upload lost'); }
          const session = { id: 'session-1', taskId: 'coordination:task', projectId: project.id, workspaceId: 'workspace-1', title: '团队协调', binding: { agent: { workerId: 'worker-1', agentKey: 'test' }, modelId: body.modelId } };
          sessions = [session];
          return { session, created: true, attachment: { ...attachmentBase, size: body.file.size, upload: { receivedAt: '2026-06-01T00:00:00Z' }, delivery: { state: 'pending', commandId: 'coordination-attachment:1', detail: null, workerConnectionState: window.workerOnline ? 'online' : 'offline' } } };
        },
        coordinationAttachmentView: async (team, attachmentId) => {
          const view = { ...attachmentBase, upload: { receivedAt: '2026-06-01T00:00:00Z' }, delivery: { state: window.deliveryState, commandId: 'coordination-attachment:1', detail: window.deliveryDetail, workerConnectionState: window.workerOnline ? 'online' : 'offline' } };
          window.views.push({ team, attachmentId, state: view.delivery.state });
          return { attachment: view };
        },
        taskSessionScope: { host: location.origin, account: 'actor', teamId: 'team-1' },
        controlIdentity: { accountId: 'actor', signal: new AbortController().signal },
        getSession: async () => { throw Error('synthetic history offline'); },
        sessionHistory: async () => { throw Error('synthetic history offline'); },
        sendMessage: async () => { throw Error('synthetic only'); },
        cancelQueuedMessage: async () => { throw Error('synthetic only'); },
        stopTurn: async () => { throw Error('synthetic only'); },
        resolveApproval: async () => { throw Error('synthetic only'); },
        selectModel: async () => { throw Error('synthetic only'); },
      };
      const root = createRoot(document.getElementById('root'));
      window.render = () => root.render(<TeamCoordination api={api} teamId="team-1" />);
      window.render();
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
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    const fileInput = page.getByRole('button', { name: '上传附件并创建会话' }) && page.locator('input[aria-label="协调附件"]')
    await page.getByRole('combobox', { name: '协调执行环境' }).waitFor()

    // 未选择环境时上传入口不可用。
    assert.equal(await fileInput.isDisabled(), true)

    // 未声明附件能力的 Agent：入口保持关闭并如实说明。
    await page.getByRole('combobox', { name: '协调执行环境' }).selectOption({ index: 2 })
    await page.getByText('所选 Agent 未声明附件读取能力，上传入口未开启。').waitFor()
    assert.equal(await fileInput.isDisabled(), true)
    assert.equal(await page.getByRole('button', { name: '上传附件并创建会话' }).isDisabled(), true)

    // 声明能力的 Agent：入口开启。
    await page.getByRole('combobox', { name: '协调执行环境' }).selectOption({ index: 1 })
    assert.equal(await fileInput.isDisabled(), false)

    // 客户端上限先拒绝：超限文件不出网。
    await fileInput.setInputFiles({ name: 'oversize.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(1024 * 1024 + 1, 7) })
    await page.getByRole('button', { name: '上传附件并创建会话' }).click()
    await page.getByText('附件超过 1 MiB 上限，请压缩后再试。').waitFor()
    assert.equal((await page.evaluate(() => window.uploads)).length, 0, 'oversize file must not reach the server')

    // 合法文件：首次上传结果未知 → 只能按原意图重试。
    await fileInput.setInputFiles({ name: '笔记.txt', mimeType: 'text/plain', buffer: Buffer.from('附件原始字节 hello 附件\n') })
    await page.getByRole('button', { name: '上传附件并创建会话' }).click()
    await page.getByText('upload lost').waitFor()
    await page.getByText('上次上传结果未知；只能按原附件重试，不能修改文件或切换会话。').waitFor()
    assert.equal(await page.getByRole('combobox', { name: '协调执行环境' }).isDisabled(), true)
    assert.equal(await fileInput.isDisabled(), true, 'pending retry locks the file input')
    await page.getByRole('button', { name: '重试原附件上传' }).click()
    await page.waitForFunction(() => window.uploads.length >= 2)

    // 成功后呈现两阶段状态，不虚构首条消息。
    const uploads = await page.evaluate(() => window.uploads)
    assert.equal(uploads.length, 2)
    assert.equal(uploads[0].requestId, uploads[1].requestId, 'uncertain upload must reuse request identity')
    assert.equal(uploads[0].workspaceId, 'workspace-1')
    assert.equal(uploads[0].workerId, 'worker-1')
    assert.equal(uploads[0].name, '笔记.txt')
    assert.equal(uploads[0].size, Buffer.byteLength('附件原始字节 hello 附件\n'))
    assert.equal((await page.evaluate(() => window.sends)).length, 0, 'upload alone must not fabricate a first message')
    await page.getByText('附件两阶段：Server 已收件「笔记.txt」').waitFor()
    await page.locator('[data-attachment-state="pending"]').waitFor()
    await page.getByText('待投递').waitFor()
    await page.getByText(/工作区内路径 attachments\/0123456789ab-笔记\.txt/).waitFor()
    await page.locator('[data-conversation-session="session-1"]').waitFor()

    // 阶段二轮询：Worker 离线时如实提示，仍在待投递期间持续跟踪。
    await page.evaluate(() => { window.workerOnline = false })
    await page.waitForFunction(() => window.views.length > 0)
    await page.getByText('Worker 当前离线，恢复后自动续签投递；账号或权限失效时会改为失败并显示原因').waitFor()

    // 撤销场景：待投递期间撤权，视图翻转为失败并展示原因，不伪装完成。
    await page.evaluate(() => { window.deliveryState = 'failed'; window.deliveryDetail = '工作节点已撤销授权，附件无法投递' })
    await page.locator('[data-attachment-state="failed"]').waitFor()
    await page.getByText(/失败（工作节点已撤销授权，附件无法投递）/) .waitFor()

    // 失败后的用户路径：明确引导重建（不重放旧意图），并提供一键新请求重传同一文件。
    await page.locator('[data-attachment-guidance="failed"]').waitFor()
    await page.getByText(/请用新请求重新上传/).waitFor()
    const retryUpload = page.getByRole('button', { name: '原文件重新上传（新请求）' })
    assert.equal(await retryUpload.isDisabled(), false)
    await page.evaluate(() => { window.deliveryState = 'pending'; window.deliveryDetail = null })
    await retryUpload.click()
    await page.waitForFunction(() => window.uploads.length >= 3)
    const rebuild = (await page.evaluate(() => window.uploads))[2]
    assert.notEqual(rebuild.requestId, (await page.evaluate(() => window.uploads))[1].requestId, '重建必须用新请求，不重放失败意图')
    assert.equal(rebuild.name, '笔记.txt', '一键重建复用原文件，免重新选文件')
    assert.equal(rebuild.size, Buffer.byteLength('附件原始字节 hello 附件\n'))
    assert.equal(rebuild.workspaceId, 'workspace-1')
    await page.locator('[data-attachment-state="pending"]').waitFor()

    // 再次上传：新一轮两阶段跟踪，恢复后翻转为已投递。
    await page.evaluate(() => { window.workerOnline = true; window.deliveryState = 'pending'; window.deliveryDetail = null })
    await fileInput.setInputFiles({ name: '第二次.txt', mimeType: 'text/plain', buffer: Buffer.from('second attachment bytes') })
    await page.getByRole('button', { name: '上传附件并创建会话' }).click()
    await page.locator('[data-attachment-state="pending"]').waitFor()
    await page.evaluate(() => { window.deliveryState = 'delivered' })
    await page.locator('[data-attachment-state="delivered"]').waitFor()
    await page.getByText('已投递').waitFor()
    // 终态已投递后不再呈现失败引导与重传入口。
    assert.equal(await page.locator('[data-attachment-guidance="failed"]').count(), 0)
    assert.equal(await retryUpload.count(), 0)
    assert.deepEqual(errors, [])
  } finally { await browser?.close(); server.close() }
})
