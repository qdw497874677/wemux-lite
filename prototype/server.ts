// PROTOTYPE — throwaway UI used to compare three wemux-lite layouts.
const port = Number(process.env.PORT || 8989)
const html = await Bun.file(new URL('./index.html', import.meta.url)).text()

Bun.serve({
  port,
  hostname: '0.0.0.0',
  fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/' || url.pathname === '/prototype') {
      return new Response(html, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store, no-cache, must-revalidate',
        },
      })
    }
    if (url.pathname === '/api/health') {
      return Response.json({ ok: true, prototype: true })
    }
    if (url.pathname === '/api/client-error' && request.method === 'POST') {
      return request.text().then((body) => {
        console.error(`[browser-error] ${body.slice(0, 4000)}`)
        return new Response(null, { status: 204 })
      })
    }
    return new Response('Not found', { status: 404 })
  },
})

console.log(`wemux-lite UI prototype: http://0.0.0.0:${port}/?variant=A`)
