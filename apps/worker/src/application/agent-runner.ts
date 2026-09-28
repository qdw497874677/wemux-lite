import { randomUUID } from 'node:crypto'
import type { AgentContent, AgentEvent, AgentRunner, ApprovalDecision, CommandRequest, RunRequest, SessionStore } from '@wemux/agent-interchange'
import { classifyAgentError, type AgentKey, type RuntimeOperationId, type SessionId, type Timestamp } from '@wemux/domain'
import type { AgentAdapter, AgentLaunchContext, AgentSignal, AgentTurnEvent, AgentTurnOutcome } from './ports/agent-adapter.js'
import type { RuntimeSessionAdapter } from './ports/runtime-session.js'
import { RuntimeSessionManager } from './runtime-session-manager.js'

const occurredAt = () => new Date().toISOString() as Timestamp
const textOf = (content: AgentContent) => content.parts.map(part => 'text' in part ? part.text : '').join('')

export interface WorkerAgentRunnerOptions {
  readonly agents: readonly AgentAdapter[]
  readonly runtimeAdapters?: ReadonlyMap<AgentKey, RuntimeSessionAdapter>
  readonly sessionStore?: SessionStore
}

/**
 * Owns provider-session lifecycle and exposes one ADK-compatible invocation
 * stream. Callers never acquire leases or stop provider processes directly.
 */
export class WorkerAgentRunner implements AgentRunner {
  private readonly managers = new Map<AgentKey, RuntimeSessionManager>()
  private readonly active = new Map<SessionId, {
    readonly invocationId: RuntimeOperationId
    stopRequested: boolean
    stop: (() => Promise<void>) | null
  }>()
  private readonly runtimeAdapters: ReadonlyMap<AgentKey, RuntimeSessionAdapter>

  constructor(private readonly options: WorkerAgentRunnerOptions) {
    this.runtimeAdapters = options.runtimeAdapters ?? new Map()
  }

  async *run(request: RunRequest): AsyncIterable<AgentEvent> {
    const agent = this.options.agents.find(candidate => candidate.agentKey === request.agentKey)
    if (!agent || agent.mode !== 'execution' || !this.runtimeAdapters.has(request.agentKey)) {
      yield this.terminal(request, { status: 'failed', failure: { code: 'agent-unavailable', message: `Agent runtime unavailable: ${request.agentKey}` } })
      return
    }
    if (this.active.has(request.sessionId)) {
      yield this.terminal(request, { status: 'failed', failure: { code: 'agent-error', message: 'Agent session already has an active invocation' } })
      return
    }

    const sessionKey = { appName: request.appName, userId: request.userId, sessionId: request.sessionId }
    const active = { invocationId: request.invocationId, stopRequested: false, stop: null as (() => Promise<void>) | null }
    this.active.set(request.sessionId, active)
    let lease: Awaited<ReturnType<RuntimeSessionManager['acquire']>> | null = null
    let faulted = false
    let terminalSeen = false
    let handle: Awaited<ReturnType<import('./ports/runtime-session.js').AgentRuntimeSession['execute']>> | null = null
    try {
      if (this.options.sessionStore) await this.options.sessionStore.getOrCreate(sessionKey)
      lease = await this.manager(agent).acquire({
        sessionId: request.sessionId,
        cwd: request.cwd,
        modelId: request.modelId,
        resume: request.resume,
      }, request.configurationFingerprint)
      handle = await lease.session.execute({
        operationId: request.invocationId,
        message: { messageId: request.messageId, content: textOf(request.message) },
        launchContext: (request.launchContext ?? null) as AgentLaunchContext | null,
      })
      active.stop = handle.stop
      if (active.stopRequested) await handle.stop()
      for await (const signal of handle.signals) {
        const event = this.toEvent(request, signal)
        if (!event) continue
        terminalSeen ||= event.customMetadata?.wemux?.terminal !== undefined
        await this.persist(sessionKey, event)
        yield event
      }
      if (!terminalSeen) {
        faulted = true
        const event = this.terminal(request, { status: 'failed', failure: { code: 'agent-error', message: 'Agent ended without a terminal signal' } })
        await this.persist(sessionKey, event)
        yield event
      }
    } catch (error) {
      faulted = true
      if (!terminalSeen) {
        const event = this.terminal(request, { status: 'failed', failure: { code: 'agent-error', message: error instanceof Error ? error.message : 'Agent failed' } })
        await this.persist(sessionKey, event)
        yield event
      }
    } finally {
      if (this.active.get(request.sessionId)?.invocationId === request.invocationId) this.active.delete(request.sessionId)
      await handle?.stop()
      if (lease) await (faulted ? lease.fault() : lease.release())
    }
  }

  async command(request: CommandRequest): Promise<void> {
    await this.managerForSession(request.sessionId).command(request.sessionId, {
      operationId: request.invocationId,
      name: request.name,
      arguments: request.arguments,
    })
  }

  async resolveApproval(request: ApprovalDecision): Promise<void> {
    const active = this.active.get(request.sessionId)
    if (!active || (request.invocationId && active.invocationId !== request.invocationId)) throw new Error('Agent invocation is not active')
    await this.managerForSession(request.sessionId).resolveApproval(request.sessionId, request.approvalId, request.decision)
  }

  async stop(sessionId: SessionId, invocationId: RuntimeOperationId): Promise<void> {
    const active = this.active.get(sessionId)
    if (active?.invocationId !== invocationId) return
    active.stopRequested = true
    await active.stop?.()
  }

  async closeSession(sessionId: SessionId): Promise<void> {
    const active = this.active.get(sessionId)
    if (active) {
      active.stopRequested = true
      await active.stop?.()
    }
    await Promise.all([...this.managers.values()].map(manager => manager.closeSession(sessionId)))
  }

  async close(): Promise<void> {
    await Promise.all([...this.active.values()].map(async invocation => {
      invocation.stopRequested = true
      await invocation.stop?.()
    }))
    await Promise.all([...this.managers.values()].map(manager => manager.shutdown()))
  }

  /** 同步强制终止所有 provider 子进程；不等待 in-flight promise，永不挂起。 */
  abort(): void {
    for (const invocation of this.active.values()) invocation.stopRequested = true
    for (const manager of this.managers.values()) manager.abort()
  }

  private async persist(sessionKey: { appName: string; userId: string; sessionId: SessionId }, event: AgentEvent) {
    if (!this.options.sessionStore || event.partial) return
    const session = await this.options.sessionStore.get(sessionKey)
    if (!session) throw new Error('Agent session disappeared while persisting an event')
    await this.options.sessionStore.appendEvent({ session, event })
  }

  private manager(agent: Extract<AgentAdapter, { mode: 'execution' }>) {
    let manager = this.managers.get(agent.agentKey)
    if (!manager) {
      const adapter = this.runtimeAdapters.get(agent.agentKey)
      if (!adapter) throw new Error(`Agent runtime unavailable: ${agent.agentKey}`)
      manager = new RuntimeSessionManager(adapter)
      this.managers.set(agent.agentKey, manager)
    }
    return manager
  }

  private managerForSession(sessionId: SessionId) {
    const manager = [...this.managers.values()].find(candidate => candidate.has(sessionId))
    if (!manager) throw new Error('Agent session is not active')
    return manager
  }

  private toEvent(request: RunRequest, signal: AgentSignal): AgentEvent | null {
    if (signal.kind === 'native-session') return this.event(request, 'system', undefined, { wemux: { nativeSession: signal.nativeSession } })
    if (signal.kind === 'finished') return this.terminal(request, signal.outcome)
    return this.turnEvent(request, signal.event)
  }

  private turnEvent(request: RunRequest, event: AgentTurnEvent): AgentEvent {
    if (event.kind === 'assistant.text.delta') return this.event(request, request.agentKey, { role: 'model', parts: [{ text: event.text }] }, { wemux: {}, provider: { kind: event.kind } }, true, event.streamKind)
    return this.event(request, request.agentKey, undefined, { wemux: event.kind === 'usage.updated'
      ? { usage: event.usage }
      : event.kind === 'approval.requested'
        ? { approvalId: event.approvalId, approval: { kind: 'requested', id: event.approvalId, action: event.action, ...(event.reason ? { reason: event.reason } : {}) } }
        : {}, provider: { ...event } }, false, 'streamKind' in event ? event.streamKind : undefined)
  }

  private terminal(request: RunRequest, outcome: AgentTurnOutcome): AgentEvent {
    const terminal = outcome.status === 'completed' ? 'completed' : outcome.status
    const failure = outcome.status === 'failed' ? classifyAgentError(outcome.failure.message) : null
    return this.event(request, request.agentKey, undefined, { wemux: {
      terminal,
      ...(outcome.status === 'failed' ? { error: {
        code: outcome.failure.code,
        message: outcome.failure.message,
        abortReason: outcome.failure.abortReason ?? 'provider_error',
        failureReason: outcome.failure.failureReason ?? failure!.reason,
        retryable: outcome.failure.retryable ?? failure!.retryable,
      } } : {}),
    } })
  }

  private event(request: RunRequest, author: string, content: AgentContent | undefined, customMetadata: NonNullable<AgentEvent['customMetadata']>, partial = false, streamKind?: AgentEvent['streamKind']): AgentEvent {
    return {
      id: randomUUID(),
      invocationId: request.invocationId,
      author,
      ...(content ? { content } : {}),
      actions: {},
      ...(streamKind ? { streamKind } : {}),
      ...(partial ? { partial: true } : {}),
      timestamp: occurredAt(),
      customMetadata,
    }
  }
}
