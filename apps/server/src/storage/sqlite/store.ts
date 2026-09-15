import { validReviewMetadata } from '@wemux/web-contract/task-platform'
import { DatabaseSync } from 'node:sqlite'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { AgentInboxMessage, CapabilityAsset, EventSeq, JournalEvent, ProjectId, SessionId, Timestamp, WorkerId } from '@wemux/domain'
import type { CommandProjection, EnrollmentTokenRecord, PersonalAccessTokenRecord, SessionCacheState, Worker, WorkerCredentialRecord } from '@wemux/server-domain'
import type { ServerStore, ServerStoreTx } from '../../application/ports/server-store.js'
import type { PendingCommand } from '../../application/ports/server-store-types.js'
import { AppError } from '../../application/errors.js'
import { migrate } from './migrations.js'

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
  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;')
    try { migrate(this.db) } catch (error) { this.db.close(); throw error }
    for (const worker of this.list<Worker>('worker')) this.put('worker', worker.id, { ...worker, connectionState: 'offline' })
    for (const cache of this.list<SessionCacheState>('cache')) this.put('cache', cache.sessionId, { ...cache, status: 'offline' })
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
    this.db.prepare('INSERT INTO records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data').run(kind, id, JSON.stringify(data))
  }
  private remove(kind: string, id: string): void { this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind, id) }
  private readonly identityReader: ServerStore['identity'] = {
    getUser: async id => this.get('user', id),
    getUserByLogin: async login => this.list<import('@wemux/server-domain').User>('user').find(u => u.username === login || u.email === login) ?? null,
    getTeam: async id => this.get('team', id),
    getLocalAccountCredential: async id => this.get('local-credential', id),
    getIdentityRecords: async i => ({ membership: this.get('membership', `${i.teamId}:${i.userId}`), workerGrant: this.get('worker-grant', `${i.workerId}:${i.userId}`), projectGrant: this.get('project-grant', `${i.projectId}:${i.userId}`), sessionGrant: this.get('session-grant', `${i.sessionId}:${i.userId}`) }),
    findPersonalAccessToken: async hash => this.list<PersonalAccessTokenRecord>('pat').find(r => r.tokenHash === hash) ?? null,
    findWorkerCredential: async hash => this.list<WorkerCredentialRecord>('worker-credential').find(r => r.credentialHash === hash) ?? null,
  }
  readonly identity = this.committed(this.identityReader)
  private readonly resourceReader: ServerStore['resources'] = {
    getWorker: async id => this.get('worker', id), getProject: async id => this.get('project', id),
    getRepository: async id => this.get('repository', id), getWorkspace: async id => this.get('workspace', id), getSession: async id => this.get('session', id),
    listWorkers: async () => this.list('worker'), listProjects: async () => this.list('project'),
    listWorkspaces: async () => this.list('workspace'), listSessions: async () => this.list('session'),
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
      saveUser: async r => this.put('user', r.id, r), saveTeam: async r => this.put('team', r.id, r),
      saveLocalAccountCredential: async r => this.put('local-credential', r.userId, r),
      saveMembership: async r => this.put('membership', `${r.teamId}:${r.userId}`, r),
      removeMembership: async (team, user) => this.remove('membership', `${team}:${user}`),
      saveWorkerGrant: async r => this.put('worker-grant', `${r.workerId}:${r.userId}`, r),
      saveProjectGrant: async r => this.put('project-grant', `${r.projectId}:${r.userId}`, r),
      saveSessionGrant: async r => this.put('session-grant', `${r.sessionId}:${r.userId}`, r),
      savePersonalAccessToken: async r => this.put('pat', r.id, r),
      revokePersonalAccessToken: async (id, revokedAt) => { const r = this.get<PersonalAccessTokenRecord>('pat', id); if (r) this.put('pat', id, { ...r, revokedAt }) },
      saveEnrollmentToken: async r => this.put('enrollment', r.tokenHash, r),
      consumeEnrollmentToken: async i => {
        const r = this.get<EnrollmentTokenRecord>('enrollment', i.tokenHash)
        if (!r || r.consumedAt || r.expiresAt <= i.consumedAt) throw new AppError(401, 'Invalid or expired enrollment token')
        this.put('enrollment', i.tokenHash, { ...r, consumedAt: i.consumedAt, consumedByWorkerId: i.workerId })
        return r
      },
      saveWorkerCredential: async r => this.put('worker-credential', r.id, r),
      revokeWorkerCredential: async (id, revokedAt) => { for (const r of this.list<WorkerCredentialRecord>('worker-credential')) if (r.workerId === id) this.put('worker-credential', r.id, { ...r, revokedAt }) },
    },
    resources: {
      ...this.resourceReader,
      saveWorker: async r => this.put('worker', r.id, r), saveProject: async r => this.put('project', r.id, r),
      saveRepository: async r => this.put('repository', r.id, r), saveWorkspace: async r => this.put('workspace', r.id, r), saveSession: async r => this.put('session', r.id, r),
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
