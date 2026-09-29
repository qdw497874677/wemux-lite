import type { HostKind } from '../hosts/bootstrap.ts'

export const clusterPaths = ['/', '/attention', '/approvals', '/timeline', '/projects', '/projects/$projectId', '/projects/$projectId/overview', '/projects/$projectId/canvas', '/projects/$projectId/board', '/projects/$projectId/tasks', '/projects/$projectId/tasks/$taskId', '/projects/$projectId/activity', '/projects/$projectId/connectors', '/projects/$projectId/skills', '/projects/$projectId/channels', '/projects/$projectId/settings', '/projects/$projectId/workspaces', '/projects/$projectId/workspaces/$workspaceId', '/projects/$projectId/sessions', '/projects/$projectId/sessions/$sessionId', '/runtime', '/runtimes', '/cluster', '/teams', '/components', '/settings', '/join', '/auth/verify-email', '/auth/password/reset', '/auth/confirm-email-change'] as const
export const localPaths = ['/local', '/local/sessions', '/local/sessions/$sessionId', '/local/settings', '/local/cluster'] as const

export function hostRoutes(hostKind: HostKind): readonly string[] {
  return hostKind === 'local-worker' ? localPaths : clusterPaths
}

export function isHostPathAllowed(hostKind: HostKind, pathname: string): boolean {
  const segments = pathname.split('/').filter(Boolean)
  return hostRoutes(hostKind).some(path => {
    const pattern = path.split('/').filter(Boolean)
    return segments.length === pattern.length && pattern.every((part, index) => part.startsWith('$') ? Boolean(segments[index]) : part === segments[index])
  })
}
