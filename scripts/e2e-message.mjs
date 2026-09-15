const { chromium } = await import(process.env.WEMUX_E2E_PLAYWRIGHT ?? 'playwright')

const origin = process.env.WEMUX_E2E_ORIGIN ?? 'http://127.0.0.1:8004'
const bootstrapToken = process.env.WEMUX_E2E_BOOTSTRAP_TOKEN
if (!bootstrapToken) throw new Error('Set WEMUX_E2E_BOOTSTRAP_TOKEN; the script creates and deletes an isolated session.')

const browser = await chromium.launch({ headless: true, ...(process.env.WEMUX_E2E_CHROMIUM ? { executablePath: process.env.WEMUX_E2E_CHROMIUM } : {}) })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
let temporarySessionId = ''
try {
  await page.goto(origin, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: /重新输入令牌|连接服务端/ }).first().click()
  await page.getByRole('textbox', { name: '管理员令牌' }).fill(bootstrapToken)
  await page.getByRole('dialog').getByRole('button', { name: '连接服务端', exact: true }).click()
  await page.getByText('服务端已连接').waitFor()

  const token = await page.evaluate(() => JSON.parse(localStorage.getItem('wemux.connection') ?? '{}').token)
  const api = async (path, init = {}) => {
    const response = await fetch(new URL(`/api${path}?teamId=default-team`, origin), { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers } })
    if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${response.status} ${await response.text()}`)
    return response.status === 204 ? null : response.json()
  }
  const workspaces = (await api('/workspaces')).items.filter(item => item.status === 'ready')
  const workers = (await api('/workers')).items.filter(item => item.connectionState === 'online')
  const workspace = workspaces.find(item => workers.some(worker => worker.id === item.workerId))
  if (!workspace) throw new Error('No ready workspace on an online worker')
  const capabilities = (await api(`/workers/${workspace.workerId}/capabilities`)).capabilities
  const agent = capabilities.find(item => item.mode === 'execution' && item.availability.status === 'available' && item.models.length)
  if (!agent) throw new Error('No executable agent/model available')
  const created = await api('/sessions', { method: 'POST', body: JSON.stringify({ workspaceId: workspace.id, title: '临时界面检查', agentKey: agent.agentKey, modelId: agent.models[0].modelId, shareScope: 'owner-only' }) })
  temporarySessionId = created.session.id

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByText('临时界面检查', { exact: true }).click()
  const composer = page.getByRole('textbox', { name: '消息内容' })
  await composer.fill('你好')
  await composer.press('Enter')
  await page.locator('[aria-label="正在处理"]').waitFor()
  if (await composer.isDisabled()) throw new Error('Composer stayed disabled after enqueue acknowledgement')
} finally {
  if (temporarySessionId) {
    try {
      const token = await page.evaluate(() => JSON.parse(localStorage.getItem('wemux.connection') ?? '{}').token)
      await fetch(new URL(`/api/sessions/${temporarySessionId}?teamId=default-team`, origin), { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
    } catch { /* Best effort cleanup; session title is fixed and contains no user data. */ }
  }
  await browser.close()
}
