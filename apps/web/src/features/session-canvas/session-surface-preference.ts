import type { SessionPresentation } from '../sessions/session-surface.tsx'

const STORAGE_KEY = 'wemux.session-surface-preferences.v1'
export type CanvasSessionMode = Extract<SessionPresentation, 'canvas-summary' | 'canvas-interactive'>

type Preferences = Record<string, CanvasSessionMode>

export function getCanvasSessionMode(projectId: string, sessionId: string): CanvasSessionMode {
  if (!projectId || !sessionId || typeof window === 'undefined') return 'canvas-interactive'
  try { const value = read()[key(projectId, sessionId)]; return value === 'canvas-summary' || value === 'canvas-interactive' ? value : 'canvas-interactive' } catch { return 'canvas-interactive' }
}

export function setCanvasSessionMode(projectId: string, sessionId: string, mode: CanvasSessionMode) {
  if (!projectId || !sessionId || typeof window === 'undefined') return
  const preferences = read()
  if (mode === 'canvas-interactive') delete preferences[key(projectId, sessionId)]
  else preferences[key(projectId, sessionId)] = mode
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences))
}

function read(): Preferences {
  if (typeof window === 'undefined') return {}
  const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}') as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  return parsed as Preferences
}

const key = (projectId: string, sessionId: string) => `${projectId}:${sessionId}`
