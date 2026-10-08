import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { CapabilityGateway, httpOrigin } from '../src/capabilities/gateway.js'
import { FilesystemAgentLaunchContextProvider } from '../src/application/agent-launch-context-provider.js'
import { handleMcpRequest } from '../src/capabilities/mcp-server.js'
import { invokeCapability, parseInvocation } from '../src/agent-cli.js'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const runtime = { snapshot: { projectId: 'p1', sessionId: 'session', issuedAt: '2026-01-01T00:00:00.000Z', assets: [
  { id: 'a1', projectId: 'p1', kind: 'instruction', name: 'rules', content: 'Test everything.', checksum: hash('Test everything.'), targetPath: null },
  { id: 'a2', projectId: 'p1', kind: 'skill', name: 'review', content: '# Review\nReview carefully.', checksum: hash('# Review\nReview carefully.'), targetPath: 'review/SKILL.md' },
], collaboration: { version: 7, canonicalSessionId: 'session', roster: [{ agentId: 'session-b', agentKey: 'test:b', sessionId: 'session-b', workerId: 'worker-1', projectId: 'p1', status: 'idle' }], instructions: '# Wemux Agent 协作协议\n使用 delegation_request。\n精确 [SILENT] 不渲染。' } }, endpoint: 'server', token: 'secret' } as any

test('materializes immutable launch assets and keeps secrets out of files', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wemux-capabilities-'))
  try {
    const provider = new FilesystemAgentLaunchContextProvider(home, 'http://127.0.0.1:9')
    const prepared = await provider.prepare({ id: 'turn' as any, sessionId: 'session' as any, commandId: 'command' as any, message: { messageId: 'message' as any, content: 'hello' }, state: 'queued', requestedAt: '2026-01-01T00:00:00.000Z', startedAt: null, finishedAt: null, capabilitySnapshot: runtime.snapshot, capabilityToken: runtime.token } as any)
    const context = prepared.context!
    assert.match(context.instructions!, /Test everything/)
    assert.match(context.instructions!, /Wemux Agent 协作协议/)
    assert.match(context.instructions!, /\[SILENT\]/)
    assert.match(await readFile(join(context.skillsRoot!, 'review', 'SKILL.md'), 'utf8'), /Review carefully/)
    assert.equal(JSON.stringify(context).includes('secret'), true)
    assert.equal((await readFile(join(context.assetsRoot, 'execution-spec.json'), 'utf8')).includes('secret'), false)
    await assert.rejects(() => provider.prepare({ id: 'turn-2' as any, sessionId: 'session' as any, commandId: 'command-2' as any, message: { messageId: 'message-2' as any, content: 'hello again' }, state: 'queued', requestedAt: '2026-01-01T00:00:00.000Z', startedAt: null, finishedAt: null, capabilitySnapshot: runtime.snapshot, capabilityToken: runtime.token } as any), /already active/)
    await prepared.cleanup()
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('gateway proxies bearer capability calls and CLI parses commands', async t => {
  const upstream = await import('node:http').then(({ createServer }) => createServer((request, response) => { response.writeHead(request.headers.authorization === 'Bearer secret' ? 200 : 401, { 'content-type': 'application/json' }); response.end(JSON.stringify({ path: request.url })) }))
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address() as any
  const gateway = new CapabilityGateway(`http://127.0.0.1:${address.port}`)
  const endpoint = await gateway.listen()
  t.after(async () => { await gateway.close(); await new Promise<void>(resolve => upstream.close(() => resolve())) })
  const result = await invokeCapability({ operation: 'session.info', input: {} }, { WEMUX_CAPABILITY_ENDPOINT: endpoint, WEMUX_CAPABILITY_TOKEN: 'secret' } as any) as any
  assert.equal(result.path, '/agent-capabilities/session.info')
  assert.equal(httpOrigin(`ws://127.0.0.1:${address.port}/worker/ws`), `http://127.0.0.1:${address.port}/`)
  assert.equal(httpOrigin(`wss://example.test/worker/ws?x=1`), 'https://example.test/')
  assert.equal(parseInvocation(['agent', 'send', '--to', 'a', '--content', 'b']).operation, 'agent.send')
  assert.deepEqual(parseInvocation(['project', 'list']), { operation: 'project.list', input: {} })
  assert.deepEqual(parseInvocation(['project', 'resources', '--project-id', 'p']), { operation: 'project.resources', input: { projectId: 'p' } })
  assert.deepEqual(parseInvocation(['session', 'get', '--session-id', 's']), { operation: 'session.get', input: { sessionId: 's' } })
  assert.deepEqual(parseInvocation(['task', 'create', '--project-id', 'p', '--request-id', 'once', '--title', 'Investigate']), { operation: 'task.create', input: { projectId: 'p', requestId: 'once', title: 'Investigate' } })
  assert.deepEqual(parseInvocation(['task', 'sessions', '--project-id', 'p', '--task-id', 't', '--limit', '2', '--cursor', '1']), { operation: 'task.sessions', input: { projectId: 'p', taskId: 't', limit: 2, cursor: '1' } })
  assert.deepEqual(parseInvocation(['session', 'events', '--session-id', 's', '--from-seq', '9']), { operation: 'session.events', input: { sessionId: 's', fromSeq: 9 } })
  assert.throws(() => parseInvocation(['task', 'list', '--project-id', 'p', '--limit', '0']), /positive safe integer/)
})

test('CLI and MCP surface structured capability denial and idempotency conflicts', async t => {
  const upstream = await import('node:http').then(({ createServer }) => createServer((request, response) => {
    response.writeHead(request.url?.endsWith('/task.create') ? 409 : 400, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: request.url?.endsWith('/task.create') ? { code: 'request_conflict', message: 'Request id reused with different content' } : { code: 'invalid_request', message: 'Missing requestId' } }))
  }))
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  t.after(async () => new Promise<void>(resolve => upstream.close(() => resolve())))
  const gateway = new CapabilityGateway(`http://127.0.0.1:${(upstream.address() as { port: number }).port}`)
  const endpoint = await gateway.listen()
  t.after(() => gateway.close())
  const previous = process.env.WEMUX_CAPABILITY_ENDPOINT, previousToken = process.env.WEMUX_CAPABILITY_TOKEN
  process.env.WEMUX_CAPABILITY_ENDPOINT = endpoint
  process.env.WEMUX_CAPABILITY_TOKEN = 'synthetic-test-token'
  t.after(() => { if (previous === undefined) delete process.env.WEMUX_CAPABILITY_ENDPOINT; else process.env.WEMUX_CAPABILITY_ENDPOINT = previous; if (previousToken === undefined) delete process.env.WEMUX_CAPABILITY_TOKEN; else process.env.WEMUX_CAPABILITY_TOKEN = previousToken })
  await assert.rejects(invokeCapability({ operation: 'task.list', input: {} }), /invalid_request: Missing requestId/)
  await assert.rejects(handleMcpRequest({ method: 'tools/call', params: { name: 'wemux_task_create', arguments: { projectId: 'p', title: 'new', requestId: 'reused' } } }), /request_conflict: Request id reused with different content/)
})

test('MCP exposes the minimal tool surface', async () => {
  const listed = await handleMcpRequest({ method: 'tools/list' })
  assert.deepEqual(listed.tools.map((tool: any) => tool.name), ['wemux_session_info', 'wemux_project_list', 'wemux_project_get', 'wemux_project_resources', 'wemux_task_list', 'wemux_task_get', 'wemux_task_create', 'wemux_task_sessions', 'wemux_session_get', 'wemux_session_events', 'wemux_agent_list', 'wemux_agent_send', 'wemux_inbox_list', 'wemux_inbox_read', 'wemux_delegation_accept', 'wemux_delegation_reject', 'wemux_delegation_complete', 'mcp_list_tools', 'mcp_call', 'http_call'])
})
