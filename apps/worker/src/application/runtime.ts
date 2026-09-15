import { createHash } from 'node:crypto'
import type { CommandId, EventSeq, SessionId, Timestamp, Turn, TurnId, WorkerId } from '@wemux/domain'
import type { CommandReceipt, ServerToWorker, WorkerCommand, WorkerToServer } from '@wemux/wire-protocol'
import type { AgentAdapter, AgentTurnHandle, AgentTurnOutcome } from './ports/agent-adapter.js'
import type { AgentLaunchContextProvider } from './ports/agent-launch-context.js'
import type { LocalState, RuntimeTransport, WorkspaceProvisioner } from './ports/local-state.js'
import type { WorkerStore } from './ports/worker-store.js'

const now = () => new Date().toISOString() as Timestamp
const DEFAULT_AGENT_IDLE_TIMEOUT_MS = 30_000
const DEFAULT_AGENT_MAX_TIMEOUT_MS = 10 * 60_000
class AgentTimeoutError extends Error {}
import { envelope } from '../domain/envelope.js'
export { envelope } from '../domain/envelope.js'
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  return JSON.stringify(value)
}

export class WorkerRuntime {
  private readonly tasks = new Map<SessionId, Promise<void>>()
  private readonly handles = new Map<SessionId, AgentTurnHandle & { turnId: TurnId }>()
  private readonly sent = new Map<SessionId, number>()
  private readonly provisions = new Map<import('@wemux/domain').WorkspaceId, Promise<void>>()
  private headRefresh: NodeJS.Timeout | null = null
  private commands: Promise<unknown> = Promise.resolve()
  private publishing: Promise<unknown> = Promise.resolve()
  private closing = false
  constructor(private readonly store: WorkerStore & LocalState, private readonly provisioner: WorkspaceProvisioner,
    private readonly agents: readonly AgentAdapter[], private readonly transport: RuntimeTransport,
    private readonly workerId: WorkerId, private readonly name: string,
    private readonly launchContexts: AgentLaunchContextProvider = { prepare: async () => ({ context: null, cleanup: async () => undefined }) },
    private readonly agentTimeouts = { idleMs: DEFAULT_AGENT_IDLE_TIMEOUT_MS, maxMs: DEFAULT_AGENT_MAX_TIMEOUT_MS }) {}

  async initialize() {
    this.store.saveCapabilities(await Promise.all(this.agents.map(agent => agent.detect())))
    for (const session of await this.store.listSessions()) {
      if (session.activeTurnId) {
        const turn = await this.store.sessions.getTurn(session.activeTurnId)
        await this.store.transaction(tx => tx.sessions.finishTurn(turn?.state === 'stopping'
          ? { turnId: session.activeTurnId!, outcome: 'cancelled', finishedAt: now() }
          : { turnId: session.activeTurnId!, outcome: 'failed', failure: { code: 'interrupted', message: 'Worker restarted during turn' }, finishedAt: now() }))
      }
    }
    for (const record of await this.store.commands.listRecoverable(100000)) {
      if (record.command.kind === 'workspace.provision') this.startProvision(record.commandId, record.command)
    }
    for (const session of await this.store.listSessions()) this.schedule(session.sessionId)
  }
  async connected() {
    this.sent.clear()
    this.send({ ...envelope(), type: 'hello', side: 'worker', workerId: this.workerId, workerVersion: '0.1.0', name: this.name, platform: process.platform, architecture: process.arch })
    this.send({ ...envelope(), type: 'capability', workerId: this.workerId, capabilities: this.store.capabilities(), detectedAt: now() })
    await this.sendHeads()
    if (this.headRefresh) clearInterval(this.headRefresh)
    this.headRefresh = setInterval(() => { void this.sendHeads() }, 1_000)
    this.headRefresh.unref()
    for (const workspace of await this.store.listWorkspaces()) await this.report(workspace.id)
  }
  receive(message: ServerToWorker): Promise<void> {
    const next = this.commands.then(async () => {
      if (this.closing) return
      if (message.type === 'command') await this.command(message.commandId, message.command)
      if (message.type === 'sync') {
        const original = await this.store.journal.read(message)
        let bytes = 1024
        const events = original.events.filter(event => {
          bytes += Buffer.byteLength(JSON.stringify(event)) + 1
          return bytes <= 900000
        })
        const page = { events, throughSeq: (events.at(-1)?.seq ?? message.fromSeq - 1) as EventSeq, hasMore: original.hasMore || events.length < original.events.length }
        const head = (await this.store.journal.listHeads()).find(h => h.sessionId === message.sessionId)
        if (!head || message.fromSeq > head.lastSeq + 1 || page.events.some((event,i) => event.seq !== message.fromSeq + i) || (!page.events.length && message.fromSeq <= head.lastSeq)) {
          this.send({ ...envelope(), type: 'sync', kind: 'gap', sessionId: message.sessionId, fromSeq: message.fromSeq, reason: 'Requested journal range is unavailable' })
        } else this.send({ ...envelope(), type: 'sync', kind: 'batch', sessionId: message.sessionId, ...page })
      }
    })
    this.commands = next.catch(() => {})
    return next
  }
  private send(message: WorkerToServer) { this.transport.send(message) }
  private async sendHeads() {
    if (this.closing) return
    this.send({ ...envelope(), type: 'sync', kind: 'heads', complete: true, heads: await this.store.journal.listHeads() })
  }
  private async command(commandId: CommandId, command: WorkerCommand) {
    const payloadFingerprint = createHash('sha256').update(canonical(command.kind === 'session.enqueue' ? { kind: command.kind, sessionId: command.sessionId, message: { messageId: command.message.messageId, content: command.message.content } } : command)).digest('hex')
    const previous = await this.store.commands.get(commandId)
    let receipt: CommandReceipt = { commandId, status: 'accepted' }
    if (previous) {
      if (previous.payloadFingerprint !== payloadFingerprint) receipt = { commandId, status: 'rejected', error: { code: 'conflicting-command', message: 'Command ID reused with a different payload', retryable: false } }
      else if (previous.state === 'rejected') receipt = previous.result as CommandReceipt
      this.send({ ...envelope(), type: 'ack', receipt })
      return
    }
    try {
      await this.validate(command)
      await this.store.transaction(async tx => {
        await tx.commands.record({ commandId, command, payloadFingerprint }, receipt)
        switch (command.kind) {
          case 'session.create': await tx.sessions.createSession(command.session.sessionId, command.session.binding); break
          case 'session.enqueue': await tx.sessions.enqueue({ sessionId: command.sessionId, submissionCommandId: commandId, message: command.message, capabilities: command.capabilities, queuedAt: now() }); break
          case 'session.delete': await tx.sessions.deleteSession(command.sessionId); break
          case 'session.cancel-queued': await tx.sessions.cancelQueued(command.sessionId, command.submissionCommandId); break
          case 'turn.stop': await tx.sessions.requestStop(command.sessionId, command.turnId); break
        }
        if (command.kind !== 'workspace.provision') await tx.commands.setExecutionState({ commandId, state: 'completed', result: null, updatedAt: now() })
      })
    } catch (error) {
      receipt = { commandId, status: 'rejected', error: { code: 'invalid-input', message: error instanceof Error ? error.message : 'Invalid command', retryable: false } }
      await this.store.transaction(tx => tx.commands.record({ commandId, command, payloadFingerprint }, receipt))
    }
    this.send({ ...envelope(), type: 'ack', receipt })
    if (receipt.status === 'rejected') return
    if (command.kind === 'workspace.provision') {
      this.startProvision(commandId, command)
      return
    }
    if (command.kind === 'session.delete') { this.sent.delete(command.sessionId); return }
    if (command.kind === 'turn.stop') {
      const handle = this.handles.get(command.sessionId)
      if (handle?.turnId === command.turnId && (await this.store.sessions.getTurn(command.turnId))?.state === 'stopping') await handle.stop()
    }
    await this.publish()
    if ('sessionId' in command) this.schedule(command.sessionId)
  }
  private available(binding: import('@wemux/domain').SessionBinding) {
    return this.store.capabilities().some(c => c.agentKey === binding.agent.agentKey && c.mode === 'execution' && c.availability.status === 'available' && c.models.some(m => m.modelId === binding.modelId))
  }
  private async validate(command: WorkerCommand) {
    if (command.kind === 'workspace.delete') throw new Error('Workspace deletion is not supported in this MVP')
    if (command.kind === 'workspace.provision') {
      if (command.workspace.workspace.workerId !== this.workerId) throw new Error('Workspace belongs to another worker')
      const existing = await this.store.workspaces.get(command.workspace.workspace.id)
      if (existing && (existing.projectId !== command.workspace.workspace.projectId || canonical(existing.spec) !== canonical(command.workspace.workspace.spec) || (existing.provisionSpec && canonical(existing.provisionSpec.repositories) !== canonical(command.workspace.repositories)))) throw new Error('Workspace binding is immutable')
      return
    }
    if (command.kind === 'session.create') {
      const { binding } = command.session
      const workspace = await this.store.workspaces.get(binding.workspaceId)
      if (!workspace || workspace.status !== 'ready') throw new Error('Workspace is not ready')
      if (binding.agent.workerId !== this.workerId || !this.available(binding)) throw new Error('Agent or model unavailable')
      return
    }
    if (command.kind === 'session.delete') return // Active protection is checked atomically in the store.
    const session = await this.store.sessions.get(command.sessionId)
    if (!session) throw new Error('Session not found')
    if (command.kind === 'session.enqueue') {
      if ((await this.store.workspaces.get(session.binding.workspaceId))?.status !== 'ready' || !this.available(session.binding)) throw new Error('Workspace, agent or model unavailable')
    }
    if (command.kind === 'turn.stop' && (await this.store.sessions.getTurn(command.turnId))?.sessionId !== command.sessionId) throw new Error('Turn not found')
  }
  private startProvision(commandId: CommandId, command: Extract<WorkerCommand, { kind: 'workspace.provision' }>) {
    const id = command.workspace.workspace.id
    if (this.provisions.has(id)) return
    const task = this.provision(commandId, command)
      .catch(error => { console.error('Workspace provisioning failed:', error) })
      .finally(() => this.provisions.delete(id))
    this.provisions.set(id, task)
  }
  private async provision(commandId: CommandId, command: Extract<WorkerCommand, { kind: 'workspace.provision' }>) {
    const definition = command.workspace.workspace
    const existing = await this.store.workspaces.get(definition.id)
    if (existing?.status === 'ready') {
      await this.store.transaction(async tx => {
        await tx.workspaces.save({ ...existing, provisionCommandId: commandId, updatedAt: now() })
        await tx.commands.setExecutionState({ commandId, state: 'completed', result: null, updatedAt: now() })
      })
      await this.report(definition.id)
      return
    }
    const local = { provisionCommandId: commandId, id: definition.id, workerId: this.workerId, projectId: definition.projectId, spec: definition.spec, provisionSpec: command.workspace, rootPath: '', status: 'provisioning' as const, failureReason: null, updatedAt: now() }
    await this.store.transaction(async tx => {
      await tx.workspaces.save(local)
      await tx.commands.setExecutionState({ commandId, state: 'running', result: null, updatedAt: now() })
    })
    await this.report(definition.id)
    try {
      const result = await this.provisioner.provision(command.workspace)
      await this.store.transaction(async tx => {
        await tx.workspaces.save({ ...local, rootPath: result.rootPath, status: 'ready', updatedAt: now() })
        await tx.workspaces.saveRepositoryCheckouts(result.checkouts)
        await tx.commands.setExecutionState({ commandId, state: 'completed', result: null, updatedAt: now() })
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Provision failed'
      await this.store.transaction(async tx => {
        await tx.workspaces.save({ ...local, status: 'failed', failureReason: reason, updatedAt: now() })
        await tx.commands.setExecutionState({ commandId, state: 'failed', result: reason, updatedAt: now() })
      })
    }
    await this.report(definition.id)
  }
  private async report(id: import('@wemux/domain').WorkspaceId) {
    const workspace = await this.store.workspaces.get(id)
    if (!workspace) return
    this.send({ ...envelope(), type: 'event', scope: 'workspace', report: { ...(workspace.provisionCommandId ? { commandId: workspace.provisionCommandId } : {}), workspaceId: id, status: workspace.status, reason: workspace.failureReason, occurredAt: workspace.updatedAt,
      location: workspace.status === 'ready' ? { workspaceId: id, workerId: this.workerId, rootPath: workspace.rootPath, checkouts: await this.store.workspaces.listRepositoryCheckouts(id) } : null } })
  }
  private schedule(id: SessionId) {
    if (this.closing || this.tasks.has(id)) return
    const task = this.run(id).catch(error => { console.error('Session execution failed:', error) }).finally(() => { this.tasks.delete(id) })
    this.tasks.set(id, task)
  }
  private async run(id: SessionId) {
    while (!this.closing) {
      const session = await this.store.sessions.get(id)
      if (!session) return
      if (!this.available(session.binding)) {
        await this.store.transaction(tx => tx.sessions.setRuntimeState(id, 'unavailable'))
        await this.publish(); return
      }
      const turn = await this.store.transaction(tx => tx.sessions.claimNext(id))
      if (!turn) return
      await this.publish()
      await this.execute(turn)
    }
  }
  private async execute(turn: Turn) {
    let outcome: AgentTurnOutcome = { status: 'failed', failure: { code: 'agent-error', message: 'Agent ended without a terminal signal' } }
    try {
      const session = (await this.store.sessions.get(turn.sessionId))!
      const workspace = (await this.store.workspaces.get(session.binding.workspaceId))!
      const agent = this.agents.find(a => a.agentKey === session.binding.agent.agentKey)
      if (!agent || agent.mode !== 'execution') throw new Error('Agent unavailable')
      const prepared = await this.launchContexts.prepare(turn)
      let handle: AgentTurnHandle | null = null
      try {
        handle = await agent.startTurn({ sessionId: turn.sessionId, turnId: turn.id, cwd: workspace.rootPath, modelId: session.binding.modelId, message: turn.message, resume: session.nativeSession, launchContext: prepared.context })
        this.handles.set(turn.sessionId, { ...handle, turnId: turn.id })
        if (this.closing || (await this.store.sessions.getTurn(turn.id))?.state === 'stopping') await handle.stop()
        const iterator = handle.signals[Symbol.asyncIterator]()
        const startedAt = Date.now()
        while (true) {
          const remainingMs = Math.max(1, this.agentTimeouts.maxMs - (Date.now() - startedAt))
          const timeoutMs = Math.min(this.agentTimeouts.idleMs, remainingMs)
          let timer: NodeJS.Timeout | undefined
          const result = await Promise.race([
            iterator.next(),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AgentTimeoutError(remainingMs <= this.agentTimeouts.idleMs ? '智能体执行时间超过上限，已自动终止。' : '智能体长时间没有产生任何事件，请重试。')), timeoutMs) }),
          ]).finally(() => { if (timer) clearTimeout(timer) })
          if (result.done) break
          const signal = result.value
          if (signal.kind === 'finished') { outcome = signal.outcome; break }
          await this.store.transaction(async tx => {
            if (signal.kind === 'native-session') await tx.sessions.bindNativeSession({ sessionId: turn.sessionId, nativeSession: signal.nativeSession })
            else await tx.appendJournal(turn.sessionId, [{ occurredAt: now(), payload: { ...signal.event, turnId: turn.id } }])
          })
          await this.publish()
        }
      } finally { if (handle) await handle.stop(); await prepared.cleanup() }
    } catch (error) { outcome = { status: 'failed', failure: { code: 'agent-error', message: error instanceof Error ? error.message : 'Agent failed' } } }
    finally { if (this.handles.get(turn.sessionId)?.turnId === turn.id) this.handles.delete(turn.sessionId) }
    await this.store.transaction(tx => tx.sessions.finishTurn(outcome.status === 'failed'
      ? { turnId: turn.id, outcome: 'failed', failure: outcome.failure, finishedAt: now() }
      : { turnId: turn.id, outcome: outcome.status, finishedAt: now() }))
    await this.publish()
  }
  private publish(): Promise<void> {
    const work = this.publishing.then(async () => {
      for (const head of await this.store.journal.listHeads()) {
        let from = (this.sent.get(head.sessionId) ?? 0) + 1
        while (from <= head.lastSeq) {
          const page = await this.store.journal.read({ sessionId: head.sessionId, fromSeq: from as EventSeq, limit: 256 })
          if (!page.events.length) break
          for (const event of page.events) this.send({ ...envelope(), type: 'event', scope: 'session', event })
          from = page.throughSeq + 1
          this.sent.set(head.sessionId, page.throughSeq)
        }
      }
    })
    this.publishing = work.catch(() => {})
    return work
  }
  async shutdown() {
    this.closing = true
    if (this.headRefresh) clearInterval(this.headRefresh)
    this.headRefresh = null
    await Promise.all([...this.handles.values()].map(handle => handle.stop()))
    await this.provisioner.stop?.()
    await this.commands
    await Promise.all(this.provisions.values())
    await Promise.all(this.tasks.values())
    await this.publishing
  }
}
