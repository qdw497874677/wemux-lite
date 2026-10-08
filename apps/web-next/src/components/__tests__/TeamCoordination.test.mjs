import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { launchAcceptanceBrowser } from '../../../tests/acceptance-runtime.mjs'

const availability = { status: 'disabled', gate: { verdict: 'FAIL', reasons: ['OS 级隔离（Landlock 等）在本机不可用', '网络出口收敛（Agent 出站收敛）在本机不可用'], evidencePath: '.scratch/web-next-project-agent-platform/evidence/ticket-05-runtime-isolation-gate.md', remediationSection: '五', reopenConditions: ['按 gate 证据 §五完成环境变更并重新探测', '写入通道复核矩阵全部通道复核为拒绝', '重探测判定为 PASS 后由部署者修改常量发版启用'] } }

test('TeamCoordination disabled card, no send controls, failure mode', async t => {
  const bundle = await build({
    stdin: {
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { flushSync } from 'react-dom';
        import { TeamCoordination } from './TeamCoordination.tsx';
        window.calls = [];
        window.render = (mode) => flushSync(() => {
          if (mode === 'error') return root.render(<TeamCoordination api={{ teamCoordinationAvailability: () => Promise.reject(Error('synthetic availability failure')) }} teamId="team-1" />);
          return root.render(<TeamCoordination api={{ teamCoordinationAvailability: (teamId, signal) => { window.calls.push(teamId); return new Promise((resolve, reject) => { if (signal && signal.aborted) return reject(Error('aborted')); window.pending = { resolve: () => resolve(window.availability) }; }); } }} teamId="team-1" />);
        });
        const root = createRoot(document.getElementById('root'));
        window.availability = ${JSON.stringify(availability)};
      `,
      resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'tsx',
    },
    bundle: true, write: false, platform: 'browser', format: 'esm', jsx: 'automatic',
  })
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/component.js' ? 'text/javascript' : 'text/html')
    res.end(req.url === '/component.js' ? bundle.outputFiles[0].text : '<div id="root"></div><script type="module" src="/component.js"></script>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let browser
  try {
    browser = await launchAcceptanceBrowser()
    const page = await browser.newPage()
    page.setDefaultTimeout(5000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.waitForFunction(() => typeof window.render === 'function')

    // 禁用态状态卡：标题、原因、证据路径、解除条件全部呈现；可用性来自服务端投影。
    await page.evaluate(() => window.render('disabled'))
    await page.waitForFunction(() => window.pending)
    await page.evaluate(() => window.pending.resolve())
    const card = page.getByRole('region', { name: '协调资格门状态' })
    await card.waitFor()
    assert.match(await card.innerText(), /协调入口不可用/)
    assert.match(await card.innerText(), /FAIL/)
    assert.match(await card.innerText(), /ticket-05-runtime-isolation-gate\.md/)
    assert.match(await card.innerText(), /coordination-write-channel-matrix\.md/)
    assert.equal(await card.getByRole('list').count() >= 2, true, '原因与解除条件列表都要渲染')
    // 断言整页无任何发送/上传可点控件（button、input、textarea 一律不渲染）。
    assert.equal(await page.locator('section[aria-labelledby="team-coordination-heading"] button, section[aria-labelledby="team-coordination-heading"] input, section[aria-labelledby="team-coordination-heading"] textarea').count(), 0)
    // 组件数据来自 api（teamId 传入），不硬编码结论。
    assert.deepEqual(await page.evaluate(() => window.calls), ['team-1'])

    // 错误路径：呈现 Failure 模式（role=alert）而非空白；未知错误归一为通用文案不泄漏细节。
    await page.evaluate(() => window.render('error'))
    const failure = page.getByRole('alert')
    await failure.waitFor()
    assert.match(await failure.innerText(), /页面出现异常/)
    assert.match(await page.locator('body').innerText(), /服务端在资格门 FAIL 期间同样拒绝/)
    assert.deepEqual(errors, [])
  } finally {
    await browser?.close()
    server.close()
  }
})
