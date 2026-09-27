import assert from 'node:assert/strict'
import test from 'node:test'
import { TerminalManager, type PtyAdapter, type PtyProcess } from '../src/terminal/terminal-manager.js'

class FakeProcess implements PtyProcess {
  readonly pid = 42
  writes: string[] = []
  sizes: Array<[number, number]> = []
  killed = false
  data?: (value: string) => void
  exited?: (event: { exitCode: number; signal?: number }) => void
  write(data: string) { this.writes.push(data) }
  resize(cols: number, rows: number) { this.sizes.push([cols, rows]) }
  kill() { this.killed = true }
  onData(listener: (data: string) => void) { this.data = listener; return { dispose: () => { this.data = undefined } } }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void) { this.exited = listener; return { dispose: () => { this.exited = undefined } } }
}

class FakePty implements PtyAdapter {
  readonly processes: FakeProcess[] = []
  spawn() { const process = new FakeProcess(); this.processes.push(process); return process }
}

test('terminal manager owns lifecycle, resize and output forwarding', () => {
  const pty = new FakePty(), output: unknown[] = [], exits: unknown[] = []
  const manager = new TerminalManager(pty, event => output.push(event), event => exits.push(event))
  const created = manager.create({ sessionId: 'session-1', cwd: '/workspace', cols: 80, rows: 24 })
  const child = pty.processes[0]!
  manager.write('session-1', created.terminalId, 'ls\r')
  manager.resize('session-1', created.terminalId, 120, 40)
  child.data?.('files\r\n')
  assert.deepEqual(child.writes, ['ls\r'])
  assert.deepEqual(child.sizes, [[120, 40]])
  assert.deepEqual(output, [{ terminalId: created.terminalId, data: 'files\r\n' }])
  child.exited?.({ exitCode: 0 })
  assert.deepEqual(exits, [{ terminalId: created.terminalId, exitCode: 0, signal: null }])
  assert.throws(() => manager.write('session-1', created.terminalId, 'x'), /Terminal not found/)
})

test('terminal manager enforces per-session limit and disposes children', () => {
  const pty = new FakePty()
  const manager = new TerminalManager(pty, () => undefined, () => undefined, 2)
  const first = manager.create({ sessionId: 'session-1', cwd: '/workspace', cols: 80, rows: 24 })
  manager.create({ sessionId: 'session-1', cwd: '/workspace', cols: 80, rows: 24 })
  assert.throws(() => manager.create({ sessionId: 'session-1', cwd: '/workspace', cols: 80, rows: 24 }), /Terminal limit reached \(2\)/)
  manager.dispose('session-1', first.terminalId)
  assert.equal(pty.processes[0]!.killed, true)
  assert.throws(() => manager.dispose('other', pty.processes.length.toString()), /Terminal not found/)
})
