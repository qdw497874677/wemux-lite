import type { AgentKey, Timestamp } from './values.js'
import type { ProjectId, UserId, WorkerId } from './ids.js'
import type { ResourceBindingId, ResourceId, ResourceRevisionId } from './resource.js'

/** Presets are templates; their expanded ResourceBindings remain the only assignment authority. */
export interface NodeResourcePresetEntry {
  readonly resourceId: ResourceId
  readonly resourceRevisionId: ResourceRevisionId
  readonly agentKey: AgentKey | null
  readonly projectId: ProjectId | null
  readonly required: boolean
}

export interface NodeResourcePreset {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly revision: number
  readonly scope: { readonly kind: 'instance' }
  readonly entries: readonly NodeResourcePresetEntry[]
  readonly autoApply: { readonly enabled: false }
  readonly createdBy: UserId
  readonly createdAt: Timestamp
}

export interface NodeResourcePresetApplication {
  readonly id: string
  readonly presetId: string
  readonly presetRevision: number
  readonly workerId: WorkerId
  readonly bindingIds: readonly ResourceBindingId[]
  readonly requestId: string
  readonly fingerprint: string
  readonly createdBy: UserId
  readonly createdAt: Timestamp
}
