import test from 'node:test'
import assert from 'node:assert/strict'
import { createClusterClient, ApiError } from '@wemux/web-client'

const origin = 'http://canvas.test'
const account = { username: 'owner', teamId: 'team', csrfToken: 'csrf', email: null, instanceAdministrator: false }
const client = (fetcher, unauthorized = () => {}) => createClusterClient(account, unauthorized, { origin, fetcher })
const contractError = e => e instanceof ApiError && e.kind === 'contract'
const encoder = new TextEncoder()
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
function stream(parts, { close = true, onCancel = () => {} } = {}) {
  let controller
  const body = new ReadableStream({ start(c) { controller = c; for (const p of parts) c.enqueue(typeof p === 'string' ? encoder.encode(p) : p); if (close) c.close() }, cancel: onCancel })
  return { body, controller, response: new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } }) }
}
const frame = (name, data = {}) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`

test('画布协作流订阅项目事件通道并只透传已知事件名', async () => {
  const calls = []
  const api = client(async (url, init) => {
    calls.push({ url, init })
    return stream([frame('snapshot', { projectId: 'p', revision: 0, presence: [] }), frame('presence.updated'), frame('presence.left', { userId: 'u' }), frame('authorization', { status: 'revoked' }), frame('unexpected.event')]).response
  })
  const events = []
  const watch = api.watchCanvasCollaboration('p /x', { onEvent: event => events.push(event) })
  await watch.done
  // 撤权通知是终止事件：不重连、不报错，由调用方决定清缓存与提示。
  assert.deepEqual(events, ['snapshot', 'presence.updated', 'presence.left', 'authorization'])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url.pathname, '/api/projects/p%20%2Fx/canvas/collaboration/events')
  assert.equal(calls[0].url.searchParams.get('teamId'), 'team')
  assert.equal(calls[0].init.headers.Accept, 'text/event-stream')
  assert.equal(calls[0].init.cache, 'no-store')
})

test('画布协作流断线按预算重连并重新拉取权威快照，401 与越界参数立即失败', async () => {
  let calls = 0, cancelled = 0
  const events = []
  const reconnecting = client(async () => {
    calls++
    if (calls === 1) throw Error('disconnected')
    if (calls === 2) return stream([frame('snapshot')]).response
    return stream([frame('snapshot')], { close: false, onCancel: () => cancelled++ }).response
  })
  const watch = reconnecting.watchCanvasCollaboration('p', { onEvent: event => events.push(event), maxReconnects: 3, reconnectDelayMs: 10 })
  await tick()
  while (calls < 3) await tick()
  watch.dispose()
  await watch.done
  // 每次重连都重新读取快照，不依赖任何共享游标。
  assert.equal(calls, 3)
  assert.deepEqual(events, ['snapshot', 'snapshot'])
  assert.equal(cancelled, 1)

  let fails = 0
  const dead = client(async () => { fails++; throw Error('nope') })
  await assert.rejects(dead.watchCanvasCollaboration('p', { onEvent: () => {}, maxReconnects: 2, reconnectDelayMs: 10 }).done, e => e.kind === 'network')
  assert.equal(fails, 3)

  let tries = 0, unauthorized = 0
  const denied = client(async () => { tries++; return Response.json({ error: { code: 'denied', message: 'no permission' } }, { status: 401 }) }, () => unauthorized++)
  await assert.rejects(denied.watchCanvasCollaboration('p', { onEvent: () => {}, maxReconnects: 3 }).done, e => e.status === 401)
  assert.equal(tries, 1)
  assert.equal(unauthorized, 1)

  for (const options of [{}, { onEvent: () => {}, maxReconnects: 11 }, { onEvent: () => {}, maxReconnects: 1.5 }, { onEvent: () => {}, reconnectDelayMs: 5 }, { onEvent: () => {}, reconnectDelayMs: 60000 }]) {
    assert.throws(() => reconnecting.watchCanvasCollaboration('p', options), contractError)
  }
  assert.throws(() => reconnecting.watchCanvasCollaboration('', { onEvent: () => {} }), contractError)
})

test('画布协作流在 dispose 或外部 abort 后停止读取且不再重连', async () => {
  for (const mode of ['dispose', 'signal']) {
    let cancelled = 0, calls = 0
    const body = stream([], { close: false, onCancel: () => cancelled++ })
    const api = client(async () => { calls++; return body.response })
    const abort = new AbortController()
    const watch = api.watchCanvasCollaboration('p', { onEvent: () => {}, signal: abort.signal, maxReconnects: 3, reconnectDelayMs: 10 })
    await tick()
    if (mode === 'dispose') watch.dispose()
    else abort.abort()
    await watch.done
    assert.equal(cancelled, 1)
    assert.equal(calls, 1)
  }
  let count = 0, watch
  watch = client(async () => stream([frame('snapshot'), frame('presence.updated')]).response).watchCanvasCollaboration('p', { onEvent: () => { count++; watch.dispose() }, maxReconnects: 3, reconnectDelayMs: 10 })
  await watch.done
  assert.equal(count, 1)
})
