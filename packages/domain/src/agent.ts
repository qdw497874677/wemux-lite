import type { WorkerId } from './ids.js'
import type { RuntimeAuthorization } from './agent-profile.js'
import type { AgentKey, ModelId } from './values.js'

export type KnownAgentKey = 'pi' | 'claude-code' | 'codex' | 'opencode'

export interface AgentRef {
  readonly workerId: WorkerId
  readonly agentKey: AgentKey
}

export type AgentRuntimeFeature = 'resume' | 'tools' | 'approvals' | 'usage' | 'cancel' | 'structured-output'

export interface AgentRuntimeCapabilities {
  readonly resume: boolean
  readonly tools: boolean
  readonly approvals: boolean
  readonly usage: boolean
  readonly cancel: boolean
  readonly structuredOutput: boolean
  /** Commands accepted by the provider runtime in addition to turn cancellation. */
  readonly commands: readonly string[]
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
  /** Provider feature contract. Optional while older Workers upgrade. */
  readonly runtime?: AgentRuntimeCapabilities
  readonly models: readonly AgentModelCapability[]
}
