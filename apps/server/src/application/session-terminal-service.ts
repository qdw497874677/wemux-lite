import { randomUUID } from 'node:crypto'
import type { SessionId, WorkerId } from '@wemux/domain'
import type { TerminalRequestPayload, TerminalResponsePayload } from '@wemux/wire-protocol'
import { AppError } from './errors.ts'
import type { ServerService } from './server-service.ts'
import type { WorkerService } from './worker-service.ts'

export interface WorkerTerminalGateway {
  send(workerId: WorkerId, payload: TerminalRequestPayload): Promise<void>
}

type TerminalInput =
  | { readonly operation: 'create'; readonly cols: number; readonly rows: number }
  | { readonly operation: 'write'; readonly terminalId: string; readonly data: string }
  | { readonly operation: 'resize'; readonly terminalId: string; readonly cols: number; readonly rows: number }
  | { readonly operation: 'dispose'; readonly terminalId: string }

export class SessionTerminalService {
  private readonly sessions: ServerService
  private readonly workers: WorkerService
  private readonly gateway: WorkerTerminalGateway
  private readonly timeoutMs: number
  constructor(
    sessions: ServerService,
    workers: WorkerService,
    gateway: WorkerTerminalGateway,
    timeoutMs = 10_000,
  ) { this.sessions = sessions; this.workers = workers; this.gateway = gateway; this.timeoutMs = timeoutMs;}

  request(sessionId: SessionId, input: TerminalInput): Promise<TerminalResponsePayload> {
    return this.perform(sessionId, input)
  }

  private async perform(sessionId: SessionId, input: TerminalInput): Promise<TerminalResponsePayload> {
    const session = await this.sessions.getSession(sessionId)
    const workerId = session.binding.agent.workerId
    const requestId = randomUUID()
    const pending = this.workers.registerTerminalRequest(requestId, workerId)
    let timeoutHandle: NodeJS.Timeout | undefined
    try {
      await this.gateway.send(workerId, { type: 'terminal.request', requestId, sessionId, ...input } as TerminalRequestPayload)
      const timeout = new Promise<never>((_, reject) => { timeoutHandle = setTimeout(() => reject(new AppError(504, 'Worker terminal request timed out')), this.timeoutMs) })
      const response = await Promise.race([pending.promise, timeout])
      if (!response.ok) throw new AppError(response.error.includes('unavailable') ? 503 : 400, response.error)
      return response
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      pending.cancel()
    }
  }
}
