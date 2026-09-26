export type ShortcutScope = 'global' | 'dialog' | 'sheet' | 'panel' | (string & {})

export interface ShortcutRegistration {
  combo: string
  handler: () => boolean | void
  scope: ShortcutScope
  description: string
  priority?: number
  enabled?: () => boolean
  allowInEditable?: boolean
}

type ShortcutEvent = Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'defaultPrevented' | 'isComposing' | 'key' | 'metaKey' | 'shiftKey' | 'preventDefault'>
type ShortcutTarget = { closest: (selectors: string) => unknown }

const editableSelector = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])'

export function shortcutTargetsEditable(target: ShortcutTarget | null): boolean {
  return target?.closest(editableSelector) != null
}

function normalizeKey(key: string) {
  return key === 'Esc' ? 'escape' : key.toLowerCase()
}

export function matchesShortcut(combo: string, event: ShortcutEvent): boolean {
  const parts = combo.toLowerCase().split('+').map(part => part.trim())
  const key = parts.at(-1)
  const mod = parts.includes('mod')
  const ctrl = parts.includes('ctrl')
  const meta = parts.includes('meta') || parts.includes('cmd')
  const alt = parts.includes('alt') || parts.includes('option')
  const shift = parts.includes('shift')
  if (mod ? !(event.metaKey || event.ctrlKey) : event.metaKey !== meta || event.ctrlKey !== ctrl) return false
  if (event.altKey !== alt || event.shiftKey !== shift) return false
  return normalizeKey(event.key) === normalizeKey(key ?? '')
}

export function createShortcutRegistry() {
  let nextId = 0
  const registrations = new Map<number, ShortcutRegistration>()
  return {
    register(registration: ShortcutRegistration) {
      const id = ++nextId
      registrations.set(id, registration)
      return () => { registrations.delete(id) }
    },
    handle(event: ShortcutEvent, target: ShortcutTarget | null) {
      if (event.defaultPrevented || event.isComposing) return false
      const editable = shortcutTargetsEditable(target)
      const matches = [...registrations.entries()]
        .filter(([, registration]) => matchesShortcut(registration.combo, event) && registration.enabled?.() !== false && (!editable || registration.allowInEditable))
        .sort(([leftId, left], [rightId, right]) => (right.priority ?? 0) - (left.priority ?? 0) || rightId - leftId)
      const registration = matches[0]?.[1]
      if (!registration) return false
      if (registration.handler() !== false) event.preventDefault()
      return true
    },
  }
}

export const shortcuts = createShortcutRegistry()

export function registerShortcut(registration: ShortcutRegistration) {
  return shortcuts.register(registration)
}

export function installShortcutListener(target: Window = window) {
  const listener = (event: KeyboardEvent) => { shortcuts.handle(event, event.target && 'closest' in event.target ? event.target as ShortcutTarget : null) }
  target.addEventListener('keydown', listener)
  return () => target.removeEventListener('keydown', listener)
}
