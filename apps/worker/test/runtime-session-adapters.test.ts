import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { ModelId, SessionId, TurnId } from '@wemux/domain'
import type { RuntimeSignal } from '../src/agents/agent-types.js'
import { ClaudeRuntimeSessionAdapter } from '../src/agents/claude-runtime-session-adapter.js'
import { PiRuntimeSessionAdapter } from '../src/agents/pi-runtime-session-adapter.js'
import { OpenCodeRuntimeSessionAdapter } from '../src/agents/opencode-runtime-session-adapter.js'

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

test('Pi process-scoped model config uses isolated agent directory, explicit key and closes on Session replacement', async () => {
  const source = await executable('pi-provider', `node -e 'const fs=require("node:fs");const rd=require("node:readline").createInterface({input:process.stdin});rd.on("line",()=>{const dir=process.env.PI_CODING_AGENT_DIR;const config=JSON.parse(fs.readFileSync(dir+"/models.json"));process.stdout.write(JSON.stringify({type:"message_update",assistantMessageEvent:{type:"text_delta",delta:JSON.stringify({dir,model:config.providers["openai-compatible"].models[0].id,first:process.env.OPENAI_API_KEY==="model-secret-first",rotated:process.env.OPENAI_API_KEY==="model-secret-rotated",other:process.env.ANTHROPIC_API_KEY??null,auth:fs.existsSync(dir+"/auth.json")})}})+"\\n"+JSON.stringify({type:"agent_settled"})+"\\n");});'`)
  const original = process.env.ANTHROPIC_API_KEY
  process.env.ANTHROPIC_API_KEY = 'must-not-inherit-another-key'
  const definition = { providerKey: 'openai-compatible' as const, endpoint: 'https://example.invalid/v1', modelIds: ['offline-model'], agentKeys: ['pi' as never], credential: { kind: 'worker-credential' as const, credentialRef: 'id', variableNames: ['OPENAI_API_KEY'] } }
  try {
    const adapter = new PiRuntimeSessionAdapter(source)
    const first = await adapter.openSession({ sessionId, cwd: process.cwd(), modelId: 'openai-compatible::offline-model' as ModelId, resume: null, piProvider: { definition, environment: { OPENAI_API_KEY: 'model-secret-first' } } })
    const signals = await collect((await first.execute({ operationId: 'pi-provider-first' as TurnId, message: { content: 'hi' }, launchContext: null })).signals)
    const delta = signals.find(signal => signal.kind === 'event' && signal.event.kind === 'assistant.text.delta')
    assert.equal(delta?.kind, 'event')
    if (delta?.kind !== 'event' || delta.event.kind !== 'assistant.text.delta') throw new Error('No Pi output')
    const values = JSON.parse(delta.event.text)
    assert.equal(values.model, 'offline-model')
    assert.equal(values.first, true)
    assert.equal(values.other, null)
    assert.equal(values.auth, false)
    await assert.rejects(first.command({ name: 'set_model', operationId: 'pi-provider-model-change' as TurnId, arguments: { modelId: 'other::model' } }), /pi_provider_model_locked/)
    assert.match(await readFile(join(values.dir, 'models.json'), 'utf8'), /\$OPENAI_API_KEY/)
    assert.doesNotMatch(await readFile(join(values.dir, 'models.json'), 'utf8'), /model-secret-first/)
    await first.close()
    await assert.rejects(access(values.dir), { code: 'ENOENT' })
    const rotated = await adapter.openSession({ sessionId, cwd: process.cwd(), modelId: 'openai-compatible::offline-model' as ModelId, resume: null, piProvider: { definition, environment: { OPENAI_API_KEY: 'model-secret-rotated' } } })
    try {
      const again = await collect((await rotated.execute({ operationId: 'pi-provider-next' as TurnId, message: { content: 'hi' }, launchContext: null })).signals)
      assert(again.some(signal => signal.kind === 'event' && signal.event.kind === 'assistant.text.delta' && JSON.parse(signal.event.text).rotated === true))
    } finally { await rotated.close() }
  } finally { if (original === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = original }
})

test('Pi process Provider redacts credential echoed in RPC output before it reaches Journal', async () => {
  const source = await executable('pi-provider-echo', `node -e 'const rd=require("node:readline").createInterface({input:process.stdin});rd.on("line",()=>{process.stdout.write(JSON.stringify({type:"message_update",assistantMessageEvent:{type:"text_delta",delta:"echo " + process.env.OPENAI_API_KEY}})+"\\n"+JSON.stringify({type:"agent_settled"})+"\\n")})'`)
  const secret = 'provider-stdout-secret-3981'
  const definition = { providerKey: 'openai-compatible' as const, endpoint: 'https://example.invalid/v1', modelIds: ['offline-model'], agentKeys: ['pi' as never], credential: { kind: 'worker-credential' as const, credentialRef: 'id', variableNames: ['OPENAI_API_KEY'] } }
  const session = await new PiRuntimeSessionAdapter(source).openSession({ sessionId, cwd: process.cwd(), modelId: 'openai-compatible::offline-model' as ModelId, resume: null, piProvider: { definition, environment: { OPENAI_API_KEY: secret } } })
  try {
    const signals = await collect((await session.execute({ operationId: 'pi-provider-echo' as TurnId, message: { content: 'hi' }, launchContext: null })).signals)
    assert.doesNotMatch(JSON.stringify(signals), new RegExp(secret))
    assert.match(JSON.stringify(signals), /\[redacted\]/)
  } finally { await session.close() }
})

test('Pi process Provider blocks credentials split across RPC deltas and native session references', async () => {
  const source = await executable('pi-provider-split', `node -e 'const rd=require("node:readline").createInterface({input:process.stdin});rd.on("line",()=>{const s=process.env.OPENAI_API_KEY;for(const value of [{type:"session",sessionId:"native-"+s},{type:"message_update",assistantMessageEvent:{type:"text_delta",delta:s.slice(0,8)}},{type:"message_update",assistantMessageEvent:{type:"text_delta",delta:s.slice(8)}},{type:"agent_settled"}])process.stdout.write(JSON.stringify(value)+"\\n")})'`)
  const secret = 'provider-split-secret-3912'
  const definition = { providerKey: 'openai-compatible' as const, endpoint: 'https://example.invalid/v1', modelIds: ['offline-model'], agentKeys: ['pi' as never], credential: { kind: 'worker-credential' as const, credentialRef: 'id', variableNames: ['OPENAI_API_KEY'] } }
  const session = await new PiRuntimeSessionAdapter(source).openSession({ sessionId, cwd: process.cwd(), modelId: 'openai-compatible::offline-model' as ModelId, resume: null, piProvider: { definition, environment: { OPENAI_API_KEY: secret } } })
  try {
    const signals = await collect((await session.execute({ operationId: 'pi-provider-split' as TurnId, message: { content: 'hi' }, launchContext: null })).signals)
    assert.deepEqual(signals.map(signal => signal.kind), ['finished'])
    assert.doesNotMatch(JSON.stringify(signals), new RegExp(secret))
  } finally { await session.close() }
})

test('Pi process Provider redacts child stderr containing credential on failure', async () => {
  const source = await executable('pi-provider-crash', 'read _; echo "failed with $OPENAI_API_KEY" >&2; exit 1')
  const secret = 'unique-provider-credential-never-journal-9248'
  const definition = { providerKey: 'openai-compatible' as const, endpoint: 'https://example.invalid/v1', modelIds: ['offline-model'], agentKeys: ['pi' as never], credential: { kind: 'worker-credential' as const, credentialRef: 'id', variableNames: ['OPENAI_API_KEY'] } }
  const session = await new PiRuntimeSessionAdapter(source).openSession({ sessionId, cwd: process.cwd(), modelId: 'openai-compatible::offline-model' as ModelId, resume: null, piProvider: { definition, environment: { OPENAI_API_KEY: secret } } })
  try {
    const signals = await collect((await session.execute({ operationId: 'pi-provider-error' as TurnId, message: { content: 'hi' }, launchContext: null })).signals)
    assert.equal(signals.at(-1)?.kind, 'finished')
    assert.doesNotMatch(JSON.stringify(signals), new RegExp(secret))
    assert.match(JSON.stringify(signals), /\[redacted\]/)
  } finally { await session.close() }
})

test('pi runtime session maps native json events', async () => {
  const cli = await executable('pi', "read _; printf '%s\\n' '{\"type\":\"session\",\"sessionId\":\"native-pi\"}' '{\"type\":\"message_update\",\"assistantMessageEvent\":{\"type\":\"text_delta\",\"delta\":\"hello\"}}' '{\"type\":\"usage\",\"inputTokens\":2,\"outputTokens\":3}' '{\"type\":\"done\"}'")
  const adapter = new PiRuntimeSessionAdapter(cli)
  const session = await adapter.openSession({ sessionId, cwd: process.cwd(), modelId, resume: null })
  const handle = await session.execute({ operationId: 'turn-pi' as TurnId, message: { content: 'hello' } })
  const signals = await collect(handle.signals)
  assert.equal(signals[0]?.kind, 'native-session')
  assert.equal(signals[1]?.kind, 'event')
  if (signals[1]?.kind === 'event') assert.deepEqual(signals[1].event, { kind: 'assistant.text.delta', text: 'hello', streamKind: 'assistant_text' })
  assert.equal(signals[2]?.kind, 'event')
  if (signals[2]?.kind === 'event') assert.deepEqual(signals[2].event, { kind: 'usage.updated', usage: { scope: 'operation', subjectId: 'turn-pi', source: 'runtime', revision: 1, completeness: 'complete', inputTokens: 2, outputTokens: 3, totalTokens: 5 } })
  assert.deepEqual(signals.at(-1), { kind: 'finished', outcome: { status: 'completed' } })
})

test('pi runtime session maps new pi RPC protocol without duplicating assistant text', async () => {
  // Regression: pi ≥0.85 RPC emits streaming `message_update` records plus a final
  // `message_end` carrying the full message, then `turn_end`/`agent_end`/`agent_settled`.
  // Full-text replays must be deduped; only agent_settled completes the prompt.
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

test('pi waits for agent_settled after a tool turn and preserves the final model answer', async () => {
  const cli = await executable('pi', "read _; printf '%s\\n' '{\"type\":\"message_start\"}' '{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"toolCall\",\"name\":\"read\"}]}}' '{\"type\":\"tool_execution_start\",\"toolCallId\":\"call-1\",\"toolName\":\"read\"}' '{\"type\":\"tool_execution_end\",\"toolCallId\":\"call-1\"}' '{\"type\":\"turn_end\",\"message\":{\"role\":\"assistant\"}}' '{\"type\":\"agent_end\",\"messages\":[]}' '{\"type\":\"message_start\"}' '{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"WEMUX_SKILL_INJECTED_73\"}]}}' '{\"type\":\"turn_end\",\"message\":{\"role\":\"assistant\"}}' '{\"type\":\"agent_end\",\"messages\":[]}' '{\"type\":\"agent_settled\"}'")
  const session = await new PiRuntimeSessionAdapter(cli).openSession({ sessionId, cwd: process.cwd(), modelId, resume: null })
  const handle = await session.execute({ operationId: 'turn-tool' as TurnId, message: { content: 'read and answer' } })
  const signals = await collect(handle.signals)
  assert.deepEqual(signals.flatMap(s => s.kind === 'event' && s.event.kind === 'assistant.text.delta' ? [s.event.text] : []), ['WEMUX_SKILL_INJECTED_73'])
  assert.deepEqual(signals.at(-1), { kind: 'finished', outcome: { status: 'completed' } })
})

test('pi runtime session 把自动重试变成用户可见事件，且重试后的正文与回合结果不受影响', async () => {
  // 限额、冷却或瞬时错误时 Pi 会自行退避重试（默认最多 10 次）。重试不发出去，用户在退避期间
  // 只能看到一个沉默的「正在处理」，无法区分“在重试”和“卡死了”。
  const cli = await executable('pi', "read _; printf '%s\\n' '{\"type\":\"agent_end\",\"messages\":[],\"willRetry\":true}' '{\"type\":\"auto_retry_start\",\"attempt\":2,\"maxAttempts\":10,\"delayMs\":8000,\"errorMessage\":\"429 Too Many Requests\"}' '{\"type\":\"auto_retry_end\",\"success\":true,\"attempt\":2}' '{\"type\":\"message_update\",\"assistantMessageEvent\":{\"type\":\"text_delta\",\"delta\":\"重试后拿到正文\"}}' '{\"type\":\"agent_settled\"}'")
  const adapter = new PiRuntimeSessionAdapter(cli)
  const session = await adapter.openSession({ sessionId, cwd: process.cwd(), modelId, resume: null })
  const handle = await session.execute({ operationId: 'turn-retry' as TurnId, message: { content: '你好' } })
  const signals = await collect(handle.signals)
  const notices = signals.flatMap(s => s.kind === 'event' && s.event.kind === 'runtime.notice' ? [s.event] : [])
  assert.deepEqual(notices[0], { kind: 'runtime.notice', level: 'warning', code: 'agent.auto-retry', message: '运行时错误，正在自动重试：429 Too Many Requests', retry: { attempt: 2, maxAttempts: 10, delayMs: 8000 } })
  assert.deepEqual(notices[1], { kind: 'runtime.notice', level: 'info', code: 'agent.retry-recovered', message: '自动重试成功，继续执行', retry: { attempt: 2, maxAttempts: null, delayMs: null } })
  assert.deepEqual(signals.flatMap(s => s.kind === 'event' && s.event.kind === 'assistant.text.delta' ? [s.event.text] : []), ['重试后拿到正文'])
  assert.deepEqual(signals.at(-1), { kind: 'finished', outcome: { status: 'completed' } })
})

test('pi runtime session 重试用尽后报出失败并保留最终错误', async () => {
  const cli = await executable('pi', "read _; printf '%s\\n' '{\"type\":\"agent_end\",\"messages\":[],\"willRetry\":true}' '{\"type\":\"auto_retry_start\",\"attempt\":10,\"maxAttempts\":10,\"delayMs\":60000,\"errorMessage\":\"usage limit reached\"}' '{\"type\":\"auto_retry_end\",\"success\":false,\"attempt\":10,\"finalError\":\"usage limit reached\"}' '{\"type\":\"agent_settled\"}'")
  const adapter = new PiRuntimeSessionAdapter(cli)
  const session = await adapter.openSession({ sessionId, cwd: process.cwd(), modelId, resume: null })
  const handle = await session.execute({ operationId: 'turn-retry-failed' as TurnId, message: { content: '你好' } })
  const signals = await collect(handle.signals)
  const notices = signals.flatMap(s => s.kind === 'event' && s.event.kind === 'runtime.notice' ? [s.event] : [])
  assert.equal(notices[1]?.code, 'agent.retry-failed')
  assert.equal(notices[1]?.level, 'warning')
  assert.equal(notices[1]?.message, '自动重试仍然失败：usage limit reached')
})

test('pi runtime session keeps every assistant message in a multi-message turn', async () => {
  // Regression: a turn can contain several assistant messages (e.g. text, tool
  // call, more text). Each message streams cumulative text and message_end may
  // replay it in full. The dedupe baseline must reset at every message_start,
  // otherwise the second message is diffed against the first message's text and
  // dropped entirely.
  const cli = await executable('pi', "read _; printf '%s\\n' '{\"type\":\"session\",\"sessionId\":\"pi-multi\"}' '{\"type\":\"message_start\"}' '{\"type\":\"message_update\",\"assistantMessageEvent\":{\"type\":\"text_delta\",\"delta\":\"你好\"}}' '{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"你好\"}]}}' '{\"type\":\"message_start\"}' '{\"type\":\"message_update\",\"assistantMessageEvent\":{\"type\":\"text_delta\",\"delta\":\"世界\"}}' '{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"世界\"}]}}' '{\"type\":\"turn_end\",\"message\":{\"role\":\"assistant\"}}' '{\"type\":\"agent_end\"}' '{\"type\":\"agent_settled\"}'")
  const adapter = new PiRuntimeSessionAdapter(cli)
  const session = await adapter.openSession({ sessionId, cwd: process.cwd(), modelId, resume: null })
  const handle = await session.execute({ operationId: 'turn-multi' as TurnId, message: { content: '你好' } })
  const signals = await collect(handle.signals)
  const texts = signals.flatMap(s => s.kind === 'event' && s.event.kind === 'assistant.text.delta' ? [s.event.text] : [])
  assert.deepEqual(texts, ['你好', '世界'])
  const last = signals.at(-1)
  assert.equal(last?.kind, 'finished')
  if (last?.kind === 'finished') assert.deepEqual(last.outcome, { status: 'completed' })
})

test('pi runtime session surfaces a model error instead of an empty success', async () => {
  // P0：模型拒绝或额度用尽时 Pi 把错误放在 assistant 的 stopReason/errorMessage 上，
  // 正文为空。只把这种终止当作 completed 会让界面什么都没显示。
  const cli = await executable('pi', "read _; printf '%s\\n' '{\"type\":\"session\",\"sessionId\":\"pi-error\"}' '{\"type\":\"message_start\"}' '{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[],\"stopReason\":\"error\",\"errorMessage\":\"403 Usage limit reached (AccessDenied.Unpurchased)\"}}' '{\"type\":\"agent_end\",\"messages\":[{\"role\":\"assistant\",\"content\":[],\"stopReason\":\"error\",\"errorMessage\":\"403 Usage limit reached (AccessDenied.Unpurchased)\"}]}' '{\"type\":\"agent_settled\"}'")
  const adapter = new PiRuntimeSessionAdapter(cli)
  const session = await adapter.openSession({ sessionId, cwd: process.cwd(), modelId, resume: null })
  const handle = await session.execute({ operationId: 'turn-pi-error' as TurnId, message: { content: '你好' } })
  const signals = await collect(handle.signals)
  const last = signals.at(-1)
  assert.equal(last?.kind, 'finished')
  if (last?.kind === 'finished') assert.deepEqual(last.outcome, { status: 'failed', failure: { code: 'agent-error', message: '403 Usage limit reached (AccessDenied.Unpurchased)' } })
})

test('pi runtime session fails a completed turn that produced no output', async () => {
  const cli = await executable('pi', "read _; printf '%s\\n' '{\"type\":\"session\",\"sessionId\":\"pi-empty\"}' '{\"type\":\"turn_end\",\"message\":{\"role\":\"assistant\"}}' '{\"type\":\"agent_end\"}' '{\"type\":\"agent_settled\"}'")
  const adapter = new PiRuntimeSessionAdapter(cli)
  const session = await adapter.openSession({ sessionId, cwd: process.cwd(), modelId, resume: null })
  const handle = await session.execute({ operationId: 'turn-pi-empty' as TurnId, message: { content: '你好' } })
  const signals = await collect(handle.signals)
  const last = signals.at(-1)
  assert.equal(last?.kind, 'finished')
  if (last?.kind === 'finished') {
    assert.equal(last.outcome.status, 'failed')
    if (last.outcome.status === 'failed') {
      assert.equal(last.outcome.failure.code, 'agent-error')
      assert.match(last.outcome.failure.message, /没有输出任何内容/)
    }
  }
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

test('pi runtime session escalates SIGTERM to SIGKILL when the child ignores graceful shutdown', async () => {
  const cli = await executable('pi-stuck', "trap '' TERM; read _; while :; do sleep 1; done")
  const adapter = new PiRuntimeSessionAdapter(cli)
  const session = await adapter.openSession({ sessionId, cwd: process.cwd(), modelId, resume: null })
  const handle = await session.execute({ operationId: 'turn-stuck' as TurnId, message: { content: 'hang' } })
  const completion = collect(handle.signals)
  await new Promise(resolve => setTimeout(resolve, 50))
  const closing = session.close()
  await new Promise(resolve => setTimeout(resolve, 50))
  session.kill?.()
  await closing
  const signals = await Promise.race([
    completion,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error('SIGKILL did not terminate Pi child')), 2_000)
      timer.unref()
    }),
  ])
  const last = signals.at(-1)
  assert.equal(last?.kind, 'finished')
  if (last?.kind === 'finished') assert.equal(last.outcome.status, 'failed')
})

test('opencode runtime session maps resume, text, tools and aggregate usage', async () => {
  const cli = await executable('opencode', `
args="$*"
printf '%s\\n' \
'{"type":"step_start","sessionID":"native-opencode","part":{"type":"step-start"}}' \
'{"type":"tool_use","sessionID":"native-opencode","part":{"id":"part-tool","tool":"bash","callID":"call-1","state":{"status":"completed","input":{"command":"echo hello"},"output":"hello\\n","metadata":{"exit":0}}}}' \
'{"type":"step_finish","sessionID":"native-opencode","part":{"reason":"tool-calls","tokens":{"input":10,"output":2,"reasoning":1,"cache":{"read":3,"write":4}},"cost":0.01}}' \
'{"type":"text","sessionID":"native-opencode","part":{"text":"done"}}' \
'{"type":"step_finish","sessionID":"native-opencode","part":{"reason":"stop","tokens":{"input":5,"output":6,"reasoning":0,"cache":{"read":7,"write":0}},"cost":0.02}}'
`)
  const adapter = new OpenCodeRuntimeSessionAdapter(cli)
  const session = await adapter.openSession({ sessionId, cwd: process.cwd(), modelId: 'opencode::big-pickle' as ModelId, resume: 'old-session' as never })
  const handle = await session.execute({ operationId: 'turn-opencode' as TurnId, message: { content: 'hello' }, launchContext: null })
  const signals = await collect(handle.signals)
  assert(signals.some(signal => signal.kind === 'native-session' && signal.nativeSession === 'native-opencode'))
  assert(signals.some(signal => signal.kind === 'event' && signal.event.kind === 'assistant.text.delta' && signal.event.text === 'done'))
  assert(signals.some(signal => signal.kind === 'event' && signal.event.kind === 'tool.started' && signal.event.toolName === 'bash'))
  assert(signals.some(signal => signal.kind === 'event' && signal.event.kind === 'tool.output.delta' && signal.event.text.trim() === 'hello'))
  assert(signals.some(signal => signal.kind === 'event' && signal.event.kind === 'tool.finished' && signal.event.exitCode === 0))
  const usage = signals.find(signal => signal.kind === 'event' && signal.event.kind === 'usage.updated')
  assert.equal(usage?.kind, 'event')
  if (usage?.kind === 'event' && usage.event.kind === 'usage.updated') assert.deepEqual(usage.event.usage, { scope: 'operation', subjectId: 'turn-opencode', source: 'runtime', revision: 1, completeness: 'complete', inputTokens: 15, outputTokens: 9, cacheReadTokens: 10, cacheWriteTokens: 4, costUsd: 0.03, totalTokens: 38, currency: 'USD' })
  assert.deepEqual(signals.at(-1), { kind: 'finished', outcome: { status: 'completed' } })
})

test('opencode runtime session fails closed when no terminal stop step is emitted', async () => {
  const cli = await executable('opencode-truncated', `printf '%s\\n' '{"type":"text","sessionID":"native-opencode","part":{"text":"partial"}}'`)
  const session = await new OpenCodeRuntimeSessionAdapter(cli).openSession({ sessionId, cwd: process.cwd(), modelId: null, resume: null })
  const signals = await collect((await session.execute({ operationId: 'turn-opencode-truncated' as TurnId, message: { content: 'hello' }, launchContext: null })).signals)
  assert.equal(signals.at(-1)?.kind, 'finished')
  if (signals.at(-1)?.kind === 'finished') assert.equal(signals.at(-1)!.outcome.status, 'failed')
})

test('claude runtime session maps native json events', async () => {
  const cli = await executable('claude', "printf '%s\\n' '{\"type\":\"system\",\"session_id\":\"native-claude\"}' '{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"hi\"}]}}' '{\"type\":\"result\",\"usage\":{\"input_tokens\":4,\"output_tokens\":5}}'")
  const adapter = new ClaudeRuntimeSessionAdapter(cli)
  const session = await adapter.openSession({ sessionId, cwd: process.cwd(), modelId, resume: null })
  const handle = await session.execute({ operationId: 'turn-claude' as TurnId, message: { content: 'hello' } })
  const signals = await collect(handle.signals)
  assert.equal(signals[0]?.kind, 'native-session')
  assert.equal(signals[1]?.kind, 'event')
  if (signals[1]?.kind === 'event') assert.deepEqual(signals[1].event, { kind: 'assistant.text.delta', text: 'hi', streamKind: 'assistant_text' })
  assert.equal(signals[2]?.kind, 'event')
  if (signals[2]?.kind === 'event') assert.deepEqual(signals[2].event, { kind: 'usage.updated', usage: { scope: 'operation', subjectId: 'turn-claude', source: 'runtime', revision: 1, completeness: 'complete', inputTokens: 4, outputTokens: 5, totalTokens: 9 } })
  assert.deepEqual(signals.at(-1), { kind: 'finished', outcome: { status: 'completed' } })
})
