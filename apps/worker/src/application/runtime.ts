import { parseVerifiedServerFileWriteFrame } from '@wemux/wire-protocol/file-admission-node'
import { WorkerFileWriteExecutor } from './file-write-executor.js'
import type { FileWriteIngress } from '../transport/types.js'
import { createHash } from 'node:crypto'
import { projectAgentEventToSessionPayload, type AgentEvent } from '@wemux/agent-interchange'
import type { CommandId, EventSeq, ModelId, ModelProviderResourceDefinition, ProjectId, SessionId, Timestamp, Turn, TurnId, WorkerId } from '@wemux/domain'
import type { CommandReceipt, ConnectorRevisionReport, FileRequestPayload, ServerToWorker, TerminalRequestPayload, WorkerCommand, WorkerToServer } from '@wemux/wire-protocol'
import type { AgentAdapter, AgentTurnEvent, AgentTurnOutcome } from './ports/agent-adapter.js'
import type { AgentLaunchContextProvider } from './ports/agent-launch-context.js'
import type { LocalState, RuntimeTransport, WorkspaceProvisioner } from './ports/local-state.js'
import type { WorkerStore } from './ports/worker-store.js'
import { WorkerAgentRunner } from './agent-runner.js'
import { runtimeAdaptersFor } from './runtime-adapters.js'
import type { RuntimeSessionAdapter } from './ports/runtime-session.js'

/** Trusted Worker-only resolver; credentials must never enter RunRequest or transport. */
export type PiProviderResolver = (projectId: ProjectId, modelId: ModelId) => Promise<{
  readonly definition: ModelProviderResourceDefinition
  readonly environment: Readonly<Record<string, string>>
  readonly credentialStamp: string | null
  readonly bindingId: string
} | null>
import { diffWorkspaceFile, FILE_READ_ERROR, fileReadErrorMessage, listWorkspaceFiles, MAX_FS_RESPONSE_PAYLOAD_BYTES, readWorkspaceFile, writeWorkspaceFile } from '../files/workspace-files.js'
import { TerminalManager, type PtyAdapter } from '../terminal/terminal-manager.js'

const now = () => new Date().toISOString() as Timestamp
const WRITE_CHANNEL_CLOSED = 'write_channel_closed: 平台当前未开放文件和终端写入通道。'
const DEFAULT_AGENT_IDLE_TIMEOUT_MS = 30_000
const DEFAULT_AGENT_MAX_TIMEOUT_MS = 10 * 60_000
class AgentTimeoutError extends Error {}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  return JSON.stringify(value)
}

export class WorkerRuntime {
  private readonly tasks = new Map<SessionId, Promise<void>>()
  private readonly sent = new Map<SessionId, number>()
  private readonly provisions = new Map<import('@wemux/domain').WorkspaceId, Promise<void>>()
  private readonly agentRunner: WorkerAgentRunner
  private readonly terminals: TerminalManager | null
  private headRefresh: NodeJS.Timeout | null = null
  private commands: Promise<unknown> = Promise.resolve()
  private publishing: Promise<unknown> = Promise.resolve()
  readonly fileWriteIngress: FileWriteIngress | undefined
  private readonly fileWriteExecutor: WorkerFileWriteExecutor | undefined
  private closing = false
  private providerConnectionOpen = false
  private providerGeneration = 0
  /** shutdown 可能因 agent 子进程或 in-flight turn 挂起；abort 同步强制终止，供接管方超时后调用。 */
  private aborted = false
  constructor(private readonly store: WorkerStore & LocalState & import('@wemux/agent-interchange').SessionStore, private readonly provisioner: WorkspaceProvisioner,
    private readonly agents: readonly AgentAdapter[], private readonly transport: RuntimeTransport,
    private readonly workerId: WorkerId, private readonly name: string,
    private readonly launchContexts: AgentLaunchContextProvider = { prepare: async () => ({ context: null, cleanup: async () => undefined }) },
    private readonly agentTimeouts = { idleMs: DEFAULT_AGENT_IDLE_TIMEOUT_MS, maxMs: DEFAULT_AGENT_MAX_TIMEOUT_MS },
    runtimeAdapters: ReadonlyMap<import('@wemux/domain').AgentKey, RuntimeSessionAdapter> = runtimeAdaptersFor(agents),
    terminalPty: PtyAdapter | null = null,
    private readonly connectorControl?: {
      syncClusterDefinition(definition: Extract<WorkerCommand, { kind: 'connector.definition.sync' }>['definition'], workerId: string): Promise<{ status: ConnectorRevisionReport['status']; credentialAvailability: ConnectorRevisionReport['credentialAvailability']; message: string }>
      testClusterDefinition(connectorId: string, revision: number): Promise<{ status: ConnectorRevisionReport['status']; credentialAvailability: ConnectorRevisionReport['credentialAvailability']; message: string }>
      resolveApproval?(identity: { sessionId: string; turnId: string; approvalId: string; decision: 'approve' | 'deny' }): boolean
      hasPendingApproval?(sessionId: string, turnId: string): boolean
    },
    private readonly piProviderResolver?: PiProviderResolver,
    /** Internal embedding only. Absent in all production constructors. */
    fileWrites?: { readonly write?: typeof writeWorkspaceFile }) {
    if (fileWrites) {
      this.fileWriteExecutor = new WorkerFileWriteExecutor(store, workerId, fileWrites)
      const publishPending = async (result: import('@wemux/wire-protocol').FileWriteResultPayload, publish: Parameters<FileWriteIngress['replay']>[0]) => {
        const record = await store.fileWrites.get(result.requestId)
        if (record?.result && !record.acknowledged) await publish(record.result)
      }
      const queue = (work: () => Promise<void>) => {
        if (this.closing) return Promise.reject(new Error('Worker runtime is shutting down'))
        const next = this.commands.then(async () => {
          if (this.aborted) throw new Error('Worker runtime is aborted')
          await work()
        })
        this.commands = next.catch(() => {})
        return next
      }
      this.fileWriteIngress = {
        retainedResult: async requestId => (await store.fileWrites.get(requestId))?.result ?? undefined,
        receive: (input, negotiation, publish) => {
          // Snapshot before the Runtime queue, including nested binding and negotiation.
          const snapshot = structuredClone(input)
          const support = structuredClone(negotiation)
          return queue(async () => {
            const candidate = snapshot as { payload?: { requestId?: string } }
            const retained = candidate.payload?.requestId ? (await store.fileWrites.get(candidate.payload.requestId))?.result : undefined
            const frame = parseVerifiedServerFileWriteFrame(snapshot, support, retained ?? undefined)
            if (frame.payload.type === 'fs.write.result.ack') {
              const acknowledgement = frame.payload
              await store.transaction(tx => tx.fileWrites.acknowledgeResult(acknowledgement))
            } else {
              const outcome = await this.fileWriteExecutor!.execute(frame.payload)
              if (outcome.status === 'reject') throw new Error('File admission identity conflict')
              if (outcome.status === 'result') await publishPending(outcome.result, publish)
            }
          })
        },
        replay: publish => queue(async () => {
          for (const result of await store.fileWrites.listPendingResults(Number.MAX_SAFE_INTEGER)) await publishPending(result, publish)
        }),
      }
    }
    this.providerConnectionOpen = !piProviderResolver
    this.agentRunner = new WorkerAgentRunner({ agents, runtimeAdapters, sessionStore: store })
    this.terminals = terminalPty ? new TerminalManager(
      terminalPty,
      event => {
        const sessionId = this.terminalSessions.get(event.terminalId)
        if (sessionId) this.send({ type: 'terminal.output', sessionId, ...event })
      },
      event => {
        const sessionId = this.terminalSessions.get(event.terminalId)
        if (!sessionId) return
        this.terminalSessions.delete(event.terminalId)
        this.send({ type: 'terminal.exit', sessionId, ...event })
      },
    ) : null
  }

  private readonly terminalSessions = new Map<string, SessionId>()

  /** A disconnected cluster must not keep a private credential in an idle Pi child. */
  providerDisconnected(): void {
    this.providerConnectionOpen = false
    this.providerGeneration++
    this.agentRunner.abortProviderSessions()
  }

  providerConnected(): void { if (this.piProviderResolver) this.providerConnectionOpen = true }

  providerCredentialChanged(): void { this.providerGeneration++; this.agentRunner.abortProviderSessions() }

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
    this.send({ type: 'capability', workerId: this.workerId, capabilities: this.store.capabilities(), detectedAt: now(), terminal: { available: this.terminals !== null, ...(this.terminals ? {} : { reason: 'node-pty unavailable' }) } })
    await this.sendHeads()
    if (this.headRefresh) clearInterval(this.headRefresh)
    this.headRefresh = setInterval(() => { void this.sendHeads() }, 1_000)
    this.headRefresh.unref()
    for (const workspace of await this.store.listWorkspaces()) if (!this.isLocalWorkspace(workspace)) await this.report(workspace.id)
  }
  receive(message: ServerToWorker): Promise<void> {
    if (message.type === 'command' && message.command.kind === 'runtime.approval.resolve') message = structuredClone(message)
    const next = this.commands.then(async () => {
      if (this.closing) return
      if (message.type === 'command') await this.command(message.commandId, message.command, true, 'cluster')
      if (message.type === 'fs.request') await this.files(message)
      if (message.type === 'terminal.request') await this.terminal(message)
      if (message.type === 'sync') {
        if (await this.isLocalSession(message.sessionId)) {
          this.send({ type: 'sync', kind: 'gap', sessionId: message.sessionId, fromSeq: message.fromSeq, reason: 'Requested journal range is unavailable' })
          return
        }
        const original = await this.store.journal.read(message)
        let bytes = 1024
        const events = original.events.filter(event => {
          bytes += Buffer.byteLength(JSON.stringify(event)) + 1
          return bytes <= 900000
        })
        const page = { events, throughSeq: (events.at(-1)?.seq ?? message.fromSeq - 1) as EventSeq, hasMore: original.hasMore || events.length < original.events.length }
        const head = (await this.store.journal.listHeads()).find(h => h.sessionId === message.sessionId)
        if (!head || message.fromSeq > head.lastSeq + 1 || page.events.some((event,i) => event.seq !== message.fromSeq + i) || (!page.events.length && message.fromSeq <= head.lastSeq)) {
          this.send({ type: 'sync', kind: 'gap', sessionId: message.sessionId, fromSeq: message.fromSeq, reason: 'Requested journal range is unavailable' })
        } else this.send({ type: 'sync', kind: 'batch', sessionId: message.sessionId, ...page })
      }
    })
    this.commands = next.catch(() => {})
    return next
  }
  private async files(request: FileRequestPayload): Promise<void> {
    if (request.operation === 'write') {
      this.send({ type: 'fs.response', requestId: request.requestId, ok: false, error: WRITE_CHANNEL_CLOSED })
      return
    }
    try {
      const session = await this.store.sessions.get(request.sessionId)
      if (!session || await this.isLocalSession(request.sessionId)) throw new Error('Session not found')
      const workspace = await this.store.workspaces.get(session.binding.workspaceId)
      if (!workspace || workspace.status !== 'ready' || workspace.workerId !== this.workerId) throw new Error('Workspace is not ready')
      if (request.operation === 'list') {
        this.send({ type: 'fs.response', requestId: request.requestId, ok: true, operation: 'list', entries: await listWorkspaceFiles(workspace.rootPath, request.subpath) })
      } else if (request.operation === 'read') {
        const result = await readWorkspaceFile(workspace.rootPath, request.subpath, request.maxBytes)
        const response = { type: 'fs.response', requestId: request.requestId, ok: true, operation: 'read', ...result } as const
        if (Buffer.byteLength(JSON.stringify(response)) > MAX_FS_RESPONSE_PAYLOAD_BYTES) throw new Error(`${FILE_READ_ERROR.transportTooLarge}: Encoded file exceeds transport payload limit (${MAX_FS_RESPONSE_PAYLOAD_BYTES} bytes)`)
        this.send(response)

      } else {
        const result = await diffWorkspaceFile(workspace.rootPath, request.subpath)
        this.send({ type: 'fs.response', requestId: request.requestId, ok: true, operation: 'diff', ...result })
      }
    } catch (error) {
      this.send({ type: 'fs.response', requestId: request.requestId, ok: false, error: request.operation === 'read' ? fileReadErrorMessage(error) : error instanceof Error ? error.message : 'File operation failed' })
    }
  }
  private async terminal(request: TerminalRequestPayload): Promise<void> {
    this.send({ type: 'terminal.response', requestId: request.requestId, ok: false, error: WRITE_CHANNEL_CLOSED })
  }
  async executeLocal(commandId: CommandId, command: WorkerCommand): Promise<CommandReceipt> {
    if (this.closing) throw new Error('Worker runtime is shutting down')
    if (command.kind === 'runtime.approval.resolve') command = structuredClone(command)
    const next = this.commands.then(() => this.command(commandId, command, false, 'local'))
    this.commands = next.catch(() => {})
    return next
  }
  private send(message: WorkerToServer) { return this.transport.send(message) }
  private async sendHeads() {
    if (this.closing) return
    const heads = []
    for (const head of await this.store.journal.listHeads()) if (!(await this.isLocalSession(head.sessionId))) heads.push(head)
    this.send({ type: 'sync', kind: 'heads', complete: true, heads })
  }
  private async isLocalSession(sessionId: SessionId) {
    const installationId = this.store.localInstallation()?.installationId
    if (!installationId) return false
    return (await this.store.sessions.get(sessionId))?.binding.agent.workerId === `local-${installationId}`
  }
  private isLocalWorkspace(workspace: import('../domain/local-workspace.js').LocalWorkspace) {
    const installationId = this.store.localInstallation()?.installationId
    return Boolean(installationId) && workspace.projectId === ('local' as import('@wemux/domain').ProjectId) && workspace.workerId === `local-${installationId}`
  }
  private async command(commandId: CommandId, command: WorkerCommand, acknowledge = true, source: 'cluster' | 'local' = 'cluster'): Promise<CommandReceipt> {
    const payloadFingerprint = createHash('sha256').update(canonical(command.kind === 'session.enqueue' ? { kind: command.kind, sessionId: command.sessionId, message: { messageId: command.message.messageId, content: command.message.content } } : command)).digest('hex')
    const previous = await this.store.commands.get(commandId)
    let receipt: CommandReceipt = { commandId, status: 'accepted' }
    if (previous) {
      if (command.kind === 'runtime.approval.resolve' && (!(await this.store.sessions.get(command.sessionId)) || (await this.isLocalSession(command.sessionId)) !== (source === 'local'))) {
        receipt = { commandId, status: 'rejected', error: { code: 'invalid-input', message: 'Session host scope mismatch', retryable: false } }
      }
      else if (previous.payloadFingerprint !== payloadFingerprint) receipt = { commandId, status: 'rejected', error: { code: 'conflicting-command', message: 'Command ID reused with a different payload', retryable: false } }
      else if (previous.state === 'rejected') receipt = previous.result as CommandReceipt
      if (acknowledge) this.send({ type: 'ack', receipt })
      return receipt
    }
    try {
      await this.validate(command, source)
      let connectorReport: Omit<ConnectorRevisionReport, 'requestId' | 'connectorId' | 'projectId' | 'workerId' | 'revision' | 'errorCode' | 'occurredAt'> | null = null
      if (command.kind === 'connector.definition.sync') connectorReport = await this.connectorControl!.syncClusterDefinition(command.definition, this.workerId)
      if (command.kind === 'connector.test') connectorReport = await this.connectorControl!.testClusterDefinition(command.connectorId, command.connectorRevision)
      await this.store.transaction(async tx => {
        if (command.kind === 'runtime.approval.resolve') {
          try { await this.requirePendingApproval(command, tx) }
          catch {
            receipt = { commandId, status: 'rejected', error: { code: 'invalid-state', message: 'Runtime accepted the decision, but terminal confirmation raced; execution outcome is unconfirmed by this receipt', retryable: false } }
            await tx.commands.record({ commandId, command, payloadFingerprint }, receipt)
            return
          }
        }
        await tx.commands.record({ commandId, command, payloadFingerprint }, receipt)
        switch (command.kind) {
          case 'session.create': await tx.sessions.createSession(command.session.sessionId, command.session.binding, command.session.storageMode); break
          case 'session.enqueue': await tx.sessions.enqueue({ sessionId: command.sessionId, submissionCommandId: commandId, message: command.message, capabilities: command.capabilities, queuedAt: now() }); break
          case 'session.delete': await tx.sessions.deleteSession(command.sessionId); break
          case 'session.cancel-queued': await tx.sessions.cancelQueued(command.sessionId, command.submissionCommandId); break
          case 'turn.stop': await tx.sessions.requestStop(command.sessionId, command.turnId); break
          case 'runtime.command':
            if (command.name === 'set_model') await tx.sessions.setModel(command.sessionId, command.arguments.modelId as import('@wemux/domain').ModelId)
            break
          case 'runtime.approval.resolve':
            await tx.appendJournal(command.sessionId, [{ occurredAt: now(), payload: { kind: 'approval.resolved', turnId: command.turnId, approvalId: command.approvalId, decision: command.decision, ...(command.decidedByAccountId ? { decidedByAccountId: command.decidedByAccountId } : {}) } }])
            break
        }
        if (command.kind !== 'workspace.provision') await tx.commands.setExecutionState({ commandId, state: 'completed', result: null, updatedAt: now() })
      })
      if (connectorReport && (command.kind === 'connector.definition.sync' || command.kind === 'connector.test')) this.send({ type: 'event', scope: 'connector', report: { requestId: command.requestId, connectorId: command.kind === 'connector.definition.sync' ? command.definition.id : command.connectorId, projectId: command.kind === 'connector.definition.sync' ? command.definition.projectId : command.projectId, workerId: this.workerId, revision: command.kind === 'connector.definition.sync' ? command.definition.revision : command.connectorRevision, ...connectorReport, errorCode: connectorReport.status === 'test_failed' || connectorReport.status === 'unavailable' ? 'connector_unavailable' : null, occurredAt: now() } })
    } catch (error) {
      receipt = { commandId, status: 'rejected', error: { code: 'invalid-input', message: error instanceof Error ? error.message : 'Invalid command', retryable: false } }
      await this.store.transaction(tx => tx.commands.record({ commandId, command, payloadFingerprint }, receipt))
    }
    if (acknowledge) this.send({ type: 'ack', receipt })
    if (receipt.status === 'rejected') return receipt
    if (command.kind === 'workspace.provision') {
      this.startProvision(commandId, command)
      return receipt
    }
    if (command.kind === 'session.delete') {
      this.sent.delete(command.sessionId)
      this.terminals?.disposeSession(command.sessionId)
      for (const [terminalId, sessionId] of this.terminalSessions) if (sessionId === command.sessionId) this.terminalSessions.delete(terminalId)
      await this.agentRunner.closeSession(command.sessionId)
      return receipt
    }
    if (command.kind === 'turn.stop' && (await this.store.sessions.getTurn(command.turnId))?.state === 'stopping') {
      await this.agentRunner.stop(command.sessionId, command.turnId)
    }
    await this.publish()
    if ('sessionId' in command) this.schedule(command.sessionId)
    return receipt
  }
  private available(binding: import('@wemux/domain').SessionBinding) {
    const localId = this.store.localInstallation()?.installationId
    const ownsWorker = binding.agent.workerId === this.workerId || (localId && binding.agent.workerId === `local-${localId}`)
    return Boolean(ownsWorker) && this.store.capabilities().some(c => c.agentKey === binding.agent.agentKey && c.mode === 'execution' && c.availability.status === 'available' && c.models.some(m => m.modelId === binding.modelId))
  }
  private async validate(command: WorkerCommand, source: 'cluster' | 'local') {
    if (command.kind === 'connector.definition.sync' || command.kind === 'connector.test') {
      if (source !== 'cluster' || !this.connectorControl) throw new Error('Connector cluster command is unavailable')
      if (command.kind === 'connector.definition.sync' && command.definition.allowedWorkerIds.length && !command.definition.allowedWorkerIds.includes(this.workerId)) throw new Error('Connector is outside this Worker scope')
      if (command.kind === 'connector.test' && command.workerId !== this.workerId) throw new Error('Connector test Worker mismatch')
      return
    }
    if (command.kind === 'workspace.delete') throw new Error('Workspace deletion is not supported in this MVP')
    if (command.kind === 'workspace.provision') {
      if (source === 'local') throw new Error('Local directories are authorized directly, not provisioned')
      const existing = await this.store.workspaces.get(command.workspace.workspace.id)
      if (existing && (existing.projectId !== command.workspace.workspace.projectId || canonical(existing.spec) !== canonical(command.workspace.workspace.spec) || (existing.provisionSpec && canonical(existing.provisionSpec.repositories) !== canonical(command.workspace.repositories)))) throw new Error('Workspace binding is immutable')
      return
    }
    if (command.kind === 'session.create') {
      if (command.session.storageMode !== undefined && command.session.storageMode !== 'local') throw new Error('Session storage mode is not available')
      const { binding } = command.session
      const workspace = await this.store.workspaces.get(binding.workspaceId)
      if (!workspace || workspace.status !== 'ready') throw new Error('Workspace is not ready')
      if (this.isLocalWorkspace(workspace) !== (source === 'local')) throw new Error('Session host scope mismatch')
      if (source === 'local' && binding.agent.agentKey === 'pi' && binding.modelId?.startsWith('openai-compatible::')) throw new Error('Pi Provider 模型只允许在授权集群 Session 使用')
      if (!this.available(binding)) throw new Error('Agent or model unavailable')
      return
    }
    if (!('sessionId' in command)) throw new Error('Unsupported command')
    const session = await this.store.sessions.get(command.sessionId)
    if (!session) throw new Error('Session not found')
    if ((await this.isLocalSession(command.sessionId)) !== (source === 'local')) throw new Error('Session host scope mismatch')
    if (command.kind === 'session.delete') return // Active protection is checked atomically in the store.
    if (command.kind === 'session.enqueue') {
      if ((await this.store.workspaces.get(session.binding.workspaceId))?.status !== 'ready' || !this.available(session.binding)) throw new Error('Workspace, agent or model unavailable')
    }
    if (command.kind === 'turn.stop' && (await this.store.sessions.getTurn(command.turnId))?.sessionId !== command.sessionId) throw new Error('Turn not found')
    if (command.kind === 'runtime.command') {
      if (session.binding.agent.agentKey === 'pi' && (session.binding.modelId?.startsWith('openai-compatible::') || command.name === 'set_model' && typeof command.arguments.modelId === 'string' && command.arguments.modelId.startsWith('openai-compatible::'))) throw new Error('Pi Provider 模型已固定，不能在原 Session 中使用运行时命令')
      if (command.name === 'set_model') {
        const modelId = command.arguments.modelId
        if (typeof modelId !== 'string' || !modelId) throw new Error('modelId is required')
        const capability = this.store.capabilities().find(item => item.agentKey === session.binding.agent.agentKey)
        if (!capability?.modelSwap || capability.mode !== 'execution' || capability.availability.status !== 'available') throw new Error('Agent does not support model swapping')
        if (!capability.models.some(model => model.modelId === modelId)) throw new Error('Model unavailable')
        // Persist the next-Turn choice only. Claiming a message fixes its model in
        // the same store transaction; never reconfigure an active native process.
        return
      }
      await this.agentRunner.command({ sessionId: command.sessionId, invocationId: command.operationId, name: command.name, arguments: command.arguments })
      return
    }
    if (command.kind === 'runtime.approval.resolve') {
      const connectorApproval = await this.requirePendingApproval(command, this.store)
      const identity = { sessionId: command.sessionId, turnId: command.turnId, approvalId: command.approvalId, decision: command.decision }
      if (connectorApproval) {
        if (!this.connectorControl?.resolveApproval?.(identity)) throw new Error('Connector approval is no longer pending')
        return
      }
      await this.agentRunner.resolveApproval({ sessionId: command.sessionId, invocationId: command.turnId, approvalId: command.approvalId, decision: command.decision })
      return
    }
  }
  private async requirePendingApproval(command: Extract<WorkerCommand, { kind: 'runtime.approval.resolve' }>, reader: {
    sessions: Pick<import('./ports/worker-store-types.js').SessionExecutionReader, 'get' | 'getTurn'>
    journal: Pick<import('./ports/worker-store-types.js').WorkerJournalReader, 'read'>
  }) {
    if (typeof command.turnId !== 'string' || !command.turnId.trim()) throw new Error('Explicit turnId is required for approval')
    if (typeof command.approvalId !== 'string' || !command.approvalId.trim() || !['approve', 'deny'].includes(command.decision)) throw new Error('Invalid approval decision')
    const session = await reader.sessions.get(command.sessionId)
    const turn = await reader.sessions.getTurn(command.turnId)
    if (session?.activeTurnId !== command.turnId || turn?.sessionId !== command.sessionId || !['running', 'stopping'].includes(turn.state)) throw new Error('Approval Turn is not active for this Session')
    let requested = false, resolved = false, finished = false, connectorApproval = false, fromSeq = 1
    do {
      const page = await reader.journal.read({ sessionId: command.sessionId, fromSeq: fromSeq as EventSeq, limit: 500 })
      for (const event of page.events) {
        if (event.sessionId !== command.sessionId || Number(event.seq) !== fromSeq++) throw new Error('Approval Journal history is incomplete')
        const payload = event.payload
        if (!('turnId' in payload) || payload.turnId !== command.turnId) continue
        if (payload.kind === 'turn.finished') finished = true
        if (payload.kind === 'approval.requested' && payload.approvalId === command.approvalId && !requested) { requested = true; connectorApproval = !!payload.action && typeof payload.action === 'object' && 'kind' in payload.action && payload.action.kind === 'connector' }
        if ((payload.kind === 'approval.resolved' || payload.kind === 'approval.expired') && payload.approvalId === command.approvalId && requested && !finished) resolved = true
      }
      if (!page.hasMore) break
      if (!page.events.length) throw new Error('Approval Journal history is incomplete')
    } while (true)
    if (!requested || resolved || finished) throw new Error('Approval is not pending for this Session and Turn')
    return connectorApproval
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
    this.send({ type: 'event', scope: 'workspace', report: { ...(workspace.provisionCommandId ? { commandId: workspace.provisionCommandId } : {}), workspaceId: id, status: workspace.status, reason: workspace.failureReason, occurredAt: workspace.updatedAt,
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
    let outcome: AgentTurnOutcome = { status: 'failed', failure: { code: 'agent-error', message: 'Agent ended without a terminal event' } }
    let iterator: AsyncIterator<AgentEvent> | null = null
    let privateProvider = false
    const launchGeneration = this.providerGeneration
    try {
      const session = (await this.store.sessions.get(turn.sessionId))!
      const workspace = (await this.store.workspaces.get(session.binding.workspaceId))!
      // Only pre-upgrade Turns lack a snapshot. Null explicitly selects Agent default.
      const modelId = Object.hasOwn(turn, 'modelId') ? turn.modelId! : session.binding.modelId
      const prepared = await this.launchContexts.prepare(turn)
      try {
        const fingerprint = createHash('sha256').update(canonical({ cwd: workspace.rootPath, modelId, nativeSession: session.nativeSession })).digest('hex')
        const customPi = session.binding.agent.agentKey === 'pi' && modelId?.startsWith('openai-compatible::')
        // This branch is intentionally cluster-only; local Web Sessions never
        // inherit a Server binding or credentials from a connected cluster.
        privateProvider = Boolean(customPi)
        let provider: Awaited<ReturnType<PiProviderResolver>> = null
        if (privateProvider) {
          if (this.isLocalWorkspace(workspace) || !this.providerConnectionOpen || !this.piProviderResolver || !modelId || session.nativeSession) throw new Error('pi_provider_unavailable')
          // Errors from the resolver may contain local credentials. Never copy
          // their messages to the durable Session Journal or Server.
          try { provider = await this.piProviderResolver(workspace.projectId, modelId) }
          catch { throw new Error('pi_provider_unavailable') }
          if (!provider || !this.providerConnectionOpen || this.providerGeneration !== launchGeneration) throw new Error('pi_provider_unavailable')
        }
        const runRequest = {
          appName: 'wemux-worker',
          userId: this.workerId,
          sessionId: turn.sessionId,
          invocationId: turn.id,
          agentKey: session.binding.agent.agentKey,
          modelId,
          cwd: workspace.rootPath,
          messageId: turn.message.messageId,
          message: { role: 'user' as const, parts: [{ text: turn.message.content }] },
          resume: session.nativeSession,
          configurationFingerprint: fingerprint,
          launchContext: prepared.context,
        }
        if (privateProvider && (!this.providerConnectionOpen || this.providerGeneration !== launchGeneration)) throw new Error('pi_provider_unavailable')
        iterator = (privateProvider && provider
          ? this.agentRunner.runWithPiProvider({ ...runRequest, resume: null }, provider, `${provider.bindingId}:${provider.credentialStamp ?? ''}`)
          : this.agentRunner.run(runRequest))[Symbol.asyncIterator]()
        const stoppingBeforeRun = (await this.store.sessions.getTurn(turn.id))?.state === 'stopping'
        const stopBeforeFirstRead = this.closing || stoppingBeforeRun || (privateProvider && (!this.providerConnectionOpen || this.providerGeneration !== launchGeneration))
        const startedAt = Date.now()
        let firstRead = true
        while (true) {
          const remainingAtStart = this.agentTimeouts.maxMs - (Date.now() - startedAt)
          if (remainingAtStart <= 0) throw new AgentTimeoutError('智能体执行时间超过上限，已自动终止。')
          // Keep one observed iterator.next() in flight across idle ticks.
          // Check the max deadline before requesting another result. Observe
          // any later rejection immediately, before optional callbacks run.
          const next = iterator.next()
          void next.catch(() => {})
          // Async generators register their active invocation on first next(),
          // not when constructed. A stop during preparation must be forwarded
          // after that registration, otherwise it is silently lost.
          if (firstRead) {
            firstRead = false
            if (stopBeforeFirstRead) await this.agentRunner.stop(turn.sessionId, turn.id)
          }
          let result: Awaited<typeof next>
          while (true) {
            const remainingMs = this.agentTimeouts.maxMs - (Date.now() - startedAt)
            if (remainingMs <= 0) throw new AgentTimeoutError('智能体执行时间超过上限，已自动终止。')
            const timeoutMs = Math.min(this.agentTimeouts.idleMs, remainingMs)
            const approvalPendingAtStart = this.connectorControl?.hasPendingApproval?.(turn.sessionId, turn.id) ?? false
            let timer: NodeJS.Timeout | undefined
            const raced = await Promise.race([
              next.then(value => ({ kind: 'event' as const, value })),
              new Promise<{ kind: 'idle' }>(resolve => { timer = setTimeout(() => resolve({ kind: 'idle' }), timeoutMs) }),
            ]).finally(() => { if (timer) clearTimeout(timer) })
            if (raced.kind === 'event') { result = raced.value; break }
            if (remainingMs <= this.agentTimeouts.idleMs) throw new AgentTimeoutError('智能体执行时间超过上限，已自动终止。')
            if (!approvalPendingAtStart && !this.connectorControl?.hasPendingApproval?.(turn.sessionId, turn.id)) throw new AgentTimeoutError('智能体长时间没有产生任何事件，请重试。')
          }
          if (result.done) break
          const event = result.value
          const terminal = event.customMetadata?.wemux?.terminal
          if (terminal) {
            outcome = terminal === 'failed'
              ? { status: 'failed', failure: {
                  code: event.customMetadata?.wemux?.error?.code ?? 'agent-error',
                  message: event.customMetadata?.wemux?.error?.message ?? 'Agent failed',
                  ...(event.customMetadata?.wemux?.error?.abortReason ? { abortReason: event.customMetadata.wemux.error.abortReason } : {}),
                  ...(event.customMetadata?.wemux?.error?.failureReason ? { failureReason: event.customMetadata.wemux.error.failureReason } : {}),
                  ...(event.customMetadata?.wemux?.error?.retryable !== undefined ? { retryable: event.customMetadata.wemux.error.retryable } : {}),
                } }
              : { status: terminal }
            break
          }
          const nativeSession = event.customMetadata?.wemux?.nativeSession
          const journalEvent = projectAgentEventToSessionPayload(event, turn.id)
          await this.store.transaction(async tx => {
            if (nativeSession) await tx.sessions.bindNativeSession({ sessionId: turn.sessionId, nativeSession })
            if (journalEvent) await tx.appendJournal(turn.sessionId, [{ occurredAt: event.timestamp, payload: journalEvent }])
          })
          await this.publish()
        }
      } finally {
        await this.agentRunner.stop(turn.sessionId, turn.id)
        await iterator?.return?.()
        await prepared.cleanup()
      }
    } catch (error) {
      const message = privateProvider
        ? 'Pi Provider 不可用或执行失败，请检查 Worker 本地配置'
        : error instanceof Error ? error.message : 'Agent failed'
      outcome = { status: 'failed', failure: {
        code: 'agent-error',
        message,
        abortReason: error instanceof AgentTimeoutError ? 'timeout' : this.closing ? 'executor_disconnected' : 'provider_error',
      } }
    }
    await this.store.transaction(tx => tx.sessions.finishTurn(outcome.status === 'failed'
      ? { turnId: turn.id, outcome: 'failed', failure: outcome.failure, finishedAt: now() }
      : { turnId: turn.id, outcome: outcome.status, finishedAt: now() }))
    await this.publish()
  }
  private publish(): Promise<void> {
    const work = this.publishing.then(async () => {
      for (const head of await this.store.journal.listHeads()) {
        if (await this.isLocalSession(head.sessionId)) continue
        let from = (this.sent.get(head.sessionId) ?? 0) + 1
        while (from <= head.lastSeq) {
          const page = await this.store.journal.read({ sessionId: head.sessionId, fromSeq: from as EventSeq, limit: 256 })
          if (!page.events.length) break
          for (const event of page.events) await this.send({ type: 'event', scope: 'session', event })
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
    await this.agentRunner.close()
    this.terminals?.disposeAll()
    this.terminalSessions.clear()
    await this.provisioner.stop?.()
    await this.commands
    await this.fileWriteExecutor?.close()
    await Promise.all(this.provisions.values())
    await Promise.all(this.tasks.values())
    await this.publishing
  }
  /** 同步强制终止：不等待任何 in-flight promise，只杀 agent 子进程。永不挂起。不证明已开始的文件 I/O 停止。 */
  abort() {
    if (this.aborted) return
    this.aborted = true
    this.closing = true
    if (this.headRefresh) clearInterval(this.headRefresh)
    this.headRefresh = null
    try { this.agentRunner.abort() } catch {}
    try { this.terminals?.disposeAll() } catch {}
    this.terminalSessions.clear()
  }
}
