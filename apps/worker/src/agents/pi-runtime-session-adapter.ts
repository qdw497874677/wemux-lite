import { spawn } from 'node:child_process'
import type { ApprovalId } from '@wemux/domain'
import type { AgentRuntimeSession, RuntimeCommand, RuntimeOperationInput, RuntimeSessionAdapter, RuntimeSessionOpenInput } from '../application/ports/runtime-session.js'
import type { AgentSignal, AgentTurnHandle } from '../application/ports/agent-adapter.js'
import { parseJsonLines } from './json-lines.js'
import { mapRuntimeRecord } from './runtime-event-mapper.js'
import { splitModelId } from '../domain/model-id.js'

/** Pi CLI expects `provider/model`, while the platform modelId convention is `provider::model`. */
function piModelArgument(modelId: string): string {
  const parsed = splitModelId(modelId as import('@wemux/domain').ModelId)
  return parsed ? `${parsed.provider}/${parsed.id}` : modelId
}

/** Bounded stderr tail kept for diagnostics when the child dies unexpectedly. */
const MAX_STDERR_BYTES = 8192

/**
 * Writes one JSON line to the child's stdin.
 *
 * The persistent `'error'` listener installed in {@link PiRuntimeSession.ensureChild}
 * prevents unhandled stream errors from crashing the Worker process. This function
 * only needs to surface the write-callback error (if any) to the caller so that the
 * awaiting operation rejects with a meaningful reason instead of hanging.
 */
async function writeLine(child: ReturnType<typeof spawn>, value: Record<string, unknown>) {
  const stdin = child.stdin
  if (!stdin || stdin.destroyed || !child.pid) throw new Error('Pi runtime input unavailable')
  return new Promise<void>((resolve, reject) => {
    stdin.write(`${JSON.stringify(value)}\n`, error => error ? reject(error) : resolve())
  })
}

export class PiRuntimeSessionAdapter implements RuntimeSessionAdapter {
  constructor(private readonly executable: string) {}
  async openSession(input: RuntimeSessionOpenInput): Promise<AgentRuntimeSession> { return new PiRuntimeSession(this.executable, input) }
}

class PiRuntimeSession implements AgentRuntimeSession {
  private child: ReturnType<typeof spawn> | null = null
  private activeOperation: RuntimeOperationInput['operationId'] | null = null
  /** Most recent failure reason captured from stdin/child error or exit events. */
  private childFailure: { code: string; message: string } | null = null
  /** Rolling tail of the child's stderr, capped at {@link MAX_STDERR_BYTES}. */
  private stderrTail = ''
  /** Set once the child process has exited; prevents reuse of a dead child. */
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null
  /** Resolves when the current child's stdio streams and process have fully closed. */
  private childClosed: Promise<void> = Promise.resolve()

  constructor(private readonly executable: string, private readonly input: RuntimeSessionOpenInput) {}

  async execute(request: RuntimeOperationInput): Promise<AgentTurnHandle> {
    if (this.activeOperation) throw new Error('Pi runtime session is busy')
    const child = await this.ensureChild()
    this.activeOperation = request.operationId
    await writeLine(child, { type: 'prompt', id: request.operationId, message: request.message.content })
    return { signals: this.signals(request.operationId, child), stop: async () => this.interrupt(request.operationId) }
  }

  async command(command: RuntimeCommand): Promise<void> {
    const child = await this.ensureChild()
    const type = command.name === 'interrupt' ? 'abort' : command.name
    if (command.name === 'set_model') {
      const selected = typeof command.arguments.modelId === 'string' ? splitModelId(command.arguments.modelId as import('@wemux/domain').ModelId) : null
      if (!selected) throw new Error('Pi set_model requires a provider-qualified modelId')
      await writeLine(child, { type, id: command.operationId, provider: selected.provider, modelId: selected.id })
      return
    }
    await writeLine(child, { type, id: command.operationId, ...command.arguments })
  }

  async resolveApproval(approvalId: ApprovalId, decision: 'approve' | 'deny'): Promise<void> {
    const child = await this.ensureChild()
    await writeLine(child, { type: 'approval_response', id: approvalId, approved: decision === 'approve' })
  }

  async close(): Promise<void> {
    const child = this.child
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    const forceTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGKILL') } catch { /* already exited */ }
      }
    }, 3000)
    forceTimer.unref()
    try { await this.childClosed }
    finally { clearTimeout(forceTimer) }
  }

  /** 同步强杀：即使已经发送过 SIGTERM，也必须能升级为 SIGKILL。 */
  kill(): void {
    const child = this.child
    if (child && child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL') } catch { /* already exited */ }
    }
  }

  /**
   * Returns a live child process, spawning a fresh one when the previous child has
   * exited or was never started.
   *
   * A persistent `'error'` listener is attached to `child.stdin` for the child's
   * entire lifetime. Without it, an asynchronous EPIPE (child dies while a write is
   * buffered) becomes an unhandled `'error'` event and crashes the whole Worker
   * process — the root cause of sessions stuck in "正在处理" with 0/1 nodes online.
   */
  private async ensureChild() {
    if (this.child && !this.child.killed && !this.exitInfo) return this.child

    // Reset per-child diagnostic state before spawning.
    this.childFailure = null
    this.stderrTail = ''
    this.exitInfo = null

    const args = ['--mode', 'rpc']
    if (this.input.modelId) args.push('--model', piModelArgument(this.input.modelId))
    if (this.input.resume) args.push('--session', this.input.resume)
    const child = spawn(this.executable, args, { cwd: this.input.cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    if (!child.stdin || !child.stdout || !child.stderr) throw new Error('Pi runtime streams unavailable')

    // Persistent listeners — never removed while the child lives.
    child.stdin.on('error', error => {
      if (!this.childFailure) this.childFailure = { code: 'stdin-error', message: error.message }
    })
    child.on('error', error => {
      if (!this.childFailure) this.childFailure = { code: 'spawn-error', message: error.message }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-MAX_STDERR_BYTES)
    })
    // 'close' fires after all stdio streams end AND the process exits, guaranteeing
    // that childFailure/exitInfo are populated before any awaiting code proceeds.
    this.childClosed = new Promise<void>(resolve => {
      child.once('close', (code, signal) => {
        if (this.child === child) this.child = null
        this.exitInfo = { code, signal }
        if (!this.childFailure) {
          const detail = [
            code !== null ? `code ${code}` : null,
            signal ? `signal ${signal}` : null,
          ].filter(Boolean).join(', ')
          const stderr = this.stderrTail.trim()
          this.childFailure = {
            code: 'child-exited',
            message: `Pi runtime exited unexpectedly${detail ? ` (${detail})` : ''}${stderr ? `: ${stderr}` : ''}`,
          }
        }
        resolve()
      })
    })

    this.child = child
    return child
  }

  private async interrupt(operationId: RuntimeOperationInput['operationId']) {
    if (this.activeOperation !== operationId) return
    if (!this.child || this.child.killed || this.exitInfo) return
    await writeLine(this.child, { type: 'abort', id: operationId })
  }

  private async *signals(operationId: RuntimeOperationInput['operationId'], child: ReturnType<typeof spawn>): AsyncIterable<AgentSignal> {
    if (!child.stdout) throw new Error('Pi runtime output unavailable')
    let emittedText = ''
    let sawToolActivity = false
    const dedupeText = (signal: AgentSignal): AgentSignal | null => {
      if (signal.kind !== 'event' || signal.event.kind !== 'assistant.text.delta') return signal
      const text = signal.event.text
      // message_end carries the full message; earlier message_update deltas may
      // already have streamed it (or a cumulative prefix). Emit only the unseen suffix.
      const suffix = text.startsWith(emittedText) ? text.slice(emittedText.length) : null
      emittedText += suffix ?? ''
      return suffix ? { ...signal, event: { ...signal.event, text: suffix } } : null
    }
    try {
      for await (const record of parseJsonLines(child.stdout)) {
        if (typeof record.sessionId === 'string') yield { kind: 'native-session', nativeSession: record.sessionId as never }
        // Each assistant message streams its own cumulative text and message_end
        // may replay it in full. A new message_start opens a fresh dedupe
        // baseline; otherwise a multi-message turn would mis-diff the second
        // message against the first message's text and drop it entirely.
        if (record.type === 'message_start') emittedText = ''
        const mapped = mapRuntimeRecord('pi', operationId, record)
        for (const signal of mapped) {
          if (signal.kind === 'event' && signal.event.kind.startsWith('tool.')) sawToolActivity = true
          const deduped = dedupeText(signal)
          if (!deduped) continue
          // Pi 在模型拒绝、额度用尽或凭据失效时会结束回合但不产生任何正文；把它当成完成会让界面
          // 空白（历史 P0：发送消息一直没有响应）。宁可显式失败，也不要假成功。
          if (deduped.kind === 'finished' && deduped.outcome.status === 'completed' && !sawToolActivity && !emittedText.trim()) {
            yield {
              kind: 'finished',
              outcome: {
                status: 'failed',
                failure: {
                  code: 'agent-error',
                  message: `Pi 结束回合但没有输出任何内容，模型可能拒绝请求、额度已用尽或凭据失效${this.childFailure ? `（${this.childFailure.message}）` : ''}`,
                },
              },
            }
            return
          }
          yield deduped
          if (signal.kind === 'finished') return
        }
      }
      // stdout closed without a terminal record — wait for the child to fully close
      // so that childFailure captures the exit code and stderr tail, then surface it.
      await this.childClosed
      const failure = this.childFailure
      yield {
        kind: 'finished',
        outcome: {
          status: 'failed',
          failure: {
            code: 'agent-error',
            message: failure?.message ?? 'Pi RPC stream closed before completion',
          },
        },
      }
    } catch (error) {
      yield { kind: 'finished', outcome: { status: 'failed', failure: { code: 'agent-error', message: error instanceof Error ? error.message : 'Pi runtime failed' } } }
    } finally { if (this.activeOperation === operationId) this.activeOperation = null }
  }
}
