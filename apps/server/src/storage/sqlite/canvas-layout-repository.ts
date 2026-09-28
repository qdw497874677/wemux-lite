import type { CanvasLayoutScope, ProjectId, UserId } from '@wemux/domain'
import type { CanvasLayoutRepository, StoredCanvasLayout } from '../../application/ports/canvas-layout-repository.ts'

interface RecordStore {
  getRecord<T>(kind: string, id: string): Promise<T | null>
  putRecord(kind: string, id: string, value: unknown): Promise<void>
}

const recordId = (projectId: ProjectId, scope: CanvasLayoutScope, viewer: UserId): string =>
  scope === 'project' ? `${projectId}:project` : `${projectId}:personal:${viewer}`

export class SqliteCanvasLayoutRepository implements CanvasLayoutRepository {
    private readonly records: RecordStore
constructor(records: RecordStore) {
    this.records = records;}

  get(projectId: ProjectId, scope: CanvasLayoutScope, viewer: UserId): Promise<StoredCanvasLayout | null> {
    return this.records.getRecord<StoredCanvasLayout>('canvas-layout', recordId(projectId, scope, viewer))
  }

  put(record: StoredCanvasLayout): Promise<void> {
    const viewer = record.ownerId ?? ('project' as UserId)
    return this.records.putRecord('canvas-layout', recordId(record.projectId, record.scope, viewer), record)
  }
}
