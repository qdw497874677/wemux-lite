import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { createWemuxServer } from '../server/src/server.ts'
import { provisionAdministrator } from './session.ts'

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> { let latest: T | undefined; for (let attempt = 0; attempt < 240; attempt++) { latest = await read(); if (accept(latest)) return latest; await delay(25) } assert.fail(`Timed out: ${JSON.stringify(latest)}`) }
function workerProcess(args: string[]): ChildProcess { return spawn(process.execPath, ['--import', 'tsx', new URL('../worker/src/cli.ts', import.meta.url).pathname, ...args], { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }) }
async function completed(child: ChildProcess) { let stdout = '', stderr = ''; child.stdout?.setEncoding('utf8').on('data', chunk => { stdout += chunk }); child.stderr?.setEncoding('utf8').on('data', chunk => { stderr += chunk }); const code = await new Promise<number | null>(resolve => child.once('close', resolve)); return { stdout, stderr, code } }

test('feishu fixture vertical slice: challenge -> event -> Session -> reply, duplicate is once', { timeout: 45_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wemux-feishu-')), workerHome = join(directory, 'worker'), repository = join(directory, 'repository')
  const pushed: Array<{ body: any; authorization: string | undefined }> = []
  const fixture = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
    if (request.url === '/open-apis/auth/v3/tenant_access_token/internal') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ code: 0, tenant_access_token: 'fixture-tenant-token', expire: 7200 })); return }
    if (request.url?.startsWith('/open-apis/im/v1/messages')) { pushed.push({ body: JSON.parse(Buffer.concat(chunks).toString()), authorization: request.headers.authorization }); response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ code: 0, data: { message_id: 'om_reply' } })); return }
    response.writeHead(404); response.end()
  })
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve)); const address = fixture.address(); assert.ok(address && typeof address === 'object')
  const apiBase = `http://127.0.0.1:${address.port}/open-apis`
  const server = createWemuxServer({ databasePath: join(directory, 'server.sqlite'), administratorEmails: ['e2e-owner@example.com'], channelEncryptionKey: 'e2e-feishu-key', channelFetch: fetch, feishuApiBaseUrl: apiBase })
  const baseUrl = await server.listen(0); let worker: ChildProcess | undefined
  t.after(async () => { if (worker && worker.exitCode === null) { worker.kill('SIGTERM'); await new Promise(resolve => worker!.once('close', resolve)) } await server.close(); await new Promise<void>(resolve => fixture.close(() => resolve())); await rm(directory, { recursive: true, force: true }) })
  const session = await provisionAdministrator({ store: server.store, baseUrl }), api = session.api
  assert.equal((await completed(spawn('git', ['init', '--initial-branch=main', repository]))).code, 0)
  assert.equal((await completed(spawn('git', ['-C', repository, '-c', 'user.name=E2E', '-c', 'user.email=e2e@example.com', 'commit', '--allow-empty', '-m', 'initial']))).code, 0)
  const enrollment = await api('/enrollment-tokens', 'POST', {}), registration = await completed(workerProcess(['register', '--home', workerHome, '--server', baseUrl, `--token=${enrollment.token}`, '--name', 'Feishu Worker']))
  assert.equal(registration.code, 0, registration.stderr); const workerId = JSON.parse(registration.stdout).workerId
  const project = await api('/projects', 'POST', { name: 'Feishu Project' }), provision = await api('/workspaces', 'POST', { projectId: project.id, workerId, name: 'Feishu Workspace', repository: { gitUrl: repository, revision: 'main' } })
  worker = workerProcess(['start', '--home', workerHome, '--name', 'Feishu Worker'])
  await eventually(() => api(`/workspaces/${provision.workspace.id}`), value => value.status === 'ready' || value.placements?.some((item: { status: string }) => item.status === 'ready'))
  const created = await api('/sessions', 'POST', { requestId: 'feishu-session', workspaceId: provision.workspace.id, title: 'Feishu Session', agentKey: 'test', modelId: 'test' })
  await eventually(() => api(`/commands/${created.commandId}`), value => value.status === 'accepted')
  const channel = await api(`/projects/${project.id}/channels`, 'POST', { requestId: 'feishu-create', kind: 'feishu', name: '飞书机器人', appId: 'cli_fixture', appSecret: 'secret', verificationToken: 'verification-fixture', encryptKey: null })
  assert.equal(channel.channel.kind, 'feishu')
  await api(`/projects/${project.id}/channel-bindings`, 'POST', { requestId: 'feishu-binding', channelId: channel.channel.id, externalConversationKey: 'oc_fixture_chat', sessionId: created.session.id, senderAllowlist: [] })
  const hook = `${baseUrl}/hooks/feishu/${channel.channel.id}`
  const challenge = await fetch(hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'verification-fixture', type: 'url_verification', challenge: 'challenge-ok' }) })
  assert.equal(challenge.status, 200); assert.equal((await challenge.json()).challenge, 'challenge-ok')
  const event = { schema: '2.0', header: { event_id: 'evt-e2e-1', event_type: 'im.message.receive_v1', token: 'verification-fixture', app_id: 'cli_fixture', tenant_key: 'tenant' }, event: { sender: { sender_id: { open_id: 'ou_sender' }, sender_type: 'user' }, message: { message_id: 'om_1', chat_id: 'oc_fixture_chat', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: 'hello feishu' }) } } }
  const send = () => fetch(hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event) })
  assert.equal((await send()).status, 200); assert.equal((await send()).status, 200)
  const page = await eventually(() => api(`/sessions/${created.session.id}/events?fromSeq=1&limit=100`), value => value.events.some((item: { payload: { kind: string; outcome?: string } }) => item.payload.kind === 'turn.finished' && item.payload.outcome === 'completed'))
  assert.equal(page.events.filter((item: { payload: { kind: string } }) => item.payload.kind === 'message.queued').length, 1)
  await eventually(async () => pushed, value => value.length === 1)
  assert.equal(pushed[0]!.authorization, 'Bearer fixture-tenant-token'); assert.equal(JSON.parse(pushed[0]!.body.content).text, 'Echo: hello feishu'); assert.equal(pushed[0]!.body.receive_id, 'oc_fixture_chat'); assert.match(pushed[0]!.body.uuid, /^[0-9a-f-]{36}$/)
  const diagnostics = await api(`/projects/${project.id}/channels`); assert.equal(diagnostics.inbound.length, 1); assert.equal(diagnostics.inbound[0].status, 'enqueued'); assert.equal(diagnostics.outbound[0].status, 'delivered')
})
