import { DatabaseSync } from 'node:sqlite'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { WorkerId } from '@wemux/domain'
import { WorkerRuntime } from '../../worker/src/application/runtime.ts'
import { SqliteWorkerStore } from '../../worker/src/storage/sqlite-store.ts'
import { LocalProvisioner } from '../../worker/src/workspaces/local-provisioner.ts'
import { WebSocketTransport } from '../../worker/src/transport/websocket.ts'
import { WorkerTransportStore } from '../../worker/src/transport/transport-store.ts'

/** Real runtime + durable WebSocket transport + Git/filesystem provisioner, with no Agent adapters.
 * The only fixture seam is ownership/lifecycle wiring, as in worker.test.ts; reports are not injected. */
export async function startWorkspaceWorker(options: { home: string; origin: string; workerId: string; credential: string; name: string }) {
  await mkdir(options.home, { recursive: true, mode: 0o700 })
  const store = new SqliteWorkerStore(join(options.home, 'worker.sqlite'))
  const queue = new WorkerTransportStore(join(options.home, 'transport.sqlite'))
  // Observe the real durable queue and ACK seam; never inject reports or acknowledgments.
  const observer = new DatabaseSync(join(options.home, 'transport.sqlite'), { readOnly: true })
  const reports: { workspaceId: string; commandId: string; epoch: string; seq: number }[] = []
  const acknowledgments = new Map<string, number>()
  const enqueue = queue.enqueue.bind(queue), acknowledge = queue.acknowledgeOutbound.bind(queue)
  queue.enqueue = payload => {
    const result = enqueue(payload) // Existing enqueue commits synchronously before returning its Promise.
    if (payload.type === 'event' && payload.scope === 'workspace' && payload.report.commandId) {
      const row = observer.prepare('SELECT seq FROM transport_outbox ORDER BY seq DESC LIMIT 1').get()
      const epoch = observer.prepare("SELECT value FROM transport_meta WHERE key='outbound_epoch'").get()
      if (!row || !epoch) throw Error('Owned fixture report queue observation missing')
      reports.push({ workspaceId: payload.report.workspaceId, commandId: payload.report.commandId, seq: Number(row.seq), epoch: String(epoch.value) })
    }
    return result
  }
  queue.acknowledgeOutbound = async frame => {
    await acknowledge(frame)
    acknowledgments.set(frame.deliveryEpoch, Math.max(acknowledgments.get(frame.deliveryEpoch) ?? 0, frame.ackThrough))
  }
  const pending = new Set<Promise<void>>()
  const failures: string[] = []
  const track = (work: Promise<void>, label: string) => {
    const observed = work.catch(() => { failures.push(label) }).finally(() => pending.delete(observed))
    pending.add(observed)
    return observed
  }
  let transport: WebSocketTransport
  const runtime = new WorkerRuntime(store, new LocalProvisioner(join(options.home, 'workspaces')), [], {
    send: payload => track(transport.send(payload), 'runtime-send'),
  }, options.workerId as WorkerId, options.name)
  transport = new WebSocketTransport({
    url: `${options.origin.replace(/^http/, 'ws')}/worker/ws`, authToken: options.credential,
    workerId: options.workerId as WorkerId, workerVersion: 'private-current-source', name: options.name,
    platform: process.platform, architecture: process.arch,
    store: queue,
    onMessage: payload => { void track(runtime.receive(payload), 'runtime-receive') },
    onConnected: () => { void track(runtime.connected(), 'runtime-connected') },
    onNotice: () => { failures.push('transport-notice') },
  })
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    transport.stop()
    await runtime.shutdown() // Aborts owned Git child if provisioning is still in progress.
    while (pending.size) await Promise.all([...pending])
  }
  try { await runtime.initialize(); transport.start() }
  catch (error) { await stop(); observer.close(); queue.close(); store.close(); throw error }
  return {
    failures,
    reportCheckpoint() { return reports.length },
    async waitForReportAcknowledgment(workspaceId: string, commandId: string, after: number) {
      for (let attempt = 0; attempt < 200; attempt++) {
        if (failures.length) throw Error('Owned Worker fixture reported an asynchronous failure')
        const report = reports.slice(after).find(value => value.workspaceId === workspaceId && value.commandId === commandId)
        if (report && (acknowledgments.get(report.epoch) ?? 0) >= report.seq) return { workerId: options.workerId, ...report, ackThrough: acknowledgments.get(report.epoch)! }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      throw Error('Relevant correlated Workspace report was not durably acknowledged')
    },
    disconnect() { transport.stop() },
    reconnect() { transport.start() },
    stop,
    // Called after all transports stop and Server closes its sockets; no SQLite close races.
    closeStores() { observer.close(); queue.close(); store.close() },
  }
}
