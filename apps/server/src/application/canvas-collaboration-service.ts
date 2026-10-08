import type { ProjectId, SessionId, UserId } from '@wemux/domain'
import { AppError } from './errors.ts'
import type { ProjectAccessService } from './project-access-service.ts'
import type { SessionAccessService } from './session-access-service.ts'
import type { Notifications } from './notifications.ts'

export type CanvasPresence = { userId: UserId; displayName: string; activeSessionId: string | null; typing: boolean; expiresAt: string }
export type CanvasCollaborationEvent = { id: number; type: 'presence.updated' | 'presence.left'; projectId: ProjectId; actorId: UserId; payload: unknown; at: string }
export type CanvasCollaborationSnapshot = { projectId: ProjectId; revision: number; presence: CanvasPresence[] }
type Room = { presence: Map<UserId, CanvasPresence>; listeners: Set<() => void> }

export class CanvasCollaborationService {
  private readonly rooms = new Map<ProjectId, Room>()
  constructor(
    private readonly projects: Pick<ProjectAccessService, 'require'>,
    private readonly sessions: Pick<SessionAccessService, 'require'>,
    private readonly notifications: Pick<Notifications, 'onAuthorization' | 'onSession'>,
    private readonly now: () => number = Date.now,
    private readonly presenceTtlMs = 30_000,
  ) {}

  async snapshot(actor: UserId, projectId: ProjectId): Promise<CanvasCollaborationSnapshot> {
    // Subscribe before the first await, including Sessions not yet authorized.
    // A later lookup may yield while an earlier accepted Session is revoked.
    let generation = 0
    const invalidate = () => { generation++ }
    const unsubscribe = this.subscribe(projectId, invalidate)
    const unsubscribeAuthorization = this.notifications.onAuthorization(actor, invalidate)
    try {
      const room = this.room(projectId)
      for (let attempt = 0; attempt < 8; attempt++) {
        this.prune(room)
        const started = generation
        const candidates = [...room.presence.values()]
        await this.projects.require(actor, projectId, 'viewer')
        const presence: CanvasPresence[] = []
        for (const value of candidates) {
          if (value.activeSessionId !== null) {
            try { await this.requireSession(actor, projectId, value.activeSessionId) }
            catch (error) {
              if (error instanceof AppError && error.status === 404) continue
              throw error
            }
          }
          presence.push(value)
        }
        // Authorization may yield past a candidate's expiry without a notification.
        this.prune(room)
        if (generation !== started) continue
        // This synchronous check is the REST read's linearization point within
        // this process's notification discipline, not a cross-process DB lock.
        // Internal generations must never become shared client-visible cursors.
        return { projectId, revision: 0, presence }
      }
      throw new AppError(503, 'Canvas presence changed during authorization; retry', 'canvas_presence_changed')
    } finally { unsubscribe(); unsubscribeAuthorization() }
  }

  async updatePresence(actor: UserId, projectId: ProjectId, input: { displayName: string; activeSessionId?: string | null; typing?: boolean }): Promise<CanvasCollaborationSnapshot> {
    await this.projects.require(actor, projectId, 'viewer')
    if (input.activeSessionId != null) await this.requireSession(actor, projectId, input.activeSessionId)
    const room = this.room(projectId)
    const value: CanvasPresence = { userId: actor, displayName: input.displayName.trim().slice(0, 80) || '成员', activeSessionId: input.activeSessionId ?? null, typing: input.typing === true, expiresAt: new Date(this.now() + this.presenceTtlMs).toISOString() }
    room.presence.set(actor, value)
    this.changed(room)
    return this.snapshot(actor, projectId)
  }

  leave(actor: UserId, projectId: ProjectId): void {
    const room = this.rooms.get(projectId)
    if (!room) return
    if (room.presence.delete(actor)) this.changed(room)
    this.evictEmptyRoom(projectId, room)
  }

  // Subscribers receive only invalidation, never unfiltered identities or replay.
  subscribe(projectId: ProjectId, listener: () => void): () => void {
    const room = this.room(projectId)
    const sessions = new Map<string, () => void>()
    const watchSessions = () => {
      const ids = new Set([...room.presence.values()].flatMap(value => value.activeSessionId === null ? [] : [value.activeSessionId]))
      for (const [id, unsubscribe] of sessions) if (!ids.has(id)) { unsubscribe(); sessions.delete(id) }
      for (const id of ids) if (!sessions.has(id)) sessions.set(id, this.notifications.onSession(id as SessionId, listener))
    }
    const changed = () => { watchSessions(); listener() }
    room.listeners.add(changed)
    watchSessions()
    return () => {
      room.listeners.delete(changed)
      for (const unsubscribe of sessions.values()) unsubscribe()
      this.evictEmptyRoom(projectId, room)
    }
  }

  private evictEmptyRoom(projectId: ProjectId, room: Room): void {
    if (room.presence.size === 0 && room.listeners.size === 0 && this.rooms.get(projectId) === room) this.rooms.delete(projectId)
  }

  private async requireSession(actor: UserId, projectId: ProjectId, sessionId: string): Promise<void> {
    const session = await this.sessions.require(actor, sessionId as SessionId, 'read')
    if (session.projectId !== projectId) throw new AppError(404, 'Session not found', 'session_not_found')
  }

  private changed(room: Room): void { room.listeners.forEach(listener => listener()) }
  private room(projectId: ProjectId): Room {
    let room = this.rooms.get(projectId)
    if (!room) { room = { presence: new Map(), listeners: new Set() }; this.rooms.set(projectId, room) }
    return room
  }
  private prune(room: Room): void {
    let changed = false
    for (const [userId, item] of room.presence) {
      if (Date.parse(item.expiresAt) <= this.now() && room.presence.delete(userId)) changed = true
    }
    if (changed) this.changed(room)
  }
}
