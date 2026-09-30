import assert from 'node:assert/strict'
import { createServer } from 'node:https'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { AgentKey, ModelProviderResourceDefinition, ModelId, SessionId, WorkerId } from '@wemux/domain'
import type { AgentAdapter } from '../worker/src/application/ports/agent-adapter.ts'
import { WorkerRuntime } from '../worker/src/application/runtime.ts'
import { SqliteWorkerStore } from '../worker/src/storage/sqlite-store.ts'
import { LocalProvisioner } from '../worker/src/workspaces/local-provisioner.ts'
import { PiRuntimeSessionAdapter } from '../worker/src/agents/pi-runtime-session-adapter.ts'

const executable = process.env.WEMUX_OFFLINE_PI_EXECUTABLE
const secret = 'offline-pi-provider-local-key-5729'

test('real Pi and WorkerRuntime complete isolated Turns against local HTTPS without real model access', { skip: !executable, timeout: 40_000 }, async () => {
  assert.ok(executable)
  const dir = await mkdtemp(join(tmpdir(), 'wemux-pi-https-'))
  const originalPiHome = process.env.PI_CODING_AGENT_DIR
  const originalNodeCa = process.env.NODE_EXTRA_CA_CERTS
  let server: ReturnType<typeof createServer> | null = null
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' })
    const cert = join(dir, 'cert.pem')
    process.env.NODE_EXTRA_CA_CERTS = cert
    const requests: Array<{ method: string; path: string; authorization: string | undefined }> = []
    server = createServer({ key: await readFile(join(dir, 'key.pem')), cert: await readFile(cert) }, (request, response) => {
      requests.push({ method: request.method ?? '', path: request.url ?? '', authorization: request.headers.authorization })
      if (request.headers.authorization !== `Bearer ${secret}` || request.url !== '/v1/chat/completions') { response.writeHead(403).end(); return }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      for (const data of [
        { id: 'chatcmpl-offline', object: 'chat.completion.chunk', created: 1, model: 'offline-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'offline-' }, finish_reason: null }] },
        { id: 'chatcmpl-offline', object: 'chat.completion.chunk', created: 1, model: 'offline-model', choices: [{ index: 0, delta: { content: 'answer' }, finish_reason: null }] },
        { id: 'chatcmpl-offline', object: 'chat.completion.chunk', created: 1, model: 'offline-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ]) response.write(`data: ${JSON.stringify(data)}\n\n`)
      response.end('data: [DONE]\n\n')
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const definition: ModelProviderResourceDefinition = { providerKey: 'openai-compatible', endpoint: `https://localhost:${address.port}/v1`, modelIds: ['offline-model'], agentKeys: ['pi' as never], credential: { kind: 'worker-credential', credentialRef: 'fixture-only', variableNames: ['OPENAI_API_KEY'] } }
    const adapter = new PiRuntimeSessionAdapter(executable)
    const session = await adapter.openSession({ sessionId: 'offline-provider-session' as never, cwd: dir, modelId: 'openai-compatible::offline-model' as never, resume: null, piProvider: { definition, environment: { OPENAI_API_KEY: secret } } })
    let output = ''
    try {
      const turn = await session.execute({ operationId: 'offline-operation' as never, message: { messageId: 'offline-message' as never, content: 'Say offline-answer' }, launchContext: null })
      const seen: string[] = []
      for await (const signal of turn.signals) {
        if (signal.kind === 'event' && signal.event.kind === 'assistant.text.delta') output += signal.event.text
        if (signal.kind === 'finished') seen.push(signal.outcome.status)
      }
      assert.deepEqual(seen, ['completed'])
      assert.equal(output, 'offline-answer')
      assert.equal(requests.length, 1)
      assert.equal(requests[0]?.authorization, `Bearer ${secret}`)
    } finally { await session.close() }

    // Exercise the actual Worker command, Session and Journal path with the
    // same real Pi executable. The resolver is an isolated Worker-only stand-in
    // for the already tested ResourceReconciler, not a Server capability claim.
    const workerHome = join(dir, 'worker')
    await mkdir(workerHome)
    const store = new SqliteWorkerStore(join(workerHome, 'worker.sqlite'))
    const workerId = 'offline-provider-worker' as WorkerId
    const sessionId = 'offline-provider-session' as SessionId
    const agentKey = 'pi' as AgentKey
    const modelId = 'openai-compatible::offline-model' as ModelId
    const agent: AgentAdapter = {
      agentKey, mode: 'execution',
      async detect() { return { agentKey, mode: 'execution' as const, displayName: 'Pi', version: '0.87.1', executablePath: executable, diagnostics: [], availability: { status: 'available' as const }, models: [{ modelId, displayName: 'Offline', source: 'configured' as const }] } },
      async startTurn() { throw new Error('legacy adapter should not execute') },
    }
    const runtime = new WorkerRuntime(store, new LocalProvisioner(join(workerHome, 'workspaces')), [agent], { send() {} }, workerId, 'fixture', undefined, undefined, new Map([[agentKey, adapter]]), null, undefined,
      async () => ({ definition, environment: { OPENAI_API_KEY: secret }, credentialStamp: 'offline-credential', bindingId: 'offline-binding' }))
    const until = async (predicate: () => Promise<boolean>) => {
      for (let i = 0; i < 250; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)) }
      throw new Error('WorkerRuntime Pi Turn timed out')
    }
    try {
      await runtime.initialize()
      runtime.providerConnected()
      const workspaceId = 'offline-provider-workspace' as never
      await runtime.receive({ type: 'command', commandId: 'provision-offline' as never, command: { kind: 'workspace.provision', workspace: { workspace: { id: workspaceId, projectId: 'offline-project' as never, workerId, name: 'Offline', spec: { kind: 'empty' }, status: 'pending', failureReason: null }, repositories: [] } } as never })
      await until(async () => (await store.workspaces.get(workspaceId))?.status === 'ready')
      await runtime.receive({ type: 'command', commandId: 'create-offline' as never, command: { kind: 'session.create', session: { sessionId, binding: { workspaceId, agent: { workerId, agentKey }, modelId } } } })
      await runtime.receive({ type: 'command', commandId: 'enqueue-offline' as never, command: { kind: 'session.enqueue', sessionId, message: { messageId: 'offline-worker-message' as never, content: 'Say offline-answer' } } })
      await until(async () => (await store.sessions.get(sessionId))?.runtimeState === 'idle')
      const journal = await store.journal.read({ sessionId, fromSeq: 1 as never, limit: 100 })
      assert.ok(journal.events.some(event => event.payload.kind === 'turn.finished' && event.payload.outcome === 'completed'), 'WorkerRuntime turn completed')
      assert.equal(journal.events.filter(event => event.payload.kind === 'assistant.text.delta').map(event => event.payload.text).join(''), 'offline-answer')
      assert.equal((await store.sessions.get(sessionId))?.nativeSession, null)
      assert.doesNotMatch(JSON.stringify(journal), new RegExp(secret))
      assert.equal(requests.length, 2, 'direct Pi RPC and WorkerRuntime each reached only loopback HTTPS')
      runtime.providerDisconnected()
      await runtime.receive({ type: 'command', commandId: 'enqueue-revoked' as never, command: { kind: 'session.enqueue', sessionId, message: { messageId: 'revoked-worker-message' as never, content: 'Should not call model' } } })
      await until(async () => (await store.sessions.get(sessionId))?.runtimeState === 'failed')
      assert.equal(requests.length, 2, 'revoked Provider does not send another model request')
      assert.doesNotMatch(JSON.stringify(await store.journal.read({ sessionId, fromSeq: 1 as never, limit: 100 })), new RegExp(secret))
    } finally { await runtime.shutdown(); store.close() }
    const remaining = await readdir(dir)
    assert.deepEqual(remaining.sort(), ['cert.pem', 'key.pem', 'worker'])
    assert.equal((await stat(join(dir, 'key.pem'))).mode & 0o077, 0)
  } finally {
    if (originalPiHome === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = originalPiHome
    if (originalNodeCa === undefined) delete process.env.NODE_EXTRA_CA_CERTS; else process.env.NODE_EXTRA_CA_CERTS = originalNodeCa
    await new Promise<void>(resolve => { if (!server) return resolve(); server.close(() => resolve()) })
    await rm(dir, { recursive: true, force: true })
  }
})
