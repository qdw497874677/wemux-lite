import assert from 'node:assert/strict'

/** Hold outgoing PATCH, not its response: a real competing write commits inside the GET/PATCH gap. */
export async function taskContentCasScenarios({ page, owner, api, origin, projectId, viewportName, check, progress }: any) {
  const task = (await api(owner, `/projects/${projectId}/tasks`, { title: `Content CAS ${viewportName}`, description: 'baseline\ncontent\n', acceptanceCriteria: null })).data
  const path = `/projects/${projectId}/tasks/${task.id}`
  const matcher = (url: URL) => url.pathname === `/api${path}`
  const get = async () => (await api(owner, path)).data
  const open = async () => { await page.goto(`${origin}/next/projects/${projectId}?task=${task.id}`); await page.getByLabel('编辑描述', { exact: true }).waitFor() }
  async function holdPatch() {
    let capture!: (body: any) => void, release!: () => void, finish!: () => void
    const captured = new Promise<any>(resolve => { capture = resolve }), gate = new Promise<void>(resolve => { release = resolve }), done = new Promise<void>(resolve => { finish = resolve })
    let used = false
    const handler = async (route: any) => {
      if (used || route.request().method() !== 'PATCH') return route.continue()
      used = true; capture(route.request().postDataJSON()); await gate
      await route.continue().catch(() => {}); finish()
    }
    await page.route(matcher, handler)
    return { captured, async release() { release(); await done; await page.unroute(matcher, handler) } }
  }
  for (const sameField of [true, false]) {
    progress(`${viewportName}: atomic content ${sameField ? 'same' : 'different'} field race`)
    await open()
    const before = await get(), local = sameField ? 'local draft\nretain newline\n' : `${task.title} edited`
    await page.getByLabel(sameField ? '编辑描述' : '编辑标题', { exact: true }).fill(local)
    const held = await holdPatch()
    await page.getByRole('button', { name: '保存任务内容', exact: true }).click()
    const body = await held.captured
    assert.equal(body.version, before.version)
    assert.deepEqual(Object.keys(body).sort(), [sameField ? 'description' : 'title', 'version'].sort())
    const remote = sameField ? 'remote same field\n' : 'remote unrelated description\n'
    // Deliberate legacy caller without version must still invalidate the versioned write.
    assert.equal((await api(owner, path, { description: remote }, 'PATCH')).status, 200)
    const conflict = page.waitForResponse((response: any) => new URL(response.url()).pathname === `/api${path}` && response.request().method() === 'PATCH' && response.status() === 409)
    conflict.catch(() => {})
    await held.release()
    assert.equal((await (await conflict).json()).error.code, 'version_conflict')
    await page.getByRole('button', { name: '重新加载内容版本', exact: true }).waitFor()
    assert.equal((await get()).description, remote)
    assert.equal(await page.getByLabel(sameField ? '编辑描述' : '编辑标题', { exact: true }).inputValue(), local)
    assert.ok(await page.getByRole('button', { name: '保存任务内容', exact: true }).isDisabled())
    await page.getByRole('button', { name: '重新加载内容版本', exact: true }).click()
    await page.getByText('已加载最新内容版本，请核实草稿。', { exact: true }).waitFor()
    if (sameField) {
      await page.getByRole('button', { name: '保留本地编辑描述', exact: true }).click()
    } else assert.equal(await page.getByLabel('编辑描述', { exact: true }).inputValue(), remote)
    const success = page.waitForResponse((response: any) => new URL(response.url()).pathname === `/api${path}` && response.request().method() === 'PATCH' && response.status() === 200)
    success.catch(() => {})
    await page.getByRole('button', { name: '保存任务内容', exact: true }).click(); await success
    await page.getByText('任务内容已保存。', { exact: true }).waitFor()
    const saved = await get()
    assert.equal(saved.description, sameField ? local : remote)
    assert.equal(saved.acceptanceCriteria, null)
    if (!sameField) assert.equal(saved.title, local)
    check(true, `${viewportName}: outgoing versioned PATCH ${sameField ? 'same' : 'different'} field race returns real409, preserves draft and explicitly recovers without losing remote content/null`)
  }
  progress(`${viewportName}: pending multiline save response retirement`)
  await open()
  await page.getByLabel('编辑描述', { exact: true }).fill('committed multiline\ntrailing\n')
  await page.getByLabel('编辑验收标准', { exact: true }).fill('criteria\nline')
  await page.getByLabel('编辑验收标准', { exact: true }).fill('')
  let delivered!: () => void, accepted!: () => void
  const gate = new Promise<void>(resolve => { delivered = resolve }), committed = new Promise<void>(resolve => { accepted = resolve })
  let used = false
  const delayResponse = async (route: any) => {
    if (used || route.request().method() !== 'PATCH') return route.continue()
    const response = await route.fetch()
    if (!response.ok()) return route.fulfill({ response })
    used = true; accepted(); await gate; await route.fulfill({ response }).catch(() => {})
  }
  await page.route(matcher, delayResponse)
  await page.getByRole('button', { name: '保存任务内容', exact: true }).click(); await committed
  assert.ok(await page.getByLabel('编辑描述', { exact: true }).isDisabled())
  assert.equal(await page.getByLabel('编辑描述', { exact: true }).inputValue(), 'committed multiline\ntrailing\n')
  assert.equal((await get()).acceptanceCriteria, '')
  assert.equal((await get()).description, 'committed multiline\ntrailing\n')
  await page.getByRole('button', { name: '关闭详情', exact: true }).click()
  const retiredUrl = page.url()
  const responseDone = page.waitForResponse((response: any) => new URL(response.url()).pathname === `/api${path}` && response.request().method() === 'PATCH' && response.status() === 200); responseDone.catch(() => {})
  delivered(); await responseDone; await page.unroute(matcher, delayResponse)
  assert.equal(page.url(), retiredUrl)
  assert.equal(await page.getByRole('heading', { name: '任务详情', exact: true }).count(), 0)
  check(true, `${viewportName}: pending multiline/explicit-empty content commits once; retired editor ignores delayed successful response`)
  progress(`${viewportName}: retired editor during held content409`)
  await open(); await page.getByLabel('编辑描述', { exact: true }).fill('retired local draft')
  const held = await holdPatch(); await page.getByRole('button', { name: '保存任务内容', exact: true }).click(); await held.captured
  await api(owner, path, { description: 'remote survives retirement\n' }, 'PATCH')
  await page.getByRole('button', { name: '关闭详情', exact: true }).click()
  const currentUrl = page.url()
  const conflict = page.waitForResponse((response: any) => new URL(response.url()).pathname === `/api${path}` && response.request().method() === 'PATCH' && response.status() === 409); conflict.catch(() => {})
  await held.release(); await conflict
  assert.equal(page.url(), currentUrl)
  assert.equal(await page.getByRole('heading', { name: '任务详情', exact: true }).count(), 0)
  assert.equal((await get()).description, 'remote survives retirement\n')
  check(true, `${viewportName}: retired content editor ignores delayed real409, does not restore draft or navigate`)
}
