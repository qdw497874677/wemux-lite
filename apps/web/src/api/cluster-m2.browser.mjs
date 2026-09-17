// Run after web build: PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs node apps/web/src/api/cluster-m2.browser.mjs
// Browser contract verification with mocked cluster HTTP; not backend integration evidence.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core')
const dist = fileURLToPath(new URL('../../dist/', import.meta.url))
const server = createServer(async (req, res) => {
  try {
    const path = req.url.split('?')[0]
    const asset = path.startsWith('/assets/') ? path : '/index.html'
    const content = await readFile(dist + asset)
    res.setHeader('Content-Type', asset.endsWith('.js') ? 'text/javascript' : asset.endsWith('.css') ? 'text/css' : 'text/html')
    res.end(content)
  } catch { res.writeHead(404).end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] })
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 1000 } })
  const agent = { agentKey: 'pi', displayName: 'Pi', mode: 'execution', availability: { status: 'available' }, models: [{ modelId: 'model', displayName: '模型' }] }
  const workers = ['a', 'b'].map(id => ({ id, name: `节点${id}`, connectionState: 'online', capabilities: [agent] }))
  const workspace = { id: 'w', projectId: 'p', name: '测试工作区', workerId: 'a', status: 'failed', placements: [{ workerId: 'a', status: 'failed', failureReason: '磁盘不足' }, { workerId: 'b', status: 'ready', failureReason: null }] }
  const session = { id: 's', projectId: 'p', workspaceId: 'w', title: '测试会话', runtimeState: 'running', binding: { agent: { workerId: 'b', agentKey: 'pi' }, modelId: 'model' }, sendCapability: { allowed: true } }
  const payloads = [{ kind: 'message.queued', commandId: 'c1', messageId: 'm1', content: '正在执行', position: 0 }, { kind: 'turn.started', turnId: 't', messageId: 'm1' }, { kind: 'message.queued', commandId: 'c2', messageId: 'm2', content: '队列内容', position: 1 }, { kind: 'approval.requested', turnId: 't', approvalId: 'approval', action: { tool: 'shell' }, reason: '需要确认' }]
  const calls = []
  await page.addInitScript(() => localStorage.setItem('wemux.connection', JSON.stringify({ token: 'test', teamId: 'team' })))
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (request.method() !== 'GET') { calls.push({ path, method: request.method(), body: request.postDataJSON() }); await route.fulfill({ json: { commandId: request.postDataJSON()?.commandId } }); return }
    let json = { items: [] }
    if (path === '/api/projects') json = { items: [{ id: 'p', name: '项目' }] }
    else if (path === '/api/workspaces') json = { items: [workspace] }
    else if (path === '/api/workers') json = { items: workers }
    else if (path.endsWith('/capabilities')) json = { capabilities: [agent] }
    else if (path === '/api/sessions') json = { items: [session] }
    else if (path === '/api/sessions/s') json = session
    else if (path === '/api/sessions/s/events') { const from = Number(new URL(request.url()).searchParams.get('fromSeq') || 1); json = { events: payloads.map((payload, i) => ({ sessionId: 's', seq: i + 1, payload })).filter(e => e.seq >= from), nextSeq: null, freshness: { status: 'synced' } } }
    else if (path.includes('/commands/')) json = { status: 'accepted', receipt: null }
    else if (path.endsWith('/stream') || path.endsWith('/events')) { await route.fulfill({ contentType: 'text/event-stream', body: '' }); return }
    await route.fulfill({ json })
  })
  const origin = `http://127.0.0.1:${server.address().port}`
  await page.goto(`${origin}/projects/p/sessions`)
  await page.getByLabel('工作节点', { exact: true }).selectOption('b')
  await page.getByRole('button', { name: /测试工作区.*配置/ }).click()
  assert.equal(await page.getByLabel('智能体', { exact: true }).inputValue(), 'pi')
  await page.getByText('节点a：初始化失败，磁盘不足', { exact: true }).waitFor()
  await page.getByLabel('搜索会话', { exact: true }).first().focus()
  const modalSearch = page.getByRole('dialog').getByLabel('搜索会话', { exact: true })
  await modalSearch.fill('测试')
  assert.equal(await modalSearch.isVisible(), true)
  await page.keyboard.press('Escape')
  await page.goto(`${origin}/projects/p/sessions/s`)
  await page.getByRole('button', { name: '停止当前回合' }).click()
  await page.getByRole('button', { name: '取消排队' }).click()
  await page.getByRole('button', { name: '批准', exact: true }).click()
  assert(calls.some(c => c.path === '/api/sessions/s/turn/stop' && c.method === 'POST' && c.body.turnId === 't'))
  assert(calls.some(c => c.path === '/api/sessions/s/messages/c2/cancel' && c.method === 'POST'))
  assert(calls.some(c => c.path === '/api/sessions/s/runtime/approvals/approval' && c.body.decision === 'approve'))
  await page.screenshot({ path: '/tmp/wemux-cluster-m2-tablet.png', fullPage: true })
  console.log('PASS browser: secondary Placement selection, placement failure, tablet modal search, stop, queue cancellation, approval request')
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }
