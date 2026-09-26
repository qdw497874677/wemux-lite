import type { CanvasLayout, CanvasLayoutScope } from '@wemux/web-contract/session-graph'
import type { Api } from '../../../api/client.ts'

export async function readPreferredCanvasLayout(api: Api, projectId: string, signal?: AbortSignal): Promise<CanvasLayout | null> {
  const personal = await api.canvasLayout(projectId, 'personal', signal)
  if (personal.layout) return personal.layout
  return (await api.canvasLayout(projectId, 'project', signal)).layout
}

export async function saveCanvasLayout(api: Api, projectId: string, scope: CanvasLayoutScope, graphRevision: string, nodePositions: CanvasLayout['nodePositions'], viewport: CanvasLayout['viewport'], collapsedGroups: readonly string[] = []): Promise<void> {
  await api.saveCanvasLayout(projectId, { scope, graphRevision, layout: { scope, graphRevision, nodePositions, collapsedGroups, viewport } })
}
