/**
 * 资源管理面写路径的线上契约。
 *
 * 这里只描述请求/响应形状：客户端不做任何授权判定，写操作一律走既有的受审计 API
 * （资源、修订、绑定、预设应用），由 Server 侧判定权限与并发。
 */
import type {
  ModelProviderResourceDefinition, ReconcileReport, Resource, ResourceBinding, ResourceBindingStatus,
  ResourceKind, ResourceRevision, ResourceSetSnapshot,
} from '@wemux/domain'
import type { NodeResourcePreset, NodeResourcePresetApplication, NodeResourcePresetEntry } from '@wemux/domain'

export type ResourceKindDTO = ResourceKind
export type ResourceDTO = Resource
export type ResourceRevisionDTO = ResourceRevision
export type ResourceBindingDTO = ResourceBinding
export type ResourceBindingStatusDTO = ResourceBindingStatus
export type ResourceSetSnapshotDTO = ResourceSetSnapshot
export type ModelProviderDefinitionDTO = ModelProviderResourceDefinition
export type NodeResourcePresetDTO = NodeResourcePreset
export type NodeResourcePresetEntryDTO = NodeResourcePresetEntry
export type NodeResourcePresetApplicationDTO = NodeResourcePresetApplication
export type ReconcileReportDTO = ReconcileReport

/** POST /api/resources：Server 注入 createdBy，Provider 资源体不得携带归属字段；时间戳由客户端给出。 */
export interface CreateResourceInput {
  readonly id: string
  readonly kind: ResourceKindDTO
  readonly name: string
  readonly description: string
  readonly definition: unknown
  readonly createdAt: string
  readonly updatedAt: string
}

/** GET /api/resources/:resourceId 同时返回资源与其全部不可变修订。 */
export interface ResourceDetailDTO {
  readonly resource: ResourceDTO
  readonly revisions: readonly ResourceRevisionDTO[]
}

/** PUT /api/resource-blobs/:sha256：按 sha256 去重，deduplicated 为真表示内容已存在。 */
export interface ResourceBlobDTO {
  readonly sha256: string
  readonly deduplicated: boolean
}

/** GET /api/resource-bindings 的条目：绑定与最近一次 Worker 回执。 */
export interface ResourceBindingProjectionDTO {
  readonly binding: ResourceBindingDTO
  readonly reconcile: ReconcileReportDTO | null
}

export interface CreateResourceBindingInput {
  readonly id?: string
  readonly workerId: string
  readonly resourceRevisionId: string
  readonly agentKey?: string
  readonly projectId?: string
}

export interface CreateResourcePresetInput {
  readonly id?: string
  readonly name: string
  readonly description: string
  readonly entries: readonly NodeResourcePresetEntryDTO[]
  readonly expectedRevision: number
}

export interface ApplyResourcePresetInput {
  readonly presetRevision: number
  readonly workerId: string
  readonly requestId: string
  readonly expectedSetRevision: number
}

export interface PublishProviderRevisionInput {
  readonly expectedVersion: number
  readonly revision: ResourceRevisionDTO
}
