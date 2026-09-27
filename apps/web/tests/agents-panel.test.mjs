import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { countAvailableAgents, groupAgentsByWorker } from '../src/features/agents/model.ts'

const worker = (id, name, capabilities) => ({
  id, name, capabilities, teamId: 'team', ownerId: 'owner', shareScope: 'owner-only', accessRole: 'owner', connectionState: 'online', version: null, platform: null, lastSeenAt: null,
})
const agent = (agentKey, displayName, status, reason, models = []) => ({
  agentKey, displayName, version: null, mode: 'execution', availability: { status, reason }, models,
})

test('agents panel maps capabilities and preserves worker grouping', () => {
  const workers = [
    worker('worker-1', '节点一', [agent('pi', 'Pi', 'available', undefined, [{ modelId: 'openai/gpt-5', displayName: 'GPT-5', source: 'detected' }])]),
    worker('worker-2', '节点二', [agent('claude', 'Claude', 'unavailable', '未安装 Claude CLI')]),
  ]
  const groups = groupAgentsByWorker(workers)
  assert.deepEqual(groups.map(group => [group.workerId, group.workerName, group.agents.map(item => item.agentKey)]), [
    ['worker-1', '节点一', ['pi']],
    ['worker-2', '节点二', ['claude']],
  ])
  assert.equal(groups[0].agents[0].workerId, 'worker-1')
  assert.equal(groups[0].agents[0].models[0].modelId, 'openai/gpt-5')
  assert.equal(countAvailableAgents(workers), 1)
})

test('agents panel exposes model ids and unavailable reasons', async () => {
  const source = await readFile(new URL('../src/features/agents/agents-panel.tsx', import.meta.url), 'utf8')
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
  assert.match(source, /entry\.availability\.reason/)
  assert.match(source, /title=\{available \? '可用' : reason\}/)
  assert.match(source, /font-mono[^\n]*>\{entry\.models\.map/)
  assert.match(source, /<code[^>]*>\{model\.modelId\}<\/code>/)
  assert.match(source, /groupAgentsByWorker\(workers\)/)
  assert.match(app, /id: 'agents'.*icon: Bot.*title: '智能体'.*keepAlive: false/s)
  assert.match(app, /agentKey: entry\.agentKey/)
})
