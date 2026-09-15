import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Api } from '../api/client'
import { projectActivityOptions, projectKeys, projectSubscription } from './project-query'

export function useProject(api: Api, projectId: string) {
  const client = useQueryClient()
  const [stream, setStream] = useState('connecting')
  useEffect(() => {
    if (!projectId) return
    let alive = true
    const scope = projectSubscription(projectId, key => { void client.invalidateQueries({ queryKey: key }) })
    setStream('connecting')
    const stop = api.watchProject(projectId, scope.event, state => {
      if (!alive) return
      setStream(state); if (state === 'live') scope.reconcile()
    })
    const reconcile = () => { if (navigator.onLine && document.visibilityState !== 'hidden') scope.reconcile() }
    window.addEventListener('online', reconcile)
    document.addEventListener('visibilitychange', reconcile)
    // Polling is independent of SSE: notifications are hints, never the durable history.
    const poll = window.setInterval(reconcile, 10000)
    return () => {
      alive = false; scope.dispose(); stop(); clearInterval(poll)
      window.removeEventListener('online', reconcile); document.removeEventListener('visibilitychange', reconcile)
      void client.cancelQueries({ queryKey: projectKeys.root(projectId) })
    }
  }, [api, projectId, client])
  const tasks = useQuery({ queryKey: projectKeys.tasks(projectId), queryFn: ({ signal }) => api.tasks(projectId, signal), enabled: !!projectId })
  const workspaces = useQuery({ queryKey: projectKeys.workspaces(projectId), queryFn: ({ signal }) => api.workspaces(projectId, signal), enabled: !!projectId })
  const sessions = useQuery({ queryKey: projectKeys.sessions(projectId), queryFn: ({ signal }) => api.sessions(projectId, signal), enabled: !!projectId })
  const reviews = useQuery({ queryKey: projectKeys.reviews(projectId), queryFn: ({ signal }) => api.pendingReviews(projectId, signal), enabled: !!projectId })
  const activity = useQuery(projectActivityOptions(api, projectId, client))
  return { tasks, workspaces, sessions, reviews, activity, stream }
}
