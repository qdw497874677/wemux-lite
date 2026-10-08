import { randomUUID } from 'node:crypto'
import type { AuditEntryId, CanvasLayout, CanvasLayoutScope, ProjectId, Timestamp, UserId } from '@wemux/domain'
import { isCanvasLayout, isCanvasLayoutScope } from '@wemux/domain'
import type { CanvasLayoutResponse, CanvasLayoutSaveResponse } from '@wemux/web-contract'
import { AppError } from './errors.ts'
import type { CanvasLayoutRepository } from './ports/canvas-layout-repository.ts'
import type { ServerStore } from './ports/server-store.ts'
import type { ProjectAccessService } from './project-access-service.ts'
import type { SessionLineageService } from './session-lineage-service.ts'

export class CanvasLayoutService {
  private readonly store: ServerStore
  private readonly repository: CanvasLayoutRepository
  private readonly projects: ProjectAccessService
  private readonly lineage: SessionLineageService
  constructor(
    store: ServerStore,
    repository: CanvasLayoutRepository,
    projects: ProjectAccessService,
    lineage: SessionLineageService
  ) {
    this.store = store; this.repository = repository; this.projects = projects; this.lineage = lineage;}

  async get(actor: UserId, projectId: ProjectId, scopeInput: unknown): Promise<CanvasLayoutResponse> {
    const scope = parseScope(scopeInput)
    await this.projects.require(actor, projectId, 'viewer')
    const saved = await this.repository.get(projectId, scope, actor)
    const projection = await this.lineage.layoutProjectionFor(actor, projectId)
    const graphRevision = projection.revision
    return { layout: saved ? projectLayout(saved.layout, projection) : null, graphRevision }
  }

  async save(actor: UserId, projectId: ProjectId, input: unknown): Promise<CanvasLayoutSaveResponse> {
    const { scope, graphRevision, layout } = parseSave(input)
    const project = await this.projects.require(actor, projectId, 'viewer')
    if (scope === 'project' && project.accessRole !== 'manager' && project.accessRole !== 'owner') throw new AppError(403, '需要 Project manager 权限', 'project_manager_required')
    const projection = await this.lineage.layoutProjectionFor(actor, projectId)
    const currentRevision = projection.revision
    if (graphRevision !== currentRevision || layout.graphRevision !== currentRevision) throw new AppError(409, 'Canvas layout graph revision is stale', 'stale_revision')
    const previous = await this.repository.get(projectId, scope, actor)
    // Only the caller's readable range is replaceable. Preserve existing invisible
    // state for other viewers, but never accept invisible identities from this input.
    const visible = projectLayout(layout, projection)
    if (previous && JSON.stringify(projectLayout(previous.layout, projection)) === JSON.stringify(visible)) return { graphRevision: currentRevision, written: false }
    const preservedPositions = Object.fromEntries(Object.entries(previous?.layout.nodePositions ?? {})
      .filter(([id]) => !projection.sessionIds.has(id)).map(([id, position]) => [id, { x: position.x, y: position.y }]))
    const preservedGroups = (previous?.layout.collapsedGroups ?? []).filter(group => !projection.workspaceGroups.has(group))
    const normalized: CanvasLayout = {
      ...visible,
      nodePositions: { ...preservedPositions, ...visible.nodePositions },
      collapsedGroups: [...new Set([...preservedGroups, ...visible.collapsedGroups])],
    }
    const updatedAt = new Date().toISOString() as Timestamp
    await this.repository.put({ projectId, ownerId: scope === 'personal' ? actor : null, scope, layout: normalized, updatedAt })
    await this.store.transaction(async tx => {
      await tx.audit.append({
        id: randomUUID() as AuditEntryId,
        actorId: actor,
        action: scope === 'project' ? 'canvas.layout.project_saved' : 'canvas.layout.personal_saved',
        resource: { kind: 'project', id: projectId },
        result: 'succeeded',
        occurredAt: updatedAt,
        metadata: { graphRevision: currentRevision },
      })
    })
    return { graphRevision: currentRevision, written: true }
  }
}

function parseScope(input: unknown): CanvasLayoutScope {
  if (!isCanvasLayoutScope(input)) throw new AppError(400, 'Invalid canvas layout scope', 'invalid_layout')
  return input
}

function parseSave(input: unknown): { scope: CanvasLayoutScope; graphRevision: string; layout: CanvasLayout } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError(400, 'Invalid canvas layout', 'invalid_layout')
  const record = input as Record<string, unknown>
  const scope = parseScope(record.scope)
  if (typeof record.graphRevision !== 'string' || !record.graphRevision || !isCanvasLayout(record.layout)) throw new AppError(400, 'Invalid canvas layout', 'invalid_layout')
  if (record.layout.scope !== scope || record.layout.graphRevision !== record.graphRevision) throw new AppError(400, 'Canvas layout metadata does not match', 'invalid_layout')
  return { scope, graphRevision: record.graphRevision, layout: record.layout }
}


type LayoutProjection = Awaited<ReturnType<SessionLineageService['layoutProjectionFor']>>

/** Explicit DTO construction also strips arbitrary identity-bearing extension fields. */
function projectLayout(layout: CanvasLayout, projection: LayoutProjection): CanvasLayout {
  return {
    scope: layout.scope,
    graphRevision: projection.revision,
    nodePositions: Object.fromEntries(Object.entries(layout.nodePositions)
      .filter(([id]) => projection.sessionIds.has(id))
      .map(([id, position]) => [id, { x: position.x, y: position.y }])),
    collapsedGroups: layout.collapsedGroups.filter(group => projection.workspaceGroups.has(group)),
    viewport: { x: layout.viewport.x, y: layout.viewport.y, zoom: layout.viewport.zoom },
  }
}
