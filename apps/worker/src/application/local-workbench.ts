import { createHash, randomUUID } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import type { AgentKey, CommandId, MessageId, ModelId, ProjectId, SessionId, Timestamp, WorkerId, WorkspaceId } from '@wemux/domain'
import type { CommandReceipt, WorkerCommand } from '@wemux/wire-protocol'
import type { LocalState } from './ports/local-state.js'
import type { WorkerStore } from './ports/worker-store.js'
import type { SessionExecution } from '../domain/session-execution.js'
type LocalCommandExecutor = { executeLocal(commandId: CommandId, command: WorkerCommand): Promise<CommandReceipt> }

const timestamp = () => new Date().toISOString() as Timestamp
const localProjectId = 'local' as ProjectId
const localWorkerId = (installationId: string) => `local-${installationId}` as WorkerId

export class LocalWorkbenchError extends Error {}

export interface LocalDirectorySummary {
  readonly workspaceId: WorkspaceId
  readonly name: string
  readonly path: string
  readonly addedAt: Timestamp
}

export interface LocalRequestIdentity { commandId: string; messageId: string }

export interface LocalWorkbenchService {
  listDirectories(): Promise<readonly LocalDirectorySummary[]>
  addDirectory(path: string): Promise<LocalDirectorySummary>
  listSessions(): Promise<readonly SessionExecution[]>
  createSession(input: { workspaceId: string; agentKey: string; modelId: string | null; requestId?: string }): Promise<SessionExecution>
  deleteSession(sessionId: string): Promise<CommandReceipt>
  enqueue(sessionId: string, content: string, identity?: LocalRequestIdentity): Promise<CommandReceipt>
  queue(sessionId: string): ReturnType<WorkerStore['sessions']['listQueued']>
  approvals(sessionId: string): Promise<readonly Extract<import('@wemux/domain').JournalEvent['payload'], { kind: 'approval.requested' }>[]>
  supportedCommands(sessionId: string): Promise<readonly string[]>
  command(sessionId: string, name: string, commandId?: string): Promise<CommandReceipt>
  resolveApproval(sessionId: string, approvalId: string, decision: 'approve' | 'deny', commandId: string | undefined, turnId: string): Promise<CommandReceipt>
  cancelQueued(sessionId: string, submissionCommandId: string): Promise<CommandReceipt>
  stop(sessionId: string, turnId: string): Promise<CommandReceipt>
  journal(sessionId: string, fromSeq: number, limit: number): ReturnType<WorkerStore['journal']['read']>
}

async function requireDirectory(input: string) {
  if (!input || input.length > 4096) throw new LocalWorkbenchError('目录路径无效')
  try {
    const canonical = await realpath(resolve(input))
    const stat = await lstat(canonical)
    if (!stat.isDirectory()) throw new LocalWorkbenchError('路径不是目录')
    return canonical
  } catch (error) {
    if (error instanceof LocalWorkbenchError) throw error
    throw new LocalWorkbenchError('目录不存在或不可访问')
  }
}

export function createLocalWorkbenchService(store: WorkerStore & LocalState, runtime: LocalCommandExecutor): LocalWorkbenchService {
  const installation = store.localInstallation()
  if (!installation) throw new Error('Local installation is not initialized')
  const workerId = localWorkerId(installation.installationId)
  // Namespace client identities by installation and operation; the runtime persists payload fingerprints.
  const identity = (scope: string, value?: string) => {
    if (value !== undefined && (!/^[a-zA-Z0-9_-]{1,128}$/.test(value))) throw new LocalWorkbenchError('请求标识无效')
    return createHash('sha256').update(`${workerId}:${scope}:${value ?? randomUUID()}`).digest('hex')
  }
  const execute = (command: WorkerCommand, commandId?: string) => runtime.executeLocal((commandId ?? randomUUID()) as CommandId, command)
  const directoryName = (path: string) => basename(path) || path
  const requireLocalSession = async (input: string) => {
    const session = await store.sessions.get(input as SessionId)
    if (!session || session.binding.agent.workerId !== workerId) throw new LocalWorkbenchError('本地会话不存在')
    return session
  }
  const accepted = async (receipt: CommandReceipt) => {
    if (receipt.status === 'rejected') throw new LocalWorkbenchError(receipt.error.message)
    return receipt
  }
  const service: LocalWorkbenchService = {
    async listDirectories() {
      return (await store.listWorkspaces()).filter(item => item.projectId === localProjectId && item.workerId === workerId && item.status === 'ready').map(item => ({ workspaceId: item.id, name: directoryName(item.rootPath), path: item.rootPath, addedAt: item.updatedAt }))
    },
    async addDirectory(input) {
      const path = await requireDirectory(input)
      const existing = (await store.listWorkspaces()).find(item => item.projectId === localProjectId && item.workerId === workerId && item.rootPath === path)
      if (existing) return { workspaceId: existing.id, name: directoryName(existing.rootPath), path: existing.rootPath, addedAt: existing.updatedAt }
      const workspaceId = randomUUID() as WorkspaceId
      const name = basename(path) || path
      const addedAt = timestamp()
      await store.transaction(tx => tx.workspaces.save({ id: workspaceId, workerId, projectId: localProjectId, spec: { kind: 'composite', memberWorkspaceIds: [] }, rootPath: path, status: 'ready', failureReason: null, updatedAt: addedAt }))
      return { workspaceId, name, path, addedAt }
    },
    async listSessions() {
      return (await store.listSessions()).filter(session => session.binding.agent.workerId === workerId)
    },
    async createSession(input) {
      const workspace = await store.workspaces.get(input.workspaceId as WorkspaceId)
      if (!workspace || workspace.projectId !== localProjectId || workspace.workerId !== workerId || workspace.status !== 'ready') throw new LocalWorkbenchError('本地目录不存在或不可用')
      const commandId = identity('create', input.requestId)
      const sessionId = identity('session', commandId) as SessionId
      const receipt = await execute({ kind: 'session.create', session: { sessionId, storageMode: 'local', binding: { workspaceId: workspace.id, agent: { workerId, agentKey: input.agentKey as AgentKey }, modelId: (input.modelId ?? null) as ModelId | null } } }, commandId)
      if (receipt.status === 'rejected') throw new LocalWorkbenchError(receipt.error.message)
      const session = await store.sessions.get(sessionId)
      if (!session) throw new LocalWorkbenchError('本地会话创建失败')
      return session
    },
    async deleteSession(sessionId) {
      await requireLocalSession(sessionId)
      return accepted(await execute({ kind: 'session.delete', sessionId: sessionId as SessionId }))
    },
    async enqueue(sessionId, content, request) {
      if (!content.trim() || content.length > 100_000) throw new LocalWorkbenchError('消息内容无效')
      await requireLocalSession(sessionId)
      return accepted(await execute({ kind: 'session.enqueue', sessionId: sessionId as SessionId, message: { messageId: identity(`message:${sessionId}`, request?.messageId) as MessageId, content } }, identity(`enqueue:${sessionId}`, request?.commandId)))
    },
    async queue(sessionId) {
      await requireLocalSession(sessionId)
      // Capability credentials are runtime-only, never part of the local Web response.
      return (await store.sessions.listQueued(sessionId as SessionId)).map(item => ({ ...item, capabilityToken: null, capabilitySnapshot: null }))
    },
    async approvals(sessionId) {
      const session = await requireLocalSession(sessionId)
      if (!session.activeTurnId) return []
      const pending = new Map<string, Extract<import('@wemux/domain').JournalEvent['payload'], { kind: 'approval.requested' }>>()
      const seen = new Set<string>()
      let finished = false
      let fromSeq = 1
      do {
        const page = await store.journal.read({ sessionId: sessionId as SessionId, fromSeq: fromSeq as import('@wemux/domain').EventSeq, limit: 500 })
        for (const event of page.events) {
          const p = event.payload
          if (p.kind === 'turn.finished' && p.turnId === session.activeTurnId) { finished = true; pending.clear() }
          if (p.kind === 'approval.requested' && p.turnId === session.activeTurnId && !seen.has(p.approvalId)) {
            seen.add(p.approvalId)
            if (!finished) pending.set(p.approvalId, p)
          }
          if ((p.kind === 'approval.resolved' || p.kind === 'approval.expired') && p.turnId === session.activeTurnId) pending.delete(p.approvalId)
        }
        if (!page.hasMore || !page.events.length) break
        fromSeq = Number(page.events.at(-1)!.seq) + 1
      } while (true)
      return [...pending.values()]
    },
    async supportedCommands(sessionId) {
      const session = await requireLocalSession(sessionId)
      const capability = store.capabilities().find(item => item.agentKey === session.binding.agent.agentKey && item.mode === 'execution' && item.availability.status === 'available')
      return capability?.runtime?.commands ?? (capability?.agentKey === 'pi' ? ['compact'] : [])
    },
    async command(sessionId, name, requestId) {
      if (!(await this.supportedCommands(sessionId)).includes(name)) throw new LocalWorkbenchError('不支持的运行时命令')
      const commandId = identity(`command:${sessionId}`, requestId)
      return accepted(await execute({ kind: 'runtime.command', sessionId: sessionId as SessionId, operationId: commandId as import('@wemux/domain').RuntimeOperationId, name: 'compact', arguments: {} }, commandId))
    },
    async resolveApproval(sessionId, approvalId, decision, requestId, turnId) {
      await requireLocalSession(sessionId)
      if (decision !== 'approve' && decision !== 'deny') throw new LocalWorkbenchError('批准决定无效')
      if (!approvalId || approvalId.length > 256) throw new LocalWorkbenchError('批准标识无效')
      if (typeof turnId !== 'string' || !turnId.trim() || turnId.length > 200) throw new LocalWorkbenchError('Explicit turnId is required for approval')
      const legacy = await store.commands.get(identity(`approval:${sessionId}:${approvalId}`, 'resolve') as CommandId)
      if (legacy?.command.kind === 'runtime.approval.resolve' && legacy.command.sessionId === sessionId && legacy.command.approvalId === approvalId && !('turnId' in legacy.command)) {
        throw new LocalWorkbenchError('legacy-unbound approval command requires explicit migration; decision was not redispatched')
      }
      // Explicit caller IDs share one operation namespace so changed targets conflict.
      const commandId = requestId === undefined ? identity(`approval:${JSON.stringify([sessionId, turnId, approvalId])}`, 'resolve') : identity('approval-request', requestId)
      return accepted(await execute({ kind: 'runtime.approval.resolve', sessionId: sessionId as SessionId, turnId: turnId as import('@wemux/domain').TurnId, approvalId: approvalId as import('@wemux/domain').ApprovalId, decision }, commandId))
    },
    async cancelQueued(sessionId, submissionCommandId) {
      await requireLocalSession(sessionId)
      return accepted(await execute({ kind: 'session.cancel-queued', sessionId: sessionId as SessionId, submissionCommandId: submissionCommandId as CommandId }))
    },
    async stop(sessionId, turnId) {
      await requireLocalSession(sessionId)
      return accepted(await execute({ kind: 'turn.stop', sessionId: sessionId as SessionId, turnId: turnId as import('@wemux/domain').TurnId }))
    },
    async journal(sessionId, fromSeq, limit) {
      await requireLocalSession(sessionId)
      if (fromSeq === 0) {
        const head = (await store.journal.listHeads()).find(item => item.sessionId === sessionId)
        fromSeq = Math.max(1, Number(head?.lastSeq ?? 0) - limit + 1)
      }
      return store.journal.read({ sessionId: sessionId as SessionId, fromSeq: fromSeq as import('@wemux/domain').EventSeq, limit })
    },
  }
  return service
}
