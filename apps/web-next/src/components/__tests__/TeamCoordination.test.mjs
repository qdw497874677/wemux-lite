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
      window.attempts = []; window.failOnce = true;
      let sessions = [];
      const api = {
        projects: async () => [project], workers: async () => [worker], workspaces: async () => [workspace],
        teamCoordinationSessions: async () => sessions,
        createTeamCoordinationSession: async (team, body) => {
          window.attempts.push({ team, body });
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
      createRoot(document.getElementById('root')).render(<TeamCoordination api={api} teamId="team-1" />);
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
    assert.deepEqual(errors, [])
  } finally { await browser?.close(); server.close() }
})
