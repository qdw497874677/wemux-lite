import type { WorkerId } from './ids.js'
import type { RuntimeAuthorization } from './runtime-protocol.js'
import type { AgentKey, ModelId } from './values.js'

export type KnownAgentKey = 'pi' | 'claude-code' | 'codex' | 'opencode'

export interface AgentRef {
  readonly workerId: WorkerId
  readonly agentKey: AgentKey
}

export interface AgentModelCapability {
  readonly modelId: ModelId
  readonly displayName: string
  readonly source: 'detected' | 'configured'
}

export type AgentAvailability =
  | { readonly status: 'available' }
  | { readonly status: 'unavailable'; readonly reason: string }
  | { readonly status: 'authentication-required'; readonly reason: string }

export interface AgentCapability {
  readonly agentKey: AgentKey
  readonly displayName: string
  readonly version: string | null
  readonly mode: 'detect-only' | 'execution'
  readonly availability: AgentAvailability
  /** Credential state is independent from executable availability. Optional for v1 Workers. */
  readonly authorization?: RuntimeAuthorization
  readonly models: readonly AgentModelCapability[]
}
