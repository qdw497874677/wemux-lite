import type { Timestamp } from '@wemux/domain'
import type { AgentEvent } from './event.js'

export interface SessionKey {
  readonly appName: string
  readonly userId: string
  readonly sessionId: string
}

/** Structurally maps to the core Google ADK Session fields. */
export interface AgentSession extends SessionKey {
  readonly state: Readonly<Record<string, unknown>>
  readonly events: readonly AgentEvent[]
  readonly lastUpdateTime: Timestamp
}

export interface SessionStore {
  getOrCreate(request: SessionKey & { readonly state?: Readonly<Record<string, unknown>> }): Promise<AgentSession>
  get(request: SessionKey): Promise<AgentSession | undefined>
  appendEvent(request: { readonly session: AgentSession; readonly event: AgentEvent }): Promise<AgentEvent>
  delete(request: SessionKey): Promise<void>
}
