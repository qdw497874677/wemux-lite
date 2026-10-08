import test from 'node:test'
import assert from 'node:assert/strict'
import { createClusterClient, PendingTaskSession, ApiError } from '@wemux/web-client'
const account = { username: 'owner', teamId: 'team', csrfToken: 'csrf', email: null, instanceAdministrator: false }
const scope = { host: 'http://host.test', account: 'owner', teamId: 'team', projectId: 'p', taskId: 't' }
const intent = { title: '标题', workspaceId: 'w', workerId: 'worker', agentKey: 'test', modelId: 'model' }
const response = (body, created = true) => ({ session: { id: 's', projectId: 'p', taskId: 't', runId: null, ownerId: 'owner', workspaceId: body.workspaceId ?? 'w', title: body.title, shareScope: 'project', binding: { workspaceId: body.workspaceId ?? 'w', agent: { workerId: body.workerId ?? 'worker', agentKey: body.agentKey ?? 'test' }, modelId: body.modelId ?? 'model' }, runtimeState: 'idle', deletedAt: null, creation: { requestId: body.requestId, commandId: 'command', fingerprint: 'fp' } }, commandId: 'command', created })
const storage = () => { const map = new Map(); return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) } }
const client = fetcher => createClusterClient(account, () => {}, { origin: scope.host, fetcher })

test('Task Session POST and discovery reuse transport, encoded path, CSRF, filters and actual response shape', async () => {
  const calls = []; const body = { ...intent, requestId: 'request' }
  const view = { ...response(body).session, access: { canRead: true, canWrite: true, canControl: true, projectRole: 'owner' }, queuedMessages: [], activeTurnId: null, activeTurnOwnerId: null, freshness: { status: 'unknown', sessionId: 's', contiguousSeq: 0, workerLastSeq: null }, sendCapability: { allowed: true, reason: '', reasonCode: 'allowed' } }
  const api = client(async (url, init) => { calls.push({ url, init }); return Response.json(init.method === 'POST' ? response(JSON.parse(init.body)) : { items: [view] }) })
  assert.equal((await api.createTaskSession('p', 't', body)).created, true)
  assert.deepEqual(JSON.parse(calls[0].init.body), body)
  assert.equal(calls[0].init.headers['X-CSRF-Token'], 'csrf'); assert.equal(calls[0].init.credentials, 'same-origin')
  assert.deepEqual(await api.taskSessions('p', 't', { projectId: 'p', taskId: 't', workspaceId: 'w', archived: false }), [view])
  assert.equal(calls[1].url.pathname, '/api/projects/p/tasks/t/sessions')
  assert.deepEqual(Object.fromEntries(calls[1].url.searchParams), { projectId: 'p', taskId: 't', workspaceId: 'w', archived: 'false', teamId: 'team' })
  await assert.rejects(api.taskSessions('p/x', 't/x'), e => e.kind === 'contract')
  assert.equal(calls[2].url.pathname, '/api/projects/p%2Fx/tasks/t%2Fx/sessions')
  await api.createTaskSession('p', 't', { title: 'Fallback', requestId: 'fallback' })
  assert.deepEqual(JSON.parse(calls[3].init.body), { title: 'Fallback', requestId: 'fallback' })
})
test('malformed success/list and HTTP conflict preserve errors rather than fabricated results', async () => {
  for (const bad of [{}, { session: { id: 's' }, created: true, commandId: 'c' }, { ...response({ ...intent, requestId: 'other' }) }, { ...response({ ...intent, requestId: 'r' }), created: 'yes' }]) {
    await assert.rejects(client(async () => Response.json(bad)).createTaskSession('p', 't', { ...intent, requestId: 'r' }), e => e instanceof ApiError && e.kind === 'contract')
  }
  for (const bad of [{}, { items: [{}] }, { items: [response({ ...intent, requestId: 'r' }).session] }]) await assert.rejects(client(async () => Response.json(bad)).taskSessions('p', 't'), e => e.kind === 'contract')
  await assert.rejects(client(async () => Response.json({ error: { code: 'request_id_conflict', message: '请求冲突' } }, { status: 409 })).createTaskSession('p', 't', { ...intent, requestId: 'r' }), e => e.status === 409 && e.code === 'request_id_conflict')
})
test('lost response, duplicate clicks, refresh and changed inputs retain the immutable persisted request; success permits next intent', async () => {
  const store = storage(), calls = []; let release, fail = true, mint = 0
  const api = client(async (_url, init) => {
    const body = JSON.parse(init.body); calls.push(body)
    assert.deepEqual(JSON.parse(store.getItem(pending.key)), body, 'persisted before send')
    if (fail) { await new Promise(r => { release = r }); throw Error('lost response') }
    return Response.json(response(body, false))
  })
  let pending = new PendingTaskSession(() => store, scope, () => `r${++mint}`)
  const mutable = { ...intent }
  const first = pending.run(() => mutable, b => api.createTaskSession('p', 't', b))
  assert.equal(pending.run(() => { throw Error('duplicate evaluated') }, () => {}), first)
  await new Promise(r => setImmediate(r)); mutable.title = '变更'; mutable.workerId = 'other'; release()
  await assert.rejects(first, e => e.kind === 'network')
  assert.equal(pending.read().title, intent.title)
  pending = new PendingTaskSession(() => store, scope, () => `r${++mint}`); fail = false
  const replay = await pending.run(() => { throw Error('retry rebuilt intent') }, b => api.createTaskSession('p', 't', b))
  assert.equal(replay.session.id, 's'); assert.equal(replay.commandId, 'command'); assert.equal(replay.created, false)
  assert.deepEqual(calls[1], calls[0]); assert.equal(pending.read(), null)
  await pending.run(() => mutable, b => api.createTaskSession('p', 't', b))
  assert.notEqual(calls[2].requestId, calls[0].requestId); assert.equal(calls[2].title, '变更')
})
test('scope isolates host/account/team/project/task and disposed transport prevents late success', async () => {
  const store = storage(), first = new PendingTaskSession(() => store, scope, () => 'original')
  await assert.rejects(first.run(() => intent, async () => { throw Error('unknown') }))
  for (const field of Object.keys(scope)) {
    const changed = { ...scope, [field]: field === 'host' ? 'https://other.test' : 'other' }
    assert.equal(new PendingTaskSession(() => store, changed).read(), null, field)
  }
  let release
  const api = client(async () => { await new Promise(r => { release = r }); return Response.json(response({ ...intent, requestId: 'original' })) })
  const flight = first.run(() => intent, b => api.createTaskSession('p', 't', b))
  await new Promise(r => setImmediate(r)); api.dispose(); release()
  await assert.rejects(flight, e => e.name === 'AbortError')
  assert.equal(first.read().requestId, 'original')
})
test('unavailable/corrupt/nonpersistent storage fails closed before send; cleanup failure keeps retry identity', async () => {
  for (const get of [() => { throw Error('denied') }, () => ({ getItem() { throw Error('denied') } }), () => ({ getItem: () => '{invalid' }), () => ({ getItem: () => null, setItem() { throw Error('quota') } }), () => ({ getItem: () => null, setItem() {} })]) {
    const pending = new PendingTaskSession(get, scope)
    await assert.rejects(pending.run(() => intent, () => { assert.fail('must not send') }), /存储|保存|读取/)
  }
  const store = storage(); store.removeItem = () => { throw Error('denied') }
  const pending = new PendingTaskSession(() => store, scope, () => 'stable')
  await assert.rejects(pending.run(() => intent, async body => response(body)), /会话已创建/)
  assert.equal(pending.read().requestId, 'stable')
})
test('conflict, revoked authorization and malformed response never silently replace request', async () => {
  const store = storage(), pending = new PendingTaskSession(() => store, scope, () => 'same')
  for (const status of [409, 403, 404]) {
    const api = client(async () => Response.json({ error: { code: status === 409 ? 'request_id_conflict' : 'forbidden', message: '拒绝' } }, { status }))
    await assert.rejects(pending.run(() => intent, b => api.createTaskSession('p', 't', b)))
    assert.equal(pending.read().requestId, 'same')
  }
})

test('shared rejected operation releases coordination and retries persisted body from another instance', async () => {
  const store = storage(), a = new PendingTaskSession(() => store, scope, () => 'first'), b = new PendingTaskSession(() => store, scope, () => 'second')
  const calls = []; let release
  const first = a.run(() => new Promise(r => { release = r }), async body => { calls.push(body); throw Error('lost response') })
  await new Promise(r => setImmediate(r))
  const remounted = b.run(() => { throw Error('duplicate intent') }, () => { throw Error('duplicate send') })
  assert.equal(first, remounted)
  release(intent); await assert.rejects(first)
  assert.equal(b.read().requestId, 'first')
  await b.run(() => { throw Error('must replay') }, async body => { calls.push(body); return response(body, false) })
  assert.deepEqual(calls[1], calls[0]); assert.equal(b.read(), null)
})

test('P1 replay reconciles current Session title and model after a lost creation response', async () => {
  const store = storage(), pending = new PendingTaskSession(() => store, scope, () => 'original')
  const calls = []; let saved
  const api = client(async (_url, init) => {
    const body = JSON.parse(init.body); calls.push(body)
    if (!saved) { saved = response(body); throw Error('committed response lost') }
    return Response.json({ ...saved, created: false })
  })
  await assert.rejects(pending.run(() => intent, body => api.createTaskSession('p', 't', body)))
  saved.session.title = 'Renamed after creation'; saved.session.binding.modelId = 'second'
  const replay = await pending.run(() => { throw Error('must retain creation request') }, body => api.createTaskSession('p', 't', body))
  assert.deepEqual(calls[1], calls[0]); assert.equal(replay.session.id, saved.session.id); assert.equal(replay.commandId, saved.commandId)
  assert.equal(replay.session.title, 'Renamed after creation'); assert.equal(replay.session.binding.modelId, 'second')
  assert.equal(pending.read(), null)
})

test('P1 successful overlapping remount coalesces capability lookup through settlement', async () => {
  const store = storage(), a = new PendingTaskSession(() => store, scope, () => 'a'), b = new PendingTaskSession(() => store, scope, () => 'b')
  const calls = []; let release, secondLookups = 0
  const send = async body => { calls.push(body); return response(body) }
  const first = a.run(() => new Promise(resolve => { release = resolve }), send)
  await new Promise(resolve => setImmediate(resolve))
  const remounted = b.run(() => { secondLookups++; return intent }, send)
  // Pre-fix B succeeds and clears storage while A's capability lookup is still held.
  await new Promise(resolve => setImmediate(resolve))
  release(intent)
  const results = await Promise.all([first, remounted])
  assert.equal(calls.length, 1, 'one operation, not two fresh request identities')
  assert.equal(secondLookups, 0); assert.equal(first, remounted); assert.deepEqual(results[0], results[1]); assert.equal(a.read(), null)
  await b.run(() => intent, send)
  assert.equal(calls.length, 2); assert.notEqual(calls[1].requestId, calls[0].requestId, 'settlement releases coordination for explicit next intent')
})

test('coordination is independent across storage objects and every full-scope field', async () => {
  const store = storage(), pending = new PendingTaskSession(() => store, scope)
  let release
  const held = pending.run(() => new Promise(r => { release = r }), async body => response(body))
  await new Promise(r => setImmediate(r))
  for (const field of Object.keys(scope)) {
    const changed = { ...scope, [field]: field === 'host' ? 'https://other.test' : 'other' }
    await new PendingTaskSession(() => store, changed).run(() => intent, async body => response(body))
  }
  const otherStore = storage()
  await new PendingTaskSession(() => otherStore, scope).run(() => intent, async body => response(body))
  release(intent); await held
})

test('synchronous reentrant intent and send observe the registered shared operation', async () => {
  const store = storage(), a = new PendingTaskSession(() => store, scope), b = new PendingTaskSession(() => store, scope)
  let fromIntent, fromSend
  const duplicate = () => b.run(() => { throw Error('reentered intent') }, () => { throw Error('reentered send') })
  const operation = a.run(() => { fromIntent = duplicate(); return intent }, async body => { fromSend = duplicate(); return response(body) })
  await operation
  assert.equal(fromIntent, operation); assert.equal(fromSend, operation); assert.equal(a.read(), null)
  await a.run(() => intent, async body => response(body))
})

test('replay still rejects changed immutable bindings or receipt and new creation rejects changed title/model', async () => {
  const body = { ...intent, requestId: 'request' }
  for (const change of [r => { r.session.taskId = 'other' }, r => { r.session.workspaceId = r.session.binding.workspaceId = 'other' }, r => { r.session.binding.agent.workerId = 'other' }, r => { r.session.binding.agent.agentKey = 'other' }, r => { r.session.creation.requestId = 'other' }, r => { r.session.creation.commandId = 'other' }]) {
    const reply = response(body, false); change(reply)
    await assert.rejects(client(async () => Response.json(reply)).createTaskSession('p', 't', body), e => e.kind === 'contract')
  }
  for (const change of [r => { r.session.title = 'Changed' }, r => { r.session.binding.modelId = 'changed' }]) {
    const reply = response(body); change(reply)
    await assert.rejects(client(async () => Response.json(reply)).createTaskSession('p', 't', body), e => e.kind === 'contract')
  }
})
