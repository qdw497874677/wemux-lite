import { TaskService } from './application/task-service.js'
import { createServer } from 'node:http'
import { SqliteServerStore } from './storage/sqlite/store.js'
import { AuthenticationService } from './application/auth.js'
import { CapabilityService } from './application/capability-service.js'
import { CapabilityTokenService } from './application/capability-token-service.js'
import { now } from './application/server-service.js'
import { Notifications } from './application/notifications.js'
import { ServerService } from './application/server-service.js'
import { WorkerService } from './application/worker-service.js'
import { httpHandler } from './http/handler.js'
import { SessionStreams } from './http/sse.js'
import { ProjectStreams } from './http/project-sse.js'
import type { StaticSite } from './http/static.js'
import { WorkerGateway } from './worker-ws/gateway.js'

export function createWemuxServer(options: { databasePath: string; bootstrapToken: string; capabilitySecret?: string; workerPackagePath?: string; webStaticPath?: string; adminSessionTtlMs?: number }) {
  const store = new SqliteServerStore(options.databasePath)
  const auth = new AuthenticationService(store, options.bootstrapToken)
  const notifications = new Notifications()
  const capabilitySecret = options.capabilitySecret ?? process.env.WEMUX_CAPABILITY_SECRET ?? options.bootstrapToken.padEnd(32, '#')
  const capabilities = new CapabilityService(store, now, new CapabilityTokenService(capabilitySecret, now))
  const service = new ServerService(store, notifications, capabilities)
  const streams = new SessionStreams(service)
  const projectStreams = new ProjectStreams(notifications)
  let gateway: WorkerGateway | undefined
  const server = createServer(httpHandler(service, auth, streams, capabilities, options.workerPackagePath ? { tarballPath: options.workerPackagePath } : undefined, { disconnectWorker: id => gateway?.disconnect(id) }, options.webStaticPath ? { root: options.webStaticPath } : undefined, options.adminSessionTtlMs, new TaskService(store, event => notifications.project(event), service), projectStreams))
  const workers = new WorkerService(store, notifications)
  gateway = new WorkerGateway(server, auth, workers, notifications)
  let closed = false
  return {
    server,
    async listen(port = 3001, host = '127.0.0.1') {
      await workers.recoverRuns()
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => { server.off('error', reject); resolve() })
      })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('No TCP address')
      return `http://${host}:${address.port}`
    },
    async close() {
      if (closed) return
      closed = true
      streams.close()
      projectStreams.close()
      await gateway.close()
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      store.close()
    },
  }
}
