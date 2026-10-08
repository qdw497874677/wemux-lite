// Run: PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs node apps/web/tests/channels.browser.mjs
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright-core')
const harness = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { createRootRoute, createRoute, createRouter, RouterProvider, useParams } from '@tanstack/react-router'
import { ChannelPage } from '/src/features/channels/channel-page.tsx'
import { ConfirmDialogProvider } from '/src/components/ui/confirm-dialog.tsx'
const api = {
  channels: async () => ({ items: [], bindings: [], inbound: [], outbound: Array.from({ length: 100 }, (_, i) => ({ id: 'recent-' + i, status: 'delivered', attempt: 1, diagnostic: 'recent delivery' })) }),
  channelDelivery: async (project, delivery, signal) => {
    const response = await fetch('/api/projects/' + encodeURIComponent(project) + '/channel-deliveries/' + encodeURIComponent(delivery), { signal })
    if (!response.ok) throw Object.assign(new Error('加载投递详情失败'), { status: response.status })
    return response.json()
  },
  replayChannelDelivery: async (project, delivery, body) => fetch('/api/projects/' + encodeURIComponent(project) + '/channel-deliveries/' + encodeURIComponent(delivery) + '/replay', { method: 'POST', body: JSON.stringify(body) }),
}
function Harness() {
  const { projectId } = useParams({ strict: false })
  return <ConfirmDialogProvider><ChannelPage api={api} projectId={projectId} sessions={[]} canManage={projectId !== 'viewer'} /></ConfirmDialogProvider>
}
const root = createRootRoute()
const route = createRoute({ getParentRoute: () => root, path: '/projects/$projectId/channels', component: Harness })
const router = createRouter({ routeTree: root.addChildren([route]) })
window.channelTestNavigate = href => router.navigate({ href })
createRoot(document.getElementById('root')).render(<RouterProvider router={router} />)
`
const server = await createServer({
  configFile: false,
  appType: 'custom',
  resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } },
  optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'react/jsx-dev-runtime', '@tanstack/react-router', 'lucide-react', 'class-variance-authority', 'clsx', 'tailwind-merge', '@radix-ui/react-dialog', '@base-ui/react/button'] },
  root: fileURLToPath(new URL('..', import.meta.url)),
  plugins: [react(), { name: 'channel-browser-harness', resolveId: id => id === '/channel-test.tsx' || id === fileURLToPath(new URL('../channel-test.tsx', import.meta.url)) ? fileURLToPath(new URL('../channel-test.tsx', import.meta.url)) : null, load: id => id === fileURLToPath(new URL('../channel-test.tsx', import.meta.url)) ? harness : null }],
  server: { host: '127.0.0.1', port: 0 },
})
server.middlewares.use(async (req, res, next) => {
  if (!req.url?.startsWith('/projects/')) return next()
  res.setHeader('Content-Type', 'text/html')
  res.end(await server.transformIndexHtml(req.url, '<html><body><div id="root"></div><script type="module" src="/channel-test.tsx"></script></body></html>'))
})
await server.listen()
const origin = `http://127.0.0.1:${server.httpServer.address().port}`
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  let replayed = false
  let replayRequests = 0
  const deliveryId = 'old delivery/+?#'
  const requests = []
  await page.route('**/api/projects/**', async route => {
    const url = new URL(route.request().url())
    const parts = url.pathname.split('/').map(decodeURIComponent)
    const project = parts[3], id = parts[5]
    requests.push([project, id])
    if (parts[6] === 'replay') {
      replayed = true; replayRequests++
      const body = JSON.parse(route.request().postData())
      assert.ok(body.requestId)
      await route.fulfill({ json: { status: 'pending' } }); return
    }
    if (project === 'other' || project === 'unauthorized' || id === 'missing') {
      await route.fulfill({ status: 404, json: { error: { message: 'Not found' } } }); return
    }
    await route.fulfill({ json: { id, channelId: 'channel-old', sessionId: 'session-old', bindingId: 'binding-old', status: replayed ? 'pending' : 'dead_letter', attempt: 6, diagnostic: 'older-than-100 failure details', responseStatus: 503, updatedAt: '2026-01-01T00:00:00Z' } })
  })
  const target = `/projects/manager/channels?delivery=${encodeURIComponent(deliveryId)}`
  await page.goto(origin + target)
  const detail = page.getByRole('region', { name: '选中投递详情' })
  await detail.getByText('older-than-100 failure details', { exact: true }).waitFor()
  assert.equal(await page.getByText('recent delivery', { exact: true }).count(), 100)
  assert.equal(await detail.getByText(`投递 ID：${deliveryId}`, { exact: true }).count(), 1)
  await detail.getByRole('button', { name: '重放', exact: true }).click()
  await detail.getByText('pending', { exact: true }).waitFor()
  assert.equal(replayRequests, 1)
  assert.equal(await detail.getByRole('button', { name: '重放', exact: true }).count(), 0)
  replayed = false
  await page.evaluate(href => window.channelTestNavigate(href), `/projects/viewer/channels#delivery=${encodeURIComponent(deliveryId)}`)
  await detail.getByText('dead_letter', { exact: true }).waitFor()
  assert.equal(await detail.getByRole('button', { name: '重放', exact: true }).count(), 0)
  await page.evaluate(href => window.channelTestNavigate(href), '/projects/manager/channels?delivery=missing')
  await detail.getByText('投递记录不存在或无权访问。', { exact: true }).waitFor()
  assert.equal(await detail.getByText('older-than-100 failure details', { exact: true }).count(), 0)
  for (const project of ['other', 'unauthorized']) {
    await page.evaluate(href => window.channelTestNavigate(href), `/projects/${project}/channels?delivery=${encodeURIComponent(deliveryId)}`)
    await detail.getByText('投递记录不存在或无权访问。', { exact: true }).waitFor()
    assert.equal(await detail.getByText('older-than-100 failure details', { exact: true }).count(), 0)
  }
  await page.evaluate(href => window.channelTestNavigate(href), `/projects/manager/channels#${encodeURIComponent(deliveryId)}`)
  await detail.getByText('older-than-100 failure details', { exact: true }).waitFor()
  assert.ok(requests.some(([project, id]) => project === 'manager' && id === deliveryId))
  assert.deepEqual(errors, [])
  console.log('PASS: Channel deep link query/fragment, encoded IDs, detail outside latest 100, manager replay and refresh, viewer read-only, missing/cross-project/unauthorized clear state, route changes without stale detail.')
} finally {
  await browser.close()
  await server.close()
}
