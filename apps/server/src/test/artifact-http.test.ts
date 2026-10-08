import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { ARTIFACT_DOWNLOAD_LIMIT, artifactRoutes } from '../http/routes/artifact-routes.ts'
import { AppError } from '../application/errors.ts'

function route() { const found = artifactRoutes.find(item => item.pattern === '/artifacts/:artifactId/content'); assert.ok(found); return found }
function response() { const target = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, number | string>; body?: Buffer; setHeader(name: string, value: number | string): void; end(value?: Buffer): void }; target.statusCode = 0; target.headers = {}; target.setHeader = (name, value) => { target.headers[name] = value }; target.end = value => { target.body = value }; return target }
const artifact = { id: 'a', projectId: 'p', taskId: 't', runId: 'r', sessionId: 's', workspaceId: 'w', workerId: 'worker', relativePath: 'report.txt', mimeType: 'text/plain', size: 3, source: 'manual', reviewState: 'pending', revision: 1, createdBy: 'u', createdAt: '', updatedAt: '' }
const text = (content: string) => ({ content, size: Buffer.byteLength(content), truncated: false, binary: false })
async function download(file: unknown, options: { size?: number; preview?: boolean; path?: string; mime?: string; error?: Error; getError?: Error } = {}) {
  const output = response()
  let reads = 0
  const run = route().handler({ artifacts: { get: async () => { if (options.getError) throw options.getError; return { ...artifact, size: options.size ?? 3, relativePath: options.path ?? artifact.relativePath, mimeType: options.mime ?? artifact.mimeType } } }, sessionFiles: { read: async (_session: string, _path: string, maximum: number) => { reads++; assert.equal(maximum, options.preview ? 2 * 1024 * 1024 : 10 * 1024 * 1024); if (options.error) throw options.error; return file } }, actor: async () => 'u', params: { artifactId: 'a' }, url: new URL(`http://localhost/artifacts/a/content${options.preview ? '?preview=1' : ''}`), response: output } as never)
  return { run, output, reads: () => reads }
}
const rejects = async (run: void | Promise<void>, status: number, code: string, message?: RegExp) => assert.rejects(Promise.resolve(run), error => error instanceof AppError && error.status === status && error.code === code && (!message || message.test(error.message)))

for (const [name, bytes, binary] of [
  ['UTF-8 text', Buffer.from('成果你好\n'), false],
  ['UTF-8 BOM', Buffer.from('\ufeff成果\r\n'), false],
  ['empty text', Buffer.alloc(0), false],
  ['binary with NUL', Buffer.from([0, 1, 255, 0, 128]), true],
  ['empty base64', Buffer.alloc(0), true],
] as const) test(`artifact content downloads real Worker ${name} response byte-for-byte`, async () => {
  // Match Worker behavior: text has only content, binary has only base64Content.
  const file = binary ? { content: null, base64Content: bytes.toString('base64'), binary: true, truncated: false, size: bytes.length } : text(bytes.toString('utf8'))
  const { run, output } = await download(file, { size: bytes.length, mime: binary ? 'application/octet-stream' : 'text/plain' })
  await run
  assert.deepEqual(output.body, bytes)
  assert.equal(output.headers['content-length'], String(bytes.length))
  assert.equal(output.headers['content-type'], binary ? 'application/octet-stream' : 'text/plain')
  assert.match(String(output.headers['content-disposition']), /attachment; filename="report.txt"/)
})

test('artifact preview keeps truncated text preview behavior', async () => {
  const { run, output } = await download({ ...text('ok!'), truncated: true, size: 4 }, { preview: true })
  await run; assert.equal(output.body?.toString(), 'ok!'); assert.equal(output.headers['content-disposition'], 'inline')
})

test('artifact Unicode filename has safe ASCII fallback and RFC 5987 filename', async () => {
  const { run, output } = await download(text('ok!'), { path: '目录/成果.txt' }); await run
  assert.equal(output.headers['content-disposition'], `attachment; filename="__.txt"; filename*=UTF-8''${encodeURIComponent('成果.txt')}`)
})

test('artifact preview and download reject declared sizes before Worker read and align at 10 MiB', async () => {
  assert.equal(ARTIFACT_DOWNLOAD_LIMIT, 10 * 1024 * 1024)
  for (const preview of [true, false]) {
    const result = await download({}, { size: (preview ? 2 : 10) * 1024 * 1024 + 1, preview })
    await rejects(result.run, 413, 'artifact_too_large', /过大/); assert.equal(result.reads(), 0)
  }
})

for (const [prefix, status, code, message] of [
  ['file_too_large', 413, 'artifact_too_large', /过大/],
  ['file_transport_too_large', 413, 'artifact_transport_too_large', /传输帧上限/],
  ['file_not_found', 404, 'artifact_not_found', /不存在/],
  ['file_unreadable', 422, 'artifact_unreadable', /不可读/],
  ['file_access_revoked', 403, 'artifact_access_revoked', /被撤权/],
] as const) test(`artifact maps real Worker error prefix ${prefix}`, async () => {
  const { run, output } = await download(null, { error: new AppError(400, `${prefix}: worker diagnostic`) })
  await rejects(run, status, code, message); assert.equal(output.body, undefined)
})

test('artifact rejects stale metadata oversized response, truncation and incomplete bytes', async () => {
  await rejects((await download({ ...text('abc'), size: ARTIFACT_DOWNLOAD_LIMIT + 1, truncated: true })).run, 413, 'artifact_too_large')
  await rejects((await download({ ...text('abc'), size: 4, truncated: true })).run, 422, 'artifact_unreadable')
  await rejects((await download({ ...text('abc'), size: 4 })).run, 422, 'artifact_unreadable')
})

for (const file of [{ binary: true, base64Content: '!!', size: 1 }, { binary: false, content: null, size: 0 }, { base64Content: 'YWJj', size: 3 }]) test('artifact malformed encoding never silently succeeds', async () => {
  await rejects((await download(file)).run, 502, 'artifact_invalid_content')
})

test('artifact preserves hidden access 404 and anonymous 401 without Worker read', async () => {
  for (const [status, code] of [[404, 'project_not_found'], [401, 'unauthorized'], [404, 'artifact_not_found']] as const) {
    const result = await download(null, { getError: new AppError(status, 'hidden', code) })
    await rejects(result.run, status, code); assert.equal(result.reads(), 0)
  }
  const result = await download(null, { getError: new AppError(403, 'revoked') })
  await rejects(result.run, 403, 'artifact_access_revoked', /被撤权/); assert.equal(result.reads(), 0)
})

test('artifact unknown Worker failure exposes diagnostic class but no raw file or path', async () => {
  const result = await download(null, { error: new AppError(400, 'unexpected: /private/secret contents') })
  await rejects(result.run, 502, 'artifact_read_failed', /http_400/)
  assert.equal(result.output.body, undefined)
})
