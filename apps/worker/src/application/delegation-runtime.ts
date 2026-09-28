import { createHash } from 'node:crypto'
import type { DelegationDispatchMessage, DelegationResultMessage } from '@wemux/wire-protocol'

export interface DelegationChildRun {
  readonly id: string
  readonly sessionId: string
  readonly taskId?: string
}

export interface DelegationRuntimePorts {
  createChildRun(input: {
    readonly requestId: string
    readonly delegationId: string
    readonly targetSessionId: string
    readonly objective: string
    readonly taskId?: string
  }): Promise<DelegationChildRun>
  executeChildRun(run: DelegationChildRun, objective: string): Promise<{ readonly outcome: 'completed' | 'failed' | 'cancelled'; readonly output?: string }>
  returnResult(message: DelegationResultMessage): Promise<void>
  continueCanonicalSession(sessionId: string, result: { readonly content: string; readonly silent: boolean }): Promise<void>
}

/** Same-Worker D1 executor. Cross-Worker transport and cancellation propagation belong to D2. */
export class DelegationRuntime {
  private readonly completed = new Map<string, DelegationResultMessage>()
  private readonly workerId: string
  private readonly ports: DelegationRuntimePorts

  constructor(workerId: string, ports: DelegationRuntimePorts) {
    this.workerId = workerId
    this.ports = ports
  }

  async execute(message: DelegationDispatchMessage, taskId?: string): Promise<DelegationResultMessage> {
    if (message.route.sourceWorkerId !== this.workerId || message.route.targetWorkerId !== this.workerId) throw new Error('D1 only supports delegation on the same Worker')
    const previous = this.completed.get(message.dispatchId)
    if (previous) return previous
    const run = await this.ports.createChildRun({
      requestId: `delegation:${message.dispatchId}`,
      delegationId: message.delegationId,
      targetSessionId: message.targetSessionId,
      objective: message.objective,
      ...(taskId ? { taskId } : {}),
    })
    const execution = await this.ports.executeChildRun(run, message.objective)
    const silent = execution.output?.trim() === '[SILENT]'
    const result: DelegationResultMessage = {
      kind: 'delegation.result',
      requestId: createHash('sha256').update(`${message.dispatchId}:${execution.outcome}`).digest('hex'),
      delegationId: message.delegationId,
      dispatchId: message.dispatchId,
      outcome: execution.outcome,
      sourceSessionId: message.sourceSessionId,
      canonicalSessionId: message.canonicalSessionId,
      sourceAgentId: message.sourceAgentId,
      targetAgentId: message.targetAgentId,
      childRunId: run.id,
      ...(silent || execution.output === undefined ? {} : { resultSummary: execution.output }),
      silent,
      route: message.route,
    }
    this.completed.set(message.dispatchId, result)
    await this.ports.returnResult(result)
    await this.ports.continueCanonicalSession(message.canonicalSessionId, { content: silent ? '' : execution.output ?? '', silent })
    return result
  }
}
