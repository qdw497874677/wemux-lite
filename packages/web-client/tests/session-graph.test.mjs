import test from 'node:test'
import assert from 'node:assert/strict'
import { createClusterClient, ApiError } from '@wemux/web-client'

const account = { username: 'owner', teamId: 'team', csrfToken: 'csrf', email: null, instanceAdministrator: false }
const client = fetcher => createClusterClient(account, () => {}, { origin: 'http://host.test', fetcher })

const revision = 'g0123456789abcdef'
const summary = overrides => ({ title: '会话', projectId: 'p', workspaceId: 'w', workerId: 'worker', agentKey: 'agent', modelId: 'model', runtimeState: 'idle', lastActivityAt: null, branchCount: 1, ...overrides })
const node = (sessionId, overrides = {}) => ({ sessionId, visibility: 'visible', summary: summary(), ...overrides })
const edge = (sourceSessionId, targetSessionId) => ({ key: 'fork:f1', relation: { type: 'fork', forkId: 'f1' }, sourceSessionId, targetSessionId })
const graph = overrides => ({ revision, nodes: [node('s1'), node('s2')], edges: [edge('s1', 's2')], hiddenRelationCount: null, ...overrides })
const fork = overrides => ({ forkId: 'f1', sourceSessionId: 's1', sourceEventCursor: 0, targetSessionId: 's2', ...overrides })
const forkBody = { sourceSessionId: 's1', requestId: 'request-1', targetWorkspaceId: 'w', targetWorkerId: 'worker', targetAgentKey: 'agent', targetModelId: 'model' }

test('画布图按项目与可选子树参数读取，并拒绝泄露受限内容的节点或悬空边', async () => {
  const calls = []
  const api = client(async (url, init) => { calls.push({ url: new URL(url), init }); return Response.json({ graph: graph() }) })
  assert.deepEqual(await api.sessionGraph('p'), graph())
  assert.equal(calls[0].url.pathname, '/api/projects/p/session-graph')
  assert.deepEqual(Object.fromEntries(calls[0].url.searchParams), { teamId: 'team' })
  assert.equal(calls[0].init.method, 'GET')
  assert.deepEqual(await api.sessionGraph('p /x', { rootSessionId: 's1', depth: 1, nodeLimit: 5 }), graph())
  assert.equal(calls[1].url.pathname, '/api/projects/p%20%2Fx/session-graph')
  assert.deepEqual(Object.fromEntries(calls[1].url.searchParams), { rootSessionId: 's1', depth: '1', nodeLimit: '5', teamId: 'team' })

  // 受限节点只能是占位：不得携带标题或成员身份。
  const placeholder = { revision, nodes: [node('s1'), { sessionId: 's2', visibility: 'placeholder', summary: null }], edges: [edge('s1', 's2')], hiddenRelationCount: 1 }
  const hidden = client(async () => Response.json({ graph: placeholder }))
  assert.deepEqual((await hidden.sessionGraph('p')).nodes[1], { sessionId: 's2', visibility: 'placeholder', summary: null })

  const malformed = [
    {},
    { graph: graph({ revision: '' }) },
    { graph: graph({ hiddenRelationCount: 'x' }) },
    { graph: graph({ nodes: [node('s1', { summary: null })] }) },
    { graph: graph({ nodes: [node('s1', { visibility: 'placeholder' })] }) },
    { graph: graph({ nodes: [{ sessionId: 'hidden', visibility: 'placeholder', summary: { title: '泄露' } }] }) },
    { graph: graph({ nodes: [node('s1', { summary: summary({ branchCount: -1 }) })] }) },
    // 悬空边意味着服务端没有按两端权限过滤，客户端必须报错而不是画出来。
    { graph: { revision, nodes: [node('s1')], edges: [edge('s1', 's2')], hiddenRelationCount: null } },
    { graph: graph({ edges: [{ ...edge('s1', 's2'), relation: { type: 'fork' } }] }) },
  ]
  for (const body of malformed) await assert.rejects(client(async () => Response.json(body)).sessionGraph('p'), e => e instanceof ApiError && e.kind === 'contract')
})

test('血缘、边详情与 Fork 命令保持请求身份，冲突与撤权如实回报', async () => {
  const calls = []
  const api = client(async (url, init) => {
    calls.push({ url: new URL(url), init })
    if (url.pathname.endsWith('/session-forks')) return Response.json({ fork: fork(), targetSessionId: 's2', graphRevision: revision, replayed: false }, { status: 201 })
    if (url.pathname.startsWith('/api/session-forks/')) return Response.json({ fork: fork(), graphRevision: revision })
    return Response.json({ sessionId: 's1', ancestors: [fork({ targetSessionId: 's1', sourceSessionId: 's0' })], children: [fork()], graphRevision: revision })
  })
  const lineage = await api.sessionLineage('s1')
  assert.equal(lineage.ancestors.length, 1)
  assert.deepEqual(lineage.children, [fork()])
  assert.equal(calls[0].url.pathname, '/api/sessions/s1/lineage')
  assert.equal((await api.sessionForkPoint('f1')).fork.forkId, 'f1')
  assert.equal(calls[1].url.pathname, '/api/session-forks/f1')

  const created = await api.forkSession('p', forkBody)
  assert.equal(created.replayed, false)
  assert.equal(created.targetSessionId, 's2')
  assert.equal(calls[2].url.pathname, '/api/projects/p/session-forks')
  assert.equal(calls[2].init.method, 'POST')
  assert.deepEqual(JSON.parse(calls[2].init.body), forkBody)
  assert.equal(calls[2].init.headers['X-CSRF-Token'], 'csrf')
  assert.deepEqual(await api.forkSession('p', { ...forkBody, sourceEventCursor: 0, contextPolicy: 'through_cursor' }), created)

  for (const body of [{}, { ...forkBody, requestId: '' }, { ...forkBody, sourceSessionId: '' }, { ...forkBody, targetWorkerId: 1 }]) {
    await assert.rejects(client(async () => Response.json({})).forkSession('p', body), e => e.kind === 'contract')
  }
  for (const bad of [{}, { fork: fork(), targetSessionId: 'other', graphRevision: revision, replayed: false }, { fork: fork({ sourceEventCursor: -1 }), targetSessionId: 's2', graphRevision: revision, replayed: false }, { fork: fork(), targetSessionId: 's2', graphRevision: revision }]) {
    await assert.rejects(client(async () => Response.json(bad, { status: 201 })).forkSession('p', forkBody), e => e.kind === 'contract')
  }
  for (const bad of [{}, { sessionId: 's1', ancestors: {}, children: [], graphRevision: revision }, { sessionId: 's1', ancestors: [], children: [fork({ forkId: '' })], graphRevision: '' }]) {
    await assert.rejects(client(async () => Response.json(bad)).sessionLineage('s1'), e => e.kind === 'contract')
  }

  for (const [status, code, kind] of [[409, 'request_id_conflict', 'server'], [409, 'cursor_not_durable', 'server'], [404, 'session_not_found', 'not-found'], [403, 'pat_scope_required', 'forbidden']]) {
    const failing = client(async () => Response.json({ error: { code, message: '失败' } }, { status }))
    await assert.rejects(failing.forkSession('p', forkBody), e => e instanceof ApiError && e.status === status && e.code === code && e.kind === kind)
    await assert.rejects(failing.sessionLineage('s1'), e => e.status === status)
  }
})
