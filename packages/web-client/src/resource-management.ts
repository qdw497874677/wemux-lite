import type { ResourceInventoryDTO } from '@wemux/web-contract/browser-host'
import type { createClusterTransport } from './cluster-transport.ts'

/**
 * 集群管理面的资源读取操作。管理面是只读投影：配置、认证、分发与可执行的每一项改动
 * 都走各自既有的受审计入口（资源、修订、绑定、预设应用），这里不提供旁路写路径。
 */
export function resourceManagementOperations({ request }: ReturnType<typeof createClusterTransport>) {
  return {
    resourceInventory: (signal?: AbortSignal) => request<ResourceInventoryDTO>('/api/resource-inventory', undefined, signal),
  }
}
