import type { DatabaseSync } from 'node:sqlite'
import type {
  Resource,
  ResourceBinding,
  ResourceBindingStatus,
  ResourceId,
  ResourceRevision,
  ResourceRevisionId,
  ResourceSetSnapshot,
  NodeResourcePreset,
  NodeResourcePresetApplication,
  Timestamp,
  UserId,
  WorkerId,
} from '@wemux/domain'
import { assertResourceBindingTransition, assertResourceRevisionImmutable, assertResourceRevisionValid } from '@wemux/domain'
import { resolveSqliteDatabase, type SqliteDatabaseSource } from './sqlite/shared-database.ts'

type RevisionRow = { data: string }
type BindingRow = { data: string; status: ResourceBindingStatus; revision: number }
type SetRow = { revision: number; fingerprint: string; snapshot_json: string; updated_at: string }

export class SqliteResourceRepository {
  readonly db: DatabaseSync
  readonly ownsDatabase: boolean
  readonly database: import('./sqlite/shared-database.ts').SharedSqliteDatabase

  constructor(source: SqliteDatabaseSource) {
    const opened = resolveSqliteDatabase(source)
    this.db = opened.database.connection
    this.database = opened.database
    this.ownsDatabase = opened.owned
    this.migrate()
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS resources (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        data TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS resource_revisions (
        id TEXT PRIMARY KEY,
        resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE RESTRICT,
        kind TEXT NOT NULL,
        version INTEGER NOT NULL,
        content_sha256 TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(resource_id, version)
      );
      CREATE TABLE IF NOT EXISTS resource_bindings (
        id TEXT PRIMARY KEY,
        worker_id TEXT NOT NULL,
        resource_revision_id TEXT NOT NULL REFERENCES resource_revisions(id) ON DELETE RESTRICT,
        resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE RESTRICT,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        revision INTEGER NOT NULL,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(worker_id, resource_revision_id)
      );
      CREATE INDEX IF NOT EXISTS resource_bindings_worker_index ON resource_bindings(worker_id, status);
      CREATE TABLE IF NOT EXISTS resource_sets (
        worker_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        fingerprint TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS resource_presets (
        id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY(id, revision)
      );
      CREATE TABLE IF NOT EXISTS resource_preset_applications (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        preset_id TEXT NOT NULL,
        preset_revision INTEGER NOT NULL,
        worker_id TEXT NOT NULL,
        data TEXT NOT NULL,
        FOREIGN KEY(preset_id, preset_revision) REFERENCES resource_presets(id, revision)
      );
      CREATE INDEX IF NOT EXISTS resource_preset_applications_worker ON resource_preset_applications(worker_id);
      CREATE TABLE IF NOT EXISTS resource_reconcile_reports (
        request_id TEXT PRIMARY KEY,
        worker_id TEXT NOT NULL,
        binding_id TEXT NOT NULL,
        resource_set_revision INTEGER NOT NULL,
        report_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );
    `)
  }

  close(): void { if (this.ownsDatabase) this.db.close() }

  transaction<T>(work: () => T | Promise<T>): Promise<T> { return this.database.transaction(work) }

  presets(): readonly NodeResourcePreset[] {
    return (this.db.prepare('SELECT data FROM resource_presets ORDER BY id,revision').all() as { data: string }[]).map(row => JSON.parse(row.data) as NodeResourcePreset)
  }

  preset(id: string, revision: number): NodeResourcePreset | null {
    const row = this.db.prepare('SELECT data FROM resource_presets WHERE id=? AND revision=?').get(id, revision) as { data: string } | undefined
    return row ? JSON.parse(row.data) as NodeResourcePreset : null
  }

  createPreset(preset: NodeResourcePreset, expectedRevision: number): NodeResourcePreset {
    const latest = this.db.prepare('SELECT max(revision) AS revision FROM resource_presets WHERE id=?').get(preset.id) as { revision: number | null }
    if ((latest.revision ?? 0) !== expectedRevision || preset.revision !== expectedRevision + 1) throw new Error('preset_revision_conflict')
    this.db.prepare('INSERT INTO resource_presets(id,revision,data) VALUES(?,?,?)').run(preset.id, preset.revision, JSON.stringify(preset))
    return preset
  }

  presetApplication(requestId: string): NodeResourcePresetApplication | null {
    const row = this.db.prepare('SELECT data FROM resource_preset_applications WHERE request_id=?').get(requestId) as { data: string } | undefined
    return row ? JSON.parse(row.data) as NodeResourcePresetApplication : null
  }

  presetApplications(workerId?: WorkerId): readonly NodeResourcePresetApplication[] {
    const rows = (workerId ? this.db.prepare('SELECT data FROM resource_preset_applications WHERE worker_id=? ORDER BY rowid DESC').all(workerId) : this.db.prepare('SELECT data FROM resource_preset_applications ORDER BY rowid DESC').all()) as { data: string }[]
    return rows.map(row => JSON.parse(row.data) as NodeResourcePresetApplication)
  }

  createPresetApplication(value: NodeResourcePresetApplication): void {
    this.db.prepare('INSERT INTO resource_preset_applications(id,request_id,preset_id,preset_revision,worker_id,data) VALUES(?,?,?,?,?,?)').run(value.id, value.requestId, value.presetId, value.presetRevision, value.workerId, JSON.stringify(value))
  }

  createResource(resource: Resource): Resource {
    this.db.prepare('INSERT INTO resources(id,kind,name,description,data,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(resource.id, resource.kind, resource.name, resource.description, JSON.stringify(resource), resource.createdBy, resource.createdAt, resource.updatedAt)
    return resource
  }

  updateResource(resource: Resource): Resource {
    const result = this.db.prepare('UPDATE resources SET name=?,description=?,data=?,updated_at=? WHERE id=? AND kind=?').run(resource.name, resource.description, JSON.stringify(resource), resource.updatedAt, resource.id, resource.kind)
    if (result.changes !== 1) throw new Error('resource_not_found')
    return resource
  }

  resource(id: ResourceId): Resource | null {
    const row = this.db.prepare('SELECT data FROM resources WHERE id=?').get(id) as { data: string } | undefined
    return row ? JSON.parse(row.data) as Resource : null
  }

  resources(): readonly Resource[] {
    return (this.db.prepare('SELECT data FROM resources ORDER BY created_at,id').all() as Array<{ data: string }>).map(row => JSON.parse(row.data) as Resource)
  }

  deleteResource(id: ResourceId): void {
    const result = this.db.prepare('DELETE FROM resources WHERE id=?').run(id)
    if (result.changes !== 1) throw new Error('resource_not_found')
  }

  createRevision(revision: ResourceRevision): ResourceRevision {
    assertResourceRevisionValid(revision)
    const existing = this.revision(revision.id)
    if (existing) {
      assertResourceRevisionImmutable(existing, revision)
      return existing
    }
    const resource = this.resource(revision.resourceId)
    if (!resource || resource.kind !== revision.kind) throw new Error('resource_kind_mismatch')
    this.db.prepare('INSERT INTO resource_revisions(id,resource_id,kind,version,content_sha256,data,created_at) VALUES(?,?,?,?,?,?,?)').run(revision.id, revision.resourceId, revision.kind, revision.version, revision.contentSha256, JSON.stringify(revision), revision.createdAt)
    return revision
  }

  revision(id: ResourceRevisionId): ResourceRevision | null {
    const row = this.db.prepare('SELECT data FROM resource_revisions WHERE id=?').get(id) as RevisionRow | undefined
    return row ? JSON.parse(row.data) as ResourceRevision : null
  }

  revisions(resourceId: ResourceId): readonly ResourceRevision[] {
    return (this.db.prepare('SELECT data FROM resource_revisions WHERE resource_id=? ORDER BY version').all(resourceId) as RevisionRow[]).map(row => JSON.parse(row.data) as ResourceRevision)
  }

  assertRevisionUnchanged(revision: ResourceRevision): void {
    const stored = this.revision(revision.id)
    if (!stored) throw new Error('resource_revision_not_found')
    assertResourceRevisionImmutable(stored, revision)
  }

  createBinding(binding: ResourceBinding): ResourceBinding {
    if (!this.revision(binding.resourceRevisionId)) throw new Error('resource_revision_not_found')
    this.db.prepare('INSERT INTO resource_bindings(id,worker_id,resource_revision_id,resource_id,kind,status,revision,data,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(binding.id, binding.workerId, binding.resourceRevisionId, binding.resourceId, binding.kind, binding.status, binding.revision, JSON.stringify(binding), binding.updatedAt)
    return binding
  }

  binding(id: string): ResourceBinding | null {
    const row = this.db.prepare('SELECT data FROM resource_bindings WHERE id=?').get(id) as { data: string } | undefined
    return row ? JSON.parse(row.data) as ResourceBinding : null
  }

  bindings(workerId?: WorkerId): readonly ResourceBinding[] {
    const rows = (workerId
      ? this.db.prepare('SELECT data FROM resource_bindings WHERE worker_id=? ORDER BY updated_at,id').all(workerId)
      : this.db.prepare('SELECT data FROM resource_bindings ORDER BY updated_at,id').all()) as Array<{ data: string }>
    return rows.map(row => JSON.parse(row.data) as ResourceBinding)
  }

  transitionBinding(id: string, status: ResourceBindingStatus, expectedRevision: number, updatedAt: Timestamp): ResourceBinding {
    const row = this.db.prepare('SELECT data,status,revision FROM resource_bindings WHERE id=?').get(id) as BindingRow | undefined
    if (!row) throw new Error('resource_binding_not_found')
    if (row.revision !== expectedRevision) throw new Error('resource_binding_revision_conflict')
    assertResourceBindingTransition(row.status, status)
    const previous = JSON.parse(row.data) as ResourceBinding
    const next = { ...previous, status, revision: previous.revision + 1, updatedAt } satisfies ResourceBinding
    const result = this.db.prepare('UPDATE resource_bindings SET status=?,revision=?,data=?,updated_at=? WHERE id=? AND revision=?').run(next.status, next.revision, JSON.stringify(next), next.updatedAt, id, expectedRevision)
    if (result.changes !== 1) throw new Error('resource_binding_revision_conflict')
    return next
  }

  resourceSet(workerId: WorkerId): ResourceSetSnapshot | null {
    const row = this.db.prepare('SELECT revision,fingerprint,snapshot_json,updated_at FROM resource_sets WHERE worker_id=?').get(workerId) as SetRow | undefined
    return row ? JSON.parse(row.snapshot_json) as ResourceSetSnapshot : null
  }

  putResourceSet(snapshot: ResourceSetSnapshot, expectedRevision: number): ResourceSetSnapshot {
    const current = this.resourceSet(snapshot.workerId)
    if ((current?.revision ?? 0) !== expectedRevision || snapshot.revision !== expectedRevision + 1) throw new Error('resource_set_revision_conflict')
    const result = expectedRevision === 0
      ? this.db.prepare('INSERT OR IGNORE INTO resource_sets(worker_id,revision,fingerprint,snapshot_json,updated_at) VALUES(?,?,?,?,?)').run(snapshot.workerId, snapshot.revision, snapshot.fingerprint, JSON.stringify(snapshot), snapshot.createdAt)
      : this.db.prepare('UPDATE resource_sets SET revision=?,fingerprint=?,snapshot_json=?,updated_at=? WHERE worker_id=? AND revision=?').run(snapshot.revision, snapshot.fingerprint, JSON.stringify(snapshot), snapshot.createdAt, snapshot.workerId, expectedRevision)
    if (result.changes !== 1) throw new Error('resource_set_revision_conflict')
    return snapshot
  }

  recordReport(report: import('@wemux/domain').ReconcileReport): void {
    this.db.prepare('INSERT OR IGNORE INTO resource_reconcile_reports(request_id,worker_id,binding_id,resource_set_revision,report_json,occurred_at) VALUES(?,?,?,?,?,?)').run(report.requestId, report.workerId, report.bindingId, report.resourceSetRevision, JSON.stringify(report), report.occurredAt)
  }

  latestReport(bindingId: string): import('@wemux/domain').ReconcileReport | null {
    const row = this.db.prepare('SELECT report_json FROM resource_reconcile_reports WHERE binding_id=? ORDER BY occurred_at DESC,rowid DESC LIMIT 1').get(bindingId) as { report_json: string } | undefined
    return row ? JSON.parse(row.report_json) as import('@wemux/domain').ReconcileReport : null
  }
}
