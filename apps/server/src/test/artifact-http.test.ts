import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { artifactRoutes } from '../http/routes/artifact-routes.ts'

function route(pattern: string) { const found = artifactRoutes.find(item => item.pattern === pattern && item.method === 'GET'); assert.ok(found); return found }
function response() { const target = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, number | string>; body?: Buffer; setHeader(name: string, value: number | string): void; end(value?: Buffer): void }; target.statusCode = 0; target.headers = {}; target.setHeader = (name, value) => { target.headers[name] = value }; target.end = value => { target.body = value }; return target }

const artifact = { id: 'a', projectId: 'p', taskId: 't', runId: 'r', sessionId: 's', workspaceId: 'w', workerId: 'worker', relativePath: 'report.txt', mimeType: 'text/plain', size: 3, source: 'manual', reviewState: 'pending', revision: 1, createdBy: 'u', createdAt: '', updatedAt: '' }

test('artifact content streams through session files without exposing content on metadata wire', async () => {
  const output = response()
  await route('/artifacts/:artifactId/content').handler({ artifacts: { get: async () => artifact }, sessionFiles: { read: async () => ({ path: 'report.txt', base64Content: Buffer.from('ok!').toString('base64') }) }, actor: async () => 'u', params: { artifactId: 'a' }, url: new URL('http://localhost/artifacts/a/content?preview=1'), response: output } as never)
  assert.equal(output.body?.toString(), 'ok!')
  assert.equal(output.headers['content-type'], 'text/plain')
  assert.match(String(output.headers['content-disposition']), /inline/)
})

test('artifact preview and download reject declared sizes above limits before worker read', async () => {
  let reads = 0
  const run = (size: number, suffix: string) => route('/artifacts/:artifactId/content').handler({ artifacts: { get: async () => ({ ...artifact, size }) }, sessionFiles: { read: async () => { reads += 1; return {} } }, actor: async () => 'u', params: { artifactId: 'a' }, url: new URL(`http://localhost/artifacts/a/content${suffix}`), response: response() } as never)
  await assert.rejects(async () => { await run(2 * 1024 * 1024 + 1, '?preview=1') }, /exceeds 2 MiB/)
  await assert.rejects(async () => { await run(20 * 1024 * 1024 + 1, '') }, /exceeds 20 MiB/)
  assert.equal(reads, 0)
})
