import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { MessageId, ModelId, RuntimeOperationId, SessionId } from '@wemux/domain'
import { TestRuntimeSessionAdapter } from '../src/agents/test-runtime-session-adapter.js'

const sessionId = 'test-session' as SessionId
const input = (content: string) => ({ operationId: 'test-turn' as RuntimeOperationId, message: { messageId: 'test-message' as MessageId, content }, launchContext: null })
const open = () => new TestRuntimeSessionAdapter(0).openSession({ sessionId, cwd: '/tmp', modelId: 'test' as ModelId, resume: null })

test('TestAgent ordinary prompts retain tools, exact echo and completed outcome', async () => {
  const handle = await (await open()).execute(input('ordinary test'))
  const signals = []
  for await (const signal of handle.signals) signals.push(signal)
  assert.deepEqual(signals.at(-1), { kind: 'finished', outcome: { status: 'completed' } })
  assert.equal(signals.filter(s => s.kind === 'event' && s.event.kind === 'tool.started').length, 1)
  assert.equal(signals.flatMap(s => s.kind === 'event' && s.event.kind === 'assistant.text.delta' ? [s.event.text] : []).join(''), 'Echo: ordinary test')
})

test('TestAgent explicit slow marker pauses before tools and stop interrupts the pause', async () => {
  const handle = await (await open()).execute(input('[test-agent:pause-ms=120000] slow'))
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
