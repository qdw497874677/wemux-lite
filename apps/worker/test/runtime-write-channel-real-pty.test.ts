import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { SessionId } from '@wemux/domain'
import type { TerminalRequestPayload, WorkerToServer } from '@wemux/wire-protocol'
import { WorkerRuntime } from '../src/application/runtime.ts'
import { SqliteWorkerStore } from '../src/storage/sqlite-store.ts'
import { loadNodePty, TerminalManager, type PtyAdapter } from '../src/terminal/terminal-manager.ts'

test('real OS PTY remains alive and untouched by direct terminal operations, then shutdown reaps it', async t => {
  const actual = await loadNodePty()
  if (!actual) {
    // 计入 skipped 而非 pass：真实 node-pty 不可用时 OS PTY 行为未被验证，不得让计数掩盖这个空洞。
    // 无条件的内存与 CLI 合同测试仍然必须运行（见 runtime-write-channel-closed.test.ts / worker-write-channel-replay.test.ts）。
    t.skip('Real node-pty unavailable: OS PTY behavior not proven; unconditional memory and CLI tests remain required')
    return
  }
  const home = await mkdtemp(join(tmpdir(), 'write-closed-real-pty-'))
  const store = new SqliteWorkerStore(':memory:'), sent: WorkerToServer[] = []
  const calls = { spawn: 0, write: 0, resize: 0, kill: 0, dispose: 0 }
  let exited = false
  const pty: PtyAdapter = { spawn: (_file, _args, options) => {
    calls.spawn++
    const process = actual.spawn('/bin/sh', [], { ...options, env: { PATH: '/usr/bin:/bin', HOME: home, HISTFILE: '/dev/null', TERM: 'xterm' } })
    process.onExit(() => { exited = true })
    return { pid: process.pid, write: data => { calls.write++; process.write(data) }, resize: (cols, rows) => { calls.resize++; process.resize(cols, rows) },
      kill: () => { calls.kill++; process.kill() },
      onData: listener => { const subscription = process.onData(listener); return { dispose: () => { calls.dispose++; subscription.dispose() } } },
      onExit: listener => { const subscription = process.onExit(listener); return { dispose: () => { calls.dispose++; subscription.dispose() } } } }
  } }
  const runtime = new WorkerRuntime(store, { provision: async () => { throw Error('unexpected provision') } }, [], { send: message => { sent.push(message) } }, 'real-pty-worker' as never, 'real-pty', undefined, undefined, undefined, pty)
  const internals = runtime as unknown as { terminals: TerminalManager; terminalSessions: Map<string, SessionId> }
  const sessionId = 'real-pty-session' as SessionId
  const created = internals.terminals.create({ sessionId, cwd: home, cols: 80, rows: 24 })
  internals.terminalSessions.set(created.terminalId, sessionId)
  t.after(async () => {
    await runtime.shutdown()
    for (let i = 0; i < 100 && !exited; i++) await delay(10)
    assert.equal(exited, true)
    assert.throws(() => process.kill(created.pid, 0), { code: 'ESRCH' })
    t.diagnostic(`real PTY pid=${created.pid}; remaining=0`)
    store.close(); await rm(home, { recursive: true, force: true })
  })
  const requests: TerminalRequestPayload[] = [
    { type: 'terminal.request', requestId: 'create', sessionId, operation: 'create', cols: 80, rows: 24 },
    { type: 'terminal.request', requestId: 'write', sessionId, operation: 'write', terminalId: created.terminalId, data: 'touch forbidden-marker\r' },
    { type: 'terminal.request', requestId: 'resize', sessionId, operation: 'resize', terminalId: created.terminalId, cols: 120, rows: 40 },
    { type: 'terminal.request', requestId: 'dispose', sessionId, operation: 'dispose', terminalId: created.terminalId },
  ]
  for (const request of requests) {
    await runtime.receive(request)
    assert.deepEqual(sent.find(message => message.type === 'terminal.response' && message.requestId === request.requestId), { type: 'terminal.response', requestId: request.requestId, ok: false, error: 'write_channel_closed: 平台当前未开放文件和终端写入通道。' })
    assert.deepEqual(calls, { spawn: 1, write: 0, resize: 0, kill: 0, dispose: 0 })
    assert.equal(exited, false); process.kill(created.pid, 0)
    assert.deepEqual([...internals.terminalSessions], [[created.terminalId, sessionId]])
    assert.deepEqual(await readdir(home), [])
  }
  await runtime.shutdown()
  assert.equal(calls.kill, 1); assert.equal(calls.dispose, 2)
})
