import type { Api } from '../../api/client.ts'

export type CanvasPresence = { userId: string; displayName: string; activeSessionId: string | null; typing: boolean; expiresAt: string }
export type CanvasCollaborationSnapshot = { projectId: string; revision: number; presence: CanvasPresence[] }
export type CanvasCollaborationStatus = 'connecting' | 'live' | 'reconnecting' | 'unavailable'

export async function readCanvasCollaboration(api: Api, projectId: string): Promise<CanvasCollaborationSnapshot> {
  return api.canvasCollaboration(projectId)
}

export async function publishCanvasPresence(api: Api, projectId: string, input: { displayName: string; activeSessionId: string | null; typing: boolean }): Promise<CanvasCollaborationSnapshot> {
  return api.updateCanvasPresence(projectId, input)
}

export function canvasCollaborationStreamUrl(projectId: string, after?: number): string {
  const query = typeof after === 'number' && after > 0 ? `?after=${after}` : ''
  return `/api/projects/${encodeURIComponent(projectId)}/canvas/collaboration/events${query}`
}

export function applyCanvasCollaborationEvent(snapshot: CanvasCollaborationSnapshot, type: string, data: unknown): CanvasCollaborationSnapshot {
  if (type === 'snapshot') return data as CanvasCollaborationSnapshot
  const event = data as { id: number; payload: CanvasPresence | { userId: string } }
  if (type === 'presence.updated') return { ...snapshot, revision: event.id, presence: [...snapshot.presence.filter(value => value.userId !== (event.payload as CanvasPresence).userId), event.payload as CanvasPresence] }
  if (type === 'presence.left') return { ...snapshot, revision: event.id, presence: snapshot.presence.filter(value => value.userId !== event.payload.userId) }
  return snapshot
}
