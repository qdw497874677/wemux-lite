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
  ExternalLoginIdentity,
  InstanceAdministrator,
  InstanceSettings,
  LocalAccountCredential,
  LoginIdentityProvider,
  LoginSession,
  Membership,
  OAuthTransaction,
  PersonalAccessTokenRecord,
  Project,
  ProjectGrant,
  RegistrationAttempt,
  RegistrationPolicy,
  Repository,
  Session,
  SessionForkRecord,
  Team,
  User,
  UserEmail,
  SessionCacheState,
  SessionGrant,
  VerificationChallenge,
  VerificationPurpose,
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
  /** 主邮箱唯一占用表的权威查询：只看规范化结果，不猜供应商别名。 */
  getUserByEmail(emailNormalized: string): Promise<User | null>
  getUserEmail(userId: UserId): Promise<UserEmail | null>
  getRegistrationAttempt(id: string): Promise<RegistrationAttempt | null>
  /** 同一邮箱最多一个待验证注册（由 partial unique index 保证）。 */
  findPendingRegistration(emailNormalized: string): Promise<RegistrationAttempt | null>
  findVerificationChallengeByTokenHash(tokenHash: string): Promise<VerificationChallenge | null>
  /** 重发/限流窗口内的挑战历史；只返回挑战元数据，不返回令牌。 */
  listVerificationChallenges(targetEmail: string, purpose: VerificationPurpose, since: Timestamp): Promise<readonly VerificationChallenge[]>
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
  /** Browser login sessions are looked up by hashed token; the raw token is never stored. */
  findLoginSessionByTokenHash(tokenHash: string): Promise<LoginSession | null>
  getLoginSession(id: string): Promise<LoginSession | null>
  listLoginSessions(userId: UserId): Promise<readonly LoginSession[]>
  listPersonalAccessTokens(): Promise<readonly PersonalAccessTokenRecord[]>
  listUsers(): Promise<readonly User[]>
  /** 用户在哪些 Team 中有成员身份；Team 选择与登录默认 Team 由此得出。 */
  listMemberships(userId: UserId): Promise<readonly Membership[]>
  /** Newest-first audit entries; durable report channel for administrator assignment and upgrade decisions. */
  listAudit(limit: number): Promise<readonly AuditEntry[]>
  /**
   * 实例管理员归属（部署声明的邮箱命中后落盘）。权威判定仍由 `AdministratorDirectory`
   * 依据启动配置做出，这里只负责记住“谁在何时按哪种来源成为管理员”。
   */
  findInstanceAdministrator(userId: UserId): Promise<InstanceAdministrator | null>
  listInstanceAdministrators(): Promise<readonly InstanceAdministrator[]>
  /** 实例设置（目前只有注册策略）；null 表示尚未显式设置，调用方用默认值。 */
  getInstanceSettings(): Promise<InstanceSettings | null>
  findWorkerCredential(credentialHash: string): Promise<WorkerCredentialRecord | null>
  /** 外部登录身份的唯一查询入口：(provider, issuer, subject) 就是身份主键，邮箱不参与判定。 */
  findLoginIdentity(provider: LoginIdentityProvider, issuer: string, subject: string): Promise<ExternalLoginIdentity | null>
  listLoginIdentities(userId: UserId): Promise<readonly ExternalLoginIdentity[]>
  findOAuthTransactionByStateHash(stateHash: string): Promise<OAuthTransaction | null>
}

export interface ServerIdentityWriter {
  saveUser(user: User): Promise<void>
  /** 占用主邮箱；邮箱已被其他账号占用时拒绝，不静默改派。 */
  saveUserEmail(record: UserEmail): Promise<void>
  saveTeam(team: Team): Promise<void>
  saveLocalAccountCredential(credential: LocalAccountCredential): Promise<void>
  saveRegistrationAttempt(attempt: RegistrationAttempt): Promise<void>
  /** 待验证注册的终态迁移（verified/expired/superseded）；未注册记录拒绝。 */
  updateRegistrationAttempt(attempt: RegistrationAttempt): Promise<void>
  saveVerificationChallenge(challenge: VerificationChallenge): Promise<void>
  /** 单次消费：不存在、已消费或已过期都返回 null，绝不复用同一令牌。 */
  consumeVerificationChallenge(input: { readonly tokenHash: string; readonly consumedAt: Timestamp }): Promise<VerificationChallenge | null>
  saveMembership(membership: Membership): Promise<void>
  removeMembership(teamId: TeamId, userId: UserId): Promise<void>
  saveWorkerGrant(grant: WorkerGrant): Promise<void>
  saveProjectGrant(grant: ProjectGrant): Promise<void>
  saveSessionGrant(grant: SessionGrant): Promise<void>
  savePersonalAccessToken(record: PersonalAccessTokenRecord): Promise<void>
  revokePersonalAccessToken(id: import('@wemux/domain').CredentialId, revokedAt: Timestamp): Promise<void>
  /** Revokes every PAT of a user (or of all users when userId is null) and reports how many changed. */
  revokePersonalAccessTokens(userId: UserId | null, revokedAt: Timestamp): Promise<number>
  /** 覆盖式保存实例设置（单例）；策略变更必须可审计。 */
  saveInstanceSettings(settings: InstanceSettings): Promise<void>
  saveLoginSession(session: LoginSession): Promise<void>
  /** Advances activity/idle expiry only; identity and absolute expiry are immutable. */
  touchLoginSession(input: { readonly id: string; readonly lastSeenAt: Timestamp; readonly idleExpiresAt: Timestamp }): Promise<void>
  /** CSRF 令牌可重新签发（只存哈希）；除开机令牌前不改变会话身份与期限。 */
  rotateLoginSessionCsrf(input: { readonly id: string; readonly csrfTokenHash: string }): Promise<void>
  revokeLoginSession(id: string, revokedAt: Timestamp): Promise<void>
  /** Revokes one user's active login sessions (logout-all and credential changes) and reports how many changed. */
  revokeLoginSessions(userId: UserId, revokedAt: Timestamp): Promise<number>
  /** 写入管理员归属；同一用户重复写入必须是拒绝而不是静默改派。 */
  saveInstanceAdministrator(record: InstanceAdministrator): Promise<void>
  saveEnrollmentToken(record: EnrollmentTokenRecord): Promise<void>
  consumeEnrollmentToken(input: {
    readonly tokenHash: string
    readonly workerId: WorkerId
    readonly consumedAt: Timestamp
  }): Promise<EnrollmentTokenRecord>
  saveWorkerCredential(record: WorkerCredentialRecord): Promise<void>
  revokeWorkerCredential(workerId: WorkerId, revokedAt: Timestamp): Promise<void>
  /** 绑定外部登录身份；同一 (provider, issuer, subject) 或同一账号的重复绑定都拒绝，不静默改派。 */
  saveLoginIdentity(identity: ExternalLoginIdentity): Promise<void>
  /** 只推进最近登录时间；绑定关系与创建时间不可变。 */
  touchLoginIdentity(input: { readonly id: string; readonly lastSignInAt: Timestamp }): Promise<void>
  /** 保存登录事务并顺带清理早已过期的旧事务，避免一次性材料无限堆积。 */
  saveOAuthTransaction(transaction: OAuthTransaction): Promise<void>
  /** 单次消费：不存在、已消费或已过期都返回 null，重放与跨浏览器 state 绝不复用。 */
  consumeOAuthTransaction(input: { readonly stateHash: string; readonly consumedAt: Timestamp }): Promise<OAuthTransaction | null>
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
  getSessionByCreateRequest(ownerId: UserId, projectId: ProjectId, requestId: string): Promise<Session | null>
  /** Lineage edges of one Project; callers filter by Session instead of re-listing the whole store. */
  listSessionForks(projectId: import('@wemux/domain').ProjectId): Promise<readonly SessionForkRecord[]>
  getSessionFork(forkId: import('@wemux/domain').SessionForkId): Promise<SessionForkRecord | null>
  /** Idempotency lookup: one Fork per (Project, requestId), independent of the caller. */
  getSessionForkByRequest(projectId: import('@wemux/domain').ProjectId, requestId: string): Promise<SessionForkRecord | null>
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
  /** Fork row plus its (Project, requestId) index are written in the caller's transaction, atomically with the target Session. */
  saveSessionFork(record: SessionForkRecord): Promise<void>
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
