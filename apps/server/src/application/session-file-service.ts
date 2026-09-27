import { randomUUID } from 'node:crypto'
import type { SessionId } from '@wemux/domain'
import type { FileRequestPayload, FileResponsePayload } from '@wemux/wire-protocol'
import { AppError } from './errors.js'
import type { ServerService } from './server-service.js'
import type { WorkerService } from './worker-service.js'

export interface WorkerFileGateway {
  send(workerId: import('@wemux/domain').WorkerId, payload: FileRequestPayload): Promise<void>
}

export class SessionFileService {
  constructor(
    private readonly sessions: ServerService,
    private readonly workers: WorkerService,
    private readonly gateway: WorkerFileGateway,
    private readonly timeoutMs = 10_000,
  ) {}

  async list(sessionId: SessionId, subpath: string): Promise<Extract<FileResponsePayload, { ok: true; operation: 'list' }>> {
    return this.request(sessionId, { operation: 'list', subpath }) as Promise<Extract<FileResponsePayload, { ok: true; operation: 'list' }>>
  }

  async read(sessionId: SessionId, subpath: string, maxBytes: number): Promise<Extract<FileResponsePayload, { ok: true; operation: 'read' }>> {
    return this.request(sessionId, { operation: 'read', subpath, maxBytes }) as Promise<Extract<FileResponsePayload, { ok: true; operation: 'read' }>>
  }

  async diff(sessionId: SessionId, subpath: string): Promise<Extract<FileResponsePayload, { ok: true; operation: 'diff' }>> {
    return this.request(sessionId, { operation: 'diff', subpath }) as Promise<Extract<FileResponsePayload, { ok: true; operation: 'diff' }>>
  }

  private async request(sessionId: SessionId, input: { readonly operation: 'list'; readonly subpath: string } | { readonly operation: 'read'; readonly subpath: string; readonly maxBytes: number } | { readonly operation: 'diff'; readonly subpath: string }): Promise<FileResponsePayload> {
    const session = await this.sessions.getSession(sessionId)
    const workerId = session.binding.agent.workerId
    const requestId = randomUUID()
    const pending = this.workers.registerFileRequest(requestId, workerId)
    let timeoutHandle: NodeJS.Timeout | undefined
    try {
      await this.gateway.send(workerId, { type: 'fs.request', requestId, sessionId, ...input })
      const timeout = new Promise<never>((_, reject) => { timeoutHandle = setTimeout(() => reject(new AppError(504, 'Worker file request timed out')), this.timeoutMs) })
      const response = await Promise.race([pending.promise, timeout])
      if (!response.ok) throw new AppError(400, response.error)
      return response
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      pending.cancel()
    }
  }
}
