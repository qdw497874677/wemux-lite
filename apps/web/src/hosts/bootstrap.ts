export const hostContractVersion = 1

export type HostKind = 'cluster' | 'local-worker'
export type HostBootstrap = {
  hostKind: HostKind
  contractVersion: number
  capabilities: readonly string[]
}

/** Validate the public, non-credential host discovery response before constructing routes. */
export function parseHostBootstrap(value: unknown): HostBootstrap {
  if (!value || typeof value !== 'object') throw new Error('无法识别工作台宿主')
  const data = value as Record<string, unknown>
  if (data.hostKind !== 'cluster' && data.hostKind !== 'local-worker') throw new Error('工作台宿主类型不受支持')
  if (data.contractVersion !== hostContractVersion) throw new Error('工作台版本与服务端不兼容，请更新页面或服务端')
  if (!Array.isArray(data.capabilities) || !data.capabilities.every(item => typeof item === 'string')) throw new Error('工作台能力合同无效')
  return { hostKind: data.hostKind, contractVersion: hostContractVersion, capabilities: data.capabilities }
}

export async function discoverHost(signal?: AbortSignal): Promise<HostBootstrap> {
  const response = await fetch('/api/host', { signal, credentials: 'same-origin', headers: { accept: 'application/json' }, cache: 'no-store' })
  if (!response.ok) throw new Error('无法连接工作台宿主，请检查服务状态后重试')
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) throw new Error('工作台宿主发现响应无效，请检查服务版本')
  return parseHostBootstrap(await response.json())
}
