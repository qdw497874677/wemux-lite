import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { chromium } from '/opt/data/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs'

test('rendered project owner: scopes, cleanup, malformed hints, catch-up, recovery and fallback preserve history', async () => {
 const bundle = await build({ entryPoints: ['apps/web/tests/project-query-rendered.tsx'].map(p => new URL('../../../' + p, import.meta.url).pathname), bundle: true, write: false, format: 'iife', jsx: 'automatic' })
 const server = createServer((req, res) => { res.setHeader('Content-Type', req.url === '/test.js' ? 'text/javascript' : 'text/html'); res.end(req.url === '/test.js' ? bundle.outputFiles[0].text : '<div id="root"></div><script src="/test.js"></script>') })
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
 const browser = await chromium.launch({ headless: true, executablePath: '/opt/data/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome' })
 try {
  const page = await browser.newPage(); await page.clock.install()
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.waitForFunction(() => window.harness?.stats().calls === 1)
  const act = fn => page.evaluate(fn)
  await act(() => { harness.append(1); harness.append(3); harness.append(7); harness.callbacks[0].state('live') })
  await page.waitForFunction(() => document.querySelector('#history').textContent === '1,3,7')
  await act(() => { harness.append(8); harness.callbacks[0].event({ projectId: 'p', type: 'future.event' }) })
  await page.waitForFunction(() => document.querySelector('#history').textContent === '1,3,7,8')
  await act(() => { harness.append(9); harness.callbacks[0].event(null) })
  await page.waitForFunction(() => document.querySelector('#history').textContent.endsWith(',9'))
  await act(() => { harness.reject(true); harness.callbacks[0].state('reconnecting'); harness.callbacks[0].state('live') })
  await page.waitForFunction(() => document.querySelector('#error').textContent.includes('unavailable'))
  assert.equal(await page.locator('#history').textContent(), '1,3,7,8,9')
  await act(() => { harness.reject(false); harness.append(12); harness.callbacks[0].state('live') })
  await page.waitForFunction(() => document.querySelector('#history').textContent.endsWith(',12'))
  await act(() => { harness.append(13); window.dispatchEvent(new Event('online')) })
  await page.waitForFunction(() => document.querySelector('#history').textContent.endsWith(',13'))
  await act(() => { harness.append(14); document.dispatchEvent(new Event('visibilitychange')) })
  await page.waitForFunction(() => document.querySelector('#history').textContent.endsWith(',14'))
  await act(() => harness.append(15)); await page.clock.runFor(10000)
  await page.waitForFunction(() => document.querySelector('#history').textContent.endsWith(',15'))
  await act(() => harness.render('q')); await page.waitForFunction(() => harness.stats().stops === 1)
  let before = await act(() => harness.stats().calls)
  await act(() => { harness.callbacks[0].event(null); harness.callbacks[0].state('live') }); await page.waitForTimeout(30)
  assert.equal(await act(() => harness.stats().calls), before)
  await act(() => harness.auth()); await page.waitForFunction(() => harness.stats().stops === 2)
  await act(() => harness.render('p')); await page.waitForFunction(() => harness.callbacks.length === 3)
  before = await act(() => harness.stats().calls)
  await act(() => { harness.callbacks[1].event(null); harness.callbacks[1].state('live') }); await page.waitForTimeout(30)
  assert.equal(await act(() => harness.stats().calls), before)
  await act(() => harness.unmount()); await page.waitForFunction(() => harness.stats().stops === 3)
  before = await act(() => harness.stats().calls)
  await act(() => { harness.callbacks[2].state('live'); window.dispatchEvent(new Event('online')); document.dispatchEvent(new Event('visibilitychange')) }); await page.clock.runFor(20000)
  assert.equal(await act(() => harness.stats().calls), before)
 } finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }
})
