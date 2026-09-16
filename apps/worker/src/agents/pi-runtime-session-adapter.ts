import { spawn } from 'node:child_process'
import type { ApprovalId } from '@wemux/domain'
import type { AgentRuntimeSession, RuntimeCommand, RuntimeOperationInput, RuntimeSessionAdapter, RuntimeSessionOpenInput } from '../application/ports/runtime-session.js'
import type { AgentSignal, AgentTurnHandle } from '../application/ports/agent-adapter.js'
import { parseJsonLines } from './json-lines.js'
import { mapRuntimeRecord } from './runtime-event-mapper.js'

async function writeLine(child: ReturnType<typeof spawn>, value: Record<string, unknown>) {
  const stdin = child.stdin
  if (!stdin || stdin.destroyed || !child.pid) throw new Error('Pi runtime input unavailable')
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => { cleanup(); reject(error) }
    const cleanup = () => stdin.off('error', onError)
    stdin.once('error', onError)
    stdin.write(`${JSON.stringify(value)}\n`, error => { cleanup(); error ? reject(error) : resolve() })
  })
}

export class PiRuntimeSessionAdapter implements RuntimeSessionAdapter {
  constructor(private readonly executable: string) {}
  async openSession(input: RuntimeSessionOpenInput): Promise<AgentRuntimeSession> { return new PiRuntimeSession(this.executable, input) }
}

class PiRuntimeSession implements AgentRuntimeSession {
  private child: ReturnType<typeof spawn> | null = null
  private activeOperation: RuntimeOperationInput['operationId'] | null = null
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
    await writeLine(child, { type, id: command.operationId, ...command.arguments })
  }

  async resolveApproval(approvalId: ApprovalId, decision: 'approve' | 'deny'): Promise<void> {
    const child = await this.ensureChild()
    await writeLine(child, { type: 'approval_response', id: approvalId, approved: decision === 'approve' })
  }

  async close(): Promise<void> { if (this.child && !this.child.killed) this.child.kill('SIGTERM'); this.child = null }

  private async ensureChild() {
    if (this.child && !this.child.killed) return this.child
    const args = ['--mode', 'rpc']
    if (this.input.modelId) args.push('--model', this.input.modelId)
    if (this.input.resume) args.push('--session', this.input.resume)
    this.child = spawn(this.executable, args, { cwd: this.input.cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    if (!this.child.stdin || !this.child.stdout || !this.child.stderr) throw new Error('Pi runtime streams unavailable')
    this.child.stderr.resume()
    return this.child
  }

  private async interrupt(operationId: RuntimeOperationInput['operationId']) {
    if (this.activeOperation === operationId && this.child && !this.child.killed) await writeLine(this.child, { type: 'abort', id: operationId })
  }

  private async *signals(operationId: RuntimeOperationInput['operationId'], child: ReturnType<typeof spawn>): AsyncIterable<AgentSignal> {
    if (!child.stdout) throw new Error('Pi runtime output unavailable')
    try {
      for await (const record of parseJsonLines(child.stdout)) {
        if (typeof record.sessionId === 'string') yield { kind: 'native-session', nativeSession: record.sessionId as never }
        const mapped = mapRuntimeRecord('pi', operationId, record)
        for (const signal of mapped) {
          yield signal
          if (signal.kind === 'finished') return
        }
      }
      yield { kind: 'finished', outcome: { status: 'failed', failure: { code: 'agent-error', message: 'Pi RPC stream closed before completion' } } }
    } catch (error) {
      yield { kind: 'finished', outcome: { status: 'failed', failure: { code: 'agent-error', message: error instanceof Error ? error.message : 'Pi runtime failed' } } }
    } finally { if (this.activeOperation === operationId) this.activeOperation = null }
  }
}
