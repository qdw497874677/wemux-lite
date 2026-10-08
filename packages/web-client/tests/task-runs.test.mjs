import test from 'node:test'
import assert from 'node:assert/strict'
import { PendingTaskRun, PendingRunCancellation, createClusterClient } from '@wemux/web-client'
const scope = { host: 'http://host.test', account: 'owner', teamId: 'team', projectId: 'p', taskId: 't' }
const intent = { mode: 'new', reuseSessionId: null, prompt: 'Implement goal', assignment: { workspaceId: 'w', workerId: 'worker', agentKey: 'test', modelId: 'model' } }
const store = () => { const entries = new Map(); return { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key) } }
const run = body => ({ id: 'run', projectId: 'p', taskId: 't', requestId: body.requestId, attempt: 1, sessionId: 's', snapshot: body.assignment, status: 'pending', request: body, resultSummary: null, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, cancelRequestedAt: null })
const account = { username: 'owner', teamId: 'team', csrfToken: 'csrf', email: null, instanceAdministrator: false }
test('Run API uses project-scoped authenticated transport and encoded routes', async () => {
  const calls = [], api = createClusterClient(account, () => {}, { origin: scope.host, fetcher: async (url, init) => { calls.push([url, init]); const body = init.body ? JSON.parse(init.body) : null; return Response.json(url.pathname.endsWith('/cancel') ? { run: run({ requestId: 'cancel' }) } : url.pathname.endsWith('/launch') ? { run: run(body) } : { items: [run({ requestId: 'start' })] }) } })
  assert.equal((await api.taskRuns('p/x', 't/y')).length, 1)
  assert.equal(calls[0][0].pathname, '/api/projects/p%2Fx/tasks/t%2Fy/runs')
  assert.equal((await api.launchTask('p', 't', { ...intent, requestId: 'start' })).run.id, 'run')
  assert.equal(calls[1][1].headers['X-CSRF-Token'], 'csrf')
  assert.equal(calls[1][1].credentials, 'same-origin')
  assert.deepEqual(JSON.parse(calls[1][1].body), { ...intent, requestId: 'start' })
  await api.cancelTaskRun('p', 't', 'run/x', 's', 'cancel')
  assert.equal(calls[2][0].pathname, '/api/projects/p/tasks/t/runs/run%2Fx/cancel')
  assert.deepEqual(JSON.parse(calls[2][1].body), { runId: 'run/x', sessionId: 's', requestId: 'cancel' })
})
test('cancel identity survives response loss and refresh, cannot settle unchanged Run, and scopes away other users', async () => {
  const storage = store(), target = { ...scope, runId: 'run', sessionId: 's' }
  const first = new PendingRunCancellation(() => storage, target, () => 'stable-cancel')
  await assert.rejects(first.run(async id => { assert.equal(id, 'stable-cancel'); throw Error('lost') }), /lost/)
  assert.equal(first.read(), 'stable-cancel')
  const refreshed = new PendingRunCancellation(() => storage, target, () => 'new-cancel')
  assert.equal(refreshed.read(), 'stable-cancel')
  await assert.rejects(refreshed.run(async id => ({ run: { ...run({ requestId: id }), status: 'pending' } })), /不符/)
  assert.equal(refreshed.read(), 'stable-cancel')
  for (const malformed of [{ status: 'cancelled', cancelRequestedAt: null }, { status: 'cancelling', cancelRequestedAt: 'whenever' }]) {
    await assert.rejects(refreshed.run(async id => ({ run: { ...run({ requestId: id }), ...malformed } })), /不符/)
    assert.equal(refreshed.read(), 'stable-cancel')
  }
  const accepted = await refreshed.run(async id => ({ run: { ...run({ requestId: id }), status: 'cancelling', cancelRequestedAt: new Date().toISOString() } }))
  assert.equal(accepted.run.status, 'cancelling')
  assert.equal(refreshed.read(), null)
  assert.equal(new PendingRunCancellation(() => storage, { ...target, account: 'other' }).read(), null)
})
test('cancel identity fails closed on blocked storage and coalesces same-scope requests', async () => {
  const storage = store(), target = { ...scope, runId: 'run', sessionId: 's' }
  const a = new PendingRunCancellation(() => storage, target, () => 'same'), b = new PendingRunCancellation(() => storage, target)
  let finish, calls = 0
  const one = a.run(async id => { calls++; await new Promise(resolve => { finish = resolve }); return { run: { ...run({ requestId: id }), status: 'cancelled', cancelRequestedAt: new Date().toISOString() } } })
  const two = b.run(() => assert.fail('must not send twice'))
  assert.equal(one, two)
  await new Promise(resolve => setImmediate(resolve)); finish(); await one
  assert.equal(calls, 1)
  const broken = new PendingRunCancellation(() => ({ getItem: () => null, setItem: () => {}, removeItem: () => {} }), target)
  await assert.rejects(broken.run(() => assert.fail('must not send')), /保存/)
})
test('completion-winning cancellation race is definitive without claiming request acceptance', async () => {
  const storage = store(), target = { ...scope, runId: 'run', sessionId: 's' }
  const pending = new PendingRunCancellation(() => storage, target, () => 'terminal-race')
  const result = await pending.run(async id => ({ run: { ...run({ requestId: id }), status: 'succeeded' } }))
  assert.equal(result.run.cancelRequestedAt, null)
  assert.equal(pending.read(), null)
})
test('lost Run reply and same-tab refresh replay the exact persisted identity, not changed form input', async () => {
  const storage = store(), calls = [], pending = new PendingTaskRun(() => storage, scope, () => 'stable')
  const first = pending.run(() => intent, async body => { calls.push(body); throw Error('lost response') })
  await assert.rejects(first, /lost response/)
  assert.deepEqual(pending.read(), { ...intent, requestId: 'stable' })
  const retry = new PendingTaskRun(() => storage, scope, () => 'different')
  const result = await retry.run(() => { throw Error('new intent must not run') }, async body => { calls.push(body); return { run: run(body) } })
  assert.equal(result.run.id, 'run')
  assert.deepEqual(calls[1], calls[0]); assert.equal(retry.read(), null)
})
test('duplicate clicks coalesce, scope partitions identity and unknown persistence fails before send', async () => {
  const storage = store(), a = new PendingTaskRun(() => storage, scope, () => 'r1'), b = new PendingTaskRun(() => storage, scope)
  let release, calls = 0
  const first = a.run(() => new Promise(resolve => { release = resolve }), async body => { calls++; return { run: run(body) } })
  const second = b.run(() => { throw Error('second evaluated') }, async () => { throw Error('second sent') })
  assert.equal(first, second)
  await new Promise(resolve => setImmediate(resolve)); release(intent); await first
  assert.equal(calls, 1)
  assert.equal(new PendingTaskRun(() => storage, { ...scope, account: 'other' }).read(), null)
  const broken = new PendingTaskRun(() => ({ getItem: () => null, setItem: () => {}, removeItem: () => {} }), scope)
  await assert.rejects(broken.run(() => intent, () => { assert.fail('no send') }), /保存/)
})
test('oversize multibyte and NUL Run prompts are rejected before storage or HTTP; empty model is invalid', async () => {
  for (const changed of [
    { prompt: '中'.repeat(70000) },
    { prompt: 'before\0after' },
    { assignment: { ...intent.assignment, modelId: null } },
  ]) {
    const storage = store(), pending = new PendingTaskRun(() => storage, scope)
    await assert.rejects(pending.run(() => ({ ...intent, ...changed }), () => { assert.fail('must not send') }), /目标或执行环境/)
    assert.equal(pending.read(), null)
  }
})
test('malformed launch success retains original identity and replacement storage cannot be overwritten by stale settlement', async () => {
  const storage = store(), pending = new PendingTaskRun(() => storage, scope, () => 'old')
  await assert.rejects(pending.run(() => intent, async body => ({ run: { requestId: body.requestId } })), /不符/)
  assert.equal(pending.read().requestId, 'old')
  let release
  const older = pending.run(() => { assert.fail('no new intent') }, async body => { await new Promise(resolve => { release = resolve }); return { run: run(body) } })
  await new Promise(resolve => setImmediate(resolve))
  const replacement = { ...intent, requestId: 'new' }
  storage.setItem(pending.key, JSON.stringify(replacement))
  release(); await older
  assert.equal(pending.read().requestId, 'new', 'settling the older operation cannot remove a different retained request')
})
test('identity mismatch never erases original Run request and invalid stored payload fails closed', async () => {
  const storage = store(), pending = new PendingTaskRun(() => storage, scope, () => 'r1')
  await assert.rejects(pending.run(() => intent, async body => ({ run: run({ ...body, requestId: 'another' }) })), /不符/)
  assert.equal(pending.read().requestId, 'r1')
  storage.setItem(pending.key, JSON.stringify({ ...intent, requestId: 'r1', extra: 'unsafe' }))
  await assert.rejects(pending.run(() => intent, () => { assert.fail('no send') }), /读取/)
})
