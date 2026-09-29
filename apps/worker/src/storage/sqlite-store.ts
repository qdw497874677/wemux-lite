import { DatabaseSync } from 'node:sqlite'
import { retentionDestinationInvariants, retentionInvariants } from './retention-invariants.ts'
import { randomUUID } from 'node:crypto'
import type { AgentEvent, AgentSession, SessionKey, SessionStore } from '@wemux/agent-interchange'
import type { EventSeq, JournalEvent, JournalEventDraft, QueuedMessage, SessionId, Timestamp, Turn, TurnId } from '@wemux/domain'
import type { WorkerStore, WorkerStoreTx } from '../application/ports/worker-store.ts'
import type { LocalState } from '../application/ports/local-state.ts'
import type { CommandRecord, SessionExecution } from '../domain/session-execution.ts'
import type { LocalWorkspace, RepositoryCheckout } from '../domain/local-workspace.ts'
import type { LocalAdminRecord, LocalInstallationIdentity } from '../domain/local-installation.ts'
import type { ConnectorDefinition, CredentialRecord, ExecutionResult } from '@wemux/connector'
import type { ConnectorExecutionRecord, WorkerConnectorStore } from '../connectors/store.ts'

export const now = () => new Date().toISOString() as Timestamp

/** Serialized transactions also isolate async port callbacks from other transactions. */
export class SqliteWorkerStore implements WorkerStore, LocalState, SessionStore, WorkerConnectorStore {
  private readonly db: DatabaseSync
  private tail: Promise<unknown> = Promise.resolve()

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
    const version = this.db.prepare('PRAGMA user_version').get()?.user_version
    if (version !== 0 && version !== 1 && version !== 2 && version !== 3 && version !== 4) { this.db.close(); throw new Error('Unsupported Worker database schema') }
    if (version === 0) this.db.exec(`BEGIN;
      CREATE TABLE documents (bucket TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(bucket,id));
      CREATE TABLE journal (session_id TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(session_id,seq));
      PRAGMA user_version=1; COMMIT;`)
    if (version !== 3 && version !== 4) {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        if (version !== 2) this.db.exec(retentionInvariants)
        this.db.exec(retentionDestinationInvariants)
        this.db.exec('PRAGMA user_version=3; COMMIT;')
      }
      catch (error) { this.db.exec('ROLLBACK'); this.db.close(); throw error }
    }
    if (version !== 4) {
      this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS connector_credentials (id TEXT PRIMARY KEY, owner_kind TEXT NOT NULL CHECK(owner_kind='connector'), owner_id TEXT NOT NULL, auth_type TEXT NOT NULL, ciphertext TEXT NOT NULL, profile_json TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS connector_executions (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, state TEXT NOT NULL, session_id TEXT NOT NULL, body TEXT NOT NULL, journal_summary TEXT, created_at TEXT NOT NULL, completed_at TEXT);
        CREATE INDEX IF NOT EXISTS connector_execution_session ON connector_executions(session_id, created_at);
        PRAGMA user_version=4; COMMIT;`)
    }
  }
  close() { this.db.close() }
  private getDocument<T>(bucket: string, id: string): T | null {
    const row = this.db.prepare('SELECT body FROM documents WHERE bucket=? AND id=?').get(bucket, id)
    return row ? JSON.parse(String(row.body)) as T : null
  }
  private list<T>(bucket: string): T[] {
    return this.db.prepare('SELECT body FROM documents WHERE bucket=? ORDER BY rowid').all(bucket).map(row => JSON.parse(String(row.body)) as T)
  }
  private put(bucket: string, id: string, value: unknown) {
    this.db.prepare('INSERT INTO documents VALUES (?,?,?) ON CONFLICT(bucket,id) DO UPDATE SET body=excluded.body').run(bucket, id, JSON.stringify(value))
  }
  private agentSessionId({ appName, userId, sessionId }: SessionKey) {
    return `${appName}\u0000${userId}\u0000${sessionId}`
  }
  async getOrCreate(request: SessionKey & { readonly state?: Readonly<Record<string, unknown>> }): Promise<AgentSession> {
    await this.tail
    const id = this.agentSessionId(request)
    const existing = this.getDocument<AgentSession>('agent-sessions', id)
    if (existing) return existing
    const session: AgentSession = {
      appName: request.appName,
      userId: request.userId,
      sessionId: request.sessionId,
      state: { ...request.state },
      events: [],
      lastUpdateTime: now(),
    }
    this.put('agent-sessions', id, session)
    return session
  }
  async get(request: SessionKey): Promise<AgentSession | undefined> {
    await this.tail
    return this.getDocument<AgentSession>('agent-sessions', this.agentSessionId(request)) ?? undefined
  }
  async appendEvent({ session, event }: { readonly session: AgentSession; readonly event: AgentEvent }): Promise<AgentEvent> {
    if (event.partial) return event
    const result = this.tail.then(async () => {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        const id = this.agentSessionId(session)
        const current = this.getDocument<AgentSession>('agent-sessions', id)
        if (!current) throw new Error('Agent session not found')
        const events = current.events.some(item => item.id === event.id)
          ? current.events.map(item => item.id === event.id ? event : item)
          : [...current.events, event]
        this.put('agent-sessions', id, {
          ...current,
          state: { ...current.state, ...event.actions.stateDelta },
          events,
          lastUpdateTime: event.timestamp,
        })
        this.db.exec('COMMIT')
        return event
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    })
    this.tail = result.catch(() => {})
    return result
  }
  async delete(request: SessionKey): Promise<void> {
    const result = this.tail.then(() => {
      this.db.prepare('DELETE FROM documents WHERE bucket=? AND id=?').run('agent-sessions', this.agentSessionId(request))
    })
    this.tail = result.catch(() => {})
    await result
  }
  identity: LocalState['identity'] = () => this.getDocument('identity', 'worker')
  saveIdentity: LocalState['saveIdentity'] = identity => this.put('identity', 'worker', identity)
  clearIdentity: LocalState['clearIdentity'] = () => { this.db.prepare('DELETE FROM documents WHERE bucket=? AND id=?').run('identity', 'worker') }
  localInstallation: LocalState['localInstallation'] = () => this.getDocument<LocalInstallationIdentity>('identity', 'installation')
  saveLocalInstallation: LocalState['saveLocalInstallation'] = identity => this.put('identity', 'installation', identity)
  localAdmin: LocalState['localAdmin'] = () => this.getDocument<LocalAdminRecord>('identity', 'local-admin')
  saveLocalAdmin: LocalState['saveLocalAdmin'] = record => this.put('identity', 'local-admin', record)
  capabilities: LocalState['capabilities'] = () => this.getDocument('capabilities', 'snapshot') ?? []
  saveCapabilities: LocalState['saveCapabilities'] = value => this.put('capabilities', 'snapshot', value)
  async listConnectorDefinitions(): Promise<readonly ConnectorDefinition[]> {
    await this.tail
    const local = this.list<ConnectorDefinition>('connector-definitions')
    const cluster = this.list<ConnectorDefinition>('cluster-connector-definitions')
    const byId = new Map(local.map(value => [value.id, value]))
    for (const value of cluster) byId.set(value.id, value) // Server project definitions are authoritative on id collision.
    return [...byId.values()]
  }
  async getConnectorDefinition(id: string): Promise<ConnectorDefinition | null> { await this.tail; return this.getDocument('cluster-connector-definitions', id) ?? this.getDocument('connector-definitions', id) }
  async saveConnectorDefinition(definition: ConnectorDefinition): Promise<void> { await this.tail; this.put('connector-definitions', definition.id, definition) }
  saveClusterConnectorDefinition(definition: ConnectorDefinition): Promise<'applied' | 'current' | 'stale'> {
    return this.mutate(async () => {
      const existing = this.getDocument<ConnectorDefinition>('cluster-connector-definitions', definition.id)
      if (existing && existing.projectId !== definition.projectId) throw new Error('Connector project binding is immutable')
      if (existing && existing.revision > definition.revision) return 'stale'
      if (existing && existing.revision === definition.revision) return JSON.stringify(existing) === JSON.stringify(definition) ? 'current' : Promise.reject(new Error('Connector revision content conflict'))
      this.put('cluster-connector-definitions', definition.id, definition)
      return 'applied'
    })
  }
  async deleteConnectorDefinition(id: string): Promise<void> { await this.tail; this.db.prepare("DELETE FROM documents WHERE bucket='connector-definitions' AND id=?").run(id) }
  async getConnectorCredential(id: string): Promise<CredentialRecord | null> {
    await this.tail
    const row = this.db.prepare('SELECT * FROM connector_credentials WHERE id=?').get(id) as Record<string, unknown> | undefined
    if (!row) return null
    return { id: String(row.id), owner: { kind: 'connector', connectorId: String(row.owner_id) }, authType: String(row.auth_type), ciphertext: String(row.ciphertext), profile: JSON.parse(String(row.profile_json)), revision: Number(row.revision), createdAt: String(row.created_at), updatedAt: String(row.updated_at) } as CredentialRecord
  }
  async saveConnectorCredential(record: CredentialRecord): Promise<void> {
    if (record.owner.kind !== 'connector') throw new Error('Worker only stores connector credentials')
    await this.tail
    this.db.prepare(`INSERT INTO connector_credentials VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET owner_kind=excluded.owner_kind,owner_id=excluded.owner_id,auth_type=excluded.auth_type,ciphertext=excluded.ciphertext,profile_json=excluded.profile_json,revision=excluded.revision,updated_at=excluded.updated_at`).run(record.id, 'connector', record.owner.connectorId, record.authType, record.ciphertext, JSON.stringify(record.profile), record.revision, record.createdAt, record.updatedAt)
  }
  async deleteConnectorCredential(id: string): Promise<void> { await this.tail; this.db.prepare('DELETE FROM connector_credentials WHERE id=?').run(id) }
  async getConnectorExecution(requestId: string): Promise<ConnectorExecutionRecord | null> {
    await this.tail
    const row = this.db.prepare('SELECT body FROM connector_executions WHERE request_id=?').get(requestId) as { body?: unknown } | undefined
    return row ? JSON.parse(String(row.body)) as ConnectorExecutionRecord : null
  }
  async beginConnectorExecution(record: ConnectorExecutionRecord): Promise<'inserted' | 'exists'> {
    await this.tail
    const inserted = this.db.prepare('INSERT OR IGNORE INTO connector_executions VALUES (?,?,?,?,?,?,?,?)').run(record.requestId, record.fingerprint, record.state, record.toolCall.sessionId, JSON.stringify(record), null, record.createdAt, null)
    return inserted.changes === 1 ? 'inserted' : 'exists'
  }
  async finishConnectorExecution(requestId: string, result: ExecutionResult, journalSummary: unknown): Promise<void> {
    await this.tail
    const row = this.db.prepare('SELECT body FROM connector_executions WHERE request_id=?').get(requestId) as { body?: unknown } | undefined
    if (!row) throw new Error('Connector execution not found')
    const current = JSON.parse(String(row.body)) as ConnectorExecutionRecord
    const record: ConnectorExecutionRecord = { ...current, state: 'completed', result, journalSummary, completedAt: result.completedAt }
    this.db.prepare('UPDATE connector_executions SET state=?,body=?,journal_summary=?,completed_at=? WHERE request_id=?').run('completed', JSON.stringify(record), JSON.stringify(journalSummary), result.completedAt, requestId)
  }
  async listConnectorJournal(sessionId: string): Promise<readonly ConnectorExecutionRecord[]> {
    await this.tail
    return (this.db.prepare('SELECT body FROM connector_executions WHERE session_id=? AND state=? ORDER BY created_at').all(sessionId, 'completed') as { body?: unknown }[]).map(row => JSON.parse(String(row.body)) as ConnectorExecutionRecord)
  }
  listSessions = async () => { await this.tail; return this.list<SessionExecution>('sessions').map(session => ({ ...session, storageMode: session.storageMode ?? 'local' as const })) }
  listWorkspaces = async () => { await this.tail; return this.list<LocalWorkspace>('workspaces') }
  workspaces: WorkerStore['workspaces'] = {
    get: async id => { await this.tail; return this.getDocument('workspaces', id) },
    listRepositoryCheckouts: async id => { await this.tail; return this.list<RepositoryCheckout>('checkouts').filter(item => item.workspaceId === id) },
  }
  sessions: WorkerStore['sessions'] = {
    get: async id => { await this.tail; const session = this.getDocument<SessionExecution>('sessions', id); return session ? { ...session, storageMode: session.storageMode ?? 'local' as const } : null },
    getTurn: async id => { await this.tail; return this.getDocument('turns', id) },
    listQueued: async id => { await this.tail; return this.queued(id) },
  }
  commands: WorkerStore['commands'] = {
    get: async id => { await this.tail; return this.getDocument('commands', id) },
    listRecoverable: async limit => { await this.tail; return this.list<CommandRecord>('commands').filter(c => c.state === 'accepted' || c.state === 'running').slice(0, limit) },
  }
  journal: WorkerStore['journal'] = {
    read: async ({ sessionId, fromSeq, limit }) => {
      await this.tail
      const rows = this.db.prepare('SELECT body FROM journal WHERE session_id=? AND seq>=? ORDER BY seq LIMIT ?').all(sessionId, fromSeq, limit + 1)
      const events = rows.slice(0, limit).map(row => JSON.parse(String(row.body)) as JournalEvent)
      return { events, throughSeq: (events.at(-1)?.seq ?? fromSeq - 1) as EventSeq, hasMore: rows.length > limit }
    },
    listHeads: async () => { await this.tail; return this.list<SessionExecution>('sessions').map(s => ({ sessionId: s.sessionId, lastSeq: this.head(s.sessionId) })) },
    getEvent: async (id, seq) => {
      await this.tail
      const row = this.db.prepare('SELECT body FROM journal WHERE session_id=? AND seq=?').get(id, seq)
      return row ? JSON.parse(String(row.body)) as JournalEvent : null
    },
  }
  private head(id: SessionId): EventSeq {
    return Number(this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM journal WHERE session_id=?').get(id)?.seq) as EventSeq
  }
  private queued(id: SessionId) {
    return this.list<QueuedMessage>('queue').filter(q => q.sessionId === id && q.state === 'queued').sort((a,b) => a.position - b.position)
  }
  private session(id: SessionId) {
    const session = this.getDocument<SessionExecution>('sessions', id)
    if (!session) throw new Error('Session not found')
    return session
  }
  private append(id: SessionId, drafts: readonly JournalEventDraft[]): JournalEvent[] {
    this.session(id)
    let seq = this.head(id)
    return drafts.map(draft => {
      const event = { ...draft, sessionId: id, seq: ++seq as EventSeq }
      this.db.prepare('INSERT INTO journal VALUES (?,?,?)').run(id, seq, JSON.stringify(event))
      return event
    })
  }
  private state(id: SessionId, state: SessionExecution['runtimeState']) {
    const session = this.session(id)
    if (session.runtimeState === state) return
    this.put('sessions', id, { ...session, runtimeState: state, updatedAt: now() })
    this.append(id, [{ occurredAt: now(), payload: { kind: 'session.runtime.changed', state, reason: null } }])
  }
  private mutate<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work)
    this.tail = result.catch(() => {})
    return result
  }
  transaction<T>(work: (tx: WorkerStoreTx) => Promise<T>): Promise<T> {
    return this.mutate(async () => {
      this.db.exec('BEGIN IMMEDIATE')
      try { const value = await work(this.tx); this.db.exec('COMMIT'); return value }
      catch (error) { this.db.exec('ROLLBACK'); throw error }
    })
  }
  private tx: WorkerStoreTx = {
    workspaces: {
      save: async workspace => this.put('workspaces', workspace.id, workspace),
      saveRepositoryCheckouts: async items => { for (const item of items) this.put('checkouts', `${item.workspaceId}:${item.repositoryId}`, item) },
      remove: async id => { this.db.prepare('DELETE FROM documents WHERE bucket=? AND id=?').run('workspaces', id) },
    },
    commands: {
      record: async (command, receipt) => {
        if (this.getDocument('commands', command.commandId)) throw new Error('Command already recorded')
        this.put('commands', command.commandId, { ...command, state: receipt.status === 'accepted' ? 'accepted' : 'rejected', result: receipt, recordedAt: now(), updatedAt: now() })
      },
      setExecutionState: async input => {
        const record = this.getDocument<CommandRecord>('commands', input.commandId)
        if (!record) throw new Error('Command not found')
        this.put('commands', input.commandId, { ...record, state: input.state, result: input.result, updatedAt: input.updatedAt })
      },
    },
    sessions: {
      deleteSession: async id => {
        const session = this.getDocument<import('../domain/session-execution.js').SessionExecution>('sessions', id)
        if (session?.activeTurnId || this.queued(id).length) throw new Error('Session is active')
        if (!this.getDocument('deleted-sessions', id)) this.put('deleted-sessions', id, { deletedAt: now() })
        this.db.prepare('DELETE FROM journal WHERE session_id=?').run(id)
        this.db.prepare("DELETE FROM documents WHERE (bucket='sessions' AND id=?) OR (bucket IN ('queue','turns') AND json_extract(body,'$.sessionId')=?)").run(id, id)
      },
      createSession: async (id, binding, storageMode = 'local') => {
        if (storageMode !== 'local') throw new Error('Session storage mode is not available')
        if (this.getDocument('deleted-sessions', id)) throw new Error('Session deleted')
        if (this.getDocument('sessions', id)) throw new Error('Session already exists')
        this.put('sessions', id, { sessionId: id, storageMode, binding, runtimeState: 'idle', activeTurnId: null, nativeSession: null, updatedAt: now() })
        this.append(id, [{ occurredAt: now(), payload: { kind: 'session.runtime.changed', state: 'idle', reason: null } }])
      },
      enqueue: async input => {
        const session = this.session(input.sessionId)
        const items = this.list<QueuedMessage>('queue').filter(q => q.sessionId === input.sessionId)
        if (items.some(q => q.message.messageId === input.message.messageId)) throw new Error('Message already submitted')
        const item: QueuedMessage = { sessionId: input.sessionId, submissionCommandId: input.submissionCommandId, message: input.message, queuedAt: input.queuedAt, capabilitySnapshot: input.capabilities?.snapshot ?? null, capabilityToken: input.capabilities?.token ?? null, capabilityTurnId: input.capabilities?.grant.turnId ?? null, position: Math.max(0, ...items.map(q => q.position)) + 1, state: 'queued' }
        this.put('queue', input.submissionCommandId, item)
        this.append(input.sessionId, [{ occurredAt: now(), payload: { kind: 'message.queued', commandId: input.submissionCommandId, messageId: input.message.messageId, content: input.message.content, position: item.position, ...(input.message.sentByAccountId ? { sentByAccountId: input.message.sentByAccountId } : {}) } }])
        if (!session.activeTurnId) this.state(input.sessionId, 'queued')
        return item
      },
      cancelQueued: async (id, commandId) => {
        const item = this.getDocument<QueuedMessage>('queue', commandId)
        if (!item || item.sessionId !== id || item.state === 'cancelled') return { status: 'not-found' }
        if (item.state === 'claimed') {
          const turn = this.list<Turn>('turns').find(t => t.sessionId === id && t.message.messageId === item.message.messageId)!
          return { status: 'already-started', turnId: turn.id }
        }
        this.put('queue', commandId, { ...item, state: 'cancelled' })
        this.append(id, [{ occurredAt: now(), payload: { kind: 'message.cancelled', commandId, messageId: item.message.messageId } }])
        if (!this.session(id).activeTurnId && !this.queued(id).length) this.state(id, 'idle')
        return { status: 'cancelled', messageId: item.message.messageId }
      },
      claimNext: async id => {
        const session = this.session(id)
        if (session.activeTurnId) return null
        const item = this.queued(id)[0]
        if (!item) return null
        const turn: Turn = { id: item.capabilityTurnId ?? randomUUID() as TurnId, sessionId: id, message: item.message, state: 'running', startedAt: now(), finishedAt: null, failure: null, capabilitySnapshot: item.capabilitySnapshot, capabilityToken: item.capabilityToken }
        this.put('queue', item.submissionCommandId, { ...item, state: 'claimed' })
        this.put('turns', turn.id, turn)
        this.put('sessions', id, { ...session, activeTurnId: turn.id })
        this.append(id, [{ occurredAt: now(), payload: { kind: 'turn.started', turnId: turn.id, messageId: item.message.messageId } }])
        this.state(id, 'running')
        return turn
      },
      bindNativeSession: async ({ sessionId, nativeSession }) => this.put('sessions', sessionId, { ...this.session(sessionId), nativeSession }),
      setModel: async (id, modelId) => {
        const session = this.session(id)
        const previousModelId = session.binding.modelId
        if (previousModelId === modelId) return
        this.put('sessions', id, { ...session, binding: { ...session.binding, modelId }, updatedAt: now() })
        this.append(id, [{ occurredAt: now(), payload: { kind: 'model.changed', previousModelId, modelId } }])
      },
      requestStop: async (id, turnId) => {
        const turn = this.getDocument<Turn>('turns', turnId)
        if (!turn || turn.sessionId !== id) return { status: 'not-found' }
        if (turn.finishedAt) return { status: 'already-finished' }
        this.put('turns', turnId, { ...turn, state: 'stopping' })
        this.state(id, 'stopping')
        return { status: 'stopping' }
      },
      setRuntimeState: async (id, state) => this.state(id, state),
      finishTurn: async result => {
        const turn = this.getDocument<Turn>('turns', result.turnId)
        if (!turn || turn.finishedAt) return
        this.put('turns', turn.id, { ...turn, state: result.outcome, finishedAt: result.finishedAt, failure: result.outcome === 'failed' ? result.failure : null })
        const session = this.session(turn.sessionId)
        this.put('sessions', turn.sessionId, { ...session, activeTurnId: null })
        this.append(turn.sessionId, [{ occurredAt: result.finishedAt, payload: { kind: 'turn.finished', turnId: turn.id, outcome: result.outcome, failure: result.outcome === 'failed' ? result.failure : null } }])
        this.state(turn.sessionId, this.queued(turn.sessionId).length ? 'queued' : result.outcome === 'failed' ? 'failed' : 'idle')
      },
    },
    appendJournal: async (id, events) => this.append(id, events),
  }
}
