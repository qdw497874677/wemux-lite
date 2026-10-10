import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { launchAcceptanceBrowser } from '../../../tests/acceptance-runtime.mjs'

test('Team coordination browser selects authorized placement, sends once, reopens Task-bound conversation and retains retry identity', async () => {
  const bundle = await build({
    stdin: { contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { TeamCoordination } from './TeamCoordination.tsx';
      const project = { id: 'project-1', teamId: 'team-1', accessRole: 'contributor' };
      const worker = { id: 'worker-1', teamId: 'team-1', name: 'Test Worker', connectionState: 'online', capabilities: [{ agentKey: 'test', displayName: 'Test Agent', mode: 'execution', availability: { status: 'available' }, models: [{ modelId: 'test-model', displayName: 'Test Model' }] }] };
      const workspace = { id: 'workspace-1', projectId: 'project-1', name: 'Test Workspace', deletedAt: null, placements: [{ workerId: 'worker-1', status: 'ready' }] };
      window.attempts = []; window.failOnce = true; window.failRefresh = false; window.refreshCalls = 0; window.completedLists = 0; window.pauseSend = false; window.releaseSend = null;
      window.staleList = false; window.pauseListTeam = null; window.releaseList = null;
      let sessions = [];
      const api = {
        projects: async () => [project], workers: async () => [worker], workspaces: async () => [workspace],
        teamCoordinationSessions: async team => {
          window.refreshCalls++;
          const snapshot = window.staleList ? [] : sessions.filter(item => team === 'team-1');
          if (window.pauseListTeam === team) await new Promise(resolve => { window.releaseList = resolve });
          if (window.failRefresh) throw Error('refresh offline');
          window.completedLists++;
          return snapshot;
        },
        createTeamCoordinationSession: async (team, body) => {
          window.attempts.push({ team, body });
          if (window.pauseSend) await new Promise(resolve => { window.releaseSend = resolve });
          if (window.failOnce) { window.failOnce = false; throw Error('request lost'); }
          const session = { id: 'session-1', taskId: 'coordination:task', projectId: project.id, title: '团队协调', binding: { agent: { agentKey: 'test' } } };
          sessions = [session]; return { session, created: true };
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
      window.switchTeam = team => root.render(<TeamCoordination api={api} teamId={team} />);
      window.switchTeam('team-1');
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
    page.setDefaultTimeout(7000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.getByRole('combobox', { name: '协调执行环境' }).waitFor()
    await page.getByRole('combobox', { name: '协调执行环境' }).selectOption({ index: 1 })
    await page.getByRole('textbox', { name: '协调首条消息' }).fill('Test handoff')
    await page.getByRole('button', { name: '发送并创建会话' }).click()
    await page.waitForFunction(() => window.attempts.length > 0)
    await page.getByRole('alert').waitFor()
    await page.getByRole('button', { name: '重试原首条消息' }).click()
    await page.locator('[data-conversation-session="session-1"]').waitFor()
    const attempts = await page.evaluate(() => window.attempts)
    assert.equal(attempts.length, 2)
    assert.deepEqual(attempts[0], attempts[1], 'uncertain first-send must reuse request and command identity')
    assert.equal(attempts[0].body.workspaceId, 'workspace-1')
    assert.equal(attempts[0].body.workerId, 'worker-1')
    assert.equal(attempts[0].body.agentKey, 'test')
    assert.equal(attempts[0].body.modelId, 'test-model')
    await page.getByRole('button', { name: '关闭会话' }).click()
    await page.getByRole('button', { name: /团队协调（test）/ }).click()
    await page.locator('[data-conversation-session="session-1"]').waitFor()
    await page.evaluate(() => { window.failRefresh = true })
    await page.getByRole('textbox', { name: '协调首条消息' }).fill('New accepted handoff')
    await page.getByRole('button', { name: '发送并创建会话' }).click()
    await page.getByText('refresh offline').waitFor()
    assert.equal(await page.getByRole('button', { name: '重试原首条消息' }).count(), 0, 'refresh failure must not resurrect an accepted first-send')
    await page.evaluate(() => { window.failRefresh = false; window.staleList = true })
    await page.getByRole('textbox', { name: '协调首条消息' }).fill('Accepted but not yet listed')
    await page.getByRole('button', { name: '发送并创建会话' }).click()
    await page.waitForFunction(() => window.completedLists >= 3)
    await page.waitForTimeout(50)
    await page.locator('[data-conversation-session="session-1"]').waitFor()
    assert.equal(await page.getByRole('button', { name: /团队协调（test）/ }).count(), 1, 'successful stale list must retain accepted session')
    await page.getByRole('button', { name: '刷新协调环境与会话' }).click()
    await page.waitForFunction(() => window.completedLists >= 4)
    await page.waitForTimeout(50)
    assert.equal(await page.getByRole('button', { name: /团队协调（test）/ }).count(), 1, 'repeated stale lists cannot remove accepted session')
    await page.evaluate(() => { window.staleList = false; window.pauseListTeam = 'team-1' })
    await page.getByRole('button', { name: '刷新协调环境与会话' }).click()
    await page.waitForFunction(() => !!window.releaseList)
    await page.evaluate(() => window.switchTeam('team-2'))
    await page.getByRole('textbox', { name: '协调首条消息' }).waitFor()
    await page.evaluate(() => window.releaseList())
    await page.waitForTimeout(100)
    assert.equal(await page.getByRole('button', { name: /团队协调（test）/ }).count(), 0, 'delayed old Team LIST cannot replace new Team sessions')
    await page.evaluate(() => { window.pauseListTeam = null; window.pauseSend = true; window.switchTeam('team-1') })
    await page.getByRole('combobox', { name: '协调执行环境' }).selectOption({ index: 1 })
    await page.getByRole('textbox', { name: '协调首条消息' }).fill('In-flight stale handoff')
    await page.getByRole('button', { name: '发送并创建会话' }).click()
    await page.waitForFunction(() => !!window.releaseSend)
    await page.evaluate(() => window.switchTeam('team-2'))
    await page.getByRole('textbox', { name: '协调首条消息' }).waitFor()
    await page.evaluate(() => window.releaseSend())
    await page.waitForTimeout(100)
    assert.equal(await page.getByRole('button', { name: '重试原首条消息' }).count(), 0, 'team change clears pending send')
    assert.equal(await page.locator('[data-conversation-session="session-1"]').count(), 0, 'stale send response cannot select old Team conversation')
    await page.evaluate(() => { window.pauseSend = false; window.switchTeam('team-1') })
    await page.getByRole('combobox', { name: '协调执行环境' }).selectOption({ index: 1 })
    await page.getByRole('textbox', { name: '协调首条消息' }).fill('Fresh team handoff')
    assert.equal(await page.getByRole('button', { name: '发送并创建会话' }).isEnabled(), true, 'team change clears busy state')
    assert.deepEqual(errors, [])
  } finally { await browser?.close(); server.close() }
})
