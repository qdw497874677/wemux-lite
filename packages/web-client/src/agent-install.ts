import type { ManagedAgentCatalogDTO, ManagedAgentInstallDTO } from '@wemux/web-contract/browser-host'
import type { createClusterTransport } from './cluster-transport.ts'

/**
 * 托管 Agent 安装的管理面写入口。安装是显式的管理员动作：先读取 Server 的固定版本目录，
 * 再由管理员确认后下发到指定 Worker；Web 不自行下载或执行任何安装包。
 */
export function agentInstallOperations({ request }: ReturnType<typeof createClusterTransport>) {
  return {
    managedAgentCatalog: (signal?: AbortSignal) => request<ManagedAgentCatalogDTO>('/api/managed-agent-catalog', undefined, signal),
    installManagedAgent: (input: { workerId: string; agentKey: string }) => request<ManagedAgentInstallDTO>('/api/managed-agent-installs', { workerId: input.workerId, agentKey: input.agentKey }),
  }
}
