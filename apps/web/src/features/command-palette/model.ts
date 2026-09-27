import type { SessionDTO } from '../../api/dto.ts'

export const commandPaletteRecentKey = 'wemux.command-palette.recent'
export const commandPaletteRecentLimit = 5

export type CommandPaletteItem = {
  id: string
  kind: 'command' | 'session'
  label: string
  description: string
  keywords?: string
  disabled?: boolean
  run: () => void
}

export function readRecentCommandIds(storage: Pick<Storage, 'getItem'>): string[] {
  try {
    const value: unknown = JSON.parse(storage.getItem(commandPaletteRecentKey) ?? '[]')
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, commandPaletteRecentLimit) : []
  } catch {
    return []
  }
}

export function rememberCommandId(storage: Pick<Storage, 'setItem'>, recent: readonly string[], id: string): string[] {
  const next = [id, ...recent.filter(item => item !== id)].slice(0, commandPaletteRecentLimit)
  try { storage.setItem(commandPaletteRecentKey, JSON.stringify(next)) } catch { /* Storage can be unavailable in hardened browsers. */ }
  return next
}

export function nextPaletteSelection(current: number, direction: 1 | -1, length: number): number {
  return length ? (current + direction + length) % length : 0
}

export function executePaletteItem(item: CommandPaletteItem | undefined, storage: Pick<Storage, 'setItem'>, recent: readonly string[]): string[] {
  if (!item || item.disabled) return [...recent]
  const next = item.kind === 'command' ? rememberCommandId(storage, recent, item.id) : [...recent]
  item.run()
  return next
}

export function paletteTextSegments(text: string, query: string): { text: string; highlighted: boolean }[] {
  const needle = query.trim()
  if (!needle) return [{ text, highlighted: false }]
  const normalizedText = text.toLocaleLowerCase()
  const normalizedNeedle = needle.toLocaleLowerCase()
  const segments: { text: string; highlighted: boolean }[] = []
  let cursor = 0
  while (cursor < text.length) {
    const match = normalizedText.indexOf(normalizedNeedle, cursor)
    if (match < 0) {
      segments.push({ text: text.slice(cursor), highlighted: false })
      break
    }
    if (match > cursor) segments.push({ text: text.slice(cursor, match), highlighted: false })
    segments.push({ text: text.slice(match, match + needle.length), highlighted: true })
    cursor = match + needle.length
  }
  return segments.length ? segments : [{ text, highlighted: false }]
}

export function filterPaletteItems(items: readonly CommandPaletteItem[], query: string): CommandPaletteItem[] {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return [...items]
  return items.filter(item => `${item.label}\n${item.description}\n${item.keywords ?? ''}`.toLocaleLowerCase().includes(normalized))
}

export function orderCommandsByRecent(items: readonly CommandPaletteItem[], recent: readonly string[]): CommandPaletteItem[] {
  const rank = new Map(recent.map((id, index) => [id, index]))
  return [...items].sort((left, right) => (rank.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.id) ?? Number.MAX_SAFE_INTEGER))
}

export function sessionPaletteItems(sessions: readonly SessionDTO[], projectId: string, open: (sessionId: string) => void): CommandPaletteItem[] {
  return [...sessions]
    .filter(session => session.canRead && !session.archivedAt && (!session.projectId || session.projectId === projectId))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map(session => ({
      id: `session:${session.id}`,
      kind: 'session' as const,
      label: session.title,
      description: `会话 · 更新于 ${new Date(session.updatedAt).toLocaleString('zh-CN')}`,
      keywords: session.id,
      run: () => open(session.id),
    }))
}
