import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { ModelId, SessionId, TurnId } from '@wemux/domain'
import type { RuntimeSignal } from '../src/agents/agent-types.js'
import { ClaudeRuntimeSessionAdapter } from '../src/agents/claude-runtime-session-adapter.js'
import { PiRuntimeSessionAdapter } from '../src/agents/pi-runtime-session-adapter.js'

async function collect(signals: AsyncIterable<RuntimeSignal>) {
  const result: RuntimeSignal[] = []
  for await (const signal of signals) result.push(signal)
  return result
}

async function executable(name: string, body: string) {
  const directory = await mkdtemp(join(tmpdir(), 'wemux-runtime-adapter-'))
  const path = join(directory, name)
  await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return path
}

const sessionId = 'session-adapter' as SessionId
const modelId = 'model-adapter' as ModelId

test('pi runtime session maps native json events', async () => {
  const cli = await executable('pi', "read _; printf '%s\\n' '{\"type\":\"session\",\"sessionId\":\"native-pi\"}' '{\"type\":\"message_update\",\"assistantMessageEvent\":{\"type\":\"text_delta\",\"delta\":\"hello\"}}' '{\"type\":\"usage\",\"inputTokens\":2,\"outputTokens\":3}' '{\"type\":\"done\"}'")
  const adapter = new PiRuntimeSessionAdapter(cli)
  const session = await adapter.openSession({ sessionId, cwd: process.cwd(), modelId, resume: null })
  const handle = await session.execute({ operationId: 'turn-pi' as TurnId, message: { content: 'hello' } })
  const signals = await collect(handle.signals)
  assert.equal(signals[0]?.kind, 'native-session')
  assert.equal(signals[1]?.kind, 'event')
  if (signals[1]?.kind === 'event') assert.deepEqual(signals[1].event, { kind: 'assistant.text.delta', text: 'hello' })
  assert.equal(signals[2]?.kind, 'event')
  if (signals[2]?.kind === 'event') assert.deepEqual(signals[2].event, { kind: 'usage.updated', usage: { scope: 'operation', subjectId: 'turn-pi', source: 'runtime', revision: 1, completeness: 'complete', inputTokens: 2, outputTokens: 3, totalTokens: 5 } })
  assert.deepEqual(signals.at(-1), { kind: 'finished', outcome: { status: 'completed' } })
})

test('claude runtime session maps native json events', async () => {
  const cli = await executable('claude', "printf '%s\\n' '{\"type\":\"system\",\"session_id\":\"native-claude\"}' '{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"hi\"}]}}' '{\"type\":\"result\",\"usage\":{\"input_tokens\":4,\"output_tokens\":5}}'")
  const adapter = new ClaudeRuntimeSessionAdapter(cli)
  const session = await adapter.openSession({ sessionId, cwd: process.cwd(), modelId, resume: null })
  const handle = await session.execute({ operationId: 'turn-claude' as TurnId, message: { content: 'hello' } })
  const signals = await collect(handle.signals)
  assert.equal(signals[0]?.kind, 'native-session')
  assert.equal(signals[1]?.kind, 'event')
  if (signals[1]?.kind === 'event') assert.deepEqual(signals[1].event, { kind: 'assistant.text.delta', text: 'hi' })
  assert.equal(signals[2]?.kind, 'event')
  if (signals[2]?.kind === 'event') assert.deepEqual(signals[2].event, { kind: 'usage.updated', usage: { scope: 'operation', subjectId: 'turn-claude', source: 'runtime', revision: 1, completeness: 'complete', inputTokens: 4, outputTokens: 5, totalTokens: 9 } })
  assert.deepEqual(signals.at(-1), { kind: 'finished', outcome: { status: 'completed' } })
})
