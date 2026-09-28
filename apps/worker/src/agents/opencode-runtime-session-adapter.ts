import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import type { ApprovalId, NativeSessionRef, RuntimeOperationId, ToolCallId } from '@wemux/domain'
import type { AgentSignal, AgentTurnHandle } from '../application/ports/agent-adapter.js'
import type { AgentRuntimeSession, RuntimeCommand, RuntimeOperationInput, RuntimeSessionAdapter, RuntimeSessionOpenInput } from '../application/ports/runtime-session.js'
import { splitModelId } from '../domain/model-id.js'

const STDERR_LIMIT = 64 * 1024
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0

export class OpenCodeRuntimeSessionAdapter implements RuntimeSessionAdapter {
  constructor(private readonly executable = process.env.WEMUX_OPENCODE_COMMAND ?? 'opencode') {}
  async openSession(input: RuntimeSessionOpenInput): Promise<AgentRuntimeSession> {
    return new OpenCodeRuntimeSession(this.executable, input)
  }
}

type OpenCodeChild = ChildProcessByStdio<null, Readable, Readable>

class OpenCodeRuntimeSession implements AgentRuntimeSession {
  private active: { operationId: RuntimeOperationId; child: OpenCodeChild; stop: () => Promise<void> } | null = null
  private nativeSession: NativeSessionRef | null

  constructor(private readonly executable: string, private readonly input: RuntimeSessionOpenInput) {
    this.nativeSession = input.resume
  }

  async execute(request: RuntimeOperationInput): Promise<AgentTurnHandle> {
    if (this.active) throw new Error('OpenCode runtime session is busy')
    const args = ['run', '--format', 'json']
    if (this.nativeSession) args.push('--session', this.nativeSession)
    if (this.input.modelId) {
      const selected = splitModelId(this.input.modelId)
      if (!selected) throw new Error(`OpenCode model ${this.input.modelId} is ambiguous; refresh Agent capabilities and select provider-qualified model`)
      args.push('--model', `${selected.provider}/${selected.id}`)
    }
    args.push(request.message.content)
    const child = spawn(this.executable, args, { cwd: this.input.cwd, env: { ...process.env, ...request.launchContext?.environment }, stdio: ['ignore', 'pipe', 'pipe'] })
    const queue = new SignalQueue()
    let stopped = false
    let terminal = false
    let stderr = Buffer.alloc(0)
    let pending = ''
    const toolStates = new Map<ToolCallId, string>()
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }
    let usageSeen = false
    const runtime = this

    const settled = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>(resolve => {
      let done = false
      const finish = (value: { code: number | null; signal: NodeJS.Signals | null; error?: Error }) => { if (!done) { done = true; resolve(value) } }
      child.once('error', error => finish({ code: null, signal: null, error }))
      child.once('close', (code, signal) => finish({ code, signal }))
    })
    child.stderr.on('data', chunk => { stderr = appendTail(stderr, Buffer.from(chunk), STDERR_LIMIT) })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => { pending += chunk; const lines = pending.split('\n'); pending = lines.pop()!; for (const line of lines) parseLine(line) })
    child.stdout.on('end', () => { if (pending.trim()) parseLine(pending) })

    const stop = async () => {
      if (!stopped && child.exitCode === null && child.signalCode === null) {
        stopped = true
        child.kill('SIGTERM')
        const force = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        }, 1_000)
        force.unref()
        await settled
        clearTimeout(force)
        return
      }
      await settled
    }
    this.active = { operationId: request.operationId, child, stop }
    void settled.then(exit => {
      if (usageSeen) queue.push({ kind: 'event', event: { kind: 'usage.updated', usage: {
        scope: 'operation', subjectId: request.operationId, source: 'runtime', revision: 1, completeness: 'complete',
        ...usage, totalTokens: usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens, currency: 'USD',
      } } })
      if (stopped) queue.end({ kind: 'finished', outcome: { status: 'cancelled' } })
      else if (exit.error) queue.end(failed('agent-unavailable', exit.error.message))
      else if (exit.code !== 0) queue.end(failed('agent-error', `OpenCode exited ${describeExit(exit)}${stderr.length ? `: ${stderr.toString('utf8').trim()}` : ''}`))
      else if (!terminal) queue.end(failed('agent-error', 'OpenCode exited without a terminal step'))
      else queue.end({ kind: 'finished', outcome: { status: 'completed' } })
      if (this.active?.operationId === request.operationId) this.active = null
    })

    async function* signals(): AsyncGenerator<AgentSignal> { try { yield* queue } finally { if (!queue.isDone) await stop() } }
    return { signals: signals(), stop }

    function parseLine(line: string) {
      if (!line.trim()) return
      let event: OpenCodeEvent
      try { event = JSON.parse(line) as OpenCodeEvent } catch { return }
      if (event.sessionID && event.sessionID !== runtime.nativeSession) {
        runtime.nativeSession = event.sessionID as NativeSessionRef
        queue.push({ kind: 'native-session', nativeSession: runtime.nativeSession })
      }
      const part = event.part
      if (event.type === 'text' && part?.text) queue.push({ kind: 'event', event: { kind: 'assistant.text.delta', text: part.text, streamKind: 'assistant_text' } })
      else if (event.type === 'tool_use' && part) {
        const id = (part.callID ?? part.id ?? `${request.operationId}-tool`) as ToolCallId
        const state = part.state?.status ?? 'completed'
        if (!toolStates.has(id)) queue.push({ kind: 'event', event: { kind: 'tool.started', toolCallId: id, toolName: part.tool ?? 'tool', input: part.state?.input ?? null, streamKind: 'command_output' } })
        if (state === 'running' && typeof part.state?.output === 'string') {
          const before = toolStates.get(id) ?? ''
          const delta = part.state.output.startsWith(before) ? part.state.output.slice(before.length) : part.state.output
          if (delta) queue.push({ kind: 'event', event: { kind: 'tool.output.delta', toolCallId: id, text: delta, streamKind: 'command_output' } })
        }
        if (state === 'completed' || state === 'error') {
          const output = typeof part.state?.output === 'string' ? part.state.output : part.state?.output == null ? '' : JSON.stringify(part.state.output)
          const before = toolStates.get(id) ?? ''
          const delta = output.startsWith(before) ? output.slice(before.length) : output
          if (delta) queue.push({ kind: 'event', event: { kind: 'tool.output.delta', toolCallId: id, text: delta, streamKind: 'command_output' } })
          queue.push({ kind: 'event', event: { kind: 'tool.finished', toolCallId: id, exitCode: state === 'error' ? 1 : number(part.state?.metadata?.exit) } })
        }
        toolStates.set(id, typeof part.state?.output === 'string' ? part.state.output : '')
      } else if (event.type === 'step_finish' && part) {
        terminal ||= part.reason === 'stop'
        if (part.tokens) {
          usageSeen = true
          usage.inputTokens += number(part.tokens.input)
          usage.outputTokens += number(part.tokens.output) + number(part.tokens.reasoning)
          usage.cacheReadTokens += number(part.tokens.cache?.read)
          usage.cacheWriteTokens += number(part.tokens.cache?.write)
          usage.costUsd += number(part.cost)
        }
      }
    }
  }

  async command(command: RuntimeCommand): Promise<void> {
    if (command.name !== 'interrupt') throw new Error(`OpenCode runtime command is unsupported: ${command.name}`)
    if (this.active?.operationId === command.operationId) await this.active.stop()
  }
  async resolveApproval(_approvalId: ApprovalId, _decision: 'approve' | 'deny'): Promise<void> {
    throw new Error('OpenCode CLI JSON mode does not expose interactive approval responses')
  }
  async close(): Promise<void> { await this.active?.stop() }
  kill(): void { const child = this.active?.child; if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }
}

interface OpenCodeEvent {
  type?: string
  sessionID?: string
  part?: {
    id?: string
    text?: string
    tool?: string
    callID?: string
    reason?: string
    state?: { status?: string; input?: unknown; output?: unknown; metadata?: { exit?: number } }
    tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
    cost?: number
  }
}

class SignalQueue implements AsyncIterable<AgentSignal> {
  private values: AgentSignal[] = []; private waiters: Array<(result: IteratorResult<AgentSignal>) => void> = []; private done = false
  get isDone() { return this.done }
  push(value: AgentSignal) { if (this.done) return; const waiter = this.waiters.shift(); if (waiter) waiter({ value, done: false }); else this.values.push(value) }
  end(final: AgentSignal) { if (this.done) return; this.push(final); this.done = true; while (this.waiters.length) { const waiter = this.waiters.shift()!; const value = this.values.shift(); waiter(value ? { value, done: false } : { value: undefined, done: true }) } }
  [Symbol.asyncIterator](): AsyncIterator<AgentSignal> { return { next: () => this.values.length ? Promise.resolve({ value: this.values.shift()!, done: false }) : this.done ? Promise.resolve({ value: undefined, done: true }) : new Promise(resolve => this.waiters.push(resolve)) } }
}
function failed(code: 'agent-error' | 'agent-unavailable', message: string): AgentSignal { return { kind: 'finished', outcome: { status: 'failed', failure: { code, message } } } }
function appendTail(current: Buffer, chunk: Buffer, limit: number) { const joined = Buffer.concat([current, chunk]); return joined.length <= limit ? joined : joined.subarray(joined.length - limit) }
function describeExit(exit: { code: number | null; signal: NodeJS.Signals | null }) { return exit.signal ? `by ${exit.signal}` : `with code ${exit.code}` }
