import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { MessageId, ModelId, SessionId, TurnId } from '@wemux/domain'
import { TestAgent } from '../src/agents/test-agent.js'

const input = (content: string) => ({ sessionId: 'test-session' as SessionId, turnId: 'test-turn' as TurnId, cwd: '/tmp', modelId: 'test' as ModelId, message: { messageId: 'test-message' as MessageId, content }, resume: null, launchContext: null })

test('TestAgent ordinary prompts retain tools, exact echo and completed outcome', async () => {
  const handle = await new TestAgent(0).startTurn(input('ordinary test'))
  const signals = []
  for await (const signal of handle.signals) signals.push(signal)
  assert.deepEqual(signals.at(-1), { kind: 'finished', outcome: { status: 'completed' } })
  assert.equal(signals.filter(s => s.kind === 'event' && s.event.kind === 'tool.started').length, 1)
  assert.equal(signals.flatMap(s => s.kind === 'event' && s.event.kind === 'assistant.text.delta' ? [s.event.text] : []).join(''), 'Echo: ordinary test')
})

test('TestAgent explicit slow marker pauses before tools and stop interrupts the pause', async () => {
  const handle = await new TestAgent(0).startTurn(input('[test-agent:pause-ms=120000] slow'))
  const iterator = handle.signals[Symbol.asyncIterator]()
  assert.equal((await iterator.next()).value.kind, 'native-session')
  let settled = false
  const next = iterator.next().then(value => { settled = true; return value })
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(settled, false)
  await handle.stop()
  assert.deepEqual((await next).value, { kind: 'finished', outcome: { status: 'cancelled' } })
  assert.equal((await iterator.next()).done, true)
})
