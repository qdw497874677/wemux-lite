import { validReviewMetadata } from '@wemux/web-contract/task-platform'
import { DatabaseSync } from 'node:sqlite'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { AgentInboxMessage, CapabilityAsset, EventSeq, JournalEvent, ProjectId, SessionId, Timestamp, WorkerId } from '@wemux/domain'
import type { AuditEntry, CommandProjection, EnrollmentTokenRecord, ExternalLoginIdentity, Membership, OAuthTransaction, PersonalAccessTokenRecord, RegistrationAttempt, SessionCacheState, SessionForkRecord, User, UserEmail, VerificationChallenge, VerificationPurpose, Worker, WorkerCredentialRecord, Workspace } from '@wemux/server-domain'
import type { ServerStore, ServerStoreTx } from '../../application/ports/server-store.js'
import type { PendingCommand } from '../../application/ports/server-store-types.js'
import { AppError } from '../../application/errors.js'
import { migrate } from './migrations.js'

/** One Fork per (Project, requestId): the idempotency index row points at the winning Fork. */
const forkRequestIndexId = (projectId: ProjectId, requestId: string): string => `${projectId}:${requestId}`

/** JSON holds domain records; indexed command/event columns implement ordering and uniqueness. */
export class SqliteServerStore implements ServerStore {
  private readonly db: DatabaseSync
  private queue: Promise<unknown> = Promise.resolve()
  private readonly transactionContext = new AsyncLocalStorage<{ id: symbol; active: boolean }>()
  private activeTransactionId: symbol | undefined
  /** Every method (including a captured method) checks its own transaction lease. */
  private transactionFacade(token: { id: symbol; active: boolean }): ServerStoreTx {
    const guard = <T extends object>(methods: T): T => new Proxy(methods, {
      get: (target, key) => {
        const method: unknown = Reflect.get(target, key)
        if (typeof method !== 'function') return method
        return async (...args: unknown[]) => {
          if (!token.active || this.activeTransactionId !== token.id) throw new Error('Transaction is no longer active')
          return method(...args)
        }
      },
    })
    return {
      tasks: guard(this.tx.tasks), identity: guard(this.tx.identity), resources: guard(this.tx.resources),
      commands: guard(this.tx.commands), cache: guard(this.tx.cache), audit: guard(this.tx.audit),
    }
  }
  /** Reads join the same FIFO as writes; a read never races a later BEGIN. */
  private committed<T extends object>(reader: T): T {
    return new Proxy(reader, {
      get: (target, key) => {
        const read: unknown = Reflect.get(target, key)
        if (typeof read !== 'function') return read
        return (...args: unknown[]) => {
          if (this.transactionContext.getStore()?.active) return Promise.reject(new Error('Use tx readers inside a transaction'))
          const result = this.queue.then(() => read(...args))
          this.queue = result.catch(() => undefined)
          return result
        }
      },
    })
  }
  /**
   * `presenceReset` 只属于“拥有这些连接的进程”启动时：把持久化的在线/新鲜度状态清成离线。
   * 默认关闭，因为任何只读入口（`credentials` 本机 CLI、验收脚本、备份）打开同一个数据库
   * 都不能影响正在运行的 Server 的连接状态。历史上本机 CLI 会把在线 Worker 刷成离线，
   * 而那条连接还在心跳，界面就永远停在离线。
   */
  constructor(path: string, options: { presenceReset?: boolean } = {}) {
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;')
    try { migrate(this.db) } catch (error) { this.db.close(); throw error }
    if (options.presenceReset) {
      for (const worker of this.list<Worker>('worker')) this.put('worker', worker.id, { ...worker, connectionState: 'offline' })
      for (const cache of this.list<SessionCacheState>('cache')) this.put('cache', cache.sessionId, { ...cache, status: 'offline' })
    }
  }
  close(): void { this.db.close() }
  private get<T>(kind: string, id: string): T | null {
    const row = this.db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind, id)
    return row ? JSON.parse(String(row.data)) as T : null
  }
  private list<T>(kind: string): T[] {
    return this.db.prepare('SELECT data FROM records WHERE kind=? ORDER BY rowid').all(kind).map(row => JSON.parse(String(row.data)) as T)
  }
  private put(kind: string, id: string, data: unknown): void {
    const normalized = kind === 'workspace' ? this.normalizeWorkspaceWrite(data as Workspace & { workerId?: WorkerId; status?: import('@wemux/domain').WorkspaceStatus }) : data
    this.db.prepare('INSERT INTO records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data').run(kind, id, JSON.stringify(normalized))
  }
  private normalizeWorkspaceWrite(workspace: Workspace & { workerId?: WorkerId; status?: import('@wemux/domain').WorkspaceStatus }): Workspace {
    const compatibility = workspace as Workspace & { workerId?: WorkerId; status?: import('@wemux/domain').WorkspaceStatus; failureReason?: string | null; provisioning?: Workspace['placements'][number]['provisioning']; location?: Workspace['placements'][number]['location'] }
    const inferredWorkerId = compatibility.workerId ?? (workspace.placements.length === 1 ? workspace.placements[0].workerId : undefined)
    if (!inferredWorkerId || !compatibility.status || compatibility.status === 'unplaced' || compatibility.status === 'deleted') {
      const { workerId: _workerId, status: _status, failureReason: _failureReason, provisioning: _provisioning, location: _location, ...logical } = compatibility
      return logical
    }
    const placement = workspace.placements.find(value => value.workerId === inferredWorkerId) ?? {
      workerId: inferredWorkerId,
      status: compatibility.status as import('@wemux/domain').WorkspacePlacementStatus,
      failureReason: null,
      location: null,
    }
    const next = {
      ...placement,
      status: compatibility.status,
      failureReason: compatibility.failureReason ?? placement.failureReason,
      ...(compatibility.provisioning ? { provisioning: compatibility.provisioning } : {}),
      location: compatibility.location ?? placement.location,
    }
    const { workerId: _workerId, status: _status, failureReason: _failureReason, provisioning: _provisioning, location: _location, ...logical } = compatibility
    return {
      ...logical,
      ...(compatibility.workerId ? {
        workerId: inferredWorkerId,
        status: next.status,
        failureReason: next.failureReason,
        provisioning: next.provisioning,
        location: next.location,
      } : {}),
      placements: [...workspace.placements.filter(value => value.workerId !== inferredWorkerId), next],
    }
  }
  private remove(kind: string, id: string): void { this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind, id) }
  private workspace(id: string): Workspace | null {
    const stored = this.get<Workspace & Record<string, unknown>>('workspace', id)
    if (!stored) return null
    const logical = Array.isArray(stored.placements) ? stored : (() => {
      const legacy = stored as Workspace & { workerId?: WorkerId; status?: import('@wemux/domain').WorkspaceStatus; failureReason?: string | null; provisioning?: Workspace['placements'][number]['provisioning']; location?: Workspace['placements'][number]['location'] }
      const { workerId, status, failureReason, provisioning, location } = legacy
      return {
        id: legacy.id,
        projectId: legacy.projectId,
        name: legacy.name,
        spec: legacy.spec,
        deletedAt: status === 'deleted' ? (new Date(0).toISOString() as Timestamp) : null,
        placements: workerId && status && status !== 'unplaced' && status !== 'deleted'
          ? [{ workerId, status, failureReason: failureReason ?? null, ...(provisioning ? { provisioning } : {}), location: location ?? null }]
          : [],
      } satisfies Workspace
    })()
    const placement = logical.placements.length === 1 ? logical.placements[0] : undefined
    return { ...logical, ...(placement ? { workerId: placement.workerId, status: placement.status, failureReason: placement.failureReason, provisioning: placement.provisioning, location: placement.location } : { status: logical.deletedAt ? 'deleted' as const : 'unplaced' as const, failureReason: null, location: null }) }
  }
  private workspaces(): Workspace[] { return this.list<{ id: string }>('workspace').map(value => this.workspace(value.id)).filter((value): value is Workspace => value !== null) }
  private readLoginSessions(where: string, ...params: string[]): import('@wemux/server-domain').LoginSession[] {
    return this.db.prepare(`SELECT * FROM login_sessions WHERE ${where}`).all(...params).map(row => {
      const session = JSON.parse(String(row.data)) as import('@wemux/server-domain').LoginSession & Record<string, unknown>
      if (!session || [['id','id'], ['userId','user_id'], ['tokenHash','token_hash'], ['csrfTokenHash','csrf_token_hash'], ['revokedAt','revoked_at']].some(([key, column]) => session[key] !== row[column])) throw new AppError(409, 'Login session indexed identity is corrupt')
      return session
    })
  }
  /** 索引列与 JSON 必须一致；不一致宁可报错也不静默采用任意一份数据。 */
  private readIndexed<T extends object>(table: string, columns: readonly (readonly [string, string])[], where: string, ...params: (string | number)[]): T[] {
    return this.db.prepare(`SELECT * FROM ${table} WHERE ${where}`).all(...params).map(row => {
      const record = JSON.parse(String(row.data)) as T & Record<string, unknown>
      if (!record || columns.some(([key, column]) => record[key] !== row[column])) throw new AppError(409, `${table} indexed identity is corrupt`)
      return record
    })
  }
  private readUserEmails(where: string, ...params: string[]): UserEmail[] {
    return this.readIndexed<UserEmail>('user_emails', [['emailNormalized','email_normalized'], ['userId','user_id'], ['emailDisplay','email_display']], where, ...params)
  }
  private readRegistrationAttempts(where: string, ...params: (string | number)[]): RegistrationAttempt[] {
    return this.readIndexed<RegistrationAttempt>('registration_attempts', [['id','id'], ['emailNormalized','email_normalized'], ['status','status'], ['consumedAt','consumed_at']], where, ...params)
  }
  private readInstanceAdministrators(where: string, ...params: (string | number)[]): import('@wemux/server-domain').InstanceAdministrator[] {
    return this.readIndexed<import('@wemux/server-domain').InstanceAdministrator>('instance_administrators', [['userId','user_id'], ['email','email'], ['assignedAt','assigned_at'], ['source','source']], where, ...params)
  }
  private readVerificationChallenges(where: string, ...params: (string | number)[]): VerificationChallenge[] {
    return this.readIndexed<VerificationChallenge>('verification_challenges', [['id','id'], ['tokenHash','token_hash'], ['purpose','purpose'], ['targetEmail','target_email'], ['registrationId','registration_id'], ['userId','user_id'], ['consumedAt','consumed_at']], where, ...params)
  }
  private readLoginIdentities(where: string, ...params: string[]): ExternalLoginIdentity[] {
    return this.readIndexed<ExternalLoginIdentity>('login_identities', [['id','id'], ['provider','provider'], ['issuer','issuer'], ['subject','subject'], ['userId','user_id'], ['lastSignInAt','last_sign_in_at']], where, ...params)
  }
  private readOAuthTransactions(where: string, ...params: (string | number)[]): OAuthTransaction[] {
    return this.readIndexed<OAuthTransaction>('oauth_transactions', [['id','id'], ['stateHash','state_hash'], ['provider','provider'], ['intent','intent'], ['userId','user_id'], ['sessionId','session_id'], ['consumedAt','consumed_at']], where, ...params)
  }
  private readonly identityReader: ServerStore['identity'] = {
    getUser: async id => this.get('user', id),
    // 登录既接受用户名也接受邮箱：邮箱统一走规范化索引，大小写或空白差异不影响登录。
    getUserByLogin: async login => {
      const byName = this.list<import('@wemux/server-domain').User>('user').find(u => u.username === login)
      if (byName) return byName
      const owned = this.readUserEmails('email_normalized=?', login.trim().toLowerCase())[0]
      if (owned) return this.get('user', owned.userId)
      return this.list<import('@wemux/server-domain').User>('user').find(u => typeof u.email === 'string' && u.email.toLowerCase() === login.trim().toLowerCase()) ?? null
    },
    getUserByEmail: async emailNormalized => {
      const owned = this.readUserEmails('email_normalized=?', emailNormalized)[0]
      return owned ? this.get('user', owned.userId) : null
    },
    getUserEmail: async userId => this.readUserEmails('user_id=?', userId)[0] ?? null,
    getRegistrationAttempt: async id => this.readRegistrationAttempts('id=?', id)[0] ?? null,
    findPendingRegistration: async emailNormalized => this.readRegistrationAttempts("email_normalized=? AND status='pending' ORDER BY rowid DESC", emailNormalized)[0] ?? null,
    findVerificationChallengeByTokenHash: async tokenHash => this.readVerificationChallenges('token_hash=?', tokenHash)[0] ?? null,
    listVerificationChallenges: async (targetEmail: string, purpose: VerificationPurpose, since: Timestamp) => this.readVerificationChallenges('target_email=? AND purpose=? AND created_at>=? ORDER BY rowid', targetEmail, purpose, since),
    getTeam: async id => this.get('team', id),
    getLocalAccountCredential: async id => this.get('local-credential', id),
    getIdentityRecords: async i => ({ membership: this.get('membership', `${i.teamId}:${i.userId}`), workerGrant: this.get('worker-grant', `${i.workerId}:${i.userId}`), projectGrant: this.get('project-grant', `${i.projectId}:${i.userId}`), sessionGrant: this.get('session-grant', `${i.sessionId}:${i.userId}`) }),
    findPersonalAccessToken: async hash => this.list<PersonalAccessTokenRecord>('pat').find(r => r.tokenHash === hash) ?? null,
    listPersonalAccessTokens: async () => this.list<PersonalAccessTokenRecord>('pat'),
    listUsers: async () => this.list<User>('user'),
    listMemberships: async userId => this.list<Membership>('membership').filter(membership => membership.userId === userId),
    listAudit: async limit => this.list<AuditEntry>('audit').sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, Math.max(0, limit)),
    findLoginSessionByTokenHash: async hash => this.readLoginSessions('token_hash=?', hash)[0] ?? null,
    getLoginSession: async id => this.readLoginSessions('id=?', id)[0] ?? null,
    listLoginSessions: async userId => this.readLoginSessions('user_id=? ORDER BY rowid', userId),
    findLoginIdentity: async (provider, issuer, subject) => this.readLoginIdentities('provider=? AND issuer=? AND subject=?', provider, issuer, subject)[0] ?? null,
    listLoginIdentities: async userId => this.readLoginIdentities('user_id=? ORDER BY rowid', userId),
    findOAuthTransactionByStateHash: async stateHash => this.readOAuthTransactions('state_hash=?', stateHash)[0] ?? null,
    findInstanceAdministrator: async userId => this.readInstanceAdministrators('user_id=?', userId)[0] ?? null,
    listInstanceAdministrators: async () => this.readInstanceAdministrators('1=1'),
    getInstanceSettings: async () => {
      const row = this.db.prepare("SELECT registration_policy,updated_at,updated_by,data FROM instance_settings WHERE id='instance'").get()
      if (!row) return null
      const settings = JSON.parse(String(row.data)) as import('@wemux/server-domain').InstanceSettings
      if (settings.id !== 'instance' || settings.registrationPolicy !== row.registration_policy || settings.updatedAt !== row.updated_at || settings.updatedBy !== row.updated_by) throw new AppError(409, 'Instance settings identity is corrupt')
      return settings
    },
    findWorkerCredential: async hash => this.list<WorkerCredentialRecord>('worker-credential').find(r => r.credentialHash === hash) ?? null,
  }
  readonly identity = this.committed(this.identityReader)
  private readonly resourceReader: ServerStore['resources'] = {
    getWorker: async id => this.get('worker', id), getProject: async id => this.get('project', id),
    getRepository: async id => this.get('repository', id), getWorkspace: async id => this.workspace(id), getSession: async id => this.get('session', id),
    getSessionByCreateRequest: async (ownerId, projectId, requestId) => this.list<import('@wemux/server-domain').Session>('session').find(session => session.ownerId === ownerId && session.projectId === projectId && session.creation?.requestId === requestId) ?? null,
    // Lineage: the Fork row is the authority; the (projectId, requestId) index is a record of
    // its own so a retried command resolves the original target without scanning the project.
    listSessionForks: async projectId => this.list<SessionForkRecord>('session-fork').filter(fork => fork.projectId === projectId),
    getSessionFork: async forkId => this.get<SessionForkRecord>('session-fork', forkId),
    getSessionForkByRequest: async (projectId, requestId) => {
      const forkId = this.get<string>('session-fork-request', forkRequestIndexId(projectId, requestId))
      return forkId ? this.get<SessionForkRecord>('session-fork', forkId) : null
    },
    listWorkers: async () => this.list('worker'), listProjects: async () => this.list('project'),
    listWorkspaces: async () => this.workspaces(), listSessions: async () => this.list('session'),
    listCapabilityAssets: async projectId => this.get<CapabilityAsset[]>('capability-assets', projectId) ?? [],
    listAgentInboxMessages: async (sessionId, unreadOnly) => this.list<AgentInboxMessage>('agent-inbox').filter(message => message.toSessionId === sessionId && (!unreadOnly || message.status !== 'read')),
    getAgentInboxMessage: async messageId => this.get('agent-inbox', messageId),
  }
  readonly resources = this.committed(this.resourceReader)
  private commandProjection(id: string): CommandProjection | null {
    const row = this.db.prepare('SELECT projection FROM commands WHERE id=?').get(id)
    return row ? JSON.parse(String(row.projection)) as CommandProjection : null
  }
  private readonly commandReader: ServerStore['commands'] = {
    getPendingCommand: async id => { const row = this.db.prepare('SELECT data FROM commands WHERE id=?').get(id); return row ? JSON.parse(String(row.data)) : null },
    get: async id => this.commandProjection(id),
    hasProvisionAttempt: async id => Boolean(this.db.prepare("SELECT 1 FROM commands WHERE json_extract(data,'$.command.kind')='workspace.provision' AND json_extract(data,'$.command.workspace.workspace.id')=? LIMIT 1").get(id)),
    listUnsettledEnqueues: async id => this.db.prepare("SELECT data FROM commands WHERE json_extract(data,'$.command.sessionId')=? AND json_extract(data,'$.command.kind')='session.enqueue' AND status IN ('pending','accepted')").all(id).map(row => JSON.parse(String(row.data)) as PendingCommand),
    listDeliverable: async (id, limit) => this.db.prepare("SELECT data FROM commands WHERE worker_id=? AND status='pending' AND NOT EXISTS (SELECT 1 FROM command_dependencies d JOIN commands p ON p.id=d.prerequisite_id WHERE d.command_id=commands.id AND p.status<>'accepted') ORDER BY rowid LIMIT ?").all(id, limit).map(row => JSON.parse(String(row.data)) as PendingCommand),
    list: async ({ workerId, status, limit }) => {
      const clauses: string[] = [], params: (string | number)[] = []
      if (workerId) { clauses.push('worker_id=?'); params.push(workerId) }
      if (status) { clauses.push('status=?'); params.push(status) }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
      return this.db.prepare(`SELECT projection FROM commands ${where} ORDER BY rowid DESC LIMIT ?`).all(...params, limit).map(row => JSON.parse(String(row.projection)) as CommandProjection)
    },
  }
  readonly commands = this.committed(this.commandReader)
  private freshness(id: SessionId): SessionCacheState {
    return this.get('cache', id) ?? { sessionId: id, contiguousSeq: 0 as EventSeq, workerLastSeq: null, status: 'unknown' }
  }
  private readonly cacheReader: ServerStore['cache'] = {
    getFreshness: async id => this.freshness(id),
    readEvents: async (id, from, limit) => {
      const rows = this.db.prepare('SELECT data FROM events WHERE session_id=? AND seq>=? AND seq<=? ORDER BY seq LIMIT ?').all(id, from, this.freshness(id).contiguousSeq, limit + 1)
      const events = rows.slice(0, limit).map(row => JSON.parse(String(row.data)) as JournalEvent)
      return { events, nextSeq: rows.length > limit ? (events[events.length - 1].seq + 1) as EventSeq : null }
    },
  }
  readonly cache = this.committed(this.cacheReader)
  private async markOffline(workerId: WorkerId, status: 'offline' | 'orphaned'): Promise<void> {
    for (const session of this.list<import('@wemux/server-domain').Session>('session')) if (session.binding.agent.workerId === workerId) this.put('cache', session.id, { ...this.freshness(session.id), status })
  }
  private taskBindings(taskId?: string, workspaceId?: string): import('@wemux/web-contract/task-platform').TaskWorkspace[] {
    return this.db.prepare(`SELECT task_id, project_id, workspace_id, created_at FROM task_workspaces WHERE ${taskId === undefined ? 'workspace_id' : 'task_id'}=?`).all(taskId ?? workspaceId!).map(row => ({ taskId: String(row.task_id), projectId: String(row.project_id), workspaceId: String(row.workspace_id), createdAt: String(row.created_at) }))
  }
  private readRuns(where: string, ...params: string[]): import('@wemux/web-contract/task-platform').Run[] {
    return this.db.prepare(`SELECT * FROM task_runs WHERE ${where} ORDER BY attempt DESC`).all(...params).map(row => {
      const run = JSON.parse(String(row.data))
      if (!run || [['id','id'], ['taskId','task_id'], ['requestId','request_id'], ['attempt','attempt'], ['status','status'], ['sessionId','session_id'], ['createCommandId','create_command_id'], ['enqueueCommandId','enqueue_command_id']].some(([key, column]) => run[key] !== row[column])) throw new AppError(409, 'Run indexed identity is corrupt')
      return run
    })
  }
  private readReviews(where: string, value: string): import('@wemux/web-contract/task-platform').ReviewRequest[] {
    return this.db.prepare(`SELECT * FROM review_requests WHERE ${where}`).all(value).map(row => {
      const review = JSON.parse(String(row.data))
      if (!review || !validReviewMetadata(review) || [['id','id'], ['taskRunId','run_id'], ['taskId','task_id'], ['projectId','project_id'], ['status','status']].some(([key, column]) => review[key] !== row[column])) throw new AppError(409, 'Review indexed identity is corrupt')
      const task = this.db.prepare('SELECT project_id,data FROM tasks WHERE id=?').get(review.taskId)
      const run = this.db.prepare('SELECT task_id FROM task_runs WHERE id=?').get(review.taskRunId)
      if (!task || task.project_id !== review.projectId || run?.task_id !== review.taskId) throw new AppError(409, 'Review relationship is corrupt')
      if (review.status === 'requested' && review.closedAt === null) {
        const current = JSON.parse(String(task.data))
        if (current.status !== 'in_review' || current.currentReviewId !== review.id) throw new AppError(409, 'Review is not the current Task cycle')
      }
      return review
    })
  }
  private readonly taskReader: ServerStore['tasks'] = {
    reviewById: async id => this.readReviews('id=?', id)[0] ?? null,
    review: async runId => this.readReviews('run_id=? ORDER BY rowid DESC LIMIT 1', runId)[0] ?? null,
    pendingReviews: async projectId => this.readReviews("project_id=? AND status='requested' AND json_extract(data,'$.closedAt') IS NULL ORDER BY rowid", projectId),
    projectActivity: async (projectId, after) => this.db.prepare('SELECT p.cursor,a.data FROM project_activity p JOIN task_activity a ON a.task_id=p.task_id AND a.seq=p.seq WHERE p.project_id=? AND p.cursor>? ORDER BY p.cursor').all(projectId, after).map(row => ({ cursor: Number(row.cursor), activity: JSON.parse(String(row.data)) })),
    cancelRequest: async (runId, requestId) => { const row = this.db.prepare('SELECT session_id FROM run_cancel_requests WHERE run_id=? AND request_id=?').get(runId, requestId); return row ? String(row.session_id) : null },
    runs: async id => this.readRuns('task_id=?', id),
    run: async id => this.readRuns('id=?', id)[0] ?? null,
    runByRequest: async (id, requestId) => this.readRuns('task_id=? AND request_id=?', id, requestId)[0] ?? null,
    runByCommand: async id => this.readRuns('create_command_id=? OR enqueue_command_id=? OR EXISTS (SELECT 1 FROM json_each(task_runs.data, \'$.cancelCommandIds\') WHERE value=?)', id, id, id)[0] ?? null,
    bindings: async id => this.taskBindings(id),
    binding: async id => this.taskBindings(undefined, id)[0] ?? null,
    activeRunUsesWorkspace: async id => Boolean(this.db.prepare("SELECT 1 FROM tasks WHERE json_extract(data,'$.activeRun.snapshot.workspaceId')=? AND json_extract(data,'$.activeRun.status') IN ('pending','running','cancelling') LIMIT 1").get(id)),
    list: async projectId => this.db.prepare('SELECT data FROM tasks WHERE project_id=? ORDER BY rowid').all(projectId).map(row => {
      const { description, acceptanceCriteria, metadataJson, blockedFrom, cancelledFrom, workspaces, links, ...summary } = JSON.parse(String(row.data)) as import('@wemux/web-contract/task-platform').TaskDetail
      return summary
    }),
    get: async id => { const row = this.db.prepare('SELECT data FROM tasks WHERE id=?').get(id); return row ? { ...JSON.parse(String(row.data)), workspaces: this.taskBindings(id) } : null },
    activity: async (id, after) => this.db.prepare('SELECT data FROM task_activity WHERE task_id=? AND seq>? ORDER BY seq').all(id, after).map(row => JSON.parse(String(row.data))),
  }
  readonly tasks = this.committed(this.taskReader)
  private readonly tx: ServerStoreTx = {
    tasks: {
      ...this.taskReader,
      saveReview: async review => { this.db.prepare('INSERT INTO review_requests(id,run_id,task_id,project_id,status,data) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data').run(review.id, review.taskRunId, review.taskId, review.projectId, review.status, JSON.stringify(review)) },
      saveCancelRequest: async (runId, requestId, sessionId) => { this.db.prepare('INSERT INTO run_cancel_requests VALUES(?,?,?)').run(runId, requestId, sessionId) },
      saveRun: async run => {
        const old = this.readRuns('id=?', run.id)[0]
        if (old && JSON.stringify([old.request, old.snapshot, old.fingerprint, old.taskId, old.sessionId, old.attempt, old.requestId, old.createCommandId, old.enqueueCommandId]) !== JSON.stringify([run.request, run.snapshot, run.fingerprint, run.taskId, run.sessionId, run.attempt, run.requestId, run.createCommandId, run.enqueueCommandId])) throw new Error('Immutable Run identity changed')
        this.db.prepare('INSERT INTO task_runs(id,task_id,request_id,attempt,status,session_id,create_command_id,enqueue_command_id,data) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data').run(run.id, run.taskId, run.requestId, run.attempt, run.status, run.sessionId, run.createCommandId, run.enqueueCommandId, JSON.stringify(run))
      },
      bind: async binding => { this.db.prepare('INSERT INTO task_workspaces(task_id,project_id,workspace_id,created_at) VALUES(?,?,?,?)').run(binding.taskId, binding.projectId, binding.workspaceId, binding.createdAt) },
      unbind: async (taskId, workspaceId) => { this.db.prepare('DELETE FROM task_workspaces WHERE task_id=? AND workspace_id=?').run(taskId, workspaceId) },
      save: async task => { this.db.prepare('INSERT INTO tasks VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(task.id, task.projectId, JSON.stringify(task)) },
      append: async (event, sourceKey) => {
        if (sourceKey && this.db.prepare('SELECT 1 FROM task_activity WHERE task_id=? AND source_key=?').get(event.taskId, sourceKey)) return
        const seq = Number(this.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM task_activity WHERE task_id=?').get(event.taskId)!.seq)
        this.db.prepare('INSERT INTO task_activity(task_id,seq,data,source_key) VALUES(?,?,?,?)').run(event.taskId, seq, JSON.stringify({ ...event, seq }), sourceKey ?? null)
      },
    },
    identity: {
      ...this.identityReader,
      saveUser: async r => this.put('user', r.id, r),
      saveUserEmail: async r => {
        try {
          this.db.prepare('INSERT INTO user_emails(email_normalized,user_id,email_display,created_at,data) VALUES(?,?,?,?,?)').run(r.emailNormalized, r.userId, r.emailDisplay, r.createdAt, JSON.stringify(r))
        } catch (error) {
          // 唯一键冲突 = 邮箱已被占用：明确 409，绝不改写既有归属。
          if (String(error).includes('UNIQUE') || String(error).includes('PRIMARY KEY')) throw new AppError(409, '该邮箱已被占用', 'email_taken')
          throw error
        }
      },
      saveRegistrationAttempt: async r => {
        try {
          this.db.prepare('INSERT INTO registration_attempts(id,email_normalized,status,created_at,expires_at,consumed_at,data) VALUES(?,?,?,?,?,?,?)').run(r.id, r.emailNormalized, r.status, r.createdAt, r.expiresAt, r.consumedAt, JSON.stringify(r))
        } catch (error) {
          // partial unique index = 同一邮箱已有待验证注册；并发提交的失败者只能走重发路径。
          if (String(error).includes('UNIQUE') || String(error).includes('PRIMARY KEY')) throw new AppError(409, '该邮箱已有待验证注册', 'registration_pending')
          throw error
        }
      },
      updateRegistrationAttempt: async r => {
        const current = this.readRegistrationAttempts('id=?', r.id)[0]
        if (!current) throw new AppError(404, 'Unknown registration attempt')
        this.db.prepare('UPDATE registration_attempts SET status=?,consumed_at=?,data=? WHERE id=?').run(r.status, r.consumedAt, JSON.stringify(r), r.id)
      },
      saveVerificationChallenge: async r => {
        try {
          this.db.prepare('INSERT INTO verification_challenges(id,token_hash,purpose,target_email,registration_id,user_id,created_at,expires_at,consumed_at,data) VALUES(?,?,?,?,?,?,?,?,?,?)').run(r.id, r.tokenHash, r.purpose, r.targetEmail, r.registrationId, r.userId, r.createdAt, r.expiresAt, r.consumedAt, JSON.stringify(r))
        } catch (error) {
          if (String(error).includes('UNIQUE') || String(error).includes('PRIMARY KEY')) throw new AppError(409, 'Verification challenge already exists')
          throw error
        }
      },
      consumeVerificationChallenge: async input => {
        // 单次消费由 `consumed_at IS NULL` 谓词原子保证：并发重放最多一个赢家。
        const result = this.db.prepare(`UPDATE verification_challenges SET consumed_at=?, data=json_set(data,'$.consumedAt',?) WHERE token_hash=? AND consumed_at IS NULL`).run(input.consumedAt, input.consumedAt, input.tokenHash)
        if (Number(result.changes) !== 1) return null
        return this.readVerificationChallenges('token_hash=?', input.tokenHash)[0] ?? null
      },
      saveTeam: async r => this.put('team', r.id, r),
      saveLocalAccountCredential: async r => this.put('local-credential', r.userId, r),
      saveMembership: async r => this.put('membership', `${r.teamId}:${r.userId}`, r),
      removeMembership: async (team, user) => this.remove('membership', `${team}:${user}`),
      saveWorkerGrant: async r => this.put('worker-grant', `${r.workerId}:${r.userId}`, r),
      saveProjectGrant: async r => this.put('project-grant', `${r.projectId}:${r.userId}`, r),
      saveSessionGrant: async r => this.put('session-grant', `${r.sessionId}:${r.userId}`, r),
      savePersonalAccessToken: async r => this.put('pat', r.id, r),
      revokePersonalAccessToken: async (id, revokedAt) => { const r = this.get<PersonalAccessTokenRecord>('pat', id); if (r) this.put('pat', id, { ...r, revokedAt }) },
      revokePersonalAccessTokens: async (userId, revokedAt) => {
        let revoked = 0
        for (const record of this.list<PersonalAccessTokenRecord>('pat')) {
          if ((userId === null || record.userId === userId) && record.revokedAt === null) { this.put('pat', record.id, { ...record, revokedAt }); revoked++ }
        }
        return revoked
      },
      saveLoginSession: async session => {
        this.db.prepare('INSERT INTO login_sessions(id,user_id,token_hash,csrf_token_hash,revoked_at,data) VALUES(?,?,?,?,?,?)').run(session.id, session.userId, session.tokenHash, session.csrfTokenHash, session.revokedAt, JSON.stringify(session))
      },
      touchLoginSession: async input => {
        const session = this.readLoginSessions('id=?', input.id)[0]
        if (!session) throw new AppError(404, 'Unknown login session')
        const next = { ...session, lastSeenAt: input.lastSeenAt, idleExpiresAt: input.idleExpiresAt }
        this.db.prepare('UPDATE login_sessions SET data=? WHERE id=?').run(JSON.stringify(next), input.id)
      },
      rotateLoginSessionCsrf: async input => {
        const session = this.readLoginSessions('id=?', input.id)[0]
        if (!session) throw new AppError(404, 'Unknown login session')
        const next = { ...session, csrfTokenHash: input.csrfTokenHash }
        this.db.prepare('UPDATE login_sessions SET csrf_token_hash=?,data=? WHERE id=?').run(input.csrfTokenHash, JSON.stringify(next), input.id)
      },
      revokeLoginSession: async (id, revokedAt) => {
        const session = this.readLoginSessions('id=?', id)[0]
        if (!session || session.revokedAt !== null) return
        this.db.prepare('UPDATE login_sessions SET revoked_at=?,data=? WHERE id=?').run(revokedAt, JSON.stringify({ ...session, revokedAt }), id)
      },
      revokeLoginSessions: async (userId, revokedAt) => {
        let revoked = 0
        for (const session of this.readLoginSessions('user_id=?', userId)) {
          if (session.revokedAt !== null) continue
          this.db.prepare('UPDATE login_sessions SET revoked_at=?,data=? WHERE id=?').run(revokedAt, JSON.stringify({ ...session, revokedAt }), session.id)
          revoked++
        }
        return revoked
      },
      saveInstanceAdministrator: async record => {
        try {
          this.db.prepare('INSERT INTO instance_administrators(user_id,email,assigned_at,source,data) VALUES(?,?,?,?,?)')
            .run(record.userId, record.email, record.assignedAt, record.source, JSON.stringify(record))
        } catch (error) {
          // 同一用户重复提升是并发登录的败方：拒绝，不静默改写归属来源。
          if (String(error).includes('UNIQUE') || String(error).includes('PRIMARY KEY')) throw new AppError(409, 'Instance administrator is already recorded')
          throw error
        }
      },
      saveInstanceSettings: async settings => {
        this.db.prepare(`INSERT INTO instance_settings(id,registration_policy,updated_at,updated_by,data) VALUES('instance',?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET registration_policy=excluded.registration_policy,updated_at=excluded.updated_at,updated_by=excluded.updated_by,data=excluded.data`)
          .run(settings.registrationPolicy, settings.updatedAt, settings.updatedBy, JSON.stringify(settings))
      },
      saveEnrollmentToken: async r => this.put('enrollment', r.tokenHash, r),
      consumeEnrollmentToken: async i => {
        const r = this.get<EnrollmentTokenRecord>('enrollment', i.tokenHash)
        if (!r || r.consumedAt || r.expiresAt <= i.consumedAt) throw new AppError(401, 'Invalid or expired enrollment token')
        this.put('enrollment', i.tokenHash, { ...r, consumedAt: i.consumedAt, consumedByWorkerId: i.workerId })
        return r
      },
      saveWorkerCredential: async r => this.put('worker-credential', r.id, r),
      revokeWorkerCredential: async (id, revokedAt) => { for (const r of this.list<WorkerCredentialRecord>('worker-credential')) if (r.workerId === id) this.put('worker-credential', r.id, { ...r, revokedAt }) },
      saveLoginIdentity: async identity => {
        try {
          this.db.prepare('INSERT INTO login_identities(id,provider,issuer,subject,user_id,last_sign_in_at,data) VALUES(?,?,?,?,?,?,?)')
            .run(identity.id, identity.provider, identity.issuer, identity.subject, identity.userId, identity.lastSignInAt, JSON.stringify(identity))
        } catch (error) {
          if (String(error).includes('UNIQUE')) throw new AppError(409, '该登录身份已被占用，不能静默改派')
          throw error
        }
      },
      touchLoginIdentity: async input => {
        const identity = this.readLoginIdentities('id=?', input.id)[0]
        if (!identity) throw new AppError(404, 'Unknown login identity')
        this.db.prepare('UPDATE login_identities SET last_sign_in_at=?,data=? WHERE id=?').run(input.lastSignInAt, JSON.stringify({ ...identity, lastSignInAt: input.lastSignInAt }), input.id)
      },
      saveOAuthTransaction: async transaction => {
        // 一次性材料只活几分钟：保存时顺手清理早已过期的旧行，避免无上限堆积。
        this.db.prepare("DELETE FROM oauth_transactions WHERE julianday(expires_at) < julianday(?, '-1 day')").run(transaction.createdAt)
        try {
          this.db.prepare('INSERT INTO oauth_transactions(id,state_hash,provider,intent,user_id,session_id,created_at,expires_at,consumed_at,data) VALUES(?,?,?,?,?,?,?,?,?,?)')
            .run(transaction.id, transaction.stateHash, transaction.provider, transaction.intent, transaction.userId, transaction.sessionId, transaction.createdAt, transaction.expiresAt, transaction.consumedAt, JSON.stringify(transaction))
        } catch (error) {
          if (String(error).includes('UNIQUE')) throw new AppError(409, 'OAuth state 已发出，不能重用')
          throw error
        }
      },
      consumeOAuthTransaction: async input => {
        const result = this.db.prepare("UPDATE oauth_transactions SET consumed_at=?,data=json_set(data,'$.consumedAt',?) WHERE state_hash=? AND consumed_at IS NULL AND julianday(expires_at) > julianday(?)")
          .run(input.consumedAt, input.consumedAt, input.stateHash, input.consumedAt)
        if (Number(result.changes) !== 1) return null
        return this.readOAuthTransactions('state_hash=?', input.stateHash)[0] ?? null
      },
    },
    resources: {
      ...this.resourceReader,
      saveWorker: async r => this.put('worker', r.id, r), saveProject: async r => this.put('project', r.id, r),
      saveRepository: async r => this.put('repository', r.id, r), saveWorkspace: async r => this.put('workspace', r.id, r), saveSession: async r => this.put('session', r.id, r),
      saveSessionFork: async fork => {
        const index = forkRequestIndexId(fork.projectId, fork.creation.requestId), indexed = this.get<string>('session-fork-request', index)
        // Index and row are written together: a second Fork claiming the same requestId in one
        // transaction is rejected here instead of silently creating an unreachable branch.
        if (indexed && indexed !== fork.id) throw new AppError(409, 'requestId already belongs to a different Session Fork', 'request_id_conflict')
        this.put('session-fork', fork.id, fork)
        this.put('session-fork-request', index, fork.id)
      },
      replaceCapabilityAssets: async (projectId: ProjectId, assets: readonly CapabilityAsset[]) => this.put('capability-assets', projectId, assets),
      createAgentInboxMessage: async input => {
        const key = `${input.message.fromSessionId}:${input.idempotencyKey}`
        const previousId = this.get<string>('agent-inbox-idempotency', key)
        if (previousId) {
          const previous = this.get<AgentInboxMessage>('agent-inbox', previousId)!
          if (previous.payloadFingerprint && previous.payloadFingerprint !== input.message.payloadFingerprint) throw new AppError(409, 'Idempotency key was already used with a different agent message')
          return previous
        }
        this.put('agent-inbox', input.message.id, input.message)
        this.put('agent-inbox-idempotency', key, input.message.id)
        return input.message
      },
      markAgentInboxMessageRead: async (messageId: string, readAt: Timestamp) => {
        const message = this.get<AgentInboxMessage>('agent-inbox', messageId)
        if (!message) return null
        const next: AgentInboxMessage = { ...message, status: 'read', readAt }
        this.put('agent-inbox', messageId, next)
        return next
      },
    },
    commands: {
      ...this.commandReader,
      depend: async (id, prerequisite) => { this.db.prepare('INSERT INTO command_dependencies VALUES(?,?)').run(id, prerequisite) },
      insertPending: async r => {
        const projection: CommandProjection = { commandId: r.commandId, workerId: r.workerId, payloadFingerprint: r.payloadFingerprint, status: 'pending', createdAt: r.createdAt, updatedAt: r.createdAt }
        this.db.prepare('INSERT INTO commands VALUES(?,?,?,?,?)').run(r.commandId, r.workerId, 'pending', JSON.stringify(r), JSON.stringify(projection))
      },
      recordReceipt: async (receipt, at) => {
        const p = this.commandProjection(receipt.commandId)
        if (!p) throw new AppError(404, 'Unknown command')
        // A late receipt proves the worker executed the command; it overrides a cancellation.
        if (p.status !== 'pending' && p.status !== 'cancelled' && p.status !== receipt.status) throw new AppError(409, 'Conflicting receipt')
        if (p.status === receipt.status) return
        this.db.prepare('UPDATE commands SET status=?, projection=? WHERE id=?').run(receipt.status, JSON.stringify({ ...p, status: receipt.status, updatedAt: at }), p.commandId)
        this.put('receipt', p.commandId, receipt)
      },
      cancelPending: async (commandId, at) => {
        const p = this.commandProjection(commandId)
        if (!p || p.status !== 'pending') return false
        this.db.prepare("UPDATE commands SET status='cancelled', projection=? WHERE id=? AND status='pending'").run(JSON.stringify({ ...p, status: 'cancelled' as const, updatedAt: at }), commandId)
        return true
      },
    },
    cache: {
      deleteSessionHistory: async id => { this.db.prepare('DELETE FROM events WHERE session_id=?').run(id); this.remove('cache', id) },
      ...this.cacheReader,
      markSessionGap: async id => {
        const state: SessionCacheState = { ...this.freshness(id), status: 'gap' }
        this.put('cache', id, state)
        return state
      },
      applyEvents: async (id, events) => {
        for (const event of events) {
          if (event.sessionId !== id || !Number.isSafeInteger(event.seq) || event.seq < 1) throw new AppError(400, 'Invalid event sequence')
          const old = this.db.prepare('SELECT data FROM events WHERE session_id=? AND seq=?').get(id, event.seq)
          if (old && String(old.data) !== JSON.stringify(event)) throw new AppError(409, 'Conflicting event')
          this.db.prepare('INSERT OR IGNORE INTO events VALUES(?,?,?)').run(id, event.seq, JSON.stringify(event))
        }
        const previous = this.freshness(id)
        let seq = previous.contiguousSeq as number
        while (this.db.prepare('SELECT 1 FROM events WHERE session_id=? AND seq=?').get(id, seq + 1)) seq++
        const max = Number(this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE session_id=?').get(id)!.seq)
        const state: SessionCacheState = { ...previous, contiguousSeq: seq as EventSeq, status: max > seq ? 'gap' : previous.workerLastSeq === seq ? 'synced' : 'syncing' }
        this.put('cache', id, state)
        return state
      },
      recordWorkerHead: async (id, lastSeq) => {
        const old = this.freshness(id)
        const state: SessionCacheState = { ...old, workerLastSeq: lastSeq, status: old.contiguousSeq === lastSeq ? 'synced' : 'gap' }
        this.put('cache', id, state)
        return state
      },
      markWorkerOffline: async id => this.markOffline(id, 'offline'), markWorkerOrphaned: async id => this.markOffline(id, 'orphaned'),
    },
    audit: { append: async r => this.put('audit', r.id, r) },
  }
  transaction<T>(work: (tx: ServerStoreTx) => Promise<T>): Promise<T> {
    if (this.transactionContext.getStore()?.active) return Promise.reject(new Error('Nested transactions are not supported; use tx primitives'))
    const result = this.queue.then(() => {
      const token = { id: Symbol('transaction'), active: true }
      return this.transactionContext.run(token, async () => {
        try {
          this.db.exec('BEGIN IMMEDIATE')
          this.activeTransactionId = token.id
          try { const value = await work(this.transactionFacade(token)); this.db.exec('COMMIT'); return value }
          catch (error) { this.db.exec('ROLLBACK'); throw error }
        } finally {
          token.active = false
          this.activeTransactionId = undefined
        }
      })
    })
    this.queue = result.catch(() => undefined)
    return result
  }
}
