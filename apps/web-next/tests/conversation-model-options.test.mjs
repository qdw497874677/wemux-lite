import test from 'node:test'
import assert from 'node:assert/strict'
import { conversationModelOptions } from '../src/lib/conversation-model-options.ts'
const session = { binding: { agent: { workerId: 'worker', agentKey: 'pi' }, modelId: 'old' } }
const agent = { agentKey: 'pi', mode: 'execution', modelSwap: true, availability: { status: 'available' }, models: [{ modelId: 'next', displayName: 'Next' }, { modelId: 'openai-compatible::custom', displayName: 'Locked' }] }
const worker = { id: 'worker', teamId: 'team', connectionState: 'online', capabilities: [agent] }
test('model discovery is restricted to exact team Worker Agent and supported selection', () => {
 assert.deepEqual(conversationModelOptions('team', session, [worker]).map(m => m.modelId), ['next'])
 for (const patch of [{ id: 'other' }, { teamId: 'other' }, { connectionState: 'offline' }, { connectionState: 'revoked' }]) assert.deepEqual(conversationModelOptions('team', session, [{ ...worker, ...patch }]), [])
 for (const patch of [{ agentKey: 'other' }, { modelSwap: false }, { mode: 'detect-only' }, { availability: { status: 'authentication-required' } }]) assert.deepEqual(conversationModelOptions('team', session, [{ ...worker, capabilities: [{ ...agent, ...patch }] }]), [])
 assert.deepEqual(conversationModelOptions('team', { binding: { ...session.binding, modelId: 'openai-compatible::current' } }, [worker]), [])
})
