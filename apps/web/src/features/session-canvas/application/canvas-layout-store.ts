import type { CanvasPoint } from '../model/session-canvas-projection.ts'

export interface CanvasViewState {
  readonly graphRevision: string
  readonly nodePositions: Readonly<Record<string, CanvasPoint>>
  readonly viewport?: { readonly x: number; readonly y: number; readonly zoom: number }
}

const storageKey = (projectId: string) => `wemux:session-canvas:${projectId}`

export function readCanvasViewState(projectId: string, graphRevision: string, storage: Storage = window.localStorage): CanvasViewState | null {
  try {
    const value = JSON.parse(storage.getItem(storageKey(projectId)) ?? 'null') as CanvasViewState | null
    if (!value || value.graphRevision !== graphRevision || typeof value.nodePositions !== 'object' || value.nodePositions === null) return null
    return value
  } catch {
    return null
  }
}

/** Ticket 18 keeps manual layout local. Server CAS persistence is owned by Ticket 22. */
export function writeCanvasViewState(projectId: string, state: CanvasViewState, storage: Storage = window.localStorage): void {
  storage.setItem(storageKey(projectId), JSON.stringify(state))
}
