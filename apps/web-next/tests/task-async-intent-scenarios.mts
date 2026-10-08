import assert from 'node:assert/strict'

const poll = async (read: () => Promise<boolean>) => { for (let i = 0; i < 150; i++) { if (await read()) return; await new Promise(resolve => setTimeout(resolve, 20)) } throw Error('Condition not reached') }

/** Hold a real successful response after the server has committed/authorized it. */
async function holdResponse(page: any, path: string, method: string) {
  let captured!: () => void, release!: () => void, finished!: () => void
  const ready = new Promise<void>(resolve => { captured = resolve }), gate = new Promise<void>(resolve => { release = resolve }), done = new Promise<void>(resolve => { finished = resolve })
  let used = false
  const matcher = (url: URL) => url.pathname === path
  const handler = async (route: any) => {
    if (used || route.request().method() !== method) return route.continue()
    const response = await route.fetch()
    if (!response.ok()) return route.fulfill({ response }) // Let the identity transport handle CSRF refresh.
    used = true
    const body = await response.body(); captured(); await gate
    await route.fulfill({ response, body }).catch(() => {}); finished()
  }
  await page.route(matcher, handler)
  return { ready, async release() { release(); await done; await page.unroute(matcher, handler); await page.waitForTimeout(150) } }
}
const createForm = (page: any) => page.getByRole('button', { name: '创建任务', exact: true }).locator('xpath=ancestor::form')
const beginCreate = async (page: any, title: string) => { const form = createForm(page); await form.locator('[name=title]').fill(title); await form.getByRole('button', { name: '创建任务', exact: true }).click() }
async function shell(page: any, viewportName: string, label: string) {
  if (viewportName === 'mobile') await page.getByRole('button', { name: '打开导航', exact: true }).click()
  await page.getByRole('navigation', { name: '主导航' }).filter({ visible: true }).getByRole('link', { name: label, exact: true }).click()
}

export async function retryIntentScenario({ page, owner, api, origin, projectId, worker, peer, viewportName, check, progress }: any) {
  progress('interleaved Placement retry identity')
  const task = (await api(owner, `/projects/${projectId}/tasks`, { title: `Retry intents ${viewportName}` })).data
  const path = `/projects/${projectId}/tasks/${task.id}`
  const create = async (name: string) => (await api(owner, `${path}/workspaces`, { name, workerId: worker.workerId, source: 'empty' })).data
  const a = await create(`Retry A ${viewportName}`), b = await create(`Retry B ${viewportName}`)
  const fail = async (created: any, commandId: string, reason: string) => {
    peer.send({ type: 'event', scope: 'workspace', report: { workspaceId: created.workspace.id, commandId, status: 'failed', reason, location: null, occurredAt: new Date().toISOString() } })
    await poll(async () => (await api(owner, `/workspaces/${created.workspace.id}`)).data.placements[0].failureReason === reason)
  }
  await fail(a, a.commandId, 'initial A'); await fail(b, b.commandId, 'initial B')
  await page.goto(`${origin}/next/projects/${projectId}?task=${task.id}`)
  const aPath = `/api${path}/workspaces/${a.workspace.id}/retry`
  const ids: string[] = [], commands: string[] = []
  let first = true
  await page.route((url: URL) => url.pathname === aPath, async (route: {
    request(): { postDataJSON(): { requestId: string } }
    fetch(): Promise<{ ok(): boolean; json(): Promise<{ commandId: string }> }>
    fulfill(options: { response: { ok(): boolean } }): Promise<void>
    abort(errorCode: string): Promise<void>
  }) => {
    const response = await route.fetch()
    if (!response.ok()) return route.fulfill({ response })
    ids.push(route.request().postDataJSON().requestId)
    commands.push((await response.json()).commandId)
    if (first) { first = false; await route.abort('failed') } else await route.fulfill({ response })
  })
  await page.getByRole('button', { name: `重试 ${a.workspace.name} 落点`, exact: true }).click()
  await page.getByRole('alert').filter({ hasText: '连接失败' }).waitFor()
  // A's uncertain attempt is already terminal, so a wrong new ID really creates another command.
  await fail(a, commands[0], 'uncertain A failed')
  await page.getByRole('button', { name: `重试 ${b.workspace.name} 落点`, exact: true }).click()
  await page.getByText('任务落点准备已重新请求。', { exact: true }).waitFor()
  await page.getByText('uncertain A failed', { exact: true }).waitFor()
  progress('retry command count before A replay'); const countBefore = (await api(owner, `/commands?workerId=${worker.workerId}&limit=500`)).data.items.length
  await page.getByRole('button', { name: `重试 ${a.workspace.name} 落点`, exact: true }).click()
  await poll(async () => ids.length === 2 && commands.length === 2)
  progress('A replay requestId equality'); assert.equal(ids[1], ids[0]); assert.equal(commands[1], commands[0])
  assert.equal((await api(owner, `/commands?workerId=${worker.workerId}&limit=500`)).data.items.length, countBefore)
  check(true, `${viewportName}: A response lost then B acknowledged then A retains exact requestId/commandId with no extra command`)
  // After A acknowledges, a deliberate next attempt must receive a new identity.
  await page.getByRole('button', { name: `重试 ${a.workspace.name} 落点`, exact: true }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: `重试 ${a.workspace.name} 落点`, exact: true }).click()
  await poll(async () => ids.length === 3 && commands.length === 3)
  assert.notEqual(ids[2], ids[1]); assert.notEqual(commands[2], commands[1])
  check(true, `${viewportName}: acknowledged A next deliberate retry creates a new intent`)
}

export async function lateCreateDepartureScenario({ page, owner, api, origin, projectId, viewportName, teamId, check, progress }: any) {
  for (const destination of ['settings', 'project']) {
    progress(`late Task create across ${destination}`)
    await page.goto(`${origin}/next/projects/${projectId}`)
    const held = await holdResponse(page, `/api/projects/${projectId}/tasks`, 'POST')
    await beginCreate(page, `Held creation ${destination} ${viewportName}`); await held.ready
    let expected: string
    if (destination === 'settings') {
      await shell(page, viewportName, '设置'); await page.getByRole('heading', { name: '账号设置', exact: true }).waitFor(); expected = page.url()
    } else {
      const other = (await api(owner, '/projects', { name: `Other intent scope ${viewportName}`, teamId })).data
      const task = (await api(owner, `/projects/${other.id}/tasks`, { title: 'Current draft task' })).data
      // SPA departure retires the create form without aborting its real transport response.
      await page.getByRole('button', { name: '返回项目列表', exact: true }).click()
      await page.getByRole('link').filter({ hasText: other.name }).first().click()
      await page.getByRole('button', { name: task.title, exact: true }).click()
      await page.getByLabel('编辑描述', { exact: true }).fill('current page draft must not be prompted')
      expected = page.url()
    }
    let prompts = 0
    page.removeAllListeners('dialog'); const deny = async (dialog: any) => { prompts++; await dialog.dismiss() }; page.on('dialog', deny)
    await held.release()
    assert.equal(page.url(), expected); assert.equal(prompts, 0)
    if (destination === 'project') assert.equal(await page.getByLabel('编辑描述', { exact: true }).inputValue(), 'current page draft must not be prompted')
    page.off('dialog', deny); page.on('dialog', (dialog: any) => dialog.accept())
    check(true, `${viewportName}: late create after ${destination} departure cannot navigate or prompt current draft`)
  }
}

export async function retiredCreateAndSaveScenario({ page, owner, member, memberId, api, projectId, taskId, viewportName, check, progress }: any) {
  const taskPath = `/projects/${projectId}/tasks/${taskId}`
  const role = async (value: string) => {
    assert.equal((await api(owner, `/projects/${projectId}/grants`, { userId: memberId, role: value })).status, 201)
    const refreshed = page.waitForResponse((response: any) => new URL(response.url()).pathname === '/api/projects' && response.status() === 200)
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await refreshed
    await poll(async () => value === 'viewer' ? await createForm(page).count() === 0 : await createForm(page).isVisible())
    await page.getByLabel('编辑描述', { exact: true }).waitFor()
  }
  progress('late Task create across actual viewer retirement')
  const held = await holdResponse(page, `/api/projects/${projectId}/tasks`, 'POST')
  await beginCreate(page, `Held role creation ${viewportName}`); await held.ready
  await role('viewer'); const expected = page.url()
  let prompts = 0; const deny = async (dialog: any) => { prompts++; await dialog.dismiss() }; page.on('dialog', deny)
  await held.release(); assert.equal(page.url(), expected); assert.equal(prompts, 0)
  check(true, `${viewportName}: successful Task POST released after viewer retirement cannot navigate`)
  await role('contributor')
  progress('save preflight GET across actual editor retirement')
  const before = (await api(member, taskPath)).data.description
  await page.getByLabel('编辑描述', { exact: true }).fill('retired preflight must not PATCH')
  const preflight = await holdResponse(page, `/api${taskPath}`, 'GET')
  let patches = 0
  const listener = (request: any) => { if (new URL(request.url()).pathname === `/api${taskPath}` && request.method() === 'PATCH') patches++ }
  page.on('request', listener)
  await page.getByRole('button', { name: '保存任务内容', exact: true }).click(); await preflight.ready
  await role('viewer'); await preflight.release()
  assert.equal(patches, 0); assert.equal(prompts, 0)
  assert.equal(await page.getByLabel('编辑描述', { exact: true }).inputValue(), before)
  assert.ok(await page.getByRole('button', { name: '保存任务内容', exact: true }).isDisabled())
  assert.equal((await api(member, taskPath)).data.description, before)
  page.off('request', listener); page.off('dialog', deny)
  check(true, `${viewportName}: held content-save preflight after role retirement issues zero PATCH and restores no draft`)
  await role('contributor')
}
