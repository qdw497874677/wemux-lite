import type { EventSeq, SessionId } from '@wemux/domain'
import type { ServerStoreTx } from './ports/server-store.ts'

/** Unknown or incomplete Journal is never proof of idleness. */
export async function sessionIdleReason(tx: ServerStoreTx, sessionId: SessionId): Promise<string | null> {
  const session = await tx.resources.getSession(sessionId)
  if (!session || session.deletedAt) return 'Session deleted'
  const worker = await tx.resources.getWorker(session.binding.agent.workerId)
  const freshness = await tx.cache.getFreshness(sessionId)
  if (worker?.connectionState !== 'online' || freshness?.status !== 'synced' || freshness.workerLastSeq !== freshness.contiguousSeq) return 'Session Journal is not fresh; wait for synchronization'
  const workerSessions = await tx.resources.listSessions()
  if (workerSessions.some(candidate => !candidate.deletedAt && candidate.binding.agent.workerId === worker.id && ['running', 'stopping'].includes(candidate.runtimeState))) return 'Worker has an active Session invocation'
  const queued = new Set<string>(), active = new Set<string>(), observed = new Set<string>()
  let from = 1 as EventSeq
  for (;;) {
    const page = await tx.cache.readEvents(sessionId, from, 500)
    for (const { payload: p } of page.events) {
      if (p.kind === 'message.queued') { queued.add(p.messageId); observed.add(p.commandId) }
      if (p.kind === 'message.cancelled') queued.delete(p.messageId)
      if (p.kind === 'turn.started') { queued.delete(p.messageId); active.add(p.turnId) }
      if (p.kind === 'turn.finished') active.delete(p.turnId)
    }
    if (!page.nextSeq) break
    from = page.nextSeq
  }
  if (queued.size || active.size) return 'Session has queued messages or a running Turn'
  // Enqueue may be committed but not yet represented in the Journal.
  for (const command of await tx.commands.listUnsettledEnqueues(sessionId)) {
    if (!observed.has(command.commandId)) return 'Session has pending enqueue delivery'
  }
  return null
}
