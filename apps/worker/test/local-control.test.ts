import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:http'
import { SqliteWorkerStore } from '../src/storage/sqlite-store.js'
import { createLocalAdmin, ensureLocalInstallation, verifyLocalAdmin } from '../src/application/local-installation.js'
import { startLocalControlServer, type LocalControlHandlers } from '../src/local-control/server.js'
import type { LocalWorkbenchService } from '../src/application/local-workbench.js'
import type { ProjectId, SessionId, Timestamp, WorkerId, WorkspaceId } from '@wemux/domain'

async function fixture(handlers: LocalControlHandlers = {}, options: { secureCookies?: boolean } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'wemux-local-control-'))
  const store = new SqliteWorkerStore(join(home, 'worker.sqlite'))
  const installation = ensureLocalInstallation(store, 'local-node')
  const admin = await createLocalAdmin(store, { username: 'owner', password: 'correct horse battery staple' })
  const server = await startLocalControlServer({ host: '127.0.0.1', port: 0, state: store, secureCookies: options.secureCookies }, handlers)
  return { home, store, installation, admin, server, cleanup: async () => { await server.close(); store.close(); await rm(home, { recursive: true, force: true }) } }
}

function cookie(response: Response) {
  return response.headers.get('set-cookie')?.split(';', 1)[0] ?? ''
}

function rawRequest(url: string, headers: Record<string, string>) {
  return new Promise<number>((resolve, reject) => {
    const target = new URL(url)
    const outgoing = request({ hostname: target.hostname, port: target.port, path: target.pathname, headers }, response => {
      response.resume()
      response.once('end', () => resolve(response.statusCode ?? 0))
    })
    outgoing.once('error', reject)
    outgoing.end()
  })
}

test('local installation and administrator persist separately from cluster identity', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wemux-local-identity-'))
  const path = join(home, 'worker.sqlite')
  let store = new SqliteWorkerStore(path)
  try {
    const installation = ensureLocalInstallation(store, 'first')
    const admin = await createLocalAdmin(store, { username: 'owner', password: 'correct horse battery staple' })
    assert.equal(store.identity(), null)
    assert.equal(ensureLocalInstallation(store, 'renamed').installationId, installation.installationId)
    assert.ok(await verifyLocalAdmin(admin, { username: 'owner', password: 'correct horse battery staple' }))
    assert.equal(await verifyLocalAdmin(admin, { username: 'owner', password: 'wrong password value' }), false)
    await assert.rejects(createLocalAdmin(store, { username: 'other', password: 'another correct password' }), /already initialized/)
    store.close(); store = new SqliteWorkerStore(path)
    assert.deepEqual(store.localInstallation(), installation)
    assert.equal(store.localAdmin()?.username, 'owner')
  } finally { store.close(); await rm(home, { recursive: true, force: true }) }
})

test('local control rejects anonymous access and supports login, status and logout', async () => {
  const f = await fixture()
  try {
    const host = await fetch(`${f.server.url}/api/host`)
    assert.equal(host.status, 200)
    assert.equal(host.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await host.json(), { hostKind: 'local-worker', contractVersion: 1, capabilities: ['local-session', 'directories', 'cluster-connection'] })
    assert.equal((await fetch(`${f.server.url}/api/local/status`)).status, 401)
    const failed = await fetch(`${f.server.url}/api/local/auth/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'wrong password value' }) })
    assert.equal(failed.status, 401)
    assert.equal(failed.headers.get('set-cookie'), null)

    const loggedIn = await fetch(`${f.server.url}/api/local/auth/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'correct horse battery staple' }) })
    assert.equal(loggedIn.status, 201)
    const session = cookie(loggedIn)
    assert.match(session, /^wemux_worker_session=/)
    assert.match(loggedIn.headers.get('set-cookie') ?? '', /HttpOnly/)
    assert.match(loggedIn.headers.get('set-cookie') ?? '', /SameSite=Strict/)
    const loginBody = await loggedIn.json() as { csrf: string }

    const status = await fetch(`${f.server.url}/api/local/status`, { headers: { cookie: session } })
    assert.equal(status.status, 200)
    const body = await status.json() as Record<string, unknown>
    assert.deepEqual(body.installation, f.installation)
    assert.deepEqual(body.cluster, { enrolled: false, connection: null })
    assert.equal(JSON.stringify(body).includes(f.admin.passwordHash), false)
    assert.equal(JSON.stringify(body).includes(f.admin.passwordSalt), false)

    assert.equal((await fetch(`${f.server.url}/api/local/auth/session`, { method: 'DELETE', headers: { cookie: session } })).status, 403)
    assert.equal((await fetch(`${f.server.url}/api/local/auth/session`, { method: 'DELETE', headers: { cookie: session, 'x-wemux-csrf': loginBody.csrf } })).status, 204)
    assert.equal((await fetch(`${f.server.url}/api/local/status`, { headers: { cookie: session } })).status, 401)
  } finally { await f.cleanup() }
})

test('built shared Web serves deep links and hashed assets without exposing files or APIs', async () => {
  const web = await mkdtemp(join(tmpdir(), 'wemux-worker-web-'))
  const f = await fixture()
  try {
    const html = '<!doctype html><script>window.__web=1</script><script type="module" src="/assets/main-abc.js"></script>'
    await mkdir(join(web, 'assets'))
    await writeFile(join(web, 'index.html'), html)
    await writeFile(join(web, 'assets', 'main-abc.js'), 'console.log("web")')
    const served = await startLocalControlServer({ host: '127.0.0.1', port: 0, state: f.store, webStaticPath: web })
    try {
      const entry = await fetch(`${served.url}/local/settings`, { headers: { accept: 'text/html' } })
      assert.equal(entry.status, 200)
      assert.equal(await entry.text(), html)
      assert.equal(entry.headers.get('cache-control'), 'no-cache')
      assert.match(entry.headers.get('content-security-policy') ?? '', /script-src 'self' 'sha256-/)
      assert.doesNotMatch((entry.headers.get('content-security-policy') ?? '').split('style-src')[0], /unsafe-inline/)
      const asset = await fetch(`${served.url}/assets/main-abc.js`)
      assert.equal(asset.status, 200)
      assert.match(asset.headers.get('content-type') ?? '', /text\/javascript/)
      assert.equal(asset.headers.get('cache-control'), 'public, max-age=3600')
      assert.equal((await fetch(`${served.url}/api/local/status`)).status, 401)
      assert.equal((await fetch(`${served.url}/api/missing`, { headers: { accept: 'text/html' } })).status, 404)
      assert.equal((await fetch(`${served.url}/assets/missing.js`)).status, 404)
      assert.equal((await fetch(`${served.url}/%2e%2e/%2e%2e/etc/passwd`)).status, 404)
    } finally { await served.close() }
  } finally { await f.cleanup(); await rm(web, { recursive: true, force: true }) }
})

test('local control marks session cookies Secure behind an HTTPS reverse proxy', async () => {
  const f = await fixture({}, { secureCookies: true })
  try {
    const loggedIn = await fetch(`${f.server.url}/api/local/auth/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'correct horse battery staple' }) })
    assert.match(loggedIn.headers.get('set-cookie') ?? '', /; Secure/)
  } finally { await f.cleanup() }
})

test('local control exposes an authenticated CSRF-protected shutdown hook', async () => {
  let resolveShutdown!: () => void
  const shutdown = new Promise<void>(resolve => { resolveShutdown = resolve })
  const f = await fixture({ shutdown: async () => resolveShutdown() })
  try {
    const loggedIn = await fetch(`${f.server.url}/api/local/auth/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'correct horse battery staple' }) })
    const session = cookie(loggedIn)
    const loginBody = await loggedIn.json() as { csrf: string }
    assert.equal((await fetch(`${f.server.url}/api/local/control/shutdown`, { method: 'POST', headers: { cookie: session } })).status, 403)
    assert.equal((await fetch(`${f.server.url}/api/local/control/shutdown`, { method: 'POST', headers: { cookie: session, 'x-wemux-csrf': loginBody.csrf } })).status, 202)
    await shutdown
  } finally { await f.cleanup() }
})

test('local control exposes CSRF-protected cluster lifecycle operations', async () => {
  const calls: string[] = []
  const cluster = {
    connection: () => ({ phase: 'offline' as const, retryAt: null, failure: null }),
    discover: async (serverUrl: string) => { calls.push(`discover:${serverUrl}`); return { serverUrl, ok: true, status: 200 } },
    enroll: async (input: { serverUrl: string; token: string; name?: string }) => { calls.push(`enroll:${input.serverUrl}:${input.token}:${input.name}`); return { workerId: 'worker-1', serverUrl: 'ws://server/worker/ws', credentialRef: 'credential', enrolledAt: '2025-01-01T00:00:00.000Z' } as import('../src/domain/worker-identity.ts').WorkerIdentity },
    connect: async () => { calls.push('connect') }, pause: async () => { calls.push('pause') }, resume: async () => { calls.push('resume') }, leave: async () => { calls.push('leave') },
    agentSettings: async () => ({ selections: [], capabilities: [] }), selectAgent: async (key: string, path: string) => { calls.push(`agent:${key}:${path}`); return { selections: [], capabilities: [] } }, resetAgent: async (key: string) => { calls.push(`reset:${key}`); return { selections: [], capabilities: [] } },
  }
  const f = await fixture({ cluster })
  try {
    const login = await fetch(`${f.server.url}/api/local/auth/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'correct horse battery staple' }) })
    const cookie = login.headers.get('set-cookie')!.split(';')[0]
    const csrf = (await login.json() as { csrf: string }).csrf
    const authenticated = { cookie, 'x-wemux-csrf': csrf, 'content-type': 'application/json' }
    assert.equal((await fetch(`${f.server.url}/api/local/cluster/discover`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ serverUrl: 'http://server' }) })).status, 403)
    assert.equal((await fetch(`${f.server.url}/api/local/cluster/discover`, { method: 'POST', headers: authenticated, body: JSON.stringify({ serverUrl: 'http://server' }) })).status, 200)
    assert.equal((await fetch(`${f.server.url}/api/local/cluster/enroll`, { method: 'POST', headers: authenticated, body: JSON.stringify({ serverUrl: 'http://server', token: 'secret', name: 'node' }) })).status, 201)
    assert.equal(calls.filter(call => call.includes('secret')).length, 1)
    const statusAfterEnroll = await fetch(`${f.server.url}/api/local/status`, { headers: { cookie } })
    assert.doesNotMatch(await statusAfterEnroll.text(), /secret/)
    assert.equal((await fetch(`${f.server.url}/api/local/cluster/pause`, { method: 'POST', headers: authenticated })).status, 200)
    assert.equal((await fetch(`${f.server.url}/api/local/cluster/resume`, { method: 'POST', headers: authenticated })).status, 202)
    assert.equal((await fetch(`${f.server.url}/api/local/cluster/enrollment`, { method: 'DELETE', headers: authenticated })).status, 204)
    assert.equal((await fetch(`${f.server.url}/api/local/agents`, { headers: { cookie } })).status, 200)
    assert.equal((await fetch(`${f.server.url}/api/local/agents/pi`, { method: 'PUT', headers: authenticated, body: JSON.stringify({ executable: '/usr/bin/pi' }) })).status, 200)
    assert.equal((await fetch(`${f.server.url}/api/local/agents/pi`, { method: 'DELETE', headers: authenticated })).status, 200)
    assert.deepEqual(calls, ['discover:http://server', 'enroll:http://server:secret:node', 'connect', 'pause', 'resume', 'leave', 'agent:pi:/usr/bin/pi', 'reset:pi'])
  } finally { await f.cleanup() }
})

test('local connector writes reject malformed and cross-scope definitions before persistence', async () => {
  const saved: unknown[] = []
  const cluster = {
    listConnectors: async () => saved,
    connectorCredentialAvailable: () => false,
    saveConnector: async (definition: unknown) => { saved.push(definition); return definition },
    deleteConnector: async (id: string) => { saved.splice(saved.findIndex(item => (item as { id: string }).id === id), 1) },
    putConnectorCredential: async () => ({ id: 'local-key', revision: 1, profile: { accountId: null, displayName: null, grantedScopes: [] }, ciphertext: 'NEVER-RETURN-THIS' }),
  } as unknown as NonNullable<LocalControlHandlers['cluster']>
  const f = await fixture({ cluster })
  try {
    const login = await fetch(`${f.server.url}/api/local/auth/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'correct horse battery staple' }) })
    const session = cookie(login)
    const csrf = (await login.json() as { csrf: string }).csrf
    const headers = { cookie: session, 'x-wemux-csrf': csrf, 'content-type': 'application/json' }
    const definition = { id: 'local-example', projectId: 'local', kind: 'mcp', name: 'example', description: null, revision: 1, enabled: true, allowedWorkerIds: [], credentialRef: null, credentialAvailability: 'not_required', riskDefaults: { requireApprovalForRead: false, allowMcpReadOnlyHint: true }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), config: { transport: 'stdio', command: '/usr/bin/node', args: ['--version'], cwd: null, publicEnvironment: {}, secretEnvironmentNames: [] } }
    const save = (body: unknown, requestHeaders = headers) => fetch(`${f.server.url}/api/local/connectors`, { method: 'POST', headers: requestHeaders, body: JSON.stringify(body) })
    assert.equal((await save(definition, { ...headers, 'x-wemux-csrf': '' })).status, 403)
    for (const bad of [
      { ...definition, projectId: 'other' },
      { ...definition, config: { ...definition.config, args: 'not-an-array' } },
      { ...definition, config: { transport: 'streamable_http', url: 'file:///etc/passwd', publicHeaders: {}, authentication: 'none', allowPrivateNetwork: false } },
      { ...definition, config: { ...definition.config, unexpectedSecret: 'leak' } },
      { ...definition, riskDefaults: { ...definition.riskDefaults, requireApprovalForRead: 'false' } },
    ]) assert.equal((await save(bad)).status, 400)
    assert.equal(saved.length, 0)
    assert.equal((await save(definition)).status, 201)
    assert.equal(saved.length, 1)
    saved[0] = { ...(saved[0] as object), config: { ...definition.config, publicEnvironment: { PUBLIC_TOKEN: 'DO-NOT-EXPOSE' } } }
    const redacted = await fetch(`${f.server.url}/api/local/connectors`, { headers: { cookie: session } })
    assert.equal(redacted.status, 200)
    assert.doesNotMatch(await redacted.text(), /DO-NOT-EXPOSE/)
    saved[0] = definition
    assert.equal((await save(definition)).status, 409)
    assert.equal((await save({ ...definition, revision: 2, createdAt: '2022-01-01T00:00:00.000Z' })).status, 409)
    const credential = (id: string, body: unknown) => fetch(`${f.server.url}/api/local/connectors/${id}/credential`, { method: 'PUT', headers, body: JSON.stringify(body) })
    assert.equal((await credential('cluster-foreign', { id: 'local-key', authType: 'api_key', secret: { value: 'hidden' } })).status, 404)
    assert.equal((await credential('local-example', { id: 'local-key', authType: 'api_key', secret: { value: 'hidden' }, extra: true })).status, 400)
    assert.equal((await credential('local-example', { id: 'local-key', authType: 'api_key', secret: { value: 'hidden' } })).status, 400)
    saved[0] = { ...(saved[0] as object), credentialRef: 'local-key', credentialAvailability: 'unconfigured', config: { ...definition.config, secretEnvironmentNames: ['value'] } }
    const response = await credential('local-example', { id: 'local-key', authType: 'api_key', secret: { value: 'hidden' } })
    assert.equal(response.status, 200)
    assert.doesNotMatch(await response.text(), /hidden|NEVER-RETURN-THIS/)
    assert.equal((await fetch(`${f.server.url}/api/local/connectors/cluster-foreign`, { method: 'DELETE', headers })).status, 404)
    assert.equal((await fetch(`${f.server.url}/api/local/connectors/local-example`, { method: 'DELETE', headers })).status, 204)
    assert.equal(saved.length, 0)
  } finally { await f.cleanup() }
})

test('local control serves session controls and protects every workbench write with CSRF', async () => {
  const calls: string[] = []
  const localSession = {
    sessionId: 'local-session' as SessionId,
    binding: { workspaceId: 'local-workspace' as WorkspaceId, agent: { workerId: 'local-worker' as WorkerId, agentKey: 'test' as import('@wemux/domain').AgentKey }, modelId: 'test' as import('@wemux/domain').ModelId },
    runtimeState: 'idle' as const,
    activeTurnId: null,
    nativeSession: null,
    updatedAt: new Date().toISOString() as Timestamp,
  }
  const workbench: LocalWorkbenchService = {
    listDirectories: async () => [{ workspaceId: localSession.binding.workspaceId, name: 'repo', path: '/tmp/repo', addedAt: localSession.updatedAt }],
    addDirectory: async path => { calls.push(`directory:${path}`); return { workspaceId: localSession.binding.workspaceId, name: 'repo', path, addedAt: localSession.updatedAt } },
    listSessions: async () => [localSession],
    createSession: async input => { calls.push(`create:${input.agentKey}:${input.modelId}`); return localSession },
    deleteSession: async sessionId => { calls.push(`delete:${sessionId}`); return { commandId: 'delete-command' as import('@wemux/domain').CommandId, status: 'accepted' as const } },
    enqueue: async (sessionId, content) => { calls.push(`enqueue:${sessionId}:${content}`); return { commandId: 'enqueue-command' as import('@wemux/domain').CommandId, status: 'accepted' as const } },
    cancelQueued: async (sessionId, submissionCommandId) => { calls.push(`cancel:${sessionId}:${submissionCommandId}`); return { commandId: 'cancel-command' as import('@wemux/domain').CommandId, status: 'accepted' as const } },
    stop: async (sessionId, turnId) => { calls.push(`stop:${sessionId}:${turnId}`); return { commandId: 'stop-command' as import('@wemux/domain').CommandId, status: 'accepted' as const } },
    queue: async () => [],
    approvals: async () => [],
    supportedCommands: async () => ['compact'],
    command: async (id, name, commandId) => { calls.push(`command:${id}:${name}:${commandId}`); return { commandId: 'compact-command' as import('@wemux/domain').CommandId, status: 'accepted' } },
    resolveApproval: async (id, approvalId, decision) => { calls.push(`approval:${id}:${approvalId}:${decision}`); return { commandId: 'approval-command' as import('@wemux/domain').CommandId, status: 'accepted' } },
    journal: async (_id, fromSeq) => { calls.push(`journal:${fromSeq}`); return { events: [], throughSeq: 0 as import('@wemux/domain').EventSeq, hasMore: false } },
  }
  const f = await fixture({ workbench })
  try {
    const page = await fetch(f.server.url)
    const pageBody = await page.text()
    assert.match(pageBody, /当前会话/)
    assert.match(pageBody, /停止运行/)
    const localScript = await (await fetch(`${f.server.url}/local.js`)).text()
    assert.match(localScript, /fromSeq=/)
    assert.match(localScript, /new EventSource/)
    assert.match(localScript, /delete-session/)

    const loggedIn = await fetch(`${f.server.url}/api/local/auth/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'correct horse battery staple' }) })
    const session = cookie(loggedIn)
    const { csrf } = await loggedIn.json() as { csrf: string }
    const authenticated = { cookie: session, 'x-wemux-csrf': csrf, 'content-type': 'application/json' }
    assert.equal((await fetch(`${f.server.url}/api/local/workbench/sessions`, { headers: { cookie: session } })).status, 200)
    assert.equal((await fetch(`${f.server.url}/api/local/workbench/sessions/local-session/events?fromSeq=bad`, { headers: { cookie: session } })).status, 400)
    assert.equal((await fetch(`${f.server.url}/api/local/workbench/sessions`, { method: 'POST', headers: { cookie: session, 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId: 'local-workspace', agentKey: 'test', modelId: 'test' }) })).status, 403)
    assert.equal((await fetch(`${f.server.url}/api/local/workbench/sessions`, { method: 'POST', headers: authenticated, body: JSON.stringify({ workspaceId: 'local-workspace', agentKey: 'test', modelId: 'test' }) })).status, 201)
    assert.equal((await fetch(`${f.server.url}/api/local/workbench/sessions/local-session/messages`, { method: 'POST', headers: authenticated, body: JSON.stringify({ content: 'hello' }) })).status, 202)
    assert.equal((await fetch(`${f.server.url}/api/local/workbench/sessions/local-session/queue/enqueue-command/cancel`, { method: 'DELETE', headers: authenticated })).status, 202)
    assert.equal((await fetch(`${f.server.url}/api/local/workbench/sessions/local-session/turns/turn-1/stop`, { method: 'POST', headers: authenticated })).status, 202)
    assert.equal((await fetch(`${f.server.url}/api/local/workbench/sessions/local-session`, { method: 'DELETE', headers: authenticated })).status, 200)
    assert.deepEqual(calls, ['create:test:test', 'enqueue:local-session:hello', 'cancel:local-session:enqueue-command', 'stop:local-session:turn-1', 'delete:local-session'])
    const base = `${f.server.url}/api/local/workbench/sessions/local-session`
    for (const route of ['queue', 'commands', 'approvals']) {
      assert.equal((await fetch(`${base}/${route}`)).status, 401)
      assert.equal((await fetch(`${base}/${route}`, { headers: authenticated })).status, 200)
    }
    for (const [route, body] of [['commands', { name: 'compact', commandId: 'stable' }], ['approvals/a1/resolve', { decision: 'approve' }]] as const) {
      assert.equal((await fetch(`${base}/${route}`, { method: 'POST', headers: { cookie: session }, body: JSON.stringify(body) })).status, 403)
      assert.equal((await fetch(`${base}/${route}`, { method: 'POST', headers: authenticated, body: JSON.stringify(body) })).status, 202)
    }
    assert.ok(calls.includes('command:local-session:compact:stable'))
    assert.ok(calls.includes('approval:local-session:a1:approve'))
    assert.equal((await fetch(`${base}/messages`, { method: 'POST', headers: authenticated, body: JSON.stringify({ content: 'hello', commandId: 'partial' }) })).status, 400)
    const controller = new AbortController()
    const stream = await fetch(`${base}/events?fromSeq=1`, { headers: { cookie: session, 'last-event-id': '41' }, signal: controller.signal })
    await stream.body!.getReader().read()
    controller.abort()
    assert.ok(calls.includes('journal:42'))
    assert.equal((await fetch(`${base}/journal?fromSeq=0&limit=200`, { headers: authenticated })).status, 200)
    assert.ok(calls.includes('journal:0'))
  } finally { await f.cleanup() }
})

test('local control closes active SSE streams during shutdown', async () => {
  const localSession = {
    sessionId: 'local-session' as SessionId,
    binding: { workspaceId: 'local-workspace' as WorkspaceId, agent: { workerId: 'local-worker' as WorkerId, agentKey: 'test' as import('@wemux/domain').AgentKey }, modelId: 'test' as import('@wemux/domain').ModelId },
    runtimeState: 'idle' as const, activeTurnId: null, nativeSession: null, updatedAt: new Date().toISOString() as Timestamp,
  }
  const workbench = {
    listDirectories: async () => [], addDirectory: async () => { throw new Error('unused') }, listSessions: async () => [localSession], createSession: async () => localSession,
    deleteSession: async () => ({ commandId: 'd' as import('@wemux/domain').CommandId, status: 'accepted' as const }),
    enqueue: async () => ({ commandId: 'e' as import('@wemux/domain').CommandId, status: 'accepted' as const }),
    queue: async () => [], approvals: async () => [], supportedCommands: async () => [], command: async () => ({ commandId: 'c' as import('@wemux/domain').CommandId, status: 'accepted' as const }),
    resolveApproval: async () => ({ commandId: 'a' as import('@wemux/domain').CommandId, status: 'accepted' as const }), cancelQueued: async () => ({ commandId: 'q' as import('@wemux/domain').CommandId, status: 'accepted' as const }), stop: async () => ({ commandId: 's' as import('@wemux/domain').CommandId, status: 'accepted' as const }),
    journal: async () => ({ events: [], throughSeq: 0 as import('@wemux/domain').EventSeq, hasMore: false }),
  } satisfies LocalWorkbenchService
  const f = await fixture({ workbench })
  try {
    const login = await fetch(`${f.server.url}/api/local/auth/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'correct horse battery staple' }) })
    const session = cookie(login)
    const controller = new AbortController()
    const stream = fetch(`${f.server.url}/api/local/workbench/sessions/local-session/events?fromSeq=1`, { headers: { cookie: session }, signal: controller.signal }).catch(() => null)
    await new Promise(resolve => setTimeout(resolve, 30))
    await Promise.race([f.server.close(), new Promise((_, reject) => setTimeout(() => reject(new Error('server close timed out')), 1000))])
    controller.abort(); await stream
  } finally { f.store.close(); await rm(f.home, { recursive: true, force: true }) }
})

test('local status counts only local workbench resources', async () => {
  const f = await fixture()
  try {
    const localWorkerId = `local-${f.installation.installationId}` as WorkerId
    await f.store.transaction(async tx => {
      await tx.workspaces.save({ id: 'local-workspace' as WorkspaceId, workerId: localWorkerId, projectId: 'local' as ProjectId, spec: { kind: 'composite', memberWorkspaceIds: [] }, rootPath: '/tmp/local', status: 'ready', failureReason: null, updatedAt: new Date().toISOString() as Timestamp })
      await tx.workspaces.save({ id: 'cluster-workspace' as WorkspaceId, workerId: 'cluster-worker' as WorkerId, projectId: 'cluster' as ProjectId, spec: { kind: 'composite', memberWorkspaceIds: [] }, rootPath: '/tmp/cluster', status: 'ready', failureReason: null, updatedAt: new Date().toISOString() as Timestamp })
      await tx.sessions.createSession('local-session' as SessionId, { workspaceId: 'local-workspace' as WorkspaceId, agent: { workerId: localWorkerId, agentKey: 'test' as import('@wemux/domain').AgentKey }, modelId: 'test' as import('@wemux/domain').ModelId })
      await tx.sessions.createSession('cluster-session' as SessionId, { workspaceId: 'cluster-workspace' as WorkspaceId, agent: { workerId: 'cluster-worker' as WorkerId, agentKey: 'test' as import('@wemux/domain').AgentKey }, modelId: 'test' as import('@wemux/domain').ModelId })
    })
    const loggedIn = await fetch(`${f.server.url}/api/local/auth/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'correct horse battery staple' }) })
    const status = await fetch(`${f.server.url}/api/local/status`, { headers: { cookie: cookie(loggedIn) } })
    const body = await status.json() as { local: { workspaces: number; sessions: number } }
    assert.deepEqual(body.local, { workspaces: 1, sessions: 1 })
  } finally { await f.cleanup() }
})

test('local control validates Host, Origin, body size and throttles failed logins', async () => {
  const f = await fixture()
  try {
    assert.equal(await rawRequest(`${f.server.url}/api/local/bootstrap`, { host: 'attacker.example' }), 400)
    const originRejected = await fetch(`${f.server.url}/api/local/bootstrap`, { headers: { origin: 'https://attacker.example' } })
    assert.equal(originRejected.status, 403)
    const tooLarge = await fetch(`${f.server.url}/api/local/auth/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ padding: 'x'.repeat(20_000) }) })
    assert.equal(tooLarge.status, 413)
    for (let index = 0; index < 5; index++) {
      const response = await fetch(`${f.server.url}/api/local/auth/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'wrong password value' }) })
      assert.equal(response.status, 401)
    }
    const throttled = await fetch(`${f.server.url}/api/local/auth/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'correct horse battery staple' }) })
    assert.equal(throttled.status, 429)
  } finally { await f.cleanup() }
})

// Opt in with the local playwright-core entry point; no production dependency.
test('browser: stable login, form capture, selection, bounded history, queue and retry identity', { skip: !process.env.WEMUX_PLAYWRIGHT_MODULE }, async () => {
  const { chromium } = await import(process.env.WEMUX_PLAYWRIGHT_MODULE!)
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] })
  const f = await fixture()
  try {
    const page = await browser.newPage()
    const failures: string[] = []
    page.on('pageerror', (error: Error) => failures.push(error.message))
    let navigations = 0
    page.on('framenavigated', () => navigations++)
    await page.goto(f.server.url)
    await page.waitForTimeout(700)
    assert.equal(navigations, 1)
    await page.locator('[name=username]').fill('owner')
    await page.locator('[name=password]').fill('wrong password value')
    await page.locator('#login button').click()
    await page.locator('#error').filter({ hasText: '用户名或密码错误' }).waitFor()
    assert.equal(navigations, 1)
    const binding = { workspaceId: 'directory', agent: { workerId: 'local', agentKey: 'pi' }, modelId: 'second' }
    const localSessions = [{ sessionId: 'one', binding, activeTurnId: 'turn' }, { sessionId: 'two', binding, activeTurnId: null }]
    const queued: { submissionCommandId: string; message: { content: string } }[] = []
    const submissions: Record<string, unknown>[] = []
    const journalRequests: string[] = []
    let lost = true, approved = false, compacted = false, delayOldSession = false
    await page.route('**/api/local/status', async (route: any) => {
      const response = await route.fetch(), data = await response.json()
      data.capabilities = ['test', 'pi'].map(agentKey => ({ agentKey, displayName: agentKey, mode: 'execution', availability: { status: 'available' }, models: ['first', 'second'].map(modelId => ({ modelId, displayName: modelId })) }))
      await route.fulfill({ json: data })
    })
    await page.route('**/api/local/workbench/**', async (route: any) => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname
      if (path.endsWith('/directories')) return route.fulfill({ json: request.method() === 'POST' ? {} : { items: [{ workspaceId: 'directory', name: 'repo', path: '/tmp/repo' }] } })
      if (path.endsWith('/sessions')) return route.fulfill({ json: request.method() === 'POST' ? localSessions[0] : { items: localSessions } })
      if (path.endsWith('/journal')) {
        journalRequests.push(url.search)
        const id = path.split('/')[5], start = Number(url.searchParams.get('fromSeq'))
        if (delayOldSession && id === 'one') await new Promise(resolve => setTimeout(resolve, 400))
        const events = (delayOldSession && id === 'one' ? [999] : start === 0 ? [401, 402] : [201, 202]).map(seq => ({ sessionId: id, seq, payload: { kind: 'assistant.text.delta', turnId: id, text: String(seq) } }))
        return route.fulfill({ json: { events, hasMore: start !== 0, throughSeq: events.at(-1)!.seq } })
      }
      if (path.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 100000\n\nid: 402\nevent: journal\ndata: '+JSON.stringify({ sessionId: path.split('/')[5], seq: 402, payload: { kind: 'assistant.text.delta', turnId: path.split('/')[5], text: '402' } })+'\n\n' })
      if (path.endsWith('/queue')) return route.fulfill({ json: { items: queued } })
      if (path.endsWith('/approvals')) return route.fulfill({ json: { items: approved ? [] : [{ kind: 'approval.requested', approvalId: 'a', turnId: 'turn', reason: '允许执行工具？' }] } })
      if (path.endsWith('/resolve')) { approved = true; return route.fulfill({ json: { status: 'accepted' } }) }
      if (path.endsWith('/commands')) { if (request.method() === 'POST') compacted = true; return route.fulfill({ json: { items: ['compact'] } }) }
      if (path.endsWith('/cancel')) { queued.length = 0; return route.fulfill({ json: { status: 'accepted' } }) }
      if (path.endsWith('/messages')) {
        const body = request.postDataJSON(); submissions.push(body)
        if (lost) { lost = false; return route.abort('failed') }
        queued.push({ submissionCommandId: body.commandId, message: { content: body.content } })
        return route.fulfill({ json: { status: 'accepted' } })
      }
      return route.fulfill({ json: {} })
    })
    await page.locator('[name=password]').fill('correct horse battery staple')
    await page.locator('#login button').click()
    await page.locator('#conversation').waitFor({ state: 'visible' })
    await page.locator('#timeline').filter({ hasText: '401402' }).waitFor()
    await page.waitForTimeout(300)
    assert.equal(journalRequests.length, 1)
    assert.equal(await page.locator('#timeline p').textContent(), '401402')
    await page.locator('[name=agentKey]').selectOption('pi')
    await page.locator('[name=modelId]').selectOption('second')
    await page.locator('#directory-form [name=path]').fill('/tmp')
    await page.locator('#directory-form button').click()
    await page.waitForTimeout(200)
    assert.equal(await page.locator('[name=agentKey]').inputValue(), 'pi')
    assert.equal(await page.locator('[name=modelId]').inputValue(), 'second')
    assert.equal(await page.locator('#directory-form [name=path]').inputValue(), '')
    assert.equal(await page.locator('#send-message').isEnabled(), true)
    await page.locator('#approvals button').filter({ hasText: '批准' }).click()
    await page.locator('#compact').click()
    await page.waitForTimeout(100)
    assert.equal(approved, true)
    assert.equal(compacted, true)
    await page.locator('[name=content]').fill('queued text')
    await page.locator('#send-message').click()
    await page.locator('#workbench-error').filter({ hasText: 'fetch' }).waitFor()
    await page.locator('#send-message').click()
    await page.locator('#queue').filter({ hasText: 'queued text' }).waitFor()
    assert.deepEqual(submissions[0], submissions[1])
    assert.equal(await page.locator('[name=content]').inputValue(), '')
    await page.locator('#queue button').click()
    await page.waitForTimeout(200)
    assert.equal(await page.locator('#queue').textContent(), '')
    await page.locator('#load-older').click()
    await page.locator('#timeline p').filter({ hasText: '201202401402' }).waitFor()
    assert.equal(journalRequests.length, 2)
    delayOldSession = true
    await page.evaluate(() => { void (globalThis as unknown as { renderJournal(): Promise<void> }).renderJournal() })
    await page.locator('#session-select').selectOption('two')
    await page.waitForTimeout(650)
    assert.equal(await page.locator('#timeline p').textContent(), '401402')
    assert.deepEqual(failures, [])
    await page.screenshot({ path: '/tmp/local-m2-browser.png', fullPage: true })
  } finally { await browser.close(); await f.cleanup() }
})
