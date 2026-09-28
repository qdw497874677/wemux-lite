import { useQuery } from '@tanstack/react-query'
import type { AttentionResult } from '@wemux/server-domain'
import type { Api } from '../../api/client.ts'

export const attentionQueryKey = ['attention'] as const

export function useAttention(api: Api) {
  return useQuery({
    queryKey: attentionQueryKey,
    queryFn: () => api.attention(),
    refetchInterval: 30_000,
  })
}
