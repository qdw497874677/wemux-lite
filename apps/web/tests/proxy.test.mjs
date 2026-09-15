import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

test('Vite proxies only the /api boundary, strips it, and bridges SSE query token to Bearer', async () => {
  const backend = createHttpServer((request, response) => {
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ url: request.url, auth: request.headers.authorization }))
  })
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve))
  let vite
  try {
    vite = await createServer({
      root: fileURLToPath(new URL('..', import.meta.url)),
      configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
      server: { port: 0, host: '127.0.0.1', proxy: { '^/api(?:/|$)': { target: `http://127.0.0.1:${backend.address().port}` } } },
    })
    await vite.listen()
    const origin = `http://127.0.0.1:${vite.httpServer.address().port}`
    const stream = await (await fetch(`${origin}/api/sessions/s1/stream?token=private-token&fromSeq=2`)).json()
    assert.equal(stream.url, '/sessions/s1/stream?token=private-token&fromSeq=2')
    assert.equal(stream.auth, 'Bearer private-token')
    const workers = await (await fetch(`${origin}/api/workers`, { headers: { Authorization: 'Bearer admin' } })).json()
    assert.equal(workers.url, '/workers')
    assert.equal(workers.auth, 'Bearer admin')
    const clientModule = await fetch(`${origin}/src/api/client.ts`)
    assert.equal(clientModule.status, 200)
    assert.match(await clientModule.text(), /createApi/)
  } finally {
    await vite?.close()
    await new Promise(resolve => backend.close(resolve))
  }
})
