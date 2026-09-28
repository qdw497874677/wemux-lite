import type { ProjectId, UserId } from '@wemux/domain'
import type { ProjectAccessService } from './project-access-service.ts'

export type CanvasPresence = { userId: UserId; displayName: string; activeSessionId: string | null; typing: boolean; expiresAt: string }
export type CanvasCollaborationEvent = { id: number; type: 'presence.updated' | 'presence.left'; projectId: ProjectId; actorId: UserId; payload: unknown; at: string }
export type CanvasCollaborationSnapshot = { projectId: ProjectId; revision: number; presence: CanvasPresence[] }
export type CanvasReplay = { contiguous: boolean; events: CanvasCollaborationEvent[] }
type Room = { revision: number; floorRevision: number; presence: Map<UserId, CanvasPresence>; events: CanvasCollaborationEvent[]; listeners: Set<(event: CanvasCollaborationEvent) => void> }

const MAX_EVENTS = 256

export class CanvasCollaborationService {
  private readonly rooms = new Map<ProjectId, Room>()
    private readonly projects: Pick<ProjectAccessService, 'require'>
  private readonly now: () => number
  private readonly presenceTtlMs
constructor(projects: Pick<ProjectAccessService, 'require'>, now: () => number = Date.now, presenceTtlMs = 30_000) {
    this.projects = projects; this.now = now; this.presenceTtlMs = presenceTtlMs;}
  async snapshot(actor: UserId, projectId: ProjectId): Promise<CanvasCollaborationSnapshot> {
    await this.assertRead(actor, projectId); const room = this.room(projectId); this.prune(projectId, room)
    return { projectId, revision: room.revision, presence: [...room.presence.values()] }
  }
  async updatePresence(actor: UserId, projectId: ProjectId, input: { displayName: string; activeSessionId?: string | null; typing?: boolean }): Promise<CanvasCollaborationSnapshot> {
    await this.assertRead(actor, projectId); const room = this.room(projectId)
    const value: CanvasPresence = { userId: actor, displayName: input.displayName.trim().slice(0, 80) || '成员', activeSessionId: input.activeSessionId ?? null, typing: input.typing === true, expiresAt: new Date(this.now() + this.presenceTtlMs).toISOString() }
    room.presence.set(actor, value); this.emit(projectId, actor, 'presence.updated', value); return this.snapshot(actor, projectId)
  }
  leave(actor: UserId, projectId: ProjectId): void { const room = this.room(projectId); if (room.presence.delete(actor)) this.emit(projectId, actor, 'presence.left', { userId: actor }) }
  eventsAfter(projectId: ProjectId, revision: number): CanvasReplay {
    const room = this.room(projectId), events = room.events.filter(event => event.id > revision)
    return { contiguous: revision > room.floorRevision && revision <= room.revision && (revision === room.revision || events[0]?.id === revision + 1), events }
  }
  subscribe(projectId: ProjectId, listener: (event: CanvasCollaborationEvent) => void): () => void { const listeners = this.room(projectId).listeners; listeners.add(listener); return () => listeners.delete(listener) }
  private emit(projectId: ProjectId, actorId: UserId, type: CanvasCollaborationEvent['type'], payload: unknown): void {
    const room = this.room(projectId); room.revision += 1
    const event = { id: room.revision, type, projectId, actorId, payload, at: new Date(this.now()).toISOString() } satisfies CanvasCollaborationEvent
    room.events.push(event)
    if (room.events.length > MAX_EVENTS) { const removed = room.events.splice(0, room.events.length - MAX_EVENTS); room.floorRevision = removed.at(-1)?.id ?? room.floorRevision }
    room.listeners.forEach(listener => listener(event))
  }
  private room(projectId: ProjectId): Room { let room = this.rooms.get(projectId); if (!room) { room = { revision: 0, floorRevision: 0, presence: new Map(), events: [], listeners: new Set() }; this.rooms.set(projectId, room) } return room }
  private prune(projectId: ProjectId, room: Room): void { for (const [userId, item] of room.presence) if (Date.parse(item.expiresAt) <= this.now() && room.presence.delete(userId)) this.emit(projectId, userId, 'presence.left', { userId }) }
  private async assertRead(actor: UserId, projectId: ProjectId): Promise<void> { await this.projects.require(actor, projectId, 'viewer') }
}
