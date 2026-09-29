import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ResourceSetSnapshot } from '@wemux/domain'

export interface InstalledResourceState {
  readonly bindingId: string
  readonly resourceId: string
  readonly resourceRevisionId: string
  readonly kind: 'skill' | 'agent-runtime'
  readonly integrity: string
  /** Only runtime entries have a fixed catalog key and staged executable. */
  readonly runtimeKey?: 'pi' | 'opencode' | 'claude-code'
  readonly executable?: string
  /** Selection active before the staged runtime was activated at Worker startup. */
  readonly previousExecutable?: string | null
  readonly previousSelection?: import('../config/agent-settings.ts').AgentSelection | null
  /** Fresh-start Agent probe; never infer ready from the npm version probe alone. */
  readonly activation?: 'ready' | 'credential-required' | 'failed'
  readonly files: Readonly<Record<string, string>>
  readonly path: string
  readonly installedAt: string
  readonly lastUsedAt: string
}

export class ResourceStateStore {
  private readonly database: DatabaseSync

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.database = new DatabaseSync(path)
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS resource_desired_state (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        revision INTEGER NOT NULL,
        fingerprint TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS resource_installed_state (
        resource_id TEXT PRIMARY KEY,
        revision_id TEXT NOT NULL,
        binding_id TEXT NOT NULL,
        integrity TEXT NOT NULL,
        state_json TEXT NOT NULL,
        last_used_at TEXT NOT NULL
      );
    `)
  }

  desired(): ResourceSetSnapshot | null {
    const row = this.database.prepare('SELECT snapshot_json FROM resource_desired_state WHERE id=1').get() as { snapshot_json: string } | undefined
    return row ? JSON.parse(row.snapshot_json) as ResourceSetSnapshot : null
  }

  saveDesired(snapshot: ResourceSetSnapshot): 'applied' | 'current' | 'stale' {
    const current = this.desired()
    if (current && snapshot.revision < current.revision) return 'stale'
    if (current && snapshot.revision === current.revision) {
      if (snapshot.fingerprint !== current.fingerprint) throw new Error('resource_set_revision_conflict')
      return 'current'
    }
    this.database.prepare(`INSERT INTO resource_desired_state(id,revision,fingerprint,snapshot_json,updated_at) VALUES(1,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,fingerprint=excluded.fingerprint,snapshot_json=excluded.snapshot_json,updated_at=excluded.updated_at`)
      .run(snapshot.revision, snapshot.fingerprint, JSON.stringify(snapshot), snapshot.createdAt)
    return 'applied'
  }

  installed(resourceId: string): InstalledResourceState | null {
    const row = this.database.prepare('SELECT state_json FROM resource_installed_state WHERE resource_id=?').get(resourceId) as { state_json: string } | undefined
    return row ? JSON.parse(row.state_json) as InstalledResourceState : null
  }

  listInstalled(): readonly InstalledResourceState[] {
    return (this.database.prepare('SELECT state_json FROM resource_installed_state ORDER BY resource_id').all() as Array<{ state_json: string }>).map(row => JSON.parse(row.state_json) as InstalledResourceState)
  }

  saveInstalled(state: InstalledResourceState): void {
    this.database.prepare(`INSERT INTO resource_installed_state(resource_id,revision_id,binding_id,integrity,state_json,last_used_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(resource_id) DO UPDATE SET revision_id=excluded.revision_id,binding_id=excluded.binding_id,integrity=excluded.integrity,state_json=excluded.state_json,last_used_at=excluded.last_used_at`)
      .run(state.resourceId, state.resourceRevisionId, state.bindingId, state.integrity, JSON.stringify(state), state.lastUsedAt)
  }

  touch(resourceId: string, at: string): void {
    const current = this.installed(resourceId)
    if (!current) return
    this.saveInstalled({ ...current, lastUsedAt: at })
  }

  close(): void { this.database.close() }
}
