import type { AgentAdapter } from './ports/agent-adapter.js'
import type { AgentRuntimeSession, RuntimeSessionAdapter, RuntimeSessionOpenInput } from './ports/runtime-session.js'

/**
 * Compatibility bridge for adapters that still expose startTurn. It preserves
 * the native-session resume contract while the provider-specific persistent
 * connection implementations are introduced behind RuntimeSessionAdapter.
 */
export class LegacyRuntimeSessionAdapter implements RuntimeSessionAdapter {
  constructor(private readonly adapter: Extract<AgentAdapter, { mode: 'execution' }>) {}

  async openSession(open: RuntimeSessionOpenInput): Promise<AgentRuntimeSession> {
    let closed = false
    let active: Awaited<ReturnType<typeof this.adapter.startTurn>> | null = null
    return {
      execute: async operation => {
        if (closed) throw new Error('Runtime session is closed')
        if (active) throw new Error('Runtime session already has an active operation')
        const handle = await this.adapter.startTurn({
          sessionId: open.sessionId,
          turnId: operation.operationId,
          cwd: open.cwd,
          modelId: open.modelId,
          message: operation.message,
          resume: open.resume,
          launchContext: operation.launchContext,
        })
        let released = false
        const release = async () => {
          if (released) return
          released = true
          await handle.stop()
          if (active === wrapped) active = null
        }
        const wrapped = {
          signals: (async function* () {
            try { yield* handle.signals }
            finally { await release() }
          })(),
          stop: release,
        }
        active = wrapped
        return wrapped
      },
      command: async () => { throw new Error('Legacy runtime commands are not supported') },
      resolveApproval: async () => { throw new Error('Legacy runtime approvals are not supported') },
      close: async () => {
        if (closed) return
        closed = true
        await active?.stop()
        active = null
      },
    }
  }
}
