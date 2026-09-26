import { useCallback, useEffect, useState } from 'react'
import type { Api } from '../../api/client.ts'
import { applyCanvasCollaborationEvent, canvasCollaborationStreamUrl, publishCanvasPresence, readCanvasCollaboration, type CanvasCollaborationSnapshot, type CanvasCollaborationStatus } from './canvas-collaboration.ts'

const EMPTY = (projectId: string): CanvasCollaborationSnapshot => ({ projectId, revision: 0, presence: [] })

export function useCanvasCollaboration(api: Api, projectId: string, activeSessionId: string | null, displayName = '当前成员') {
  const [snapshot, setSnapshot] = useState<CanvasCollaborationSnapshot>(() => EMPTY(projectId))
  const [status, setStatus] = useState<CanvasCollaborationStatus>('connecting')
  const refresh = useCallback(async () => { try { const next = await readCanvasCollaboration(api, projectId); setSnapshot(next); setStatus('live') } catch { setStatus('unavailable') } }, [api, projectId])
  useEffect(() => { setSnapshot(EMPTY(projectId)); setStatus('connecting'); void refresh() }, [projectId, refresh])
  useEffect(() => { void publishCanvasPresence(api, projectId, { displayName, activeSessionId, typing: false }).then(setSnapshot).catch(() => setStatus('unavailable')) }, [api, projectId, activeSessionId, displayName])
  useEffect(() => { const timer = window.setInterval(() => { void publishCanvasPresence(api, projectId, { displayName, activeSessionId, typing: false }).then(setSnapshot).catch(() => setStatus('reconnecting')) }, 15_000); return () => window.clearInterval(timer) }, [api, projectId, activeSessionId, displayName])
  useEffect(() => {
    if (typeof EventSource === 'undefined') return
    const source = new EventSource(canvasCollaborationStreamUrl(projectId), { withCredentials: true })
    const on = (type: string) => (event: MessageEvent<string>) => { try { const data = JSON.parse(event.data); setSnapshot(current => applyCanvasCollaborationEvent(current, type, data)); setStatus('live') } catch { setStatus('reconnecting') } }
    const listeners = ['snapshot', 'presence.updated', 'presence.left'] as const
    const handlers = listeners.map(type => [type, on(type)] as const); handlers.forEach(([type, handler]) => source.addEventListener(type, handler as EventListener))
    source.onopen = () => setStatus('live'); source.onerror = () => setStatus('reconnecting')
    return () => { handlers.forEach(([type, handler]) => source.removeEventListener(type, handler as EventListener)); source.close() }
  }, [projectId])

  return { snapshot, status, refresh }
}
