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

test('generic webhook vertical slice delivers inbound once and one final assistant callback', { timeout: 45_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wemux-generic-webhook-')), workerHome = join(directory, 'worker'), repository = join(directory, 'repository')
  const callbacks: unknown[] = []
  const receiver = createServer(async (request, response) => { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); callbacks.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))); response.writeHead(204); response.end() })
  await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve)); const receiverAddress = receiver.address(); assert.ok(receiverAddress && typeof receiverAddress === 'object')
  const callbackUrl = `http://127.0.0.1:${receiverAddress.port}/callback`
  const channelFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (requestUrl !== callbackUrl) throw new Error(`Unexpected callback URL: ${requestUrl}`)
    return fetch(input, init)
  }
  const server = createWemuxServer({ databasePath: join(directory, 'server.sqlite'), administratorEmails: ['e2e-owner@example.com'], channelEncryptionKey: 'e2e-channel-key', channelFetch })
  const baseUrl = await server.listen(0); let worker: ChildProcess | undefined
  t.after(async () => { if (worker && worker.exitCode === null) { worker.kill('SIGTERM'); await new Promise(resolve => worker!.once('close', resolve)) } await server.close(); await new Promise<void>(resolve => receiver.close(() => resolve())); await rm(directory, { recursive: true, force: true }) })
  const session = await provisionAdministrator({ store: server.store, baseUrl }), api = session.api
  assert.equal((await completed(spawn('git', ['init', '--initial-branch=main', repository]))).code, 0)
  assert.equal((await completed(spawn('git', ['-C', repository, '-c', 'user.name=E2E', '-c', 'user.email=e2e@example.com', 'commit', '--allow-empty', '-m', 'initial']))).code, 0)
  const enrollment = await api('/enrollment-tokens', 'POST', {}), registration = await completed(workerProcess(['register', '--home', workerHome, '--server', baseUrl, `--token=${enrollment.token}`, '--name', 'Webhook Worker']))
  assert.equal(registration.code, 0, registration.stderr); const workerId = JSON.parse(registration.stdout).workerId
  const project = await api('/projects', 'POST', { name: 'Webhook Project' }), provision = await api('/workspaces', 'POST', { projectId: project.id, workerId, name: 'Webhook Workspace', repository: { gitUrl: repository, revision: 'main' } })
  worker = workerProcess(['start', '--home', workerHome, '--name', 'Webhook Worker'])
  await eventually(() => api(`/workspaces/${provision.workspace.id}`), value => value.status === 'ready' || value.placements?.some((item: { status: string }) => item.status === 'ready'))
  const created = await api('/sessions', 'POST', { requestId: 'webhook-session', workspaceId: provision.workspace.id, title: 'Webhook Session', agentKey: 'test', modelId: 'test' })
  await eventually(() => api(`/commands/${created.commandId}`), value => value.status === 'accepted')
  const channel = await api(`/projects/${project.id}/channels`, 'POST', { requestId: 'channel-create', name: 'Generic Webhook', callbackUrl: null, sourceCidrs: [] })
  assert.equal(typeof channel.issuedToken, 'string')
  const binding = await api(`/projects/${project.id}/channel-bindings`, 'POST', { requestId: 'binding-create', channelId: channel.channel.id, externalConversationKey: 'external-1', sessionId: created.session.id, callbackUrl, senderAllowlist: [] })
  const send = async (deliveryId: string) => fetch(`${baseUrl}/hooks/generic/${channel.channel.id}`, { method: 'POST', headers: { authorization: `Bearer ${channel.issuedToken}`, 'content-type': 'application/json', 'x-wemux-delivery-id': deliveryId, 'x-wemux-timestamp': new Date().toISOString() }, body: JSON.stringify({ conversation: 'external-1', sender: 'fixture', text: 'hello webhook' }) })
  assert.equal((await send('provider-delivery-1')).status, 202); const duplicate = await send('provider-delivery-1'); assert.equal(duplicate.status, 202); assert.equal((await duplicate.json()).duplicate, true)
  const page = await eventually(() => api(`/sessions/${created.session.id}/events?fromSeq=1&limit=100`), value => value.events.some((event: { payload: { kind: string; outcome?: string } }) => event.payload.kind === 'turn.finished' && event.payload.outcome === 'completed'))
  assert.equal(page.events.filter((event: { payload: { kind: string } }) => event.payload.kind === 'message.queued').length, 1)
  assert.equal(page.events.filter((event: { payload: { kind: string } }) => event.payload.kind === 'assistant.text.delta').map((event: { payload: { text: string } }) => event.payload.text).join(''), 'Echo: hello webhook')
  await eventually(async () => callbacks, value => value.length === 1); assert.equal((callbacks[0] as { text: string }).text, 'Echo: hello webhook')
  const diagnostics = await api(`/projects/${project.id}/channels`); assert.equal(diagnostics.inbound[0].status, 'enqueued'); assert.equal(diagnostics.outbound[0].status, 'delivered')
  const rotated = await api(`/projects/${project.id}/channels/${channel.channel.id}/token/rotate`, 'POST', { requestId: 'channel-rotate', expectedRevision: 1 }); assert.equal(typeof rotated.issuedToken, 'string'); assert.equal((await send('provider-old-overlap')).status, 202)
  const newTokenResponse = await fetch(`${baseUrl}/hooks/generic/${channel.channel.id}`, { method: 'POST', headers: { authorization: `Bearer ${rotated.issuedToken}`, 'content-type': 'application/json', 'x-wemux-delivery-id': 'provider-new-token', 'x-wemux-timestamp': new Date().toISOString() }, body: JSON.stringify({ conversation: 'external-1', sender: 'fixture', text: 'hello rotated webhook' }) }); assert.equal(newTokenResponse.status, 202)
  const rotatedReplay = await api(`/projects/${project.id}/channels/${channel.channel.id}/token/rotate`, 'POST', { requestId: 'channel-rotate', expectedRevision: 1 }); assert.equal(rotatedReplay.replayed, true); assert.equal(rotatedReplay.issuedToken, undefined)
  await api(`/projects/${project.id}/channel-bindings/${binding.binding.id}/enabled`, 'POST', { requestId: 'binding-disable', expectedRevision: 1, enabled: false })
  assert.equal((await send('provider-delivery-2')).status, 202)
  await eventually(() => api(`/projects/${project.id}/channels`), value => value.inbound.some((item: { providerEventId: string; status: string }) => item.providerEventId === 'provider-delivery-2' && item.status === 'failed_closed'))
})
