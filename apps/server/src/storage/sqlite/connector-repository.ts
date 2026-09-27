import { DatabaseSync } from 'node:sqlite'
import type { ConnectorDefinition, ConnectorId } from '@wemux/connector'
import { migrate } from './migrations.ts'
import type {
  ConnectorDistributionRecord,
  ConnectorRepository,
  ConnectorRequestRecord,
} from '../../application/ports/connector-repository.ts'

export class SqliteConnectorRepository implements ConnectorRepository {
  private queue: Promise<unknown> = Promise.resolve()
  private readonly db: DatabaseSync
  constructor(path: string) { this.db = new DatabaseSync(path); this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;'); migrate(this.db) }
  close(): void { this.db.close() }

  private serial<T>(work: () => T): Promise<T> {
    const result = this.queue.then(work)
    this.queue = result.catch(() => undefined)
    return result
  }

  get(id: ConnectorId): Promise<ConnectorDefinition | null> {
    return this.serial(() => {
      const row = this.db.prepare('SELECT data FROM connector_definitions WHERE id=?').get(id)
      return row ? JSON.parse(String(row.data)) as ConnectorDefinition : null
    })
  }

  list(projectId: string): Promise<readonly ConnectorDefinition[]> {
    return this.serial(() => this.db.prepare('SELECT data FROM connector_definitions WHERE project_id=? ORDER BY id').all(projectId).map(row => JSON.parse(String(row.data)) as ConnectorDefinition))
  }

  getRequest(projectId: string, requestId: string): Promise<ConnectorRequestRecord | null> {
    return this.serial(() => {
      const row = this.db.prepare('SELECT * FROM connector_requests WHERE project_id=? AND request_id=?').get(projectId, requestId)
      return row ? this.request(row) : null
    })
  }

  create(definition: ConnectorDefinition, request: ConnectorRequestRecord): Promise<void> {
    return this.serial(() => this.transaction(() => {
      this.db.prepare('INSERT INTO connector_definitions VALUES(?,?,?,?,?)').run(definition.id, definition.projectId, definition.revision, definition.enabled ? 1 : 0, JSON.stringify(definition))
      this.insertRequest(request)
    }))
  }

  update(definition: ConnectorDefinition, expectedRevision: number, request: ConnectorRequestRecord): Promise<boolean> {
    return this.serial(() => this.transaction(() => {
      const changed = this.db.prepare('UPDATE connector_definitions SET revision=?,enabled=?,data=? WHERE id=? AND project_id=? AND revision=?').run(definition.revision, definition.enabled ? 1 : 0, JSON.stringify(definition), definition.id, definition.projectId, expectedRevision).changes === 1
      if (changed) this.insertRequest(request)
      return changed
    }))
  }

  saveRequest(request: ConnectorRequestRecord): Promise<void> { return this.serial(() => { this.insertRequest(request) }) }

  listDistributions(connectorId: ConnectorId): Promise<readonly ConnectorDistributionRecord[]> {
    return this.serial(() => this.db.prepare('SELECT * FROM connector_distributions WHERE connector_id=? ORDER BY worker_id').all(connectorId).map(row => this.distribution(row)))
  }

  saveDistribution(record: ConnectorDistributionRecord): Promise<void> {
    return this.serial(() => { this.db.prepare(`INSERT INTO connector_distributions VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(connector_id,worker_id) DO UPDATE SET revision=excluded.revision,request_id=excluded.request_id,command_id=excluded.command_id,status=excluded.status,credential_availability=excluded.credential_availability,message=excluded.message,updated_at=excluded.updated_at WHERE excluded.revision >= connector_distributions.revision`).run(record.connectorId, record.workerId, record.revision, record.requestId, record.commandId, record.status, record.credentialAvailability, record.message, record.updatedAt) })
  }

  applyReport(record: Omit<ConnectorDistributionRecord, 'commandId'>): Promise<void> {
    return this.serial(() => { this.db.prepare('UPDATE connector_distributions SET status=?,credential_availability=?,message=?,updated_at=? WHERE connector_id=? AND worker_id=? AND revision<=?').run(record.status, record.credentialAvailability, record.message, record.updatedAt, record.connectorId, record.workerId, record.revision) })
  }

  private transaction<T>(work: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const result = work(); this.db.exec('COMMIT'); return result } catch (error) { this.db.exec('ROLLBACK'); throw error } }
  private insertRequest(value: ConnectorRequestRecord): void { this.db.prepare('INSERT INTO connector_requests VALUES(?,?,?,?,?,?,?)').run(value.projectId, value.requestId, value.fingerprint, value.operation, value.connectorId, JSON.stringify(value.result), value.createdAt) }
  private request(row: Record<string, unknown>): ConnectorRequestRecord { return { projectId: String(row.project_id), requestId: String(row.request_id), fingerprint: String(row.fingerprint), operation: String(row.operation) as ConnectorRequestRecord['operation'], connectorId: String(row.connector_id) as ConnectorId, result: JSON.parse(String(row.result)), createdAt: String(row.created_at) as never } }
  private distribution(row: Record<string, unknown>): ConnectorDistributionRecord { return { connectorId: String(row.connector_id) as ConnectorId, workerId: String(row.worker_id) as never, revision: Number(row.revision), requestId: String(row.request_id), commandId: String(row.command_id), status: String(row.status) as ConnectorDistributionRecord['status'], credentialAvailability: String(row.credential_availability) as ConnectorDistributionRecord['credentialAvailability'], message: row.message === null ? null : String(row.message), updatedAt: String(row.updated_at) as never } }
}
