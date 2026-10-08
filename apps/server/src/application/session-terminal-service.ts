import type { SessionId, UserId, WorkerId } from '@wemux/domain'
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
  constructor(
    _sessions: ServerService,
    _workers: WorkerService,
    _gateway: WorkerTerminalGateway,
    _timeoutMs = 10_000,
  ) {}

  async request(_sessionId: SessionId, _input: TerminalInput, _actor?: UserId): Promise<TerminalResponsePayload> {
    // Keep the service boundary closed too: HTTP is not the only possible caller.
    throw new AppError(403, '平台当前未开放文件和终端写入通道。', 'write_channel_closed')
  }
}
