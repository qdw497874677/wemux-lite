import { useQuery } from '@tanstack/react-query'
import type { Api } from '../api/client'

export const resourceKeys = { workers: ['workers'], projects: ['projects'], workspaces: ['workspaces'], sessions: ['sessions'], commands: ['commands'] } as const
export const resourceOptions = (api: Api) => ({
  workers: { queryKey: resourceKeys.workers, queryFn: ({ signal }: { signal: AbortSignal }) => api.workers(signal), staleTime: 2000, refetchInterval: 5000 },
  projects: { queryKey: resourceKeys.projects, queryFn: ({ signal }: { signal: AbortSignal }) => api.projects(signal), staleTime: 2000, refetchInterval: 10000 },
  workspaces: { queryKey: resourceKeys.workspaces, queryFn: ({ signal }: { signal: AbortSignal }) => api.workspacesAll(signal), staleTime: 2000, refetchInterval: 5000 },
  sessions: { queryKey: resourceKeys.sessions, queryFn: ({ signal }: { signal: AbortSignal }) => api.sessionsAll(signal), staleTime: 2000, refetchInterval: 5000 },
})
export function useResources(api: Api, globalInventory = false) {
  const options = resourceOptions(api)
  const workers = useQuery(options.workers)
  const projects = useQuery(options.projects)
  const workspaces = useQuery({ ...options.workspaces, enabled: globalInventory })
  const sessions = useQuery({ ...options.sessions, enabled: globalInventory })
  return { workers, projects, workspaces, sessions }
}
