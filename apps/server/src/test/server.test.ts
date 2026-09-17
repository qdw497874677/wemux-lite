import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import { WebSocket } from 'ws'
import type { ServerToWorker } from '@wemux/wire-protocol'
import { createWemuxServer } from '../server.js'

const realDateNow = Date.now
const token = 'integration-bootstrap-token-12345'

const capability = { agentKey: 'pi', displayName: 'Pi', version: '1', mode: 'execution', availability: { status: 'available' }, models: [{ modelId: 'test-model', displayName: 'Test', source: 'configured' }] }
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function eventually(check: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await delay(20) }
  assert.fail('Timed out waiting for condition')
}
class Peer {
  readonly messages: ServerToWorker[] = []
  private counter = 0
  constructor(readonly ws: WebSocket) { ws.on('message', data => this.messages.push(JSON.parse(data.toString()) as ServerToWorker)) }
  send(message: Record<string, unknown>) { this.ws.send(JSON.stringify({ protocolVersion: 1, messageId: `worker-message-${++this.counter}`, ...message })) }
  async wait(predicate: (message: ServerToWorker) => boolean): Promise<ServerToWorker> {
    await eventually(async () => this.messages.some(predicate))
    return this.messages.splice(this.messages.findIndex(predicate), 1)[0]
  }
  async close() { if (this.ws.readyState === WebSocket.CLOSED) return; const done = once(this.ws, 'close'); this.ws.close(); await done }
}

test('serves an installer and configured Worker tarball without exposing enrollment credentials', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wemux-lite-download-')), tarballPath = join(dir, 'wemux-lite-worker.tgz')
  await writeFile(tarballPath, Buffer.from('fake-worker-package'))
  const app = createWemuxServer({ databasePath: ':memory:', bootstrapToken: token, workerPackagePath: tarballPath })
  const base = await app.listen(0)
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }) })
  const scriptResponse = await fetch(`${base}/downloads/install-worker.sh`)
  const script = await scriptResponse.text()
  assert.equal(scriptResponse.status, 200)
  assert.match(scriptResponse.headers.get('content-type') ?? '', /text\/x-shellscript/)
  assert.match(script, /WEMUX_SERVER_URL \(or WEMUX_SERVER_URLS\) is required/)
  assert.match(script, /\/downloads\/worker\.tgz/)
  assert.match(script, /server addresses must start with http:\/\/ or https:\//)
  assert.match(script, /--proto '=http,https' --proto-redir '=http,https' -fsS --connect-timeout 10/)
  assert.match(script, /no_proxy_extra=.*100\.64\.0\.0\/10/, '内网/tailnet 网段默认绕过全局代理')
  assert.match(script, /for candidate in .*tr ',' ' /, '逐候选地址下载 worker 包')
  assert.equal(script.includes(token), false)
  const rootResponse = await fetch(`${base}/`)
  assert.equal(rootResponse.status, 401)
  const packageResponse = await fetch(`${base}/downloads/worker.tgz`)
  assert.equal(packageResponse.status, 200)
  assert.equal(await packageResponse.text(), 'fake-worker-package')
  assert.match(packageResponse.headers.get('content-disposition') ?? '', /attachment/)
})

test('rejects a directory configured as the Worker package', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wemux-lite-download-directory-'))
  const app = createWemuxServer({ databasePath: ':memory:', bootstrapToken: token, workerPackagePath: dir })
  const base = await app.listen(0)
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }) })
  const response = await fetch(`${base}/downloads/worker.tgz`)
  assert.equal(response.status, 503)
  assert.match(await response.text(), /Worker package is unavailable/)
})

test('returns 503 when the Worker package was not configured', async t => {
  const app = createWemuxServer({ databasePath: ':memory:', bootstrapToken: token })
  const base = await app.listen(0)
  t.after(() => app.close())
  const response = await fetch(`${base}/downloads/worker.tgz`)
  assert.equal(response.status, 503)
  assert.match(await response.text(), /Worker package is not configured/)
})

test('serves the web UI bundle with SPA fallback without masking API 404s', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wemux-lite-static-'))
  const root = join(dir, 'dist')
  await mkdir(join(root, 'assets'), { recursive: true })
  await writeFile(join(root, 'index.html'), '<!doctype html><title>wemux</title>')
  await writeFile(join(root, 'assets', 'app.js'), 'console.log(1)')
  const app = createWemuxServer({ databasePath: ':memory:', bootstrapToken: token, webStaticPath: root })
  const base = await app.listen(0)
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }) })

  const index = await fetch(`${base}/`)
  assert.equal(index.status, 200)
  assert.match(index.headers.get('content-type') ?? '', /text\/html/)
  assert.match(await index.text(), /wemux/)

  const asset = await fetch(`${base}/assets/app.js`)
  assert.equal(asset.status, 200)
  assert.match(asset.headers.get('content-type') ?? '', /text\/javascript/)
  assert.equal(await asset.text(), 'console.log(1)')

  const deepLink = await fetch(`${base}/console/deep/link`, { headers: { accept: 'text/html,application/xhtml+xml' } })
  assert.equal(deepLink.status, 200)
  assert.match(await deepLink.text(), /wemux/)

  const apiMiss = await fetch(`${base}/no-such-endpoint`, { headers: { accept: 'application/json', authorization: `Bearer ${token}` } })
  assert.equal(apiMiss.status, 404)
  assert.match(await apiMiss.text(), /Not found/)

  const prefixed = await fetch(`${base}/api/bootstrap`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
  assert.equal(prefixed.status, 200)

  const traversal = await fetch(`${base}/..%2f..%2f..%2fetc%2fpasswd`, { headers: { accept: 'text/html' } })
  assert.equal(traversal.status, 200)
  assert.match(traversal.headers.get('content-type') ?? '', /text\/html/)
  assert.equal((await traversal.text()).includes('root:'), false)
})

test('installer downloads, installs, registers and starts with stubbed tools', { timeout: 15000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wemux-lite-installer-'))
  const workerPackage = join(dir, 'worker.tgz')
  await writeFile(workerPackage, 'fake-worker-package')
  const app = createWemuxServer({ databasePath: ':memory:', bootstrapToken: token, workerPackagePath: workerPackage })
  const base = await app.listen(0)
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }) })
  const script = await (await fetch(`${base}/downloads/install-worker.sh`)).text()
  const scriptPath = join(dir, 'install.sh')
  await writeFile(scriptPath, script)
  const log = join(dir, 'calls.log')
  const stub = (name: string, lines: string[]) => {
    const path = join(dir, name)
    writeFileSync(path, ['#!/bin/sh', ...lines].join('\n') + '\n')
    chmodSync(path, 0o755)
  }
  const path = () => `${dir}:${process.env.PATH ?? ''}`
  stub('curl', [
    `printf 'curl\\n' >> '${log}'`,
    "previous=''",
    'for argument in "$@"; do',
    `  if [ "$previous" = '-o' ]; then printf 'fake-tarball' > "$argument"; fi`,
    '  previous="$argument"',
    'done',
  ])
  stub('npm', [`printf 'npm %s\\n' "$*" >> '${log}'`])
  stub('wemux-lite-worker', [`[ "$1" = version ] && printf 'wemux-lite-worker 0.1.0\\n'`, `printf 'wemux-lite-worker %s\\n' "$*" >> '${log}'`])
  const run = (extra: Record<string, string> = {}) => spawnSync('sh', [scriptPath], {
    env: { ...process.env, PATH: path(), WEMUX_SERVER_URL: base, WEMUX_ENROLLMENT_TOKEN: 'stub-enrollment-token', WEMUX_WORKER_NAME: 'Stub node', ...extra },
  })
  const lines = () => readFileSync(log, 'utf8').split('\n').filter(Boolean)

  const completed = run()
  assert.equal(completed.status, 0, completed.stderr.toString())
  const executed = lines()
  assert.equal(executed[0], 'curl')
  assert.match(executed[1] ?? '', /^npm install --global .+\/wemux-lite-worker\.[^/]+\/worker\.tgz$/)
  assert.match(executed[2] ?? '', /^wemux-lite-worker version$/)
  assert.equal(executed[3], `wemux-lite-worker register --server ${base} --servers ${base} --name Stub node`)
  assert.equal(executed[4], 'wemux-lite-worker start')

  writeFileSync(log, '')
  stub('wemux-lite-worker', [`[ "$1" = version ] && printf 'wemux-lite-worker 0.1.0\\n'`, `printf 'wemux-lite-worker %s\\n' "$*" >> '${log}'`, '[ "$1" != register ]'])
  const failed = run()
  assert.notEqual(failed.status, 0)
  assert.equal(lines().includes('wemux-lite-worker start'), false)
  assert.match(lines().at(-1) ?? '', /wemux-lite-worker register --server/)

  writeFileSync(log, '')
  stub('wemux-lite-worker', ['exit 1'])
  const shadowed = run()
  assert.equal(shadowed.status, 70)
  assert.match(shadowed.stderr.toString(), /missing or shadowed/)

  writeFileSync(log, '')
  const manual = run({ WEMUX_ENROLLMENT_TOKEN: '' })
  assert.equal(manual.status, 0)
  assert.match(manual.stdout.toString(), /wemux-lite-worker register/)
  assert.equal(lines().includes('curl'), true)
  assert.equal(lines().some(line => line.includes('register')), false)

  const missingName = run({ WEMUX_WORKER_NAME: '' })
  assert.equal(missingName.status, 64)
  assert.match(missingName.stderr.toString(), /WEMUX_WORKER_NAME is required/)

  // nc 模式：下载不经 curl，改由 node 经 tailscale nc 隧道取包，注册/启动带 --transport nc
  writeFileSync(log, '')
  stub('tailscale', [`printf 'tailscale %s\\n' "$*" >> '${log}'`])
  stub('node', [
    `previous=''`,
    'for argument in "$@"; do',
    "  if [ \"$previous\" = '-o' ]; then printf 'fake-tarball' > \"$argument\"; fi",
    '  previous="$argument"',
    'done',
    `printf 'node tunnel %s:%s%s \\n' \"$3\" \"$4\" \"$5\" >> '${log}'`,
  ])
  stub('wemux-lite-worker', [`[ "$1" = version ] && printf 'wemux-lite-worker 0.1.0\\n'`, `printf 'wemux-lite-worker %s\\n' "$*" >> '${log}'`])
  const viaNc = run({ WEMUX_TRANSPORT: 'nc' })
  assert.equal(viaNc.status, 0, viaNc.stderr.toString())
  const ncLines = lines()
  assert.equal(ncLines.some(line => line.startsWith('npm install --global')), true)
  assert.equal(ncLines.some(line => /^wemux-lite-worker register .+ --transport nc$/.test(line)), true, JSON.stringify(ncLines))
  assert.equal(ncLines.includes('wemux-lite-worker start --transport nc'), true)
  assert.equal(ncLines.some(line => line.startsWith('curl')), false)
})

test('bootstrap secret issues an expiring persisted admin session', async t => {
  // Keep HTTP scheduling real, but make expiry independent of CI load.
  let currentTime = Date.now()
  t.mock.method(Date, 'now', () => currentTime)
  const app = createWemuxServer({ databasePath: ':memory:', bootstrapToken: token, adminSessionTtlMs: 25 })
  const base = await app.listen(0)
  try {
    const issued = await fetch(`${base}/auth/session`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
    assert.equal(issued.status, 201)
    const session = await issued.json() as { token: string; expiresAt: string; teamId: string }
    assert.match(session.token, /^wemux-session-/)
    assert.equal(typeof session.expiresAt, 'string')
    assert.equal(typeof session.teamId, 'string')
    assert.equal((await fetch(`${base}/workers`, { headers: { authorization: `Bearer ${session.token}` } })).status, 200)
    currentTime += 35
    assert.equal((await fetch(`${base}/workers`, { headers: { authorization: `Bearer ${session.token}` } })).status, 401)
    assert.equal((await fetch(`${base}/auth/session`, { method: 'POST', headers: { authorization: `Bearer ${session.token}` } })).status, 401)
  } finally { await app.close() }
})

test('the test after admin session expiry has the real clock (no filesystem)', async () => {
  assert.equal(Date.now, realDateNow)
  const before = Date.now()
  await delay(5)
  assert.ok(Date.now() > before)
  assert.ok(Math.abs(Date.now() - new Date().getTime()) < 1000)
})

test('HTTP + SQLite + Worker WS + SSE durable end-to-end loop', { timeout: 20000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wemux-lite-server-')), databasePath = join(dir, 'server.sqlite')
  let app = createWemuxServer({ databasePath, bootstrapToken: token }), base = await app.listen(0)
  const peers: Peer[] = []
  t.after(async () => { for (const p of peers) await p.close(); await app.close(); await rm(dir, { recursive: true, force: true }) })
  async function request(path: string, method = 'GET', body?: unknown, bearer: string | null = token) {
    const response = await fetch(`${base}${path}`, { method, headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, data: response.status === 204 ? null : await response.json() }
  }
  async function connect(workerId: string, credential: string) {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/worker/ws', { headers: { Authorization: `Bearer ${credential}` } })
    const p = new Peer(ws); peers.push(p); await once(ws, 'open')
    p.send({ type: 'hello', side: 'worker', workerId, workerVersion: 'test', name: 'Test worker', platform: 'linux', architecture: 'x64' })
    await p.wait(m => m.type === 'hello')
    return p
  }
  assert.equal((await request('/health', 'GET', undefined, null)).status, 200)
  assert.equal((await request('/projects', 'GET', undefined, null)).status, 401)
  assert.equal((await request('/bootstrap', 'POST', {}, 'wrong')).status, 401)
  const bootstrap = await request('/bootstrap', 'POST', {})
  assert.equal(bootstrap.status, 200)
  assert.deepEqual((await request('/bootstrap', 'POST', {})).data, bootstrap.data)
  const enrollment = (await request('/enrollment-tokens', 'POST', {})).data
  const enrolled = await request('/workers/enroll', 'POST', { token: enrollment.token, name: 'Test' }, null)
  assert.equal(enrolled.status, 201)
  const { workerId, credential } = enrolled.data
  assert.equal((await request('/workers/enroll', 'POST', { token: enrollment.token, name: 'Replay' }, null)).status, 401)
  assert.equal((await request('/workers', 'GET', undefined, credential)).status, 401)
  const project = (await request('/projects', 'POST', { name: 'Integration' })).data
  const emptyProvision = await request('/workspaces', 'POST', { projectId: project.id, workerId, name: 'Blank', source: 'empty' })
  assert.equal(emptyProvision.status, 201)
  assert.deepEqual(emptyProvision.data.workspace.spec, { kind: 'composite', memberWorkspaceIds: [] })
  const emptyWorkspace = emptyProvision.data.workspace

  const provision = await request('/workspaces', 'POST', { projectId: project.id, workerId, name: 'Repo', repository: { gitUrl: 'https://example.com/repo.git', revision: 'main' } })
  assert.equal(provision.status, 201)
  const workspace = provision.data.workspace
  assert.equal((await request('/sessions', 'POST', { workspaceId: workspace.id, title: 'Chat', agentKey: 'pi', modelId: 'test-model' })).status, 409)
  let peer = await connect(workerId, credential)
  const emptyCommand = await peer.wait(m => m.type === 'command' && m.commandId === emptyProvision.data.commandId)
  if (emptyCommand.type === 'command' && emptyCommand.command.kind === 'workspace.provision') assert.deepEqual(emptyCommand.command.workspace.repositories, [])
  else assert.fail('expected empty workspace provision command')
  peer.send({ type: 'ack', receipt: { commandId: emptyProvision.data.commandId, status: 'accepted' } })
  peer.send({ type: 'event', scope: 'workspace', report: { workspaceId: emptyWorkspace.id, status: 'ready', reason: null, location: { workspaceId: emptyWorkspace.id, workerId, rootPath: '/tmp/blank', checkouts: [] }, occurredAt: new Date().toISOString() } })
  await eventually(async () => (await request(`/workspaces/${emptyWorkspace.id}`)).data.status === 'ready')
  const command = await peer.wait(m => m.type === 'command' && m.commandId === provision.data.commandId)
  assert.equal(command.type, 'command')
  if (command.type === 'command') {
    assert.equal(command.command.kind, 'workspace.provision')
    assert.equal(JSON.stringify(command).includes('rootPath'), false)
  }
  peer.send({ type: 'ack', receipt: { commandId: provision.data.commandId, status: 'accepted' } })
  peer.send({ type: 'capability', workerId, detectedAt: new Date().toISOString(), capabilities: [capability] })
  peer.send({ type: 'event', scope: 'workspace', report: { workspaceId: workspace.id, status: 'ready', reason: null, location: null, occurredAt: new Date().toISOString() } })
  await eventually(async () => (await request(`/workspaces/${workspace.id}`)).data.status === 'ready')
  assert.equal((await request(`/workers/${workerId}/capabilities`)).data.capabilities[0].agentKey, 'pi')
  peer.send({ type: 'heartbeat', nonce: 'ping', sentAt: new Date().toISOString() })
  await peer.wait(m => m.type === 'heartbeat' && m.nonce === 'ping')
  const createBody = { requestId: 'standalone-create', workspaceId: workspace.id, title: 'Chat', agentKey: 'pi', modelId: 'test-model' }
  const created = await request('/sessions', 'POST', createBody)
  assert.equal(created.status, 201)
  const replayedCreate = await request('/sessions', 'POST', createBody)
  assert.equal(replayedCreate.status, 201)
  assert.equal(replayedCreate.data.session.id, created.data.session.id)
  assert.equal(replayedCreate.data.commandId, created.data.commandId)
  assert.equal((await request('/sessions', 'POST', { ...createBody, title: 'Different' })).status, 409)
  const session = created.data.session
  await peer.wait(m => m.type === 'command' && m.commandId === created.data.commandId)
  peer.send({ type: 'ack', receipt: { commandId: created.data.commandId, status: 'accepted' } })
  // Regression: omitted modelId must resolve to the Agent default on the wire (worker protocol requires text)
  const defaultModelCreate = await request('/sessions', 'POST', { requestId: 'default-model-create', workspaceId: workspace.id, title: 'Default model', agentKey: 'pi' })
  assert.equal(defaultModelCreate.status, 201)
  assert.equal(defaultModelCreate.data.session.binding.modelId, null)
  const defaultModelCommand = await peer.wait(m => m.type === 'command' && m.commandId === defaultModelCreate.data.commandId)
  if (defaultModelCommand.type === 'command' && defaultModelCommand.command.kind === 'session.create') assert.equal(defaultModelCommand.command.session.binding.modelId, 'test-model')
  else assert.fail('expected session.create command')
  peer.send({ type: 'ack', receipt: { commandId: defaultModelCreate.data.commandId, status: 'accepted' } })
  const assets = await request(`/projects/${project.id}/capability-assets`, 'PUT', { items: [
    { kind: 'instruction', name: 'team-rules', content: 'Always report test results.' },
    { kind: 'prompt', name: 'review', content: 'Review this change.' },
    { kind: 'skill', name: 'summarize', content: '# Summarize\nSummarize the current work.' },
  ] })
  assert.equal(assets.status, 200)
  assert.equal((await request(`/projects/${project.id}/capability-assets`)).data.items.length, 3)
  const enqueued = await request(`/sessions/${session.id}/messages`, 'POST', { commandId: 'stable-command', content: 'hello' })
  assert.equal(enqueued.status, 202)
  const repeated = await request(`/sessions/${session.id}/messages`, 'POST', { commandId: 'stable-command', content: 'hello' })
  assert.equal(repeated.status, 202, JSON.stringify(repeated.data))
  assert.equal((await request(`/sessions/${session.id}/messages`, 'POST', { commandId: 'stable-command', content: 'changed' })).status, 409)
  const enqueueCommand = await peer.wait(m => m.type === 'command' && m.commandId === 'stable-command')
  assert.equal(enqueueCommand.type, 'command')
  if (enqueueCommand.type !== 'command' || enqueueCommand.command.kind !== 'session.enqueue' || !enqueueCommand.command.capabilities) assert.fail('Expected capability launch contract')
  assert.equal(enqueueCommand.command.capabilities.snapshot.assets.length, 3)
  const capabilityInfo = await fetch(`${base}/agent-capabilities/session.info`, { method: 'POST', headers: { Authorization: `Bearer ${enqueueCommand.command.capabilities.token}`, 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(capabilityInfo.status, 200)
  assert.equal((await capabilityInfo.json() as any).sessionId, session.id)
  const forbidden = await fetch(`${base}/agent-capabilities/agent.send`, { method: 'POST', headers: { Authorization: `Bearer ${enqueueCommand.command.capabilities.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ toAgentId: 'missing', content: 'hello', idempotencyKey: 'one' }) })
  assert.equal(forbidden.status, 404)
  peer.send({ type: 'ack', receipt: { commandId: 'stable-command', status: 'accepted' } })
  await eventually(async () => (await request('/commands/stable-command')).data.status === 'accepted')
  const event = (seq: number) => ({ sessionId: session.id, seq, occurredAt: '2026-01-01T00:00:00.000Z', payload: { kind: 'assistant.text.delta', turnId: 'turn-1', text: `delta-${seq}` } })
  peer.send({ type: 'event', scope: 'session', event: event(2) })
  await peer.wait(m => m.type === 'sync' && m.fromSeq === 1)
  const gap = (await request(`/sessions/${session.id}/events`)).data
  assert.equal(gap.freshness.status, 'gap'); assert.deepEqual(gap.events, [])
  peer.send({ type: 'sync', kind: 'batch', sessionId: session.id, throughSeq: 2, hasMore: false, events: [event(1), event(2)] })
  await eventually(async () => (await request(`/sessions/${session.id}/events`)).data.freshness.status === 'synced')
  peer.send({ type: 'event', scope: 'session', event: event(2) })
  const page = (await request(`/sessions/${session.id}/events?limit=1`)).data
  assert.equal(page.events.length, 1); assert.equal(page.nextSeq, 2)
  const controller = new AbortController()
  const stream = await fetch(`${base}/sessions/${session.id}/stream`, { headers: { Authorization: `Bearer ${token}`, 'Last-Event-ID': '1' }, signal: controller.signal })
  assert.equal(stream.headers.get('content-type'), 'text/event-stream')
  const reader = stream.body!.getReader()
  let streamText = ''
  async function readUntil(needle: string) {
    while (!streamText.includes(needle)) {
      const result = await reader.read(); assert.equal(result.done, false)
      streamText += new TextDecoder().decode(result.value)
    }
  }
  await readUntil('id: 2\n')
  assert.equal(streamText.includes('id: 1\n'), false)
  peer.send({ type: 'event', scope: 'session', event: event(3) })
  await readUntil('id: 3\n')
  controller.abort(); await reader.cancel().catch(() => undefined)
  await peer.close()
  await eventually(async () => (await request('/workers')).data.items[0].connectionState === 'offline')
  assert.equal((await request(`/sessions/${session.id}/events`)).data.freshness.status, 'offline')
  assert.equal((await request(`/sessions/${session.id}/messages`, 'POST', { content: 'reject\0before-persist' })).status, 400)
  const offline = await request(`/sessions/${session.id}/messages`, 'POST', { content: 'persist across restart' })
  await app.close()
  app = createWemuxServer({ databasePath, bootstrapToken: token }); base = await app.listen(0)
  peer = await connect(workerId, credential)
  await peer.wait(m => m.type === 'command' && m.commandId === offline.data.commandId)
  assert.equal(peer.messages.some(m => m.type === 'command' && m.commandId === 'stable-command'), false)
  peer.send({ type: 'sync', kind: 'heads', complete: true, heads: [{ sessionId: session.id, lastSeq: 4 }] })
  await peer.wait(m => m.type === 'sync' && m.fromSeq === 4)
  peer.send({ type: 'sync', kind: 'batch', sessionId: session.id, throughSeq: 4, hasMore: false, events: [event(4)] })
  await eventually(async () => (await request(`/sessions/${session.id}/events`)).data.events.length === 4)
  assert.equal((await request(`/sessions/${session.id}/events`)).data.freshness.status, 'synced')
  assert.equal((await request(`/sessions/${session.id}`, 'PATCH', { title: 'Renamed' })).data.title, 'Renamed')
  assert.equal((await request(`/workspaces/${workspace.id}`, 'DELETE')).status, 501)
  // A durable enqueue not yet observed in Journal is not idle.
  assert.equal((await request(`/sessions/${session.id}`, 'DELETE')).status, 409)
  assert.equal((await request(`/sessions/${session.id}/events`)).status, 200)
  assert.equal((await request(`/workspaces/${workspace.id}`, 'DELETE')).status, 501)
  assert.equal((await request(`/projects/${project.id}`, 'DELETE')).status, 409)
  assert.equal((await request('/sessions')).data.items.length, 2)
  const db = new DatabaseSync(databasePath)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()!.count, 14)
  const records = db.prepare('SELECT data FROM records').all().map(r => String(r.data)).join('\n')
  assert.equal(records.includes(credential), false); assert.equal(records.includes(enrollment.token), false)
  db.close()
})

test('reject unauthorized, malformed and cross-worker protocol writes; atomic enrollment', { timeout: 10000 }, async t => {
  const app = createWemuxServer({ databasePath: ':memory:', bootstrapToken: token }), base = await app.listen(0)
  t.after(() => app.close())
  async function post(path: string, data: unknown) {
    const r = await fetch(base + path, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
    return { status: r.status, data: await r.json() }
  }
  await post('/bootstrap', {})
  const enrollment = (await post('/enrollment-tokens', {})).data
  const attempts = await Promise.all([post('/workers/enroll', { token: enrollment.token, name: 'One' }), post('/workers/enroll', { token: enrollment.token, name: 'Two' })])
  assert.deepEqual(attempts.map(r => r.status).sort(), [201, 401])
  const first = attempts.find(r => r.status === 201)!.data
  const secondToken = (await post('/enrollment-tokens', {})).data.token
  const second = (await post('/workers/enroll', { token: secondToken, name: 'Other' })).data
  const rejected = new WebSocket(base.replace('http:', 'ws:') + '/worker/ws', { headers: { Authorization: 'Bearer bad' } })
  const unauthorized = await new Promise<number>(resolve => {
    rejected.on('unexpected-response', (_req, res) => { resolve(res.statusCode!); res.resume(); rejected.terminate() })
    rejected.on('error', () => undefined)
  })
  assert.equal(unauthorized, 401)
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/worker/ws', { headers: { Authorization: `Bearer ${first.credential}` } })
  const peer = new Peer(ws); await once(ws, 'open')
  peer.send({ type: 'hello', side: 'worker', workerId: second.workerId, workerVersion: '1', name: 'Spoof', platform: 'linux', architecture: 'x64' })
  const error = await peer.wait(m => m.type === 'error')
  assert.equal(error.type === 'error' && error.error.code, 'unauthorized')
  await peer.close()
  const malformed = await fetch(base + '/projects', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: '{' })
  assert.equal(malformed.status, 400)
  assert.equal((await post('/enrollment-tokens', { ttlSeconds: -1 })).status, 400)
})
