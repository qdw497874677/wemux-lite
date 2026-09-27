import { randomUUID } from 'node:crypto'

export interface PtyProcess {
  readonly pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  onData(listener: (data: string) => void): { dispose(): void }
  onExit(listener: (event: { readonly exitCode: number; readonly signal?: number }) => void): { dispose(): void }
}

export interface PtyAdapter {
  spawn(file: string, args: readonly string[], options: {
    readonly name: string
    readonly cols: number
    readonly rows: number
    readonly cwd: string
    readonly env: Record<string, string>
  }): PtyProcess
}

export interface TerminalOutput {
  readonly terminalId: string
  readonly data: string
}

export interface TerminalExit {
  readonly terminalId: string
  readonly exitCode: number
  readonly signal: number | null
}

interface TerminalRecord {
  readonly sessionId: string
  readonly process: PtyProcess
  readonly subscriptions: readonly { dispose(): void }[]
}

export class TerminalManager {
  private readonly terminals = new Map<string, TerminalRecord>()

  constructor(
    private readonly pty: PtyAdapter,
    private readonly output: (event: TerminalOutput) => void,
    private readonly exit: (event: TerminalExit) => void,
    private readonly maxPerSession = 5,
  ) {}

  create(input: { readonly sessionId: string; readonly cwd: string; readonly cols: number; readonly rows: number }): { readonly terminalId: string; readonly pid: number } {
    const count = [...this.terminals.values()].filter(value => value.sessionId === input.sessionId).length
    if (count >= this.maxPerSession) throw new Error(`Terminal limit reached (${this.maxPerSession})`)
    const terminalId = randomUUID()
    const shell = process.env.SHELL || 'bash'
    const child = this.pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: input.cols,
      rows: input.rows,
      cwd: input.cwd,
      env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    })
    const subscriptions = [
      child.onData(data => this.output({ terminalId, data })),
      child.onExit(event => {
        this.disposeRecord(terminalId, false)
        this.exit({ terminalId, exitCode: event.exitCode, signal: event.signal ?? null })
      }),
    ]
    this.terminals.set(terminalId, { sessionId: input.sessionId, process: child, subscriptions })
    return { terminalId, pid: child.pid }
  }

  write(sessionId: string, terminalId: string, data: string): void {
    this.require(sessionId, terminalId).process.write(data)
  }

  resize(sessionId: string, terminalId: string, cols: number, rows: number): void {
    this.require(sessionId, terminalId).process.resize(cols, rows)
  }

  dispose(sessionId: string, terminalId: string): void {
    this.require(sessionId, terminalId)
    this.disposeRecord(terminalId, true)
  }

  disposeSession(sessionId: string): void {
    for (const [terminalId, record] of this.terminals) if (record.sessionId === sessionId) this.disposeRecord(terminalId, true)
  }

  disposeAll(): void {
    for (const terminalId of [...this.terminals.keys()]) this.disposeRecord(terminalId, true)
  }

  private require(sessionId: string, terminalId: string): TerminalRecord {
    const record = this.terminals.get(terminalId)
    if (!record || record.sessionId !== sessionId) throw new Error('Terminal not found')
    return record
  }

  private disposeRecord(terminalId: string, kill: boolean): void {
    const record = this.terminals.get(terminalId)
    if (!record) return
    this.terminals.delete(terminalId)
    for (const subscription of record.subscriptions) subscription.dispose()
    if (kill) record.process.kill()
  }
}

export async function loadNodePty(): Promise<PtyAdapter | null> {
  try {
    const module = await import('node-pty')
    return { spawn: (file, args, options) => module.spawn(file, [...args], options) }
  } catch {
    return null
  }
}
