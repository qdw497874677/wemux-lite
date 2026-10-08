import type { HostBootstrap } from '@wemux/web-contract/browser-host'
import { ApiError } from './errors.ts'
export const hostContractVersion = 1

/** Validate the public, non-credential host discovery response before constructing routes. */
export function parseHostBootstrap(value: unknown): HostBootstrap {
  if (!value || typeof value !== 'object') throw new ApiError('无法识别工作台宿主', undefined, 'contract')
  const data = value as Record<string, unknown>
  if (data.hostKind !== 'cluster' && data.hostKind !== 'local-worker') throw new ApiError('工作台宿主类型不受支持', undefined, 'contract')
  if (data.contractVersion !== hostContractVersion) throw new ApiError('工作台版本与服务端不兼容，请更新页面或服务端', undefined, 'contract')
  if (!Array.isArray(data.capabilities) || !data.capabilities.every(item => typeof item === 'string')) throw new ApiError('工作台能力合同无效', undefined, 'contract')
  return { hostKind: data.hostKind, contractVersion: hostContractVersion, capabilities: data.capabilities }
}

export async function discoverHost(signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<HostBootstrap> {
  let response: Response
  try { response = await fetcher('/api/host', { signal, redirect: 'error', credentials: 'same-origin', headers: { accept: 'application/json' }, cache: 'no-store' }) } catch { signal?.throwIfAborted(); throw new ApiError('无法连接工作台宿主，请检查网络后重试', undefined, 'network') }
  signal?.throwIfAborted()
  if (!response.ok) throw new ApiError('无法连接工作台宿主，请检查服务状态后重试', response.status)
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) throw new ApiError('工作台宿主发现响应无效，请检查服务版本', undefined, 'contract')
  let value: unknown
  try { value = await response.json() } catch { signal?.throwIfAborted(); throw new ApiError('工作台宿主发现响应无效，请检查服务版本', undefined, 'contract') }
  signal?.throwIfAborted()
  return parseHostBootstrap(value)
}
