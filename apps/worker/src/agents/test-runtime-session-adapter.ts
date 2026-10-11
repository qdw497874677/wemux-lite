import { setTimeout as delay } from 'node:timers/promises'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ApprovalId, NativeSessionRef, ToolCallId } from '@wemux/domain'
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
  private active: { readonly operationId: RuntimeOperationInput['operationId']; stop(): void; approval?: { id: ApprovalId; decide(decision: 'approve' | 'deny'): void } } | null = null

  constructor(private readonly open: RuntimeSessionOpenInput, private readonly delayMs: number) {}

  async execute(input: RuntimeOperationInput): Promise<AgentTurnHandle> {
    if (this.active) throw new Error('Test runtime session is busy')
    const controller = new AbortController()
    const current = { operationId: input.operationId, stop: () => controller.abort() }
    this.active = current
    const wait = () => delay(this.delayMs, undefined, { signal: controller.signal })
    const signals = this.signals(input, controller, wait, current)
    return { signals, stop: async () => current.stop() }
  }

  async command(): Promise<void> { throw new Error('Test runtime commands are not supported') }
  async resolveApproval(approvalId: ApprovalId, decision: 'approve' | 'deny'): Promise<void> {
    if (!this.active?.approval || this.active.approval.id !== approvalId) throw new Error('Test runtime approval is not pending')
    const pending = this.active.approval
    this.active.approval = undefined
    pending.decide(decision)
  }

  async close(): Promise<void> {
    this.active?.stop()
    this.active = null
  }

  private async *signals(input: RuntimeOperationInput, controller: AbortController, wait: () => Promise<void>, current: NonNullable<TestRuntimeSession['active']>): AsyncGenerator<AgentSignal> {
    try {
      yield { kind: 'native-session', nativeSession: this.open.resume ?? `test:${this.open.sessionId}` as NativeSessionRef }
      const toolCallId = `${input.operationId}:echo` as ToolCallId
      // Deterministic non-provider failure for owned Worker/browser acceptance.
      // A literal prefix is required; ordinary prompts remain unchanged.
      if (input.message.content.startsWith('[test-agent:fail]')) {
        await wait()
        yield { kind: 'finished', outcome: { status: 'failed', failure: { code: 'agent-error', message: 'Test Agent injected failure' } } }
        return
      }
      // Only the explicit fixture prompt requests a native approval; no provider or subprocess is involved.
      if (input.message.content.startsWith('[test-agent:approval]')) {
        const approvalId = `${input.operationId}:approval` as ApprovalId
        yield { kind: 'event', event: { kind: 'approval.requested', approvalId, action: { tool: 'test.fixture' }, reason: 'Deterministic Test Agent approval' } }
        const decision = await new Promise<'approve' | 'deny'>((resolve, reject) => {
          const abort = () => reject(controller.signal.reason ?? new Error('Test Agent stopped'))
          controller.signal.addEventListener('abort', abort, { once: true })
          current.approval = { id: approvalId, decide: value => { controller.signal.removeEventListener('abort', abort); resolve(value) } }
        })
        // Keep the fixture Turn active while the command journals the accepted
        // native decision; production adapters may finish asynchronously too.
        await wait()
        yield { kind: 'event', event: { kind: 'assistant.text.delta', text: `Native approval: ${decision}`, streamKind: 'assistant_text' } }
        yield { kind: 'finished', outcome: { status: 'completed' } }
        return
      }
      // Delivered-attachment verification fixture: reads the original bytes
      // from the session working directory and echoes their digest, proving
      // the Agent (not just the Server) actually received the upload.
      const readFileFixture = /^\[test-agent:read-file\]\s*(\S+)/.exec(input.message.content)
      if (readFileFixture) {
        const subpath = readFileFixture[1]
        const readToolCallId = `${input.operationId}:read-file` as ToolCallId
        yield { kind: 'event', event: { kind: 'tool.started', toolCallId: readToolCallId, toolName: 'read-file', input: { subpath }, streamKind: 'command_output' } }
        let bytes: Buffer
        try {
          const cwd = resolve(this.open.cwd)
          const candidate = resolve(cwd, subpath)
          if (candidate !== cwd && !candidate.startsWith(cwd + '/')) throw new Error(`read-file fixture path escapes the session directory: ${subpath}`)
          bytes = await readFile(candidate)
        } catch (error) {
          await wait()
          yield { kind: 'event', event: { kind: 'tool.finished', toolCallId: readToolCallId, exitCode: 1 } }
          yield { kind: 'finished', outcome: { status: 'failed', failure: { code: 'agent-error', message: `read-file fixture failed: ${(error as Error).message}` } } }
          return
        }
        const digest = createHash('sha256').update(bytes).digest('hex')
        await wait()
        yield { kind: 'event', event: { kind: 'tool.output.delta', toolCallId: readToolCallId, text: `${subpath} ${bytes.length} bytes`, streamKind: 'command_output' } }
        yield { kind: 'event', event: { kind: 'tool.finished', toolCallId: readToolCallId, exitCode: 0 } }
        await wait()
        yield { kind: 'event', event: { kind: 'assistant.text.delta', text: `Read ${subpath}: sha256=${digest} size=${bytes.length}`, streamKind: 'assistant_text' } }
        yield { kind: 'finished', outcome: { status: 'completed' } }
        return
      }
      const slow = input.message.content.match(/^\[test-agent:pause-ms=(\d+)\]/)
      if (slow) {
        for (let remaining = Math.min(Number(slow[1]), 120000); remaining > 0; remaining -= 1000) {
          await delay(Math.min(remaining, 1000), undefined, { signal: controller.signal })
          yield { kind: 'native-session', nativeSession: this.open.resume ?? `test:${this.open.sessionId}` as NativeSessionRef }
        }
      }
      await wait()
      yield { kind: 'event', event: { kind: 'tool.started', toolCallId, toolName: 'echo', input: { text: input.message.content }, streamKind: 'command_output' } }
      await wait()
      yield { kind: 'event', event: { kind: 'tool.output.delta', toolCallId, text: input.message.content, streamKind: 'command_output' } }
      yield { kind: 'event', event: { kind: 'tool.finished', toolCallId, exitCode: 0 } }
      for (const text of [`Echo: `, ...input.message.content.match(/.{1,8}/gs) ?? []]) {
        await wait()
        yield { kind: 'event', event: { kind: 'assistant.text.delta', text, streamKind: 'assistant_text' } }
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
