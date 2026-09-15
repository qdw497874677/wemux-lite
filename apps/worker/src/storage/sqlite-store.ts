import { DatabaseSync } from 'node:sqlite'
import { retentionDestinationInvariants, retentionInvariants } from './retention-invariants.js'
import { randomUUID } from 'node:crypto'
import type { EventSeq, JournalEvent, JournalEventDraft, QueuedMessage, SessionId, Timestamp, Turn, TurnId } from '@wemux/domain'
import type { WorkerStore, WorkerStoreTx } from '../application/ports/worker-store.js'
import type { LocalState } from '../application/ports/local-state.js'
import type { CommandRecord, SessionExecution } from '../domain/session-execution.js'
import type { LocalWorkspace, RepositoryCheckout } from '../domain/local-workspace.js'

export const now = () => new Date().toISOString() as Timestamp

/** Serialized transactions also isolate async port callbacks from other transactions. */
export class SqliteWorkerStore implements WorkerStore, LocalState {
  private readonly db: DatabaseSync
  private tail: Promise<unknown> = Promise.resolve()

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
    const version = this.db.prepare('PRAGMA user_version').get()?.user_version
    if (version !== 0 && version !== 1 && version !== 2 && version !== 3) { this.db.close(); throw new Error('Unsupported Worker database schema') }
    if (version === 0) this.db.exec(`BEGIN;
      CREATE TABLE documents (bucket TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(bucket,id));
      CREATE TABLE journal (session_id TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(session_id,seq));
      PRAGMA user_version=1; COMMIT;`)
    if (version !== 3) {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        if (version !== 2) this.db.exec(retentionInvariants)
        this.db.exec(retentionDestinationInvariants)
        this.db.exec('PRAGMA user_version=3; COMMIT;')
      }
      catch (error) { this.db.exec('ROLLBACK'); this.db.close(); throw error }
    }
  }
  close() { this.db.close() }
  private get<T>(bucket: string, id: string): T | null {
    const row = this.db.prepare('SELECT body FROM documents WHERE bucket=? AND id=?').get(bucket, id)
    return row ? JSON.parse(String(row.body)) as T : null
  }
  private list<T>(bucket: string): T[] {
    return this.db.prepare('SELECT body FROM documents WHERE bucket=? ORDER BY rowid').all(bucket).map(row => JSON.parse(String(row.body)) as T)
  }
  private put(bucket: string, id: string, value: unknown) {
    this.db.prepare('INSERT INTO documents VALUES (?,?,?) ON CONFLICT(bucket,id) DO UPDATE SET body=excluded.body').run(bucket, id, JSON.stringify(value))
  }
  identity: LocalState['identity'] = () => this.get('identity', 'worker')
  saveIdentity: LocalState['saveIdentity'] = identity => this.put('identity', 'worker', identity)
  capabilities: LocalState['capabilities'] = () => this.get('capabilities', 'snapshot') ?? []
  saveCapabilities: LocalState['saveCapabilities'] = value => this.put('capabilities', 'snapshot', value)
  listSessions = async () => { await this.tail; return this.list<SessionExecution>('sessions') }
  listWorkspaces = async () => { await this.tail; return this.list<LocalWorkspace>('workspaces') }
  workspaces: WorkerStore['workspaces'] = {
    get: async id => { await this.tail; return this.get('workspaces', id) },
    listRepositoryCheckouts: async id => { await this.tail; return this.list<RepositoryCheckout>('checkouts').filter(item => item.workspaceId === id) },
  }
  sessions: WorkerStore['sessions'] = {
    get: async id => { await this.tail; return this.get('sessions', id) },
    getTurn: async id => { await this.tail; return this.get('turns', id) },
    listQueued: async id => { await this.tail; return this.queued(id) },
  }
  commands: WorkerStore['commands'] = {
    get: async id => { await this.tail; return this.get('commands', id) },
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
    const session = this.get<SessionExecution>('sessions', id)
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
  transaction<T>(work: (tx: WorkerStoreTx) => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      this.db.exec('BEGIN IMMEDIATE')
      try { const value = await work(this.tx); this.db.exec('COMMIT'); return value }
      catch (error) { this.db.exec('ROLLBACK'); throw error }
    })
    this.tail = result.catch(() => {})
    return result
  }
  private tx: WorkerStoreTx = {
    workspaces: {
      save: async workspace => this.put('workspaces', workspace.id, workspace),
      saveRepositoryCheckouts: async items => { for (const item of items) this.put('checkouts', `${item.workspaceId}:${item.repositoryId}`, item) },
      remove: async id => { this.db.prepare('DELETE FROM documents WHERE bucket=? AND id=?').run('workspaces', id) },
    },
    commands: {
      record: async (command, receipt) => {
        if (this.get('commands', command.commandId)) throw new Error('Command already recorded')
        this.put('commands', command.commandId, { ...command, state: receipt.status === 'accepted' ? 'accepted' : 'rejected', result: receipt, recordedAt: now(), updatedAt: now() })
      },
      setExecutionState: async input => {
        const record = this.get<CommandRecord>('commands', input.commandId)
        if (!record) throw new Error('Command not found')
        this.put('commands', input.commandId, { ...record, state: input.state, result: input.result, updatedAt: input.updatedAt })
      },
    },
    sessions: {
      deleteSession: async id => {
        const session = this.get<import('../domain/session-execution.js').SessionExecution>('sessions', id)
        if (session?.activeTurnId || this.queued(id).length) throw new Error('Session is active')
        if (!this.get('deleted-sessions', id)) this.put('deleted-sessions', id, { deletedAt: now() })
        this.db.prepare('DELETE FROM journal WHERE session_id=?').run(id)
        this.db.prepare("DELETE FROM documents WHERE (bucket='sessions' AND id=?) OR (bucket IN ('queue','turns') AND json_extract(body,'$.sessionId')=?)").run(id, id)
      },
      createSession: async (id, binding) => {
        if (this.get('deleted-sessions', id)) throw new Error('Session deleted')
        if (this.get('sessions', id)) throw new Error('Session already exists')
        this.put('sessions', id, { sessionId: id, binding, runtimeState: 'idle', activeTurnId: null, nativeSession: null, updatedAt: now() })
        this.append(id, [{ occurredAt: now(), payload: { kind: 'session.runtime.changed', state: 'idle', reason: null } }])
      },
      enqueue: async input => {
        const session = this.session(input.sessionId)
        const items = this.list<QueuedMessage>('queue').filter(q => q.sessionId === input.sessionId)
        if (items.some(q => q.message.messageId === input.message.messageId)) throw new Error('Message already submitted')
        const item: QueuedMessage = { sessionId: input.sessionId, submissionCommandId: input.submissionCommandId, message: input.message, queuedAt: input.queuedAt, capabilitySnapshot: input.capabilities?.snapshot ?? null, capabilityToken: input.capabilities?.token ?? null, capabilityTurnId: input.capabilities?.grant.turnId ?? null, position: Math.max(0, ...items.map(q => q.position)) + 1, state: 'queued' }
        this.put('queue', input.submissionCommandId, item)
        this.append(input.sessionId, [{ occurredAt: now(), payload: { kind: 'message.queued', commandId: input.submissionCommandId, messageId: input.message.messageId, content: input.message.content, position: item.position } }])
        if (!session.activeTurnId) this.state(input.sessionId, 'queued')
        return item
      },
      cancelQueued: async (id, commandId) => {
        const item = this.get<QueuedMessage>('queue', commandId)
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
      requestStop: async (id, turnId) => {
        const turn = this.get<Turn>('turns', turnId)
        if (!turn || turn.sessionId !== id) return { status: 'not-found' }
        if (turn.finishedAt) return { status: 'already-finished' }
        this.put('turns', turnId, { ...turn, state: 'stopping' })
        this.state(id, 'stopping')
        return { status: 'stopping' }
      },
      setRuntimeState: async (id, state) => this.state(id, state),
      finishTurn: async result => {
        const turn = this.get<Turn>('turns', result.turnId)
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
