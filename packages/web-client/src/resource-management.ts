import type { ResourceInventoryDTO } from '@wemux/web-contract/browser-host'
import type {
  ApplyResourcePresetInput, CreateResourceBindingInput, CreateResourceInput, CreateResourcePresetInput,
  NodeResourcePresetApplicationDTO, NodeResourcePresetDTO, PublishProviderRevisionInput, ResourceBindingDTO,
  ResourceBindingProjectionDTO, ResourceBlobDTO, ResourceDTO, ResourceDetailDTO, ResourceRevisionDTO,
  ResourceSetSnapshotDTO,
} from '@wemux/web-contract/resource-write'
import type { createClusterTransport } from './cluster-transport.ts'

/**
 * 集群管理面的资源操作。
 *
 * 读取仍是只读投影；写入不是旁路：每一项都调用既有的受审计 API（资源、修订、blob、
 * 绑定、预设应用），携带 CSRF 与 requestId，授权与乐观并发完全由 Server 判定，
 * 客户端不做任何权限推断。
 */
export function resourceManagementOperations({ request }: ReturnType<typeof createClusterTransport>) {
  return {
    resourceInventory: (signal?: AbortSignal) => request<ResourceInventoryDTO>('/api/resource-inventory', undefined, signal),

    resourceList: async (signal?: AbortSignal) => (await request<{ items: ResourceDTO[] }>('/api/resources', undefined, signal)).items,
    resourceDetail: (resourceId: string, signal?: AbortSignal) =>
      request<ResourceDetailDTO>(`/api/resources/${encodeURIComponent(resourceId)}`, undefined, signal),
    createResource: (resource: CreateResourceInput) => request<ResourceDTO>('/api/resources', resource, undefined, 'POST'),
    updateResource: (resource: ResourceDTO) =>
      request<ResourceDTO>(`/api/resources/${encodeURIComponent(resource.id)}`, resource, undefined, 'PATCH'),
    deleteResource: (resourceId: string) =>
      request<{ ok: boolean }>(`/api/resources/${encodeURIComponent(resourceId)}`, undefined, undefined, 'DELETE'),

    putResourceBlob: (sha256: string, base64Content: string) =>
      request<ResourceBlobDTO>(`/api/resource-blobs/${encodeURIComponent(sha256)}`, { base64Content }, undefined, 'PUT'),
    publishResourceRevision: (resourceId: string, revision: ResourceRevisionDTO) =>
      request<ResourceRevisionDTO>(`/api/resources/${encodeURIComponent(resourceId)}/revisions`, revision, undefined, 'POST'),
    publishProviderRevision: (resourceId: string, input: PublishProviderRevisionInput) =>
      request<ResourceRevisionDTO>(`/api/resources/${encodeURIComponent(resourceId)}/provider-revisions`, input, undefined, 'POST'),

    resourceBindings: async (workerId?: string, signal?: AbortSignal) => (await request<{ items: ResourceBindingProjectionDTO[] }>(
      workerId ? `/api/resource-bindings?workerId=${encodeURIComponent(workerId)}` : '/api/resource-bindings',
      undefined,
      signal,
    )).items,
    createResourceBinding: (binding: CreateResourceBindingInput) =>
      request<ResourceBindingDTO>('/api/resource-bindings', binding, undefined, 'POST'),
    /** 撤销是状态迁移：转入 pending-gc，绝不物理删除；expectedRevision 由 Server 做 CAS。 */
    revokeResourceBinding: (bindingId: string, expectedRevision: number) =>
      request<ResourceBindingDTO>(`/api/resource-bindings/${encodeURIComponent(bindingId)}`, { status: 'pending-gc', expectedRevision }, undefined, 'PATCH'),

    resourcePresets: async (signal?: AbortSignal) => (await request<{ items: NodeResourcePresetDTO[] }>('/api/resource-presets', undefined, signal)).items,
    createResourcePreset: (preset: CreateResourcePresetInput) =>
      request<NodeResourcePresetDTO>('/api/resource-presets', preset, undefined, 'POST'),
    resourceSet: (workerId: string, signal?: AbortSignal) =>
      request<ResourceSetSnapshotDTO>(`/api/workers/${encodeURIComponent(workerId)}/resource-set`, undefined, signal),
    /** requestId 幂等：同一 requestId 重放返回既有应用，不重复创建绑定。 */
    applyResourcePreset: (presetId: string, input: ApplyResourcePresetInput) =>
      request<NodeResourcePresetApplicationDTO>(`/api/resource-presets/${encodeURIComponent(presetId)}/applications`, input, undefined, 'POST'),
  }
}
