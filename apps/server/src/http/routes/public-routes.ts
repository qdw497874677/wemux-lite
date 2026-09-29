import type { CapabilityToolName } from '@wemux/domain'
import { AppError } from '../../application/errors.ts'
import { serveWorkerDownload } from '../worker-downloads.ts'
import type { RouteDescriptor } from './types.ts'

export const publicRoutes: readonly RouteDescriptor[] = [
  { method: 'GET', pattern: '/health', auth: 'public', handler: ({ json }) => json(200, { status: 'ok' }) },
  { method: 'GET', pattern: '/host', auth: 'public', handler: ({ json }) => json(200, { hostKind: 'cluster', contractVersion: 1, capabilities: ['cluster-session', 'projects', 'workers'] }) },
  {
    method: 'GET', pattern: '/downloads/worker.tgz', auth: 'public', handler: async ({ response, path, downloads }) => {
      if (!await serveWorkerDownload(response, path, downloads)) throw new AppError(404, 'Not found')
    },
  },
  {
    method: 'GET', pattern: '/downloads/worker-manifest.json', auth: 'public', handler: async ({ response, path, downloads }) => {
      if (!await serveWorkerDownload(response, path, downloads)) throw new AppError(404, 'Not found')
    },
  },
  {
    method: 'GET', pattern: '/downloads/install-worker.sh', auth: 'public', handler: async ({ response, path, downloads }) => {
      if (!await serveWorkerDownload(response, path, downloads)) throw new AppError(404, 'Not found')
    },
  },
  { method: 'POST', pattern: '/workers/enroll', auth: 'public', handler: async ({ service, readBody, json }) => json(201, await service.enroll(await readBody())) },
  {
    method: 'DELETE', pattern: '/workers/:workerId/enrollment', auth: 'worker', handler: async ({ request, auth, service, control, params, response }) => {
      const header = request.headers.authorization
      const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined
      const workerId = await auth.authenticateWorker(token)
      if (workerId !== params.workerId) throw new AppError(403, 'Forbidden')
      await service.leaveWorker(workerId, id => control?.disconnectWorker(id))
      response.writeHead(204).end()
    },
  },
  {
    method: 'POST', pattern: '/agent-capabilities/:operation', auth: 'capability', handler: async ({ request, capabilities, params, readBody, json }) => {
      if (!capabilities) throw new AppError(503, 'Agent capabilities are disabled')
      const header = request.headers.authorization
      const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined
      if (!token) throw new AppError(401, 'Missing capability token')
      const operation = params.operation as CapabilityToolName
      const input = await readBody() as any
      const claims = await capabilities.verify(token, operation)
      const result = operation === 'session.info' ? await capabilities.sessionInfo(claims)
        : operation === 'agent.list' ? await capabilities.listAgents(claims)
        : operation === 'agent.send' ? await capabilities.sendAgentMessage(claims, input)
        : operation === 'agent.inbox.list' ? await capabilities.listInbox(claims, input)
        : operation === 'agent.inbox.read' ? await capabilities.readInbox(claims, input)
        : operation === 'delegation.accept' ? await capabilities.acceptDelegation(claims, input)
        : operation === 'delegation.reject' ? await capabilities.rejectDelegation(claims, input)
        : operation === 'delegation.complete' ? await capabilities.completeDelegation(claims, input)
        : (() => { throw new AppError(404, 'Capability not found') })()
      json(200, result)
    },
  },
]
