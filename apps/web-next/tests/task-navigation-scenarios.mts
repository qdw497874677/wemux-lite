import assert from 'node:assert/strict'

export async function taskNavigationScenarios({ page, owner, api, origin, projectId, task, worker, peer, viewportName, check, progress }: any) {
  const path = `/projects/${projectId}/tasks/${task.id}`
  progress('task-local workspace create uncertain retry')
  let lost = false
  await page.route((url: URL) => url.pathname === `/api${path}/workspaces`, async (route: {
    request(): { method(): string }
    fetch(): Promise<unknown>
    abort(errorCode: string): Promise<void>
    continue(): Promise<void>
  }) => {
    if (route.request().method() === 'POST' && !lost) { lost = true; await route.fetch(); await route.abort('failed') } else await route.continue()
  })
  const form = page.getByRole('button', { name: '创建并绑定工作区', exact: true }).locator('xpath=ancestor::form')
  await form.locator('[name=name]').fill(`Task workspace ${viewportName}`)
  await form.locator('[name=workerId]').selectOption(worker.workerId)
  await form.getByRole('button', { name: '创建并绑定工作区', exact: true }).click()
  await form.getByRole('alert').filter({ hasText: '连接失败' }).waitFor()
  await form.getByRole('button', { name: '创建并绑定工作区', exact: true }).click()
  await page.getByText('工作区已创建并绑定，准备结果以各落点报告为准。', { exact: true }).waitFor()
  const current = (await api(owner, path)).data
  assert.equal(current.workspaces.length, 1)
  const workspace = (await api(owner, `/workspaces/${current.workspaces[0].workspaceId}`)).data
  assert.equal(workspace.name, `Task workspace ${viewportName}`)
  peer.send({ type: 'event', scope: 'workspace', report: { workspaceId: workspace.id, commandId: workspace.placements[0].provisioning.commandId, status: 'failed', reason: 'task-local fixture failure', location: null, occurredAt: new Date().toISOString() } })
  for (let i = 0; i < 100; i++) { if ((await api(owner, `/workspaces/${workspace.id}`)).data.placements[0].status === 'failed') break; await new Promise(resolve => setTimeout(resolve, 20)) }
  await page.getByRole('button', { name: '加载最新版本', exact: true }).click()
  await page.getByText('task-local fixture failure', { exact: true }).waitFor()
  await page.getByRole('button', { name: `重试 ${workspace.name} 落点`, exact: true }).click()
  await page.getByText('任务落点准备已重新请求。', { exact: true }).waitFor()
  const retried = (await api(owner, `/workspaces/${workspace.id}`)).data
  assert.notEqual(retried.placements[0].provisioning.commandId, workspace.placements[0].provisioning.commandId)
  check(true, `${viewportName}: task-local uncertain create binds once and per-placement retry uses protocol fixture`)
  // Existing test continues with a different Workspace, so unbind only this owned fixture.
  assert.equal((await api(owner, `${path}/workspaces/${workspace.id}`, { version: current.version }, 'DELETE')).status, 200)
  await page.getByRole('button', { name: '加载最新版本', exact: true }).click()

  progress('task deep link and history')
  assert.equal(new URL(page.url()).searchParams.get('task'), task.id)
  await page.reload(); await page.getByLabel('编辑描述', { exact: true }).waitFor()
  await page.getByRole('button', { name: '关闭详情', exact: true }).click()
  assert.equal(new URL(page.url()).searchParams.has('task'), false)
  await page.goBack(); await page.getByLabel('编辑描述', { exact: true }).waitFor()
  assert.equal(new URL(page.url()).searchParams.get('task'), task.id)
  await page.goForward(); await page.getByRole('heading', { name: '任务详情', exact: true }).waitFor({ state: 'hidden' })
  await page.goBack(); await page.getByLabel('编辑描述', { exact: true }).waitFor()
  check(true, `${viewportName}: Task query deep link reload and back-forward restores detail`)

  progress('unsaved close shell tab and history')
  const another = (await api(owner, `/projects/${projectId}/tasks`, { title: `Navigation target ${viewportName}`, requestId: `navigation-${viewportName}` })).data
  await page.getByRole('button', { name: '刷新任务', exact: true }).click()
  await page.getByRole('button', { name: another.title, exact: true }).waitFor()
  await page.getByLabel('编辑描述', { exact: true }).fill('navigation protected draft')
  page.removeAllListeners('dialog')
  let prompts = 0
  const deny = async (dialog: any) => { prompts++; await dialog.dismiss() }
  page.on('dialog', deny)
  await page.getByRole('button', { name: '关闭详情', exact: true }).click()
  await page.getByRole('button', { name: '工作区', exact: true }).click()
  await page.getByRole('button', { name: '返回项目列表', exact: true }).click()
  await page.getByRole('button', { name: another.title, exact: true }).click()
  if (viewportName === 'mobile') await page.getByRole('button', { name: '打开导航', exact: true }).click()
  await page.getByRole('navigation', { name: '主导航' }).filter({ visible: true }).getByRole('link', { name: '设置', exact: true }).click()
  if (viewportName === 'mobile') await page.keyboard.press('Escape')
  // Real popstate with refusal restores the current history entry, without re-mounting draft.
  await page.evaluate(() => history.back())
  for (let i = 0; i < 100 && (prompts < 6 || new URL(page.url()).searchParams.get('task') !== task.id); i++) await page.waitForTimeout(10)
  assert.equal(await page.getByLabel('编辑描述', { exact: true }).inputValue(), 'navigation protected draft')
  assert.equal(new URL(page.url()).searchParams.get('task'), task.id)
  assert.ok(prompts >= 6)
  page.off('dialog', deny); page.on('dialog', (dialog: any) => dialog.accept())
  await page.getByRole('button', { name: '关闭详情', exact: true }).click()
  await page.getByRole('heading', { name: '任务详情', exact: true }).waitFor({ state: 'hidden' })
  const actual = (await api(owner, path)).data
  await page.getByRole('button', { name: actual.title, exact: true }).click()
  await page.getByLabel('编辑描述', { exact: true }).waitFor()
  assert.notEqual(await page.getByLabel('编辑描述', { exact: true }).inputValue(), 'navigation protected draft')
  check(true, `${viewportName}: refused close/tab/list/history preserves draft; confirmed close discards memory-only draft`)
}

/** Capture real authorized HTTP responses, then deliver only after authority/UI changes. */
export async function holdTaskReads(page: any, projectId: string, taskId: string) {
  const paths = new Set([`/api/projects/${projectId}/tasks/${taskId}`, `/api/projects/${projectId}/tasks/${taskId}/activity`, '/api/workspaces'])
  const held = new Set<string>(), pending: Promise<void>[] = []
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const handler = async (route: any) => {
    const path = new URL(route.request().url()).pathname
    if (route.request().method() !== 'GET' || held.has(path)) return route.continue()
    held.add(path)
    const response = await route.fetch(); assert.equal(response.status(), 200)
    const body = await response.body()
    pending.push(gate.then(async () => { await route.fulfill({ response, body }).catch(() => {}) }))
    await pending.at(-1)
  }
  const matcher = (url: URL) => paths.has(url.pathname)
  await page.route(matcher, handler)
  await page.getByRole('button', { name: '加载最新版本', exact: true }).click()
  for (let i = 0; i < 200 && pending.length < 3; i++) await page.waitForTimeout(10)
  assert.equal(pending.length, 3)
  return async () => { release(); await Promise.all(pending); await page.unroute(matcher, handler); await page.waitForTimeout(50) }
}
