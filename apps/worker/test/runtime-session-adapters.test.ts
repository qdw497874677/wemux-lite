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

test('pi runtime session maps new pi RPC protocol without duplicating assistant text', async () => {
  // Regression: pi ≥0.85 RPC emits streaming `message_update` records plus a final
  // `message_end` carrying the full message, then `turn_end`/`agent_end`/`agent_settled`.
  // Full-text replays must be deduped and turn_end must finish the turn (used to hang).
  const cli = await executable('pi', "read _; printf '%s\\n' '{\"type\":\"session\",\"sessionId\":\"pi-new\"}' '{\"type\":\"message_start\"}' '{\"type\":\"message_update\",\"usage\":{\"input\":9,\"output\":1}}' '{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"收到\"}]}}' '{\"type\":\"turn_end\",\"message\":{\"role\":\"assistant\"}}' '{\"type\":\"agent_end\"}' '{\"type\":\"agent_settled\"}'")
  const adapter = new PiRuntimeSessionAdapter(cli)
  const session = await adapter.openSession({ sessionId, cwd: process.cwd(), modelId, resume: null })
  const handle = await session.execute({ operationId: 'turn-new' as TurnId, message: { content: '你好' } })
  const signals = await collect(handle.signals)
  const texts = signals.flatMap(s => s.kind === 'event' && s.event.kind === 'assistant.text.delta' ? [s.event.text] : [])
  assert.deepEqual(texts, ['收到'])
  const last = signals.at(-1)
  assert.equal(last?.kind, 'finished')
  if (last?.kind === 'finished') assert.deepEqual(last.outcome, { status: 'completed' })
})

test('pi runtime session reports failure when child exits without completing stdout', async () => {
  // Regression: Worker used to crash with an unhandled 'error' event (EPIPE) when the
  // Pi child process died mid-session, leaving the UI stuck on "正在处理" with 0/1 nodes online.
  // The fake script reads the prompt then exits non-zero without writing any stdout,
  // reproducing the exact production failure mode.
  const cli = await executable('pi-crash', 'read _; echo "fatal: model unavailable" >&2; exit 1')
  const adapter = new PiRuntimeSessionAdapter(cli)
  const session = await adapter.openSession({ sessionId, cwd: process.cwd(), modelId, resume: null })
  const handle = await session.execute({ operationId: 'turn-crash' as TurnId, message: { content: '你好' } })
  const signals = await collect(handle.signals)
  const last = signals.at(-1)
  assert.equal(last?.kind, 'finished')
  if (last?.kind === 'finished') {
    assert.equal(last.outcome.status, 'failed')
    if (last.outcome.status === 'failed') {
      assert.match(last.outcome.failure.message, /fatal: model unavailable|exited unexpectedly/)
    }
  }
})

test('pi runtime session does not crash on EPIPE when child closes stdin immediately', async () => {
  // Regression: an asynchronous EPIPE on child.stdin with no persistent 'error' listener
  // becomes an unhandled exception that kills the entire Worker process.
  // The fake script closes its read end immediately so the next write triggers EPIPE.
  const cli = await executable('pi-epipe', 'exec <&-; exit 1')
  const adapter = new PiRuntimeSessionAdapter(cli)
  const session = await adapter.openSession({ sessionId, cwd: process.cwd(), modelId, resume: null })
  // execute() may reject (write callback error) or succeed (write buffered before exit);
  // either way the process must NOT crash from an unhandled 'error' event.
  let handle: Awaited<ReturnType<typeof session.execute>> | null = null
  let executeError: unknown = null
  try {
    handle = await session.execute({ operationId: 'turn-epipe' as TurnId, message: { content: '你好' } })
  } catch (error) {
    executeError = error
  }
  if (executeError) {
    assert.ok(executeError instanceof Error)
    return // Clean rejection is acceptable — process survived.
  }
  assert.ok(handle)
  const signals = await collect(handle.signals)
  const last = signals.at(-1)
  assert.equal(last?.kind, 'finished')
  if (last?.kind === 'finished') assert.equal(last.outcome.status, 'failed')
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
