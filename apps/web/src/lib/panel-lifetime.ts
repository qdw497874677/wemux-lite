/* Derived from pingdotgg/t3code (MIT). */

type TimerHandle = ReturnType<typeof globalThis.setTimeout>
type PanelOperation = (key: string) => Promise<void> | void

export interface PanelLease {
  readonly key: string
  readonly ready: Promise<void>
  readonly release: () => void
}

export interface PanelLifetimeOptions {
  closeDelayMs?: number
  onOpen?: PanelOperation
  onClose?: PanelOperation
  setTimeout?: (callback: () => void, delayMs: number) => TimerHandle
  clearTimeout?: (handle: TimerHandle) => void
  onRetainedKeysChange?: (keys: readonly string[]) => void
}

type LeaseState = {
  references: number
  closeTimer: TimerHandle | null
  ready: Promise<void>
  keepAlive: boolean
}

export interface PanelLifetime {
  acquire: (key: string, options?: { keepAlive?: boolean }) => PanelLease
  references: (key: string) => number
  retainedKeys: () => string[]
  subscribe: (listener: () => void) => () => void
  whenIdle: (key: string) => Promise<void>
  dispose: () => void
}

export function createPanelLifetime(options: PanelLifetimeOptions = {}): PanelLifetime {
  const closeDelayMs = options.closeDelayMs ?? 30_000
  const schedule = options.setTimeout ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs))
  const cancel = options.clearTimeout ?? (handle => globalThis.clearTimeout(handle))
  const leases = new Map<string, LeaseState>()
  const pendingOperations = new Map<string, Promise<void>>()
  const listeners = new Set<() => void>()

  const emit = () => {
    const keys = [...leases.keys()]
    options.onRetainedKeysChange?.(keys)
    listeners.forEach(listener => listener())
  }
  const enqueue = (key: string, operation: () => Promise<void> | void) => {
    const previous = pendingOperations.get(key)
    const pending = previous
      ? previous.catch(() => undefined).then(operation)
      : Promise.resolve().then(operation)
    pendingOperations.set(key, pending)
    void pending.finally(() => {
      if (pendingOperations.get(key) === pending) pendingOperations.delete(key)
    }).catch(() => undefined)
    return pending
  }
  const close = (key: string, expected: LeaseState) => {
    const latest = leases.get(key)
    if (latest !== expected || latest.references > 0) return
    leases.delete(key)
    emit()
    void enqueue(key, () => options.onClose?.(key)).catch(() => undefined)
  }

  return {
    acquire(key, acquireOptions = {}) {
      const keepAlive = acquireOptions.keepAlive !== false
      let state = leases.get(key)
      if (!state) {
        state = {
          references: 0,
          closeTimer: null,
          keepAlive,
          ready: enqueue(key, () => options.onOpen?.(key)),
        }
        leases.set(key, state)
        emit()
      }
      if (state.closeTimer !== null) cancel(state.closeTimer)
      state.closeTimer = null
      state.references += 1
      state.keepAlive = state.keepAlive && keepAlive
      let released = false
      return {
        key,
        ready: state.ready,
        release: () => {
          if (released) return
          released = true
          const current = leases.get(key)
          if (!current) return
          current.references = Math.max(0, current.references - 1)
          if (current.references > 0 || current.closeTimer !== null) return
          if (!current.keepAlive) {
            close(key, current)
            return
          }
          current.closeTimer = schedule(() => {
            current.closeTimer = null
            close(key, current)
          }, closeDelayMs)
        },
      }
    },
    references: key => leases.get(key)?.references ?? 0,
    retainedKeys: () => [...leases.keys()],
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    whenIdle: key => pendingOperations.get(key) ?? Promise.resolve(),
    dispose() {
      for (const state of leases.values()) if (state.closeTimer !== null) cancel(state.closeTimer)
      leases.clear()
      listeners.clear()
      emit()
    },
  }
}

export const panelLifetime = createPanelLifetime()
