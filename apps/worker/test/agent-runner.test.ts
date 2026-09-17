import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { MemorySessionStore, textContent } from '@wemux/agent-interchange'
import type { AgentKey, MessageId, ModelId, SessionId, TurnId } from '@wemux/domain'
import { WorkerAgentRunner } from '../src/application/agent-runner.js'
import type { AgentRuntimeSession, RuntimeSessionAdapter } from '../src/application/ports/runtime-session.js'
import { SqliteWorkerStore } from '../src/storage/sqlite-store.js'

const agentKey = 'test' as AgentKey
const sessionId = 'session-runner' as SessionId
const operationId = 'turn-runner' as TurnId
const request = (overrides: Record<string, unknown> = {}) => ({
  appName: 'wemux',
  userId: 'local',
  sessionId,
  invocationId: operationId,
  agentKey,
  modelId: 'model' as ModelId,
  cwd: '/tmp/work',
  messageId: 'message-runner' as MessageId,
  message: textContent('user', 'hello'),
  resume: null,
  configurationFingerprint: 'fingerprint',
  ...overrides,
})

async function collect<T>(iterable: AsyncIterable<T>) {
  const result: T[] = []
  for await (const item of iterable) result.push(item)
  return result
}

const detection = { agentKey, displayName: 'Test', available: true, version: null, executablePath: '/test', models: [], commands: [], authorization: { state: 'authorized' as const }, diagnostics: [] }
const executionAgent = { agentKey, mode: 'execution' as const, async detect() { return detection } }

test('runner owns the lease, maps signals, persists non-partial events, and reuses provider session', async () => {
  let opens = 0
  let closes = 0
  let executions = 0
  const runtime: AgentRuntimeSession = {
    async execute(input) {
      executions++
      return {
        signals: (async function* () {
          yield { kind: 'native-session', nativeSession: 'native-1' as never } as const
          yield { kind: 'event', event: { kind: 'assistant.text.delta', text: `reply-${executions}` } } as const
          yield { kind: 'finished', outcome: { status: 'completed' } } as const
        })(),
        async stop() {},
      }
    },
    async close() { closes++ },
  }
  const adapter: RuntimeSessionAdapter = { async openSession() { opens++; return runtime } }
  const store = new MemorySessionStore()
  const runner = new WorkerAgentRunner({
    agents: [executionAgent],
    runtimeAdapters: new Map([[agentKey, adapter]]),
    sessionStore: store,
  })

  const first = await collect(runner.run(request()))
  const second = await collect(runner.run(request({ invocationId: 'turn-2' as TurnId, messageId: 'message-2' as MessageId })))
  assert.equal(opens, 1)
  assert.equal(executions, 2)
  assert.equal(first.some(event => event.partial && event.content?.parts.some(part => 'text' in part && part.text === 'reply-1')), true)
  assert.equal(first.at(-1)?.customMetadata?.wemux?.terminal, 'completed')
  assert.equal(second.at(-1)?.customMetadata?.wemux?.terminal, 'completed')
  const stored = await store.get({ appName: 'wemux', userId: 'local', sessionId })
  assert.equal(stored?.events.some(event => event.partial), false)
  assert.equal(stored?.events.length, 4)
  await runner.close()
  assert.equal(closes, 1)
})

test('SQLite session store persists non-partial runner events across reopen', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wemux-agent-store-'))
  const path = join(home, 'worker.sqlite')
  const adapter: RuntimeSessionAdapter = { async openSession() { return {
    async execute() { return {
      signals: (async function* () {
        yield { kind: 'event', event: { kind: 'assistant.text.delta', text: 'streamed' } } as const
        yield { kind: 'event', event: { kind: 'usage.updated', usage: { inputTokens: 1, outputTokens: 2 } } } as const
        yield { kind: 'finished', outcome: { status: 'completed' } } as const
      })(),
      async stop() {},
    } },
    async close() {},
  } } }
  let store = new SqliteWorkerStore(path)
  let runner = new WorkerAgentRunner({ agents: [executionAgent], runtimeAdapters: new Map([[agentKey, adapter]]), sessionStore: store })
  try {
    await collect(runner.run(request()))
    await runner.close()
    store.close()
    store = new SqliteWorkerStore(path)
    const session = await store.get({ appName: 'wemux', userId: 'local', sessionId })
    assert.equal(session?.events.some(event => event.partial), false)
    assert.equal(session?.events.length, 2)
    assert.equal(session?.events.at(-1)?.customMetadata?.wemux?.terminal, 'completed')
  } finally {
    await runner.close()
    store.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('runner emits exactly one failed terminal event when provider throws', async () => {
  const adapter: RuntimeSessionAdapter = { async openSession() { return {
    async execute() { throw new Error('provider exploded') },
    async close() {},
  } } }
  const runner = new WorkerAgentRunner({
    agents: [executionAgent],
    runtimeAdapters: new Map([[agentKey, adapter]]),
  })
  const events = await collect(runner.run(request()))
  assert.equal(events.length, 1)
  assert.equal(events[0]?.customMetadata?.wemux?.terminal, 'failed')
  assert.equal(events[0]?.customMetadata?.wemux?.error?.message, 'provider exploded')
  await runner.close()
})

test('same-session concurrency is rejected without disturbing the active invocation', async () => {
  let release: (() => void) | undefined
  const adapter: RuntimeSessionAdapter = { async openSession() { return {
    async execute() { return {
      signals: (async function* () {
        await new Promise<void>(resolve => { release = resolve })
        yield { kind: 'finished', outcome: { status: 'completed' } } as const
      })(),
      async stop() { release?.() },
    } },
    async close() {},
  } } }
  const runner = new WorkerAgentRunner({ agents: [executionAgent], runtimeAdapters: new Map([[agentKey, adapter]]) })
  const first = collect(runner.run(request()))
  while (!release) await new Promise(resolve => setImmediate(resolve))
  const concurrent = await collect(runner.run(request({ invocationId: 'turn-concurrent' as TurnId })))
  assert.equal(concurrent.length, 1)
  assert.equal(concurrent[0]?.customMetadata?.wemux?.terminal, 'failed')
  assert.match(concurrent[0]?.customMetadata?.wemux?.error?.message ?? '', /already has an active invocation/)
  release()
  assert.equal((await first).at(-1)?.customMetadata?.wemux?.terminal, 'completed')
  await runner.close()
})

test('session command routes through the retained runtime while approval stays bound to the active invocation', async () => {
  const calls: string[] = []
  let release: (() => void) | undefined
  const adapter: RuntimeSessionAdapter = { async openSession() { return {
    async execute() { return {
      signals: (async function* () { await new Promise<void>(resolve => { release = resolve }); yield { kind: 'finished', outcome: { status: 'completed' } } as const })(),
      async stop() { release?.() },
    } },
    async command(command) { calls.push(`command:${command.operationId}:${command.name}`) },
    async resolveApproval(approvalId, decision) { calls.push(`approval:${approvalId}:${decision}`) },
    async close() {},
  } } }
  const runner = new WorkerAgentRunner({ agents: [executionAgent], runtimeAdapters: new Map([[agentKey, adapter]]) })
  const collecting = collect(runner.run(request()))
  while (!release) await new Promise(resolve => setImmediate(resolve))
  await runner.command({ sessionId, invocationId: 'command-operation' as TurnId, name: 'compact', arguments: {} })
  await assert.rejects(() => runner.resolveApproval({ sessionId, invocationId: 'other' as TurnId, approvalId: 'approval-1' as never, decision: 'approve' }), /not active/)
  await runner.resolveApproval({ sessionId, invocationId: operationId, approvalId: 'approval-1' as never, decision: 'approve' })
  assert.deepEqual(calls, ['command:command-operation:compact', 'approval:approval-1:approve'])
  release()
  await collecting
  await runner.command({ sessionId, invocationId: 'idle-command' as TurnId, name: 'compact', arguments: {} })
  assert.equal(calls.at(-1), 'command:idle-command:compact')
  await runner.close()
})

test('stop is routed only to the matching active invocation', async () => {
  let stopped = 0
  let release: (() => void) | undefined
  const adapter: RuntimeSessionAdapter = { async openSession() { return {
    async execute() { return {
      signals: (async function* () { await new Promise<void>(resolve => release = resolve); yield { kind: 'finished', outcome: { status: 'cancelled' } } as const })(),
      async stop() { stopped++; release?.() },
    } },
    async close() {},
  } } }
  const runner = new WorkerAgentRunner({
    agents: [executionAgent],
    runtimeAdapters: new Map([[agentKey, adapter]]),
  })
  const collecting = collect(runner.run(request()))
  await new Promise(resolve => setImmediate(resolve))
  await runner.stop(sessionId, 'other' as TurnId)
  assert.equal(stopped, 0)
  await runner.stop(sessionId, operationId)
  assert.equal(stopped, 1)
  const events = await collecting
  assert.equal(events.at(-1)?.customMetadata?.wemux?.terminal, 'cancelled')
  await runner.close()
})


test('stop requested while a provider session is opening is delivered after execute attaches', async () => {
  let finishOpen: (() => void) | undefined
  let stopped = 0
  let released = false
  const waiters: Array<() => void> = []
  const adapter: RuntimeSessionAdapter = { async openSession() {
    await new Promise<void>(resolve => finishOpen = resolve)
    return {
      async execute() { return {
        signals: (async function* () {
          if (!released) await new Promise<void>(resolve => waiters.push(resolve))
          yield { kind: 'finished', outcome: { status: 'cancelled' } } as const
        })(),
        async stop() { stopped++; released = true; for (const resolve of waiters.splice(0)) resolve() },
      } },
      async close() {},
    }
  } }
  const runner = new WorkerAgentRunner({
    agents: [executionAgent],
    runtimeAdapters: new Map([[agentKey, adapter]]),
  })
  const collecting = collect(runner.run(request()))
  while (!finishOpen) await new Promise(resolve => setImmediate(resolve))
  await runner.stop(sessionId, operationId)
  finishOpen()
  await new Promise(resolve => setImmediate(resolve))
  const events = await collecting
  assert.equal(stopped >= 1, true)
  assert.equal(events.at(-1)?.customMetadata?.wemux?.terminal, 'cancelled')
  await runner.close()
})
