// Adapted from Paperclip navigation-scroll.ts (MIT). Issue-specific rules omitted.
export class NavigationScrollMemory {
  private positions = new Map<string, number>()
  remember(key: string, scrollTop: number) { this.positions.set(key, Math.max(0, scrollTop)) }
  recall(key: string) { return this.positions.get(key) ?? 0 }
}
export function applyMainContentScrollTop(mainElement: HTMLElement | null, scrollTop: number) {
  if (!mainElement) return
  mainElement.scrollTo?.({ top: scrollTop, left: 0, behavior: 'auto' })
  mainElement.scrollTop = scrollTop
  mainElement.scrollLeft = 0
}
