import type { Timestamp } from '@wemux/domain'
import type { AgentEvent } from './event.js'
import type { AgentSession, SessionKey, SessionStore } from './session.js'

const keyOf = ({ appName, userId, sessionId }: SessionKey) => `${appName}\u0000${userId}\u0000${sessionId}`
const now = () => new Date().toISOString() as Timestamp

/** In-memory adapter for tests and embedded use. */
export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, AgentSession>()

  async getOrCreate(request: SessionKey & { readonly state?: Readonly<Record<string, unknown>> }): Promise<AgentSession> {
    const key = keyOf(request)
    const existing = this.sessions.get(key)
    if (existing) return existing
    const session: AgentSession = {
      appName: request.appName,
      userId: request.userId,
      sessionId: request.sessionId,
      state: { ...request.state },
      events: [],
      lastUpdateTime: now(),
    }
    this.sessions.set(key, session)
    return session
  }

  async get(request: SessionKey): Promise<AgentSession | undefined> {
    return this.sessions.get(keyOf(request))
  }

  async appendEvent({ session, event }: { readonly session: AgentSession; readonly event: AgentEvent }): Promise<AgentEvent> {
    if (event.partial) return event
    const state = { ...session.state, ...event.actions.stateDelta }
    const events = session.events.some(item => item.id === event.id)
      ? session.events.map(item => item.id === event.id ? event : item)
      : [...session.events, event]
    this.sessions.set(keyOf(session), { ...session, state, events, lastUpdateTime: event.timestamp })
    return event
  }

  async delete(request: SessionKey): Promise<void> {
    this.sessions.delete(keyOf(request))
  }
}
