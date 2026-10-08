import assert from 'node:assert/strict'

/** Two mounted editors use real HTTP. No content response mocks. */
export async function checkTaskContentEditors({ page, context, origin, projectId, task, api, viewport, check, progress }: any) {
  const path = `/projects/${projectId}/tasks/${task.id}`
  const description = 'first line\n  second line\n', criteria = '- first\n- second\n'
  const get = async () => (await api(context, path)).data
  const save = async (editor: any) => {
    const response = editor.waitForResponse((r: any) => new URL(r.url()).pathname === `/api${path}` && r.request().method() === 'PATCH' && r.status() === 200)
    response.catch(() => {}) // Observe rejection even if a preceding UI assertion fails.
    await editor.getByRole('button', { name: '保存任务内容', exact: true }).click()
    assert.equal((await response).status(), 200)
    await editor.getByText('任务内容已保存。', { exact: true }).waitFor()
  }
  progress('multiline initial API values'); assert.equal((await get()).description, description)
  assert.equal((await get()).acceptanceCriteria, criteria)
  progress('multiline initial editor values'); await page.getByLabel('编辑描述', { exact: true }).waitFor(); assert.equal(await page.getByLabel('编辑描述', { exact: true }).inputValue(), description)
  assert.equal(await page.getByLabel('编辑验收标准', { exact: true }).inputValue(), criteria)
  await page.getByLabel('编辑标题', { exact: true }).fill(`${task.title} renamed`)
  progress('title-only save'); await save(page)
  assert.equal((await get()).description, description)
  assert.equal((await get()).acceptanceCriteria, criteria)
  check(true, 'multiline create and title-only roundtrip retain exact content')

  const other = await context.newPage()
  try {
    progress('second editor open'); await other.setViewportSize(viewport)
    await other.goto(`${origin}/next/projects/${projectId}`)
    await other.getByRole('button', { name: `${task.title} renamed`, exact: true }).click()
    await other.getByLabel('编辑描述', { exact: true }).waitFor()
    await page.getByLabel('编辑标题', { exact: true }).fill(`${task.title} independent`)
    await other.getByLabel('编辑描述', { exact: true }).fill('Other editor\nnew description\n')
    progress('different-field remote save'); await save(other); progress('different-field local save'); await save(page); progress('different-field persisted assertions')
    assert.equal((await get()).title, `${task.title} independent`)
    assert.equal((await get()).description, 'Other editor\nnew description\n')
    check(true, 'two editors different-field saves preserve both edits')

    await other.getByLabel('编辑描述', { exact: true }).fill('Remote same-field\nchange')
    await page.getByLabel('编辑描述', { exact: true }).fill('Local same-field\ndraft')
    await save(other)
    progress('same-field reload'); await page.getByRole('button', { name: '加载最新版本', exact: true }).click()
    await page.getByText('编辑描述存在远端修改，请选择保留哪一份。', { exact: true }).waitFor()
    assert.equal(await page.getByLabel('编辑描述', { exact: true }).inputValue(), 'Local same-field\ndraft')
    assert.ok(await page.getByRole('button', { name: '保存任务内容', exact: true }).isDisabled())
    await page.getByRole('button', { name: '保留本地编辑描述', exact: true }).click()
    await save(page)
    assert.equal((await get()).description, 'Local same-field\ndraft')
    check(true, 'same-field reload retains draft and requires explicit local choice')

    progress('second same-field setup'); await other.getByRole('button', { name: '加载最新版本', exact: true }).click()
    for (let i = 0; i < 100 && await other.getByLabel('编辑描述', { exact: true }).inputValue() !== 'Local same-field\ndraft'; i++) await other.waitForTimeout(20)
    assert.equal(await other.getByLabel('编辑描述', { exact: true }).inputValue(), 'Local same-field\ndraft')
    await other.getByLabel('编辑描述', { exact: true }).fill('Latest remote\nversion')
    await save(other)
    await page.getByLabel('编辑描述', { exact: true }).fill('Second local draft')
    // Save performs a fresh read and refuses a detected conflict without PATCH.
    let writes = 0
    const listener = (request: any) => { if (new URL(request.url()).pathname === `/api${path}` && request.method() === 'PATCH') writes++ }
    page.on('request', listener)
    await page.getByRole('button', { name: '保存任务内容', exact: true }).click()
    await page.getByText('编辑描述存在远端修改，请选择保留哪一份。', { exact: true }).waitFor()
    assert.equal(writes, 0); page.off('request', listener)
    await page.getByRole('button', { name: '采用远端编辑描述', exact: true }).click()
    assert.equal(await page.getByLabel('编辑描述', { exact: true }).inputValue(), 'Latest remote\nversion')
    check(true, 'save preflight detects same-field conflict; remote choice discards only that field')
    progress('null-empty roundtrip'); for (const acceptanceCriteria of [null, '']) {
      assert.equal((await api(context, path, { acceptanceCriteria }, 'PATCH')).status, 200)
      await page.getByRole('button', { name: '加载最新版本', exact: true }).click()
      // Wait for the actual authoritative detail GET, then verify via title-only save.
      await page.getByLabel('编辑标题', { exact: true }).fill(`${task.title} ${acceptanceCriteria === null ? 'null' : 'empty'}`)
      await save(page)
      assert.equal((await get()).acceptanceCriteria, acceptanceCriteria)
    }
    check(true, 'title-only saves preserve distinct null and empty acceptance criteria')
  } finally { await other.close() }
}
