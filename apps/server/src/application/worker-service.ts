import { isActiveRun, projectRuns, saveRunProjection } from './run-projection.js'
import type { CommandId, EventSeq, SessionId, WorkerId } from '@wemux/domain'
import type { ProjectEvent } from '@wemux/web-contract/task-platform'
import type { ServerToWorker, WorkerToServer } from '@wemux/wire-protocol'
import type { ServerStore } from './ports/server-store.js'
import { AppError, requireValue } from './errors.js'
import { Notifications } from './notifications.js'
import { newId, now } from './server-service.js'

/** Worker ownership and journal consistency belong here, not in the WS adapter. */
export const envelope = (): { readonly messageId: import('@wemux/domain').MessageId } => ({ messageId: newId<'MessageId'>() })

export class WorkerService {
  constructor(private readonly store: ServerStore, private readonly notifications: Notifications) {}
  async recoverRuns() {
    const changes = await this.store.transaction(async tx => {
      const changed: { workerId: WorkerId; projectId: string; taskId: string; runId: string }[] = []
      for (const session of await tx.resources.listSessions()) {
        const tasks = await tx.tasks.list(session.projectId)
        const before = new Map<string, string>()
        for (const task of tasks) for (const run of await tx.tasks.runs(task.id)) if (run.sessionId === session.id) before.set(run.id, JSON.stringify(run))
        await projectRuns(tx, session.id)
        for (const task of tasks) for (const run of await tx.tasks.runs(task.id)) {
          if (before.has(run.id) && before.get(run.id) !== JSON.stringify(run)) changed.push({ workerId: run.snapshot.workerId as WorkerId, projectId: run.projectId, taskId: run.taskId, runId: run.id })
        }
      }
      return changed
    })
    for (const change of changes) {
      this.notifications.commands(change.workerId)
      this.notifications.project({ id: newId(), projectId: change.projectId, taskId: change.taskId, runId: change.runId, type: 'run.changed' })
    }
  }
  private async ownSession(workerId: WorkerId, sessionId: SessionId, resources = this.store.resources) {
    const session = requireValue(await resources.getSession(sessionId))
    if (session.binding.agent.workerId !== workerId) throw new AppError(403, 'Session belongs to another worker')
    return session
  }
  async connected(workerId: WorkerId, details: { readonly workerVersion: string; readonly platform: string; readonly name?: string }): Promise<void> {
    await this.store.transaction(async tx => {
      const worker = requireValue(await tx.resources.getWorker(workerId))
      if (worker.connectionState === 'revoked') throw new AppError(403, 'Worker revoked')
      await tx.resources.saveWorker({ ...worker, name: details.name ?? worker.name, connectionState: 'online', version: details.workerVersion, platform: details.platform, lastSeenAt: now() })
    })
  }
  async disconnected(workerId: WorkerId): Promise<void> {
    await this.store.transaction(async tx => {
      const worker = requireValue(await tx.resources.getWorker(workerId))
      await tx.resources.saveWorker({ ...worker, connectionState: worker.connectionState === 'revoked' ? 'revoked' : 'offline' })
      await tx.cache.markWorkerOffline(workerId)
    })
    for (const session of await this.store.resources.listSessions()) if (session.binding.agent.workerId === workerId) this.notifications.session(session.id)
  }
  async deliverable(workerId: WorkerId): Promise<readonly ServerToWorker[]> {
    return (await this.store.commands.listDeliverable(workerId, 100)).map(p => ({ type: 'command', commandId: p.commandId, command: p.command }))
  }
  private request(sessionId: SessionId, seq: number): ServerToWorker {
    return { type: 'sync', kind: 'request', sessionId, fromSeq: (seq + 1) as EventSeq, limit: 500 }
  }
  async receive(workerId: WorkerId, message: WorkerToServer): Promise<readonly ServerToWorker[]> {
    const replies: ServerToWorker[] = [], changed = new Set<SessionId>()
    let commandsChanged = false
    const projectEvents = new Map<string, ProjectEvent>()
    const runChanged = (run: { id: string; projectId: string; taskId: string }) => {
      projectEvents.set(`run:${run.id}`, { id: newId(), projectId: run.projectId, taskId: run.taskId, runId: run.id, type: 'run.changed' })
    }
    await this.store.transaction(async tx => {
      const worker = requireValue(await tx.resources.getWorker(workerId))
      if (worker.connectionState === 'revoked') throw new AppError(403, 'Worker revoked')
      await tx.resources.saveWorker({ ...worker, lastSeenAt: now() })
      switch (message.type) {
        case 'heartbeat': replies.push({ type: 'heartbeat', nonce: message.nonce, sentAt: now() }); break
        case 'capability':
          if (message.workerId !== workerId) throw new AppError(403, 'Worker identity mismatch')
          await tx.resources.saveWorker({ ...worker, capabilities: message.capabilities, lastSeenAt: now() })
          break
        case 'ack': {
          const command = requireValue(await tx.commands.get(message.receipt.commandId))
          if (command.workerId !== workerId) throw new AppError(403, 'Command belongs to another worker')
          await tx.commands.recordReceipt(message.receipt, now())
          if (command.status === message.receipt.status) break
          commandsChanged = true
          const run = await tx.tasks.runByCommand(message.receipt.commandId)
          if (run && message.receipt.status === 'rejected' && isActiveRun(run) && run.cancelCommandIds.at(-1) === message.receipt.commandId) {
            await saveRunProjection(tx, { ...run, failure: { code: 'cancel_rejected', message: message.receipt.error.message } })
            changed.add(run.sessionId as SessionId)
            runChanged(run)
          }
          if (run && message.receipt.status === 'rejected' && isActiveRun(run) && !run.cancelCommandIds.includes(message.receipt.commandId)) {
            if (run.createCommandId === message.receipt.commandId) await tx.commands.cancelPending(run.enqueueCommandId as CommandId, now())
            await saveRunProjection(tx, { ...run, status: run.cancelRequestedAt ? 'cancelled' : 'failed', finishedAt: now(), failure: { code: message.receipt.error.code, message: message.receipt.error.message } }, 'run.finished')
            changed.add(run.sessionId as SessionId)
            runChanged(run)
          }
          if (message.receipt.status === 'rejected') {
            for (const workspace of await tx.resources.listWorkspaces()) {
              const placement = workspace.placements.find(value => value.workerId === workerId && value.provisioning?.commandId === message.receipt.commandId && ['pending', 'provisioning'].includes(value.status))
              if (!placement?.provisioning) continue
              const at = now(), reason = message.receipt.error.message
              await tx.resources.saveWorkspace({ ...workspace, workerId, status: 'failed' as const, failureReason: reason, provisioning: { ...placement.provisioning, reportedAt: at }, location: placement.location, placements: workspace.placements.map(value => value.workerId === workerId ? { ...placement, status: 'failed' as const, failureReason: reason, provisioning: { ...placement.provisioning!, reportedAt: at } } : value) })
              await workspaceActivity(workspace.id, 'failed', reason, at)
            }
          }
          break
        }
        case 'event':
          if (message.scope === 'workspace') {
            const r = message.report, w = requireValue(await tx.resources.getWorkspace(r.workspaceId))
            const placement = w.placements.find(value => value.workerId === workerId)
            if (!placement || (r.location && (r.location.workerId !== workerId || r.location.workspaceId !== w.id))) throw new AppError(403, 'Workspace ownership placement mismatch')
            // Attempt identity is authoritative. Legacy reports are accepted only
            // before any explicit retry; their timestamps cannot prove attempt ownership.
            if (r.commandId ? r.commandId !== placement.provisioning?.commandId : placement.provisioning?.replacedAttempt === true) break
            const allowed = placement.status === 'deleting' ? ['deleting', 'deleted', 'failed'] : ['pending', 'provisioning', 'ready', 'failed']
            if (!allowed.includes(r.status)) throw new AppError(409, 'Invalid workspace transition')
            if (placement.status === 'ready' && r.status !== 'ready') break
            if (placement.provisioning?.reportedAt && r.occurredAt < placement.provisioning.reportedAt) break
            if (placement.status === 'failed' && r.status !== 'failed') break
            if (!r.commandId && placement.provisioning && r.occurredAt < placement.provisioning.startedAt) break
            const same = placement.status === r.status && placement.failureReason === r.reason && JSON.stringify(placement.location) === JSON.stringify(r.location)
            const next: import('@wemux/server-domain').WorkspacePlacement = { ...placement, status: r.status as import('@wemux/domain').WorkspacePlacementStatus, failureReason: r.reason, location: r.location, ...(placement.provisioning ? { provisioning: { ...placement.provisioning, reportedAt: r.occurredAt } } : {}) }
            await tx.resources.saveWorkspace({ ...w, workerId, status: next.status, failureReason: next.failureReason, provisioning: next.provisioning, location: next.location, placements: w.placements.map(value => value.workerId === workerId ? next : value) })
            if (!same) await workspaceActivity(w.id, r.status, r.reason, r.occurredAt)
          } else {
            if ((await this.ownSession(workerId, message.event.sessionId, tx.resources)).deletedAt) break
            const before = await tx.cache.getFreshness(message.event.sessionId)
            const existing = await tx.cache.readEvents(message.event.sessionId, message.event.seq, 1)
            const state = await tx.cache.applyEvents(message.event.sessionId, [message.event])
            if (existing.events[0]?.seq === message.event.seq && JSON.stringify(before) === JSON.stringify(state)) break
            await projectRuntime(message.event.sessionId, (before?.contiguousSeq ?? 0) + 1, state.contiguousSeq)
            changed.add(message.event.sessionId)
            if (state.status === 'gap') replies.push(this.request(message.event.sessionId, state.contiguousSeq))
          }
          break
        case 'sync':
          if (message.kind === 'heads') {
            for (const head of message.heads) {
              if ((await this.ownSession(workerId, head.sessionId, tx.resources)).deletedAt) continue
              const state = await tx.cache.recordWorkerHead(head.sessionId, head.lastSeq)
              changed.add(head.sessionId)
              if (state.contiguousSeq < head.lastSeq) replies.push(this.request(head.sessionId, state.contiguousSeq))
              if (state.contiguousSeq > head.lastSeq) throw new AppError(409, 'Worker journal head regressed')
            }
          } else {
            if ((await this.ownSession(workerId, message.sessionId, tx.resources)).deletedAt) break
            const previous = await tx.cache.getFreshness(message.sessionId)
            let inserted = false
            if (message.kind === 'gap') {
              await tx.cache.markSessionGap(message.sessionId)
            } else {
              const before = await tx.cache.getFreshness(message.sessionId)
              const beforeSeq = before?.contiguousSeq ?? 0
              if (message.events.some(e => e.seq > message.throughSeq)) throw new AppError(409, 'Invalid batch cursor')
              for (const event of message.events) {
                const page = await tx.cache.readEvents(message.sessionId, event.seq, 1)
                if (page.events[0]?.seq !== event.seq) inserted = true
              }
              const state = await tx.cache.applyEvents(message.sessionId, message.events)
              const staleOrDuplicate = message.throughSeq <= beforeSeq
              if (!message.hasMore && !staleOrDuplicate) {
                if (message.throughSeq < (before?.workerLastSeq ?? 0) || state.contiguousSeq > message.throughSeq) throw new AppError(409, 'Worker journal head regressed')
                await tx.cache.recordWorkerHead(message.sessionId, message.throughSeq)
              }
              await projectRuntime(message.sessionId, beforeSeq + 1, state.contiguousSeq)
              if (!staleOrDuplicate && (message.hasMore || state.contiguousSeq < message.throughSeq)) replies.push(this.request(message.sessionId, state.contiguousSeq))
            }
            if (inserted || JSON.stringify(previous) !== JSON.stringify(await tx.cache.getFreshness(message.sessionId))) changed.add(message.sessionId)
          }
          break
      }
      async function workspaceActivity(workspaceId: string, status: string, reason: string | null, occurredAt: string) {
        const workspace = requireValue(await tx.resources.getWorkspace(workspaceId as import('@wemux/domain').WorkspaceId))
        const binding = await tx.tasks.binding(workspaceId)
        projectEvents.set(`workspace:${workspaceId}`, { id: newId(), projectId: workspace.projectId, workspaceId, ...(binding ? { taskId: binding.taskId } : {}), type: 'workspace.provisioning' })
        if (!binding) return
        const task = requireValue(await tx.tasks.get(binding.taskId))
        await tx.tasks.save({ ...task, lastActivityAt: now() })
        await tx.tasks.append({ taskId: task.id, projectId: task.projectId, type: 'workspace.provisioning', actor: workerId, requestId: newId(), occurredAt, payload: { workspaceId, status, reason } })
      }
      // Only contiguous journal entries influence the display projection.
      async function projectRuntime(sessionId: SessionId, start: number, through: EventSeq) {
        const session = requireValue(await tx.resources.getSession(sessionId))
        let from = start as EventSeq, runtimeState = session.runtimeState
        while (from <= through) {
          const page = await tx.cache.readEvents(sessionId, from, 500)
          for (const event of page.events) if (event.payload.kind === 'session.runtime.changed') runtimeState = event.payload.state
          if (!page.nextSeq) break
          from = page.nextSeq
        }
        await tx.resources.saveSession({ ...session, runtimeState })
        const tasks = await tx.tasks.list(session.projectId)
        const before = new Map<string, string>()
        for (const task of tasks) for (const run of await tx.tasks.runs(task.id)) if (run.sessionId === sessionId) before.set(run.id, JSON.stringify(run))
        await projectRuns(tx, sessionId)
        for (const task of tasks) for (const run of await tx.tasks.runs(task.id)) {
          if (before.has(run.id) && before.get(run.id) !== JSON.stringify(run)) runChanged(run)
        }
      }
    })
    for (const event of projectEvents.values()) this.notifications.project(event)
    for (const id of changed) this.notifications.session(id)
    if (commandsChanged || changed.size) this.notifications.commands(workerId)
    return replies
  }
}
