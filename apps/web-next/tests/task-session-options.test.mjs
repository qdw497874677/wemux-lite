import test from 'node:test'
import assert from 'node:assert/strict'
import { taskSessionOptions } from '../src/lib/task-session-options.ts'

const workspace = { id: 'space', projectId: 'project', name: '工作区', deletedAt: null, placements: [{ workerId: 'worker', status: 'ready' }] }
const agent = { agentKey: 'agent', displayName: '执行者', mode: 'execution', availability: { status: 'available' }, models: [{ modelId: 'provider/model', displayName: '模型' }] }
const worker = { id: 'worker', teamId: 'team', name: '节点', connectionState: 'online', capabilities: [agent] }
const options = (spaces = [workspace], workers = [worker]) => taskSessionOptions('project', 'team', spaces, workers)
test('explicit selection includes all four bindings and concrete advertised model, independent of Task assignment', () => {
  const [option] = options()
  assert.deepEqual(JSON.parse(option.key), ['space', 'worker', 'agent', 'provider/model'])
  assert.equal(option.modelId, 'provider/model')
  assert.match(option.label, /工作区 \/ 节点 \/ 执行者 \/ 模型（provider\/model）/)
})
test('only same-project nondeleted ready placements on online same-team workers are eligible', () => {
  for (const change of [{ projectId: 'other' }, { deletedAt: 'now' }, { placements: [] }, { placements: [{ workerId: 'worker', status: 'failed' }] }, { placements: [{ workerId: 'other', status: 'ready' }] }]) assert.deepEqual(options([{ ...workspace, ...change }]), [])
  for (const change of [{ teamId: 'other' }, { connectionState: 'offline' }, { connectionState: 'revoked' }]) assert.deepEqual(options([workspace], [{ ...worker, ...change }]), [])
})
test('unavailable, detect-only, unadvertised and blank models cannot be selected', () => {
  for (const change of [{ mode: 'detect-only' }, { availability: { status: 'authentication-required' } }, { availability: { status: 'unavailable' } }, { models: [] }, { models: [{ modelId: ' ', displayName: 'empty' }] }]) assert.deepEqual(options([workspace], [{ ...worker, capabilities: [{ ...agent, ...change }] }]), [])
  assert.equal(options([workspace], [{ ...worker, capabilities: [{ ...agent, models: [...agent.models, { modelId: 'other', displayName: '另一个' }] }] }]).length, 2)
})
