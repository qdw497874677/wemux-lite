import { spawn } from 'node:child_process'
import type { ApprovalId } from '@wemux/domain'
import type { AgentRuntimeSession, RuntimeCommand, RuntimeOperationInput, RuntimeSessionAdapter, RuntimeSessionOpenInput } from '../application/ports/runtime-session.js'
import type { AgentSignal, AgentTurnHandle } from '../application/ports/agent-adapter.js'
import { parseJsonLines } from './json-lines.js'
import { mapRuntimeRecord } from './runtime-event-mapper.js'

export class ClaudeRuntimeSessionAdapter implements RuntimeSessionAdapter {
  constructor(private readonly executable: string) {}
  async openSession(input: RuntimeSessionOpenInput): Promise<AgentRuntimeSession> {
    return new ClaudeRuntimeSession(this.executable, input)
  }
}

class ClaudeRuntimeSession implements AgentRuntimeSession {
  private active: { operationId: RuntimeOperationInput['operationId']; child: ReturnType<typeof spawn> } | null = null
  private resume: string | null
  constructor(private readonly executable: string, private readonly input: RuntimeSessionOpenInput) { this.resume = input.resume }

  async execute(request: RuntimeOperationInput): Promise<AgentTurnHandle> {
    if (this.active) throw new Error('Claude runtime session is busy')
    const child = spawn(this.executable, this.args(request.message.content), { cwd: this.input.cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    const completion = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    this.active = { operationId: request.operationId, child }
    const signals = this.signals(request.operationId, child, completion)
    return { signals, stop: async () => { if (!child.killed) child.kill('SIGTERM') } }
  }

  async command(command: RuntimeCommand): Promise<void> {
    if (command.name === 'interrupt') {
      if (this.active?.operationId === command.operationId && !this.active.child.killed) this.active.child.kill('SIGTERM')
      return
    }
    throw new Error(`Claude runtime command is not supported: ${command.name}`)
  }

  async resolveApproval(_approvalId: ApprovalId, _decision: 'approve' | 'deny'): Promise<void> {
    throw new Error('Claude runtime approvals are not supported by this adapter')
  }

  async close(): Promise<void> { if (this.active && !this.active.child.killed) this.active.child.kill('SIGTERM') }

  private args(message: string) {
    const args = ['-p', '--output-format', 'stream-json', '--verbose']
    if (this.input.modelId) args.push('--model', this.input.modelId)
    if (this.resume) args.push('--resume', this.resume)
    args.push(message)
    return args
  }

  private async *signals(operationId: RuntimeOperationInput['operationId'], child: ReturnType<typeof spawn>, completion: Promise<number | null>): AsyncIterable<AgentSignal> {
    const stderr: Buffer[] = []
    if (!child.stdout || !child.stderr) throw new Error('Claude runtime streams unavailable')
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)))
    try {
      for await (const record of parseJsonLines(child.stdout)) {
        if (record.type === 'system' && (record.subtype === 'init' || record.subtype === undefined) && typeof record.session_id === 'string') {
          this.resume = record.session_id
          yield { kind: 'native-session', nativeSession: record.session_id as never }
        }
        for (const signal of mapRuntimeRecord('claude', operationId, record)) yield signal
      }
      const exitCode = await completion
      if (exitCode === 0) yield { kind: 'finished', outcome: { status: 'completed' } }
      else yield { kind: 'finished', outcome: { status: 'failed', failure: { code: 'agent-error', message: Buffer.concat(stderr).toString('utf8').trim() || `Claude exited with code ${exitCode}` } } }
    } catch (error) {
      yield { kind: 'finished', outcome: { status: 'failed', failure: { code: 'agent-error', message: error instanceof Error ? error.message : 'Claude runtime failed' } } }
    } finally { if (this.active?.operationId === operationId) this.active = null }
  }
}
