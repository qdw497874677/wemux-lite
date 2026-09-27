import { useSyncExternalStore } from 'react'

export type TerminalContextSnapshot = { readonly active: boolean; readonly terminalId: string | null; readonly lines: readonly string[] }
const empty: TerminalContextSnapshot = { active: false, terminalId: null, lines: [] }
const snapshots = new Map<string, TerminalContextSnapshot>()
const listeners = new Map<string, Set<() => void>>()

export function setTerminalContext(sessionId: string, snapshot: TerminalContextSnapshot): void {
  snapshots.set(sessionId, snapshot)
  listeners.get(sessionId)?.forEach(listener => listener())
}
export function clearTerminalContext(sessionId: string): void { snapshots.delete(sessionId); listeners.get(sessionId)?.forEach(listener => listener()) }
export function terminalContextSnapshot(sessionId: string): TerminalContextSnapshot { return snapshots.get(sessionId) ?? empty }
export function useTerminalContext(sessionId: string): TerminalContextSnapshot {
  return useSyncExternalStore(
    listener => { const group = listeners.get(sessionId) ?? new Set(); group.add(listener); listeners.set(sessionId, group); return () => { group.delete(listener); if (!group.size) listeners.delete(sessionId) } },
    () => terminalContextSnapshot(sessionId),
    () => empty,
  )
}
export function terminalContextText(snapshot: TerminalContextSnapshot, limit = 20): string {
  const lines = snapshot.lines.slice(-limit)
  return lines.length ? `[终端上下文]\n${lines.join('\n')}` : ''
}
