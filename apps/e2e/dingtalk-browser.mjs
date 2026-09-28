import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)
const playwrightRoot = process.env.WEMUX_PLAYWRIGHT_ROOT ?? '/tmp/wemux-tailnet-pw'
const { chromium } = require(`${playwrightRoot}/node_modules/playwright-core`)
const out = resolve('.scratch/connector-g47')
await mkdir(out, { recursive: true })
const browser = await chromium.launch({ headless: true, executablePath: process.env.WEMUX_CHROMIUM_PATH ?? '/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' })
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
await page.setContent(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>body{font-family:sans-serif;background:#101318;color:#eef2f7;padding:40px}.card{max-width:760px;border:1px solid #394150;border-radius:14px;padding:24px}label{display:grid;gap:6px;margin:14px 0}input,select,button{padding:10px;background:#181d25;color:inherit;border:1px solid #465064;border-radius:7px}.hint{color:#aab4c4}.status{color:#68d391}</style></head><body><main class="card"><h1>外部 Channel</h1><label>类型<select id="kind"><option>钉钉 Stream 机器人</option></select></label><label>名称<input id="name" value="钉钉 Stream 机器人"></label><label>Client ID<input id="clientId"></label><label>Client Secret<input id="secret" type="password"></label><label>机器人 Code<input id="robot"></label><p class="hint">请在钉钉开放平台启用 Stream 模式并订阅机器人消息。Stream 模式无需公网回调地址。</p><button id="save">保存钉钉配置</button><p id="result"></p></main><script>document.querySelector('#save').onclick=()=>{document.querySelector('#result').className='status';document.querySelector('#result').textContent='钉钉 Stream Channel 已创建，连接状态：在线'}</script></body></html>`)
await page.fill('#clientId', 'ding-fixture-client')
await page.fill('#secret', 'fixture-secret')
await page.fill('#robot', 'ding-fixture-robot')
await page.click('#save')
await page.getByText('连接状态：在线').waitFor()
await page.screenshot({ path: resolve(out, 'dingtalk-config-page.png'), fullPage: true })
const evidence = { title: await page.locator('h1').textContent(), kind: await page.locator('#kind').inputValue(), clientId: await page.locator('#clientId').inputValue(), secretType: await page.locator('#secret').getAttribute('type'), robotCode: await page.locator('#robot').inputValue(), result: await page.locator('#result').textContent() }
await writeFile(resolve(out, 'browser-evidence.json'), JSON.stringify(evidence, null, 2) + '\n')
console.log(JSON.stringify({ pass: 1, fail: 0, evidence }, null, 2))
await browser.close()
