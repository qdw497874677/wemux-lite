import { setTimeout as delay } from 'node:timers/promises'
import type { AgentKey, ModelId, NativeSessionRef, ToolCallId } from '@wemux/domain'
import type { AgentAdapter, AgentSignal, AgentTurnInput } from '../application/ports/agent-adapter.js'

/** No subprocess, credentials or model service; repeatable E2E fixture. */
export class TestAgent implements Extract<AgentAdapter, { mode: 'execution' }> {
  readonly agentKey = 'test' as AgentKey
  readonly mode = 'execution' as const
  constructor(private readonly delayMs = 25) {}
  async detect() {
    return { agentKey: this.agentKey, displayName: 'Deterministic Test Agent', version: '1', mode: this.mode,
      availability: { status: 'available' as const }, models: [{ modelId: 'test' as ModelId, displayName: 'Test', source: 'configured' as const }],
      executablePath: null, diagnostics: [] }
  }
  async startTurn(input: AgentTurnInput) {
    const controller = new AbortController()
    const wait = () => delay(this.delayMs, undefined, { signal: controller.signal })
    async function* signals(): AsyncGenerator<AgentSignal> {
      try {
        yield { kind: 'native-session', nativeSession: input.resume ?? `test:${input.sessionId}` as NativeSessionRef }
        const toolCallId = `${input.turnId}:echo` as ToolCallId
        // Explicit E2E-only prompt marker; ordinary test/test execution stays unchanged.
        const slow = input.message.content.match(/^\[test-agent:pause-ms=(\d+)\]/)
        if (slow) {
          // Keep the real runtime's idle watchdog intact while remaining observably active.
          for (let remaining = Math.min(Number(slow[1]), 120000); remaining > 0; remaining -= 1000) {
            await delay(Math.min(remaining, 1000), undefined, { signal: controller.signal })
            yield { kind: 'native-session', nativeSession: input.resume ?? `test:${input.sessionId}` as NativeSessionRef }
          }
        }
        await wait()
        yield { kind: 'event', event: { kind: 'tool.started', toolCallId, toolName: 'echo', input: { text: input.message.content } } }
        await wait()
        yield { kind: 'event', event: { kind: 'tool.output.delta', toolCallId, text: input.message.content } }
        yield { kind: 'event', event: { kind: 'tool.finished', toolCallId, exitCode: 0 } }
        for (const text of [`Echo: `, ...input.message.content.match(/.{1,8}/gs) ?? []]) {
          await wait()
          yield { kind: 'event', event: { kind: 'assistant.text.delta', text } }
        }
        yield { kind: 'finished', outcome: { status: 'completed' } }
      } catch (error) {
        if (!controller.signal.aborted) throw error
        yield { kind: 'finished', outcome: { status: 'cancelled' } }
      }
    }
    return { signals: signals(), stop: async () => { controller.abort() } }
  }
}
