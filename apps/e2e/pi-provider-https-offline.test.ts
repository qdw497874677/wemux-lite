import assert from 'node:assert/strict'
import { createServer } from 'node:https'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ModelProviderResourceDefinition } from '@wemux/domain'
import { PiRuntimeSessionAdapter } from '../worker/src/agents/pi-runtime-session-adapter.ts'

const executable = process.env.WEMUX_OFFLINE_PI_EXECUTABLE
const secret = 'offline-pi-provider-local-key-5729'

test('real Pi performs an isolated Turn against a local HTTPS compatible endpoint without real model access', { skip: !executable, timeout: 40_000 }, async () => {
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
    const remaining = await readdir(dir)
    assert.deepEqual(remaining.sort(), ['cert.pem', 'key.pem'])
    assert.equal((await stat(join(dir, 'key.pem'))).mode & 0o077, 0)
  } finally {
    if (originalPiHome === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = originalPiHome
    if (originalNodeCa === undefined) delete process.env.NODE_EXTRA_CA_CERTS; else process.env.NODE_EXTRA_CA_CERTS = originalNodeCa
    await new Promise<void>(resolve => { if (!server) return resolve(); server.close(() => resolve()) })
    await rm(dir, { recursive: true, force: true })
  }
})
