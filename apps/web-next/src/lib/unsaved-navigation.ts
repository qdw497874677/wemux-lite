/** Memory-only guards. Authentication retirement never calls these guards. */
const guards = new Set<() => boolean>()
export function registerUnsaved(check: () => boolean) { guards.add(check); return () => { guards.delete(check) } }
export function hasUnsaved() { return [...guards].some(check => check()) }
export function confirmNavigation() { return !hasUnsaved() || window.confirm('任务内容尚未保存，确认放弃草稿并离开？') }
