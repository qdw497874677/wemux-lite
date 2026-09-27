import { createHash } from 'node:crypto'
import type { CommandId, EventSeq, SessionId, Timestamp, TurnId, WorkerId } from '@wemux/domain'
import type { WorkerCommand } from '@wemux/wire-protocol'
import type { Run, TaskActivity } from '@wemux/web-contract/task-platform'
import type { ServerStoreTx } from './ports/server-store.ts'

export const isActiveRun = (run: Pick<Run, 'status'>) => ['pending', 'running', 'cancelling'].includes(run.status)

/** Stable target identity makes replay and queued/start races idempotent. */
export async function ensureRunCancel(tx: ServerStoreTx, run: Run, retryRequestId?: string): Promise<Run> {
  const target = `run-cancel:${run.id}:${run.turnId ?? 'queued'}`
  const recorded = [...run.cancelCommandIds].reverse().find(id => id === target || id.startsWith(`${target}:retry:`))
  const commandId = (retryRequestId ? `${target}:retry:${createHash('sha256').update(retryRequestId).digest('hex')}` : recorded ?? target) as CommandId
  if (run.cancelCommandIds.includes(commandId) && await tx.commands.get(commandId)) return run
  const command: WorkerCommand = run.turnId
    ? { kind: 'turn.stop', sessionId: run.sessionId as SessionId, turnId: run.turnId as TurnId }
    : { kind: 'session.cancel-queued', sessionId: run.sessionId as SessionId, submissionCommandId: run.enqueueCommandId as CommandId }
  await tx.commands.insertPending({ commandId, workerId: run.snapshot.workerId as WorkerId, command, payloadFingerprint: createHash('sha256').update(JSON.stringify(command)).digest('hex'), createdAt: new Date().toISOString() as Timestamp })
  if (!run.turnId) await tx.commands.depend(commandId, run.enqueueCommandId as CommandId)
  return { ...run, cancelCommandIds: run.cancelCommandIds.includes(commandId) ? run.cancelCommandIds : [...run.cancelCommandIds, commandId] }
}

/** Projection, cursor and activity share the caller's continuous-cache transaction. */
export async function saveRunProjection(tx: ServerStoreTx, run: Run, type?: TaskActivity['type']) {
  await tx.tasks.saveRun(run)
  const task = await tx.tasks.get(run.taskId)
  if (!task) throw new Error('Run Task missing')
  const at = run.finishedAt ?? run.startedAt ?? run.createdAt
  await tx.tasks.save({ ...task, activeRun: isActiveRun(run) ? run : task.activeRun?.id === run.id ? null : task.activeRun, ...(type ? { lastActivityAt: Date.parse(at) > Date.parse(task.lastActivityAt) ? at : task.lastActivityAt } : {}) })
  if (type) await tx.tasks.append({ taskId: run.taskId, projectId: run.projectId, type, actor: 'server', requestId: run.requestId, occurredAt: at, payload: { runId: run.id, status: run.status, resultSummary: run.resultSummary, failure: run.failure } }, `${run.id}:${type}`)
}

export async function projectRuns(tx: ServerStoreTx, sessionId: SessionId) {
  const session = await tx.resources.getSession(sessionId)
  if (!session) return
  // Historical Runs survive unbinding and rebinding to another Task.
  const tasks = await tx.tasks.list(session.projectId)
  for (const task of tasks) {
    if (!task) continue
    for (let run of await tx.tasks.runs(task.id)) {
      if (run.sessionId !== sessionId) continue
      let from = (run.lastProjectedSeq + 1) as EventSeq
      for (;;) {
        const page = await tx.cache.readEvents(sessionId, from, 500)
        for (const event of page.events) {
          const p = event.payload
          let type: TaskActivity['type'] | undefined
          if (isActiveRun(run)) {
            if (p.kind === 'message.queued' && p.commandId === run.enqueueCommandId && run.messageId === null) run = { ...run, messageId: p.messageId }
            if (p.kind === 'turn.started' && run.messageId !== null && p.messageId === run.messageId && run.turnId === null) {
              run = { ...run, turnId: p.turnId, startedAt: event.occurredAt, status: run.cancelRequestedAt ? 'cancelling' : 'running' }; type = 'run.started'
              if (run.cancelRequestedAt) run = await ensureRunCancel(tx, run)
            }
            if (p.kind === 'message.cancelled' && p.commandId === run.enqueueCommandId && run.cancelRequestedAt) {
              run = { ...run, status: 'cancelled', finishedAt: event.occurredAt }; type = 'run.finished'
            }
            if (p.kind === 'assistant.text.delta' && run.turnId !== null && p.turnId === run.turnId) run = { ...run, resultSummary: (run.resultSummary ?? '') + p.text }
            if (p.kind === 'turn.finished' && run.turnId !== null && p.turnId === run.turnId) {
              run = { ...run, status: run.cancelRequestedAt ? 'cancelled' : p.outcome === 'completed' ? 'succeeded' : 'failed', finishedAt: event.occurredAt, failure: run.cancelRequestedAt || p.outcome === 'completed' ? null : { code: p.failure?.code ?? p.outcome, message: p.failure?.message ?? 'Turn cancelled without Run cancellation intent' } }; type = 'run.finished'
            }
          }
          run = { ...run, lastProjectedSeq: event.seq }
          await saveRunProjection(tx, run, type)
        }
        if (!page.nextSeq) break
        from = page.nextSeq
      }
      // Startup may have no new Journal events, but accepted cancellation intent
      // must still have a durable target. Never replace a rejected target here.
      if (isActiveRun(run) && run.cancelRequestedAt && !session.deletedAt) {
        const reconciled = await ensureRunCancel(tx, run)
        if (reconciled !== run) await saveRunProjection(tx, reconciled)
      }
    }
  }
}
