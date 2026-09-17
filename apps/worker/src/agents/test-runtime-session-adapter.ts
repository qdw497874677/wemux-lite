import { setTimeout as delay } from 'node:timers/promises'
import type { NativeSessionRef, ToolCallId } from '@wemux/domain'
import type { AgentSignal, AgentTurnHandle } from '../application/ports/agent-adapter.js'
import type { AgentRuntimeSession, RuntimeOperationInput, RuntimeSessionAdapter, RuntimeSessionOpenInput } from '../application/ports/runtime-session.js'

/** No subprocess, credentials or model service; repeatable E2E runtime fixture. */
export class TestRuntimeSessionAdapter implements RuntimeSessionAdapter {
  constructor(private readonly delayMs = 25) {}

  async openSession(input: RuntimeSessionOpenInput): Promise<AgentRuntimeSession> {
    return new TestRuntimeSession(input, this.delayMs)
  }
}

class TestRuntimeSession implements AgentRuntimeSession {
  private active: { readonly operationId: RuntimeOperationInput['operationId']; stop(): void } | null = null

  constructor(private readonly open: RuntimeSessionOpenInput, private readonly delayMs: number) {}

  async execute(input: RuntimeOperationInput): Promise<AgentTurnHandle> {
    if (this.active) throw new Error('Test runtime session is busy')
    const controller = new AbortController()
    const current = { operationId: input.operationId, stop: () => controller.abort() }
    this.active = current
    const wait = () => delay(this.delayMs, undefined, { signal: controller.signal })
    const signals = this.signals(input, controller, wait)
    return { signals, stop: async () => current.stop() }
  }

  async command(): Promise<void> { throw new Error('Test runtime commands are not supported') }
  async resolveApproval(): Promise<void> { throw new Error('Test runtime approvals are not supported') }

  async close(): Promise<void> {
    this.active?.stop()
    this.active = null
  }

  private async *signals(input: RuntimeOperationInput, controller: AbortController, wait: () => Promise<void>): AsyncGenerator<AgentSignal> {
    try {
      yield { kind: 'native-session', nativeSession: this.open.resume ?? `test:${this.open.sessionId}` as NativeSessionRef }
      const toolCallId = `${input.operationId}:echo` as ToolCallId
      const slow = input.message.content.match(/^\[test-agent:pause-ms=(\d+)\]/)
      if (slow) {
        for (let remaining = Math.min(Number(slow[1]), 120000); remaining > 0; remaining -= 1000) {
          await delay(Math.min(remaining, 1000), undefined, { signal: controller.signal })
          yield { kind: 'native-session', nativeSession: this.open.resume ?? `test:${this.open.sessionId}` as NativeSessionRef }
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
    } finally {
      if (this.active?.operationId === input.operationId) this.active = null
    }
  }
}
