import type {
  AgentInboxMessage,
  CapabilityAsset,
  CommandId,
  EventSeq,
  JournalEvent,
  SessionId,
  TeamId,
  Timestamp,
  UserId,
  ProjectId,
  WorkerId,
} from '@wemux/domain'
import type {
  AuditEntry,
  CommandProjection,
  EnrollmentTokenRecord,
  LocalAccountCredential,
  Membership,
  PersonalAccessTokenRecord,
  Project,
  ProjectGrant,
  Repository,
  Session,
  Team,
  User,
  SessionCacheState,
  SessionGrant,
  Worker,
  WorkerCredentialRecord,
  WorkerGrant,
  Workspace,
} from '@wemux/server-domain'
import type { CommandReceipt, WorkerCommand } from '@wemux/wire-protocol'

export interface ServerTaskReader {
  reviewById(id: string): Promise<import('@wemux/web-contract/task-platform').ReviewRequest | null>
  review(runId: string): Promise<import('@wemux/web-contract/task-platform').ReviewRequest | null>
  pendingReviews(projectId: string): Promise<readonly import('@wemux/web-contract/task-platform').ReviewRequest[]>
  projectActivity(projectId: string, after: number): Promise<readonly import('@wemux/web-contract/task-platform').ProjectActivityItem[]>
  cancelRequest(runId: string, requestId: string): Promise<string | null>
  runs(taskId: string): Promise<readonly import('@wemux/web-contract/task-platform').Run[]>
  run(id: string): Promise<import('@wemux/web-contract/task-platform').Run | null>
  runByRequest(taskId: string, requestId: string): Promise<import('@wemux/web-contract/task-platform').Run | null>
  runByCommand(commandId: string): Promise<import('@wemux/web-contract/task-platform').Run | null>
  bindings(taskId: string): Promise<readonly import('@wemux/web-contract/task-platform').TaskWorkspace[]>
  binding(workspaceId: string): Promise<import('@wemux/web-contract/task-platform').TaskWorkspace | null>
  /** Query seam for Run snapshot occupancy; never infer occupancy from Assignment. */
  activeRunUsesWorkspace(workspaceId: string): Promise<boolean>
  list(projectId: string): Promise<readonly import('@wemux/web-contract/task-platform').TaskSummary[]>
  get(id: string): Promise<import('@wemux/web-contract/task-platform').TaskDetail | null>
  activity(id: string, after: number): Promise<readonly import('@wemux/web-contract/task-platform').TaskActivity[]>
}
export interface ServerTaskWriter {
  saveReview(review: import('@wemux/web-contract/task-platform').ReviewRequest): Promise<void>
  saveCancelRequest(runId: string, requestId: string, sessionId: string): Promise<void>
  saveRun(run: import('@wemux/web-contract/task-platform').Run): Promise<void>
  bind(binding: import('@wemux/web-contract/task-platform').TaskWorkspace): Promise<void>
  unbind(taskId: string, workspaceId: string): Promise<void>
  save(task: import('@wemux/web-contract/task-platform').TaskDetail): Promise<void>
  append(event: Omit<import('@wemux/web-contract/task-platform').TaskActivity, 'seq'>, sourceKey?: string): Promise<void>
}

export interface PendingCommand {
  readonly commandId: CommandId
  readonly workerId: WorkerId
  readonly command: WorkerCommand
  readonly payloadFingerprint: string
  readonly createdAt: Timestamp
}

export interface SessionEventPage {
  readonly events: readonly JournalEvent[]
  readonly nextSeq: EventSeq | null
}

export interface IdentityRecords {
  readonly membership: Membership | null
  readonly workerGrant: WorkerGrant | null
  readonly projectGrant: ProjectGrant | null
  readonly sessionGrant: SessionGrant | null
}

export interface ServerIdentityReader {
  getUser(userId: UserId): Promise<User | null>
  getUserByLogin(login: string): Promise<User | null>
  getTeam(teamId: TeamId): Promise<Team | null>
  getLocalAccountCredential(userId: UserId): Promise<LocalAccountCredential | null>

  getIdentityRecords(input: {
    readonly userId: UserId
    readonly teamId: TeamId
    readonly workerId?: WorkerId
    readonly projectId?: import('@wemux/domain').ProjectId
    readonly sessionId?: SessionId
  }): Promise<IdentityRecords>

  findPersonalAccessToken(tokenHash: string): Promise<PersonalAccessTokenRecord | null>
  findWorkerCredential(credentialHash: string): Promise<WorkerCredentialRecord | null>
}

export interface ServerIdentityWriter {
  saveUser(user: User): Promise<void>
  saveTeam(team: Team): Promise<void>
  saveLocalAccountCredential(credential: LocalAccountCredential): Promise<void>
  saveMembership(membership: Membership): Promise<void>
  removeMembership(teamId: TeamId, userId: UserId): Promise<void>
  saveWorkerGrant(grant: WorkerGrant): Promise<void>
  saveProjectGrant(grant: ProjectGrant): Promise<void>
  saveSessionGrant(grant: SessionGrant): Promise<void>
  savePersonalAccessToken(record: PersonalAccessTokenRecord): Promise<void>
  revokePersonalAccessToken(id: import('@wemux/domain').CredentialId, revokedAt: Timestamp): Promise<void>
  saveEnrollmentToken(record: EnrollmentTokenRecord): Promise<void>
  consumeEnrollmentToken(input: {
    readonly tokenHash: string
    readonly workerId: WorkerId
    readonly consumedAt: Timestamp
  }): Promise<EnrollmentTokenRecord>
  saveWorkerCredential(record: WorkerCredentialRecord): Promise<void>
  revokeWorkerCredential(workerId: WorkerId, revokedAt: Timestamp): Promise<void>
}

export interface AgentInboxMessageInput {
  readonly message: AgentInboxMessage
  readonly idempotencyKey: string
}

export interface ServerResourceReader {
  listWorkers(): Promise<readonly Worker[]>
  listProjects(): Promise<readonly Project[]>
  listWorkspaces(): Promise<readonly Workspace[]>
  listSessions(): Promise<readonly Session[]>
  getWorker(workerId: WorkerId): Promise<Worker | null>
  getProject(projectId: import('@wemux/domain').ProjectId): Promise<Project | null>
  getRepository(repositoryId: import('@wemux/domain').RepositoryId): Promise<Repository | null>
  getWorkspace(workspaceId: import('@wemux/domain').WorkspaceId): Promise<Workspace | null>
  getSession(sessionId: SessionId): Promise<Session | null>
  listCapabilityAssets(projectId: ProjectId): Promise<readonly CapabilityAsset[]>
  listAgentInboxMessages(sessionId: SessionId, unreadOnly?: boolean): Promise<readonly AgentInboxMessage[]>
  getAgentInboxMessage(messageId: string): Promise<AgentInboxMessage | null>
}

export interface ServerResourceWriter {
  saveWorker(worker: Worker): Promise<void>
  saveProject(project: Project): Promise<void>
  saveRepository(repository: Repository): Promise<void>
  saveWorkspace(workspace: Workspace): Promise<void>
  saveSession(session: Session): Promise<void>
  replaceCapabilityAssets(projectId: ProjectId, assets: readonly CapabilityAsset[]): Promise<void>
  createAgentInboxMessage(input: AgentInboxMessageInput): Promise<AgentInboxMessage>
  markAgentInboxMessageRead(messageId: string, readAt: Timestamp): Promise<AgentInboxMessage | null>
}

export interface ServerCommandReader {
  getPendingCommand(commandId: CommandId): Promise<PendingCommand | null>
  get(commandId: CommandId): Promise<CommandProjection | null>
  /** Includes pending and terminal history, even for legacy Workspaces without attempt metadata. */
  hasProvisionAttempt(workspaceId: import('@wemux/domain').WorkspaceId): Promise<boolean>
  /** All pending/accepted Turn submissions for this Session, without a history window. */
  listUnsettledEnqueues(sessionId: SessionId): Promise<readonly PendingCommand[]>
  listDeliverable(workerId: WorkerId, limit: number): Promise<readonly PendingCommand[]>
  list(input: { readonly workerId?: WorkerId; readonly status?: CommandProjection['status']; readonly limit: number }): Promise<readonly CommandProjection[]>
}

export interface ServerCommandWriter {
  depend(commandId: CommandId, prerequisiteId: CommandId): Promise<void>
  insertPending(command: PendingCommand): Promise<void>
  recordReceipt(receipt: CommandReceipt, recordedAt: Timestamp): Promise<void>
  /** Cancel a still-pending command; resolves false when it is missing or no longer pending. */
  cancelPending(commandId: CommandId, cancelledAt: Timestamp): Promise<boolean>
}

export interface ServerCacheReader {
  readEvents(sessionId: SessionId, fromSeq: EventSeq, limit: number): Promise<SessionEventPage>
  getFreshness(sessionId: SessionId): Promise<SessionCacheState | null>
}

export interface ServerCacheWriter {
  deleteSessionHistory(sessionId: SessionId): Promise<void>
  markSessionGap(sessionId: SessionId): Promise<SessionCacheState>
  applyEvents(sessionId: SessionId, events: readonly JournalEvent[]): Promise<SessionCacheState>
  recordWorkerHead(sessionId: SessionId, lastSeq: EventSeq): Promise<SessionCacheState>
  markWorkerOffline(workerId: WorkerId): Promise<void>
  markWorkerOrphaned(workerId: WorkerId): Promise<void>
}

export interface ServerAuditWriter {
  append(entry: AuditEntry): Promise<void>
}
