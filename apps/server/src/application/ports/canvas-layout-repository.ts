import type { CanvasLayout, CanvasLayoutScope, ProjectId, Timestamp, UserId } from '@wemux/domain'

export interface StoredCanvasLayout {
  readonly projectId: ProjectId
  readonly ownerId: UserId | null
  readonly scope: CanvasLayoutScope
  readonly layout: CanvasLayout
  readonly updatedAt: Timestamp
}

export interface CanvasLayoutRepository {
  get(projectId: ProjectId, scope: CanvasLayoutScope, viewer: UserId): Promise<StoredCanvasLayout | null>
  put(record: StoredCanvasLayout): Promise<void>
}
