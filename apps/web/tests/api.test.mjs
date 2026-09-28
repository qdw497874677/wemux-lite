import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { appendPage, projectJournal } from '../src/api/journal.ts'
import { anonymousSession, createApi } from '../src/api/client.ts'

// 用例大量替换 globalThis.fetch / window；进程内后续测试文件（如 proxy.test.mjs 的真实 Vite 代理链路）依赖原生物，必须恢复现场。
const realFetch = globalThis.fetch
const realWindow = globalThis.window
const hadWindow = 'window' in globalThis
before(() => {})
after(() => { globalThis.fetch = realFetch; if (hadWindow) globalThis.window = realWindow; else delete globalThis.window })

const event = (seq, payload, sessionId = 's1') => ({ sessionId, seq, occurredAt: '', payload })
const queued = (seq, messageId) => event(seq, { kind: 'message.queued', commandId: messageId, messageId, content: messageId, position: 1 })
test('journal replay deduplicates, sorts, preserves queued messages during a turn', () => {
  const first = [queued(1, 'm1'), event(2, { kind: 'turn.started', turnId: 't1', messageId: 'm1' })]
  const next = [event(4, { kind: 'assistant.text.delta', turnId: 't1', text: '你好' }), queued(3, 'm2')]
  const events = appendPage(appendPage(first, next, 's1'), next, 's1')
  const result = projectJournal(events)
  assert.equal(result.messages.find(item => item.role === 'assistant').text, '你好')
  assert.equal(result.messages.find(item => item.id === 'm2').status, 'queued')
  assert.equal(result.runtimeState, 'running')
  assert.equal(projectJournal([...events, event(5, { kind: 'turn.finished', turnId: 't1', outcome: 'completed', failure: null })]).runtimeState, 'queued')
})
test('journal projects tool lifecycle into the ordered conversation timeline', () => {
  const result = projectJournal([
    queued(1, 'm1'),
    event(2, { kind: 'turn.started', turnId: 't1', messageId: 'm1' }),
    event(3, { kind: 'tool.started', turnId: 't1', toolCallId: 'tool-1', toolName: 'bash', input: { command: 'pwd' } }),
    event(4, { kind: 'tool.output.delta', turnId: 't1', toolCallId: 'tool-1', text: '/tmp' }),
    event(5, { kind: 'tool.output.delta', turnId: 't1', toolCallId: 'tool-1', text: '/repo' }),
    event(6, { kind: 'tool.finished', turnId: 't1', toolCallId: 'tool-1', exitCode: 0 }),
    event(7, { kind: 'assistant.text.delta', turnId: 't1', text: '完成' }),
    event(8, { kind: 'turn.finished', turnId: 't1', outcome: 'completed', failure: null }),
  ])
  assert.deepEqual(result.timeline.map(item => item.kind), ['message', 'reasoning', 'tool', 'message'])
  const reasoning = result.timeline.find(item => item.kind === 'reasoning')
  assert.match(reasoning.text, /bash$/)
  assert.equal(reasoning.duration, 1)
  const tool = result.timeline.find(item => item.kind === 'tool')
  assert.equal(tool.toolName, 'bash')
  assert.deepEqual(tool.input, { command: 'pwd' })
  assert.equal(tool.output, '/tmp/repo')
  assert.equal(tool.status, 'completed')
  assert.equal(tool.exitCode, 0)
  assert.equal(result.timeline.at(-1).text, '完成')
})

test('journal keeps assistant text segments ordered around tool calls and exposes failures inline', () => {
  const result = projectJournal([
    queued(1, 'm1'),
    event(2, { kind: 'turn.started', turnId: 't1', messageId: 'm1' }),
    event(3, { kind: 'assistant.text.delta', turnId: 't1', text: '先检查。' }),
    event(4, { kind: 'tool.started', turnId: 't1', toolCallId: 'tool-1', toolName: 'read', input: { path: 'a.ts' } }),
    event(5, { kind: 'tool.finished', turnId: 't1', toolCallId: 'tool-1', exitCode: 1 }),
    event(6, { kind: 'assistant.text.delta', turnId: 't1', text: '读取失败。' }),
    event(7, { kind: 'turn.finished', turnId: 't1', outcome: 'failed', failure: { code: 'READ_FAILED', message: '无法读取文件' } }),
  ])
  assert.deepEqual(result.timeline.map(item => item.kind), ['message', 'message', 'reasoning', 'tool', 'message', 'notice'])
  assert.equal(result.timeline[1].text, '先检查。')
  assert.match(result.timeline[2].text, /read$/)
  assert.equal(result.timeline[3].status, 'failed')
  assert.equal(result.timeline[4].text, '读取失败。')
  assert.equal(result.timeline[5].text, '无法读取文件')
  assert.equal(result.timeline[5].tone, 'error')
})

test('journal exposes message rejection beside the rejected user message', () => {
  const result = projectJournal([
    queued(1, 'm1'),
    event(2, { kind: 'message.rejected', commandId: 'c1', messageId: 'm1', reason: '当前模型不可用' }),
  ])
  assert.equal(result.timeline[0].kind, 'message')
  assert.equal(result.timeline[0].status, 'rejected')
  assert.deepEqual(result.timeline[1], { kind: 'notice', id: 'rejected:m1:2', text: '当前模型不可用', tone: 'error' })
})

test('cross-session events and sequence gaps are explicit failures', () => {
  assert.throws(() => appendPage([], [queued(2, 'm')], 's1'), /gap/)
  assert.throws(() => appendPage([], [event(1, { kind: 'session.runtime.changed', state: 'idle' }, 's2')], 's1'), /sessionId/)
})
test('API adapts current server lists, pagination, auth and fetch-stream SSE lifecycle', async () => {
  globalThis.window = { location: { origin: 'http://localhost:8002' } }
  const calls = []
  let streamRequests = 0
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    if (url.pathname.endsWith('/stream')) {
      streamRequests += 1
      const body = new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('id: 2\nevent: session.event\ndata: {}\n\n')) },
        cancel() {},
      })
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    }
    const body = url.pathname.endsWith('/events')
      ? { events: [queued(1, 'm')], nextSeq: null, freshness: { status: 'offline' } }
      : url.pathname.endsWith('/capabilities')
        ? { workerId: 'w1', capabilities: [{ agentKey: 'test' }] }
        : { items: [{ id: 'w1', capabilities: [] }] }
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
  }
  const api = createApi({ teamId: 'team', csrfToken: 'csrf-secret', username: 'owner', email: null })
  assert.deepEqual(await api.workers(), [{ id: 'w1', capabilities: [{ agentKey: 'test' }] }])
  // 凭据只在 HttpOnly Cookie 里：请求既不携带 Bearer 头，也绝不把令牌放进查询串。
  assert.equal(calls[0].options.headers.Authorization, undefined)
  assert.equal(calls[0].options.credentials, 'same-origin')
  assert.equal(calls[0].options.headers['X-CSRF-Token'], undefined)
  assert.equal(calls[0].url.searchParams.get('token'), null)
  assert.equal(calls[1].url.pathname, '/api/workers/w1/capabilities')
  const page = await api.events('s1', 0)
  assert.equal(page.throughSeq, 1)
  assert.equal(page.hasMore, false)
  assert.equal(page.freshness.status, 'offline')
  assert.equal(calls[2].url.searchParams.get('fromSeq'), '1')
  // 写操作额外携带内存中的 CSRF 令牌，服务端据此拒绝跨站请求。
  await api.revokeWorker('w1')
  const write = calls.at(-1)
  assert.equal(write.options.method, 'POST')
  assert.equal(write.options.headers['X-CSRF-Token'], 'csrf-secret')
  let changes = 0
  const close = api.watch('s1', 1, () => changes++, () => {})
  await new Promise(resolve => setTimeout(resolve, 20))
  const streamCall = calls.find(call => call.url.pathname.endsWith('/stream'))
  assert.equal(streamCall.url.searchParams.get('fromSeq'), '2')
  assert.equal(streamCall.url.searchParams.get('token'), null)
  assert.equal(streamCall.options.headers.Authorization, undefined)
  assert.equal(streamCall.options.credentials, 'same-origin')
  assert.equal(changes >= 1, true)
  assert.equal(streamRequests, 1)
  close()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(streamRequests, 1)
})
test('注册与登录都不需要引导令牌：凭据只走请求体与 Cookie', async () => {
  globalThis.window = { location: { origin: 'https://wemux.example.com' } }
  const calls = []
  const account = { user: { id: 'user-1', username: 'owner', email: 'owner@example.com', createdAt: '2030-01-01T00:00:00.000Z' }, teamId: 'default-team', session: { id: 'session-1', client: 'web', createdAt: '2030-01-01T00:00:00.000Z', lastSeenAt: '2030-01-01T00:00:00.000Z', idleExpiresAt: '2030-01-01T01:00:00.000Z', absoluteExpiresAt: '2030-01-08T00:00:00.000Z', current: true }, expiresAt: '2030-01-08T00:00:00.000Z' }
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    const body = url.pathname.endsWith('/auth/register')
      ? { status: 'accepted', email: 'o***@example.com' }
      : { ...account, csrfToken: `csrf-${calls.length}` }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const api = createApi(anonymousSession())
  const accepted = await api.register({ email: 'owner@example.com', displayName: 'Owner', password: 'correct horse battery staple' })
  assert.equal(calls[0].url.pathname, '/api/auth/register')
  // 部署声明（WEMUX_ADMIN_EMAILS）替代了引导令牌：注册请求里既没有 Authorization，也没有任何令牌字段。
  assert.equal(calls[0].options.headers.Authorization, undefined)
  assert.deepEqual(Object.keys(JSON.parse(calls[0].options.body)).sort(), ['displayName', 'email', 'password'])
  assert.equal(accepted.status, 'accepted')
  assert.equal(accepted.email, 'o***@example.com')
  const signedIn = await api.login('owner', 'correct horse battery staple')
  assert.equal(calls[1].url.pathname, '/api/auth/login')
  assert.equal(calls[1].options.headers.Authorization, undefined, 'Cookie 会话不带 Bearer')
  assert.equal(JSON.parse(calls[1].options.body).login, 'owner')
  assert.equal(signedIn.csrfToken, 'csrf-2')
  await api.logout()
  assert.equal(calls[2].url.pathname, '/api/auth/logout')
  assert.equal(calls[2].options.headers['X-CSRF-Token'], 'csrf-2')
})

test('creates empty and Git workspaces with explicit source payloads', async () => {
  globalThis.window = { location: { origin: 'https://wemux.example.com' } }
  const bodies = []
  globalThis.fetch = async (_url, options) => {
    bodies.push(JSON.parse(options.body))
    return new Response(JSON.stringify({ workspace: { id: `workspace-${bodies.length}`, projectId: 'project-1', workerId: 'worker-1', name: 'Workspace', status: 'pending', failureReason: null, location: null } }), { status: 201, headers: { 'content-type': 'application/json' } })
  }
  const api = createApi({ teamId: 'team-1', csrfToken: 'csrf-1', username: 'owner', email: null })
  await api.createWorkspace('project-1', { name: 'Blank', workerId: 'worker-1', source: 'empty' })
  await api.createWorkspace('project-1', { name: 'Repo', workerId: 'worker-1', source: 'git', repository: { name: 'Repo', gitUrl: 'https://example.com/repo.git', revision: 'main' } })
  assert.deepEqual(bodies[0], { projectId: 'project-1', name: 'Blank', workerId: 'worker-1', source: 'empty' })
  assert.equal(bodies[1].source, 'git')
  assert.equal(bodies[1].repository.gitUrl, 'https://example.com/repo.git')
})

test('creates enrollment tokens with the CSRF token of the cookie session and bounded TTL', async () => {
  globalThis.window = { location: { origin: 'https://wemux.example.com' } }
  let captured
  globalThis.fetch = async (url, options) => {
    captured = { url, options }
    return new Response(JSON.stringify({ token: 'one-time-secret', expiresAt: '2030-01-01T00:00:00.000Z' }), { status: 201, headers: { 'content-type': 'application/json' } })
  }
  const result = await createApi({ teamId: 'default-team', csrfToken: 'csrf-1', username: 'owner', email: null }).createEnrollmentToken({ ttlSeconds: 900 })
  assert.equal(captured.url.pathname, '/api/enrollment-tokens')
  assert.equal(captured.options.method, 'POST')
  assert.equal(captured.options.headers.Authorization, undefined)
  assert.equal(captured.options.credentials, 'same-origin')
  assert.equal(captured.options.headers['X-CSRF-Token'], 'csrf-1')
  assert.deepEqual(JSON.parse(captured.options.body), { ttlSeconds: 900 })
  assert.equal(result.token, 'one-time-secret')
})
test('message submission times out at the enqueue acknowledgement boundary', async () => {
  globalThis.window = { location: { origin: 'https://wemux.example.com' } }
  const originalTimeout = AbortSignal.timeout
  let timeoutMs
  AbortSignal.timeout = milliseconds => { timeoutMs = milliseconds; return new AbortController().signal }
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.method, 'POST')
    return new Response(JSON.stringify({ commandId: 'command-1', messageId: 'message-1', status: 'pending' }), { status: 202, headers: { 'content-type': 'application/json' } })
  }
  try {
    const result = await createApi({ teamId: 'team', csrfToken: 'csrf-1', username: 'owner', email: null }).send('session-1', { commandId: 'command-1', messageId: 'message-1', content: 'hello' })
    assert.equal(timeoutMs, 15000)
    assert.equal(result.status, 'pending')
  } finally { AbortSignal.timeout = originalTimeout }
})

test('unavailable backend and non-JSON responses never fall back to fake data', async () => {
  const api = createApi(anonymousSession())
  globalThis.fetch = async () => { throw new TypeError('offline') }
  await assert.rejects(api.workers(), /连接失败/)
  globalThis.fetch = async () => new Response('<html/>', { headers: { 'content-type': 'text/html' } })
  await assert.rejects(api.projects(), /响应格式异常/)
  globalThis.fetch = async () => new Response('', { status: 401 })
  await assert.rejects(api.projects(), /登录会话已失效|连接已中断/)
})

test('DELETE accepts a successful 204 response without requiring JSON', async () => {
  globalThis.window = { location: { origin: 'https://wemux.example.com' } }
  globalThis.fetch = async () => new Response(null, { status: 204 })
  await assert.doesNotReject(createApi({ teamId: 'team', csrfToken: 'csrf-1', username: 'owner', email: null }).deleteSession('session-1'))
})
