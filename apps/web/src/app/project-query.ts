import type { ProjectActivityItem, ProjectEvent } from '@wemux/web-contract/task-platform'
import type { QueryClient } from '@tanstack/react-query'
import type { Api } from '../api/client'

/** One namespace per authorized project; notification IDs never enter durable cursors. */
export const projectKeys = {
  root: (p: string) => ['project', p] as const,
  tasks: (p: string) => ['project', p, 'tasks'] as const,
  task: (p: string, t: string) => ['project', p, 'task', t] as const,
  runs: (p: string, t: string) => ['project', p, 'runs', t] as const,
  workspaces: (p: string) => ['project', p, 'workspaces'] as const,
  sessions: (p: string) => ['project', p, 'sessions'] as const,
  session: (p: string, s: string) => ['project', p, 'session', s] as const,
  activity: (p: string) => ['project', p, 'activity'] as const,
  reviews: (p: string) => ['project', p, 'reviews'] as const,
  review: (p: string, t: string, r: string) => ['project', p, 'review', t, r] as const,
}
export function eventKeys(event: ProjectEvent): readonly (readonly string[])[] {
  const p = event.projectId
  const keys: (readonly string[])[] = [projectKeys.activity(p)]
  if (event.taskId) keys.push(projectKeys.tasks(p), projectKeys.task(p, event.taskId))
  if (event.taskId && ['run.changed', 'task.transitioned', 'assignment.changed', 'binding.changed', 'workspace.provisioning'].includes(event.type)) {
    keys.push(projectKeys.runs(p, event.taskId), projectKeys.reviews(p), ['project', p, 'review', event.taskId])
  }
  if (event.type === 'run.changed') keys.push(projectKeys.sessions(p), ['project', p, 'session'])
  if ('workspaceId' in event || ['assignment.changed', 'binding.changed'].includes(event.type)) keys.push(projectKeys.workspaces(p))
  return keys
}
export function mergeActivity(previous: readonly ProjectActivityItem[], incoming: readonly ProjectActivityItem[]) {
  const items = new Map(previous.map(item => [`${item.activity.taskId}:${item.activity.seq}`, item]))
  for (const item of incoming) {
    if (!Number.isSafeInteger(item?.cursor) || item.cursor < 1 || !item.activity || typeof item.activity.taskId !== 'string' || !item.activity.taskId || !Number.isSafeInteger(item.activity.seq) || item.activity.seq < 1) throw new Error('Invalid durable activity cursor or identity')
    const identity = `${item.activity.taskId}:${item.activity.seq}`
    const existing = items.get(identity)
    if (existing && existing.cursor !== item.cursor) throw new Error('Conflicting durable activity cursor')
    if ([...items.values()].some(previous => previous.cursor === item.cursor && `${previous.activity.taskId}:${previous.activity.seq}` !== identity)) throw new Error('Conflicting durable activity identity')
    items.set(identity, existing ?? item)
  }
  return [...items.values()].sort((a, b) => a.cursor - b.cursor)
}
export function projectActivityOptions(api: Api, p: string, client: QueryClient) {
  return { queryKey: projectKeys.activity(p), enabled: !!p, queryFn: async ({ signal }: { signal: AbortSignal }) => {
    let items = client.getQueryData<ProjectActivityItem[]>(projectKeys.activity(p)) ?? []
    while (true) {
      const cursor = items.at(-1)?.cursor ?? 0
      const page = await api.projectActivity(p, cursor, signal)
      signal.throwIfAborted()
      items = mergeActivity(items, page)
      if (!page.length || (items.at(-1)?.cursor ?? 0) <= cursor) return items
    }
  } }
}

/** Scope closure rejects callbacks queued before unsubscribe, even if transport ignores abort. */
export function projectSubscription(p: string, invalidate: (key: readonly string[]) => void) {
  let current = true
  return {
    event(event: unknown) {
      if (!current) return
      if (!event || typeof event !== 'object') { invalidate(projectKeys.root(p)); return }
      const value = event as Record<string, unknown>
      if (typeof value.projectId === 'string' && value.projectId !== p) return
      const required = value.type === 'workspace.provisioning' ? ['workspaceId'] : value.type === 'run.changed' ? ['taskId', 'runId'] : value.type === 'binding.changed' ? ['taskId', 'workspaceId'] : ['taskId']
      if (value.projectId !== p || typeof value.id !== 'string' || !value.id || !['task.created', 'task.updated', 'task.transitioned', 'assignment.changed', 'link.changed', 'binding.changed', 'run.changed', 'workspace.provisioning'].includes(String(value.type)) || required.some(key => typeof value[key] !== 'string' || !value[key])) {
        invalidate(projectKeys.root(p)); return
      }
      eventKeys(event as ProjectEvent).forEach(invalidate)
    },
    reconcile() { if (current) invalidate(projectKeys.root(p)) },
    dispose() { current = false },
  }
}
