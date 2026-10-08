import { createHash, randomUUID } from 'node:crypto'
import type { AgentContent, AgentEvent, AgentRunner, ApprovalDecision, CommandRequest, RunRequest, SessionStore } from '@wemux/agent-interchange'
import { classifyAgentError, type AgentKey, type RuntimeOperationId, type SessionId, type Timestamp } from '@wemux/domain'
import type { AgentAdapter, AgentLaunchContext, AgentSignal, AgentTurnEvent, AgentTurnOutcome } from './ports/agent-adapter.js'
import type { RuntimeSessionAdapter, RuntimeSessionOpenInput } from './ports/runtime-session.js'
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
  private providerManager: RuntimeSessionManager | null
  private readonly active = new Map<SessionId, {
    readonly invocationId: RuntimeOperationId
    stopRequested: boolean
    stop: (() => Promise<void>) | null
  }>()
  private readonly runtimeAdapters: ReadonlyMap<AgentKey, RuntimeSessionAdapter>
  private readonly privateSessions = new Set<SessionId>()

  constructor(private readonly options: WorkerAgentRunnerOptions) {
    this.runtimeAdapters = options.runtimeAdapters ?? new Map()
    const piAdapter = this.runtimeAdapters.get('pi' as AgentKey)
    this.providerManager = piAdapter ? new RuntimeSessionManager(piAdapter) : null
  }

  run(request: RunRequest): AsyncIterable<AgentEvent> { return this.runInternal(request, null) }

  /** Trusted Worker-only entry. Provider secrets never belong in a RunRequest or SessionStore. */
  runWithPiProvider(request: RunRequest, provider: NonNullable<RuntimeSessionOpenInput['piProvider']>, fingerprint: string): AsyncIterable<AgentEvent> {
    if (request.agentKey !== 'pi' || request.resume || !fingerprint || !provider.environment.OPENAI_API_KEY?.trim() || Object.keys(provider.environment).length !== 1 || provider.definition.providerKey !== 'openai-compatible' || provider.definition.modelIds.length !== 1 || request.modelId !== `openai-compatible::${provider.definition.modelIds[0]}`) throw new Error('pi_provider_launch_invalid')
    const processHash = createHash('sha256').update(JSON.stringify(provider.definition)).update('\0').update(provider.environment.OPENAI_API_KEY).digest('hex')
    return this.runInternal(request, { provider, fingerprint: `${processHash}:${fingerprint}` })
  }

  private async *runInternal(request: RunRequest, privateProvider: { provider: NonNullable<RuntimeSessionOpenInput['piProvider']>; fingerprint: string } | null): AsyncIterable<AgentEvent> {
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
    if (privateProvider) this.privateSessions.add(request.sessionId)
    let lease: Awaited<ReturnType<RuntimeSessionManager['acquire']>> | null = null
    let faulted = false
    let terminalSeen = false
    let handle: Awaited<ReturnType<import('./ports/runtime-session.js').AgentRuntimeSession['execute']>> | null = null
    try {
      if (this.options.sessionStore) await this.options.sessionStore.getOrCreate(sessionKey)
      lease = await (privateProvider ? this.privateManager() : this.manager(agent)).acquire({
        sessionId: request.sessionId,
        cwd: request.cwd,
        modelId: request.modelId,
        resume: request.resume,
        ...(privateProvider ? { piProvider: privateProvider.provider } : {}),
      }, privateProvider ? `${request.configurationFingerprint}:${privateProvider.fingerprint}` : request.configurationFingerprint)
      if (privateProvider && !this.privateSessions.has(request.sessionId)) throw new Error('pi_provider_disconnected')
      handle = await lease.session.execute({
        operationId: request.invocationId,
        message: { messageId: request.messageId, content: textOf(request.message) },
        launchContext: (request.launchContext ?? null) as AgentLaunchContext | null,
      })
      active.stop = handle.stop
      if (active.stopRequested) await handle.stop()
      const signals = privateProvider ? this.checkedPiProviderSignals(handle.signals, privateProvider.provider.environment.OPENAI_API_KEY) : handle.signals
      for await (const signal of signals) {
        if (privateProvider && (active.stopRequested || !this.privateSessions.has(request.sessionId))) {
          faulted = true
          const stopped = this.terminal(request, { status: 'failed', failure: { code: 'agent-error', message: 'Pi Provider 已撤销或连接中断' } })
          terminalSeen = true
          await this.persist(sessionKey, stopped)
          yield stopped
          break
        }
        // The isolated Provider process cannot create a resumable native Pi
        // Session: its config and authentication belong to this child only.
        if (privateProvider && signal.kind === 'native-session') continue
        // PiRuntimeSessionAdapter normalizes iterator aborts into finished/failed
        // signals. Preserve the explicit stop intent at this boundary too; the
        // catch below only handles adapters that propagate the exception.
        const stoppedPiAbort = !privateProvider && request.agentKey === 'pi' && active.stopRequested && signal.kind === 'finished'
          && signal.outcome.status === 'failed' && signal.outcome.failure.message === 'This operation was aborted'
        const event = this.toEvent(request, stoppedPiAbort ? { kind: 'finished', outcome: { status: 'cancelled' } } : signal)
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
        // Adapter/child errors can echo launch environment. In private
        // Provider mode no diagnostic from an untrusted subprocess may enter
        // Journal, Web, or Server; the local operator can inspect process logs.
        const message = privateProvider ? 'Pi Provider 启动或执行失败，请检查 Worker 本地配置' : error instanceof Error ? error.message : 'Agent failed'
        // Native Pi can reject its signal iterator during an explicitly
        // requested stop before emitting a terminal signal. Keep unrelated
        // adapter errors (and private Provider isolation failures) as failed.
        const abortedByStop = !privateProvider && request.agentKey === 'pi' && active.stopRequested && error instanceof Error && error.message === 'This operation was aborted'
        const event = this.terminal(request, abortedByStop ? { status: 'cancelled' } : { status: 'failed', failure: { code: 'agent-error', message } })
        await this.persist(sessionKey, event)
        yield event
      }
    } finally {
      if (this.active.get(request.sessionId)?.invocationId === request.invocationId) this.active.delete(request.sessionId)
      if (privateProvider) this.privateSessions.delete(request.sessionId)
      await handle?.stop()
      if (lease) await (faulted ? lease.fault() : lease.release())
    }
  }

  /** Hold private Provider output until every field can be checked across deltas. */
  private async *checkedPiProviderSignals(source: AsyncIterable<AgentSignal>, secret: string): AsyncIterable<AgentSignal> {
    const buffered: AgentSignal[] = []
    let size = 0
    try {
      for await (const signal of source) {
        const encoded = JSON.stringify(signal)
        size += Buffer.byteLength(encoded)
        if (size > 1024 * 1024) throw new Error('provider_output_limit')
        buffered.push(signal)
      }
    } catch {
      yield { kind: 'finished', outcome: { status: 'failed', failure: { code: 'agent-error', message: 'Pi Provider 输出无法安全验证' } } }
      return
    }
    const strings: string[] = []
    const collect = (value: unknown): void => {
      if (typeof value === 'string') strings.push(value)
      else if (Array.isArray(value)) value.forEach(collect)
      else if (value && typeof value === 'object') Object.values(value).forEach(collect)
    }
    collect(buffered)
    if (strings.join('').includes(secret)) {
      yield { kind: 'finished', outcome: { status: 'failed', failure: { code: 'agent-error', message: 'Provider 输出包含本机凭据，已阻止发布 [redacted]' } } }
      return
    }
    for (const signal of buffered) yield signal
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
    await this.managerForSession(request.sessionId).resolveApproval(request.sessionId, request.approvalId, request.decision, () => {
      if (this.active.get(request.sessionId) !== active || active.invocationId !== request.invocationId) throw new Error('Approval invocation is no longer active')
    })
  }

  async stop(sessionId: SessionId, invocationId: RuntimeOperationId): Promise<void> {
    const active = this.active.get(sessionId)
    if (active?.invocationId !== invocationId) return
    active.stopRequested = true
    await active.stop?.()
  }

  abortProviderSessions(): void {
    const manager = this.providerManager
    // Kill only private Pi children; ordinary Pi Sessions must survive
    // cluster disconnect and must never share a child with a Provider Turn.
    for (const sessionId of this.privateSessions) {
      const active = this.active.get(sessionId)
      if (active) { active.stopRequested = true; void active.stop?.().catch(() => undefined) }
    }
    this.privateSessions.clear()
    manager?.abort()
    this.providerManager = null
  }

  async closeSession(sessionId: SessionId): Promise<void> {
    const active = this.active.get(sessionId)
    if (active) {
      active.stopRequested = true
      await active.stop?.()
    }
    await Promise.all([...this.managers.values(), this.providerManager].filter((manager): manager is RuntimeSessionManager => manager !== null).map(manager => manager.closeSession(sessionId)))
  }

  async close(): Promise<void> {
    await Promise.all([...this.active.values()].map(async invocation => {
      invocation.stopRequested = true
      await invocation.stop?.()
    }))
    await Promise.all([...this.managers.values(), this.providerManager].filter((manager): manager is RuntimeSessionManager => manager !== null).map(manager => manager.shutdown()))
  }

  /** 同步强制终止所有 provider 子进程；不等待 in-flight promise，永不挂起。 */
  abort(): void {
    for (const invocation of this.active.values()) invocation.stopRequested = true
    for (const manager of [...this.managers.values(), this.providerManager]) manager?.abort()
  }

  private async persist(sessionKey: { appName: string; userId: string; sessionId: SessionId }, event: AgentEvent) {
    if (!this.options.sessionStore || event.partial) return
    const session = await this.options.sessionStore.get(sessionKey)
    if (!session) throw new Error('Agent session disappeared while persisting an event')
    await this.options.sessionStore.appendEvent({ session, event })
  }

  private privateManager(): RuntimeSessionManager {
    if (!this.providerManager) {
      const adapter = this.runtimeAdapters.get('pi' as AgentKey)
      if (!adapter) throw new Error('Pi runtime unavailable')
      this.providerManager = new RuntimeSessionManager(adapter)
    }
    return this.providerManager
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
    const manager = [...this.managers.values(), this.providerManager].find(candidate => candidate?.has(sessionId))
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
