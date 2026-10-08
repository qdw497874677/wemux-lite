import { taskContentCasScenarios } from './task-content-cas.browser.mts'
import { retryIntentScenario, lateCreateDepartureScenario, retiredCreateAndSaveScenario } from './task-async-intent-scenarios.mts'
import { taskNavigationScenarios, holdTaskReads } from './task-navigation-scenarios.mts'
import { checkTaskContentEditors } from './task-content-editors.mts'
// Synthetic accounts and a controlled Worker protocol peer. No real Agent or clone.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { WebSocket } from 'ws'
import { createWemuxServer } from '../../server/src/server.ts'
import { TransportV2Peer } from '../../server/src/test/transport-v2-peer.ts'
import { launchAcceptanceBrowser } from './acceptance-runtime.mjs'
const root = await mkdtemp(join(tmpdir(), 'wemux-ticket03-browser-'))
const evidence = process.env.WEMUX_TICKET03_EVIDENCE ?? `${root}-result.json`
const result: { passed: boolean; checks: string[]; failureStep?: string; protocolFixture: string } = { passed: false, checks: [], protocolFixture: 'Controlled Worker WebSocket reports; no real git clone or runtime execution' }
let app: ReturnType<typeof createWemuxServer> | undefined, browser: any, peer: TransportV2Peer | undefined, step = 'setup'
const check = (value: unknown, name: string) => { assert.ok(value, name); result.checks.push(name) }
try {
  assert.ok(process.env.WEMUX_NEXT_TEST_DIST?.startsWith('/tmp/'))
  const reservation = createServer(); await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve)); const port = (reservation.address() as { port: number }).port; await new Promise<void>(resolve => reservation.close(() => resolve()))
  const origin = `http://127.0.0.1:${port}`, outbox = join(root, 'outbox'); await mkdir(outbox)
  app = createWemuxServer({ databasePath: join(root, 'server.sqlite'), administratorEmails: ['owner@example.test'], capabilitySecret: 'synthetic-project-test-capability-secret-1234', webNextStaticPath: resolve(process.env.WEMUX_NEXT_TEST_DIST!), mail: { WEMUX_PUBLIC_URL: origin, WEMUX_SMTP_FROM: 'Wemux <test@example.test>', WEMUX_MAIL_OUTBOX: outbox }, google: {} })
  await app.listen(port); browser = await launchAcceptanceBrowser()
  const api = async (context: any, path: string, body?: unknown, method?: string) => {
    let csrf: string | undefined
    if (body !== undefined || (method && method !== 'GET')) { const me = await context.request.get(`${origin}/api/auth/me`); if (me.ok()) csrf = (await me.json()).csrfToken }
    const response = await context.request.fetch(`${origin}/api${path}`, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { Origin: origin, ...(csrf ? { 'x-csrf-token': csrf } : {}) }, ...(body === undefined ? {} : { data: body }) })
    return { status: response.status(), data: response.status() === 204 ? null : await response.json() }
  }
  const register = async (context: any, email: string) => {
    assert.equal((await api(context, '/auth/register', { email, displayName: email.split('@')[0], password: 'synthetic password 12345' })).status, 202)
    const messages = await readdir(outbox); let token = ''
    for (const name of messages) { const raw = await readFile(join(outbox, name), 'utf8'); if (!raw.includes(email)) continue; const text = Buffer.from(raw.slice(raw.indexOf('\r\n\r\n') + 4).replace(/\r\n/g, ''), 'base64').toString(); const match = text.match(/http:\/\/[^\s]+\/next\/auth\/verify-email\?token=([^\s]+)/); if (match) token = new URL(`http://x/?token=${match[1]}`).searchParams.get('token')! }
    assert.ok(token); assert.equal((await api(context, '/auth/email/verify', { token })).status, 200)
    return (await api(context, '/auth/me')).data
  }
  const owner = await browser.newContext(), member = await browser.newContext(), outsider = await browser.newContext()
  step = 'register private identities'
  const ownerAccount = await register(owner, 'owner@example.test')
  assert.equal((await api(owner, '/settings/registration-policy', { policy: 'open' }, 'PATCH')).status, 200)
  const memberAccount = await register(member, 'member@example.test'), outsiderAccount = await register(outsider, 'outsider@example.test')
  const teamId = ownerAccount.teamId
  const invitation = await api(owner, `/teams/${teamId}/invitations`, { email: 'member@example.test' })
  assert.equal((await api(member, `/team-invitations/${invitation.data.token}/accept`, {})).status, 200)
  const enrollment = await api(owner, '/enrollment-tokens', {})
  const worker = (await api(owner, '/workers/enroll', { token: enrollment.data.token, name: 'Private protocol Worker' })).data
  peer = new TransportV2Peer(new WebSocket(`${origin.replace('http', 'ws')}/worker/ws`, { headers: { Authorization: `Bearer ${worker.credential}` } }), worker.workerId)
  await peer.connect({ name: 'Private protocol Worker' })
  peer.send({ type: 'capability', detectedAt: new Date().toISOString(), workerId: worker.workerId, capabilities: [{ agentKey: 'test', displayName: 'Test Agent', version: 'fixture', mode: 'execution', availability: { status: 'available' }, models: [{ modelId: 'test', displayName: 'Local Test', source: 'configured' }] }] })
  const waitApi = async (path: string, predicate: (data: any) => boolean) => { for (let i = 0; i < 100; i++) { const response = await api(owner, path); if (predicate(response.data)) return response.data; await new Promise(resolve => setTimeout(resolve, 30)) } throw Error('API condition not reached') }
  await waitApi(`/workers/${worker.workerId}`, data => data.capabilities.length === 1)
  const submit = async (page: any, label: string, values: Record<string, string> = {}) => { step = label; const button = page.locator('form').getByRole('button', { name: label, exact: true }); const form = button.locator('xpath=ancestor::form'); for (const [name, value] of Object.entries(values)) { const field = form.locator(`[name="${name}"]`); if (await field.evaluate((e: Element) => e.tagName === 'SELECT')) await field.selectOption(value); else await field.fill(value) } await button.click() }
  for (const [viewportName, viewport] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]] as const) {
    const page = await owner.newPage(); await page.setViewportSize(viewport); page.setDefaultTimeout(10000); page.on('dialog', (dialog: any) => dialog.accept()); const errors: string[] = []; page.on('pageerror', () => errors.push('pageerror'))
    step = `${viewportName}: create project`
    await page.goto(`${origin}/next/projects`); await submit(page, '创建项目', { name: `Project ${viewportName}` })
    await page.getByRole('heading', { name: `Project ${viewportName}`, exact: true }).waitFor()
    const projectId = new URL(page.url()).pathname.split('/').at(-1)!
    const taskPath = `/projects/${projectId}/tasks`
    await page.getByRole('button', { name: '工作区', exact: true }).click()
    await submit(page, '创建工作区', { name: `Workspace ${viewportName}`, workerId: worker.workerId })
    await page.getByRole('heading', { name: `Workspace ${viewportName}`, exact: true }).waitFor()
    let workspace = (await api(owner, `/workspaces?projectId=${projectId}`)).data.items[0]
    const firstCommand = workspace.placements[0].provisioning.commandId
    // Current preparation cancellation is explicitly protected, even while pending.
    await page.getByText('准备取消暂不可用。已提交的准备请求会继续处理；关闭页面或表单不会停止 Worker，也不会回滚或删除文件。', { exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: '取消排队准备', exact: true }).count(), 0)
    const refusal = await api(owner, `/commands/${firstCommand}`, undefined, 'DELETE')
    assert.equal(refusal.status, 409); assert.equal(refusal.data.error.code, 'protected_command')
    peer.send({ type: 'event', scope: 'workspace', report: { workspaceId: workspace.id, commandId: firstCommand, status: 'failed', reason: 'controlled preparation failure', location: null, occurredAt: new Date().toISOString() } })
    await waitApi(`/workspaces/${workspace.id}`, data => data.placements[0].status === 'failed')
    await page.getByRole('button', { name: '刷新准备状态', exact: true }).click(); await page.getByText('controlled preparation failure', { exact: true }).waitFor()
    await submit(page, '重试准备'); step = 'retry notice'; await page.getByText('准备请求已提交。', { exact: true }).waitFor()
    step = 'retry replacement command'; workspace = await waitApi(`/workspaces/${workspace.id}`, data => data.placements[0].provisioning.commandId !== firstCommand)
    peer.send({ type: 'event', scope: 'workspace', report: { workspaceId: workspace.id, commandId: workspace.placements[0].provisioning.commandId, status: 'ready', reason: null, location: { workspaceId: workspace.id, workerId: worker.workerId, rootPath: `${root}/fixture-workspace`, checkouts: [] }, occurredAt: new Date().toISOString() } })
    step = 'ready report'; await waitApi(`/workspaces/${workspace.id}`, data => data.placements[0].status === 'ready')
    await page.getByRole('button', { name: '刷新准备状态', exact: true }).click(); step = 'ready browser projection'; await page.getByText('Private protocol Worker：已就绪', { exact: true }).waitFor()
    check(true, `${viewportName}: real UI create placement, protected cancellation, protocol failure retry and ready projection`)
    await submit(page, '创建工作区', { name: `Repository ${viewportName}`, gitUrl: 'https://example.test/private-fixture.git', revision: 'main' })
    await page.getByRole('heading', { name: `Repository ${viewportName}`, exact: true }).waitFor()
    const repositoryWorkspace = (await api(owner, `/workspaces?projectId=${projectId}`)).data.items.find((value: any) => value.spec.kind === 'repository')
    check(!!repositoryWorkspace && repositoryWorkspace.placements.length === 0, `${viewportName}: Repository linked without claiming clone or placement`)
    const article = page.locator('article').filter({ has: page.getByRole('heading', { name: `Repository ${viewportName}`, exact: true }) })
    await article.locator('select[name="workerId"]').selectOption(worker.workerId)
    await article.getByRole('button', { name: '新增 Worker 落点', exact: true }).click()
    await waitApi(`/workspaces/${repositoryWorkspace.id}`, data => data.placements.length === 1)
    check(true, `${viewportName}: absent Placement provisioned through authoritative reprovision route`)

    await page.getByRole('button', { name: '任务', exact: true }).click()
    let uncertain = true
    await page.route((url: URL) => url.pathname === `/api/projects/${projectId}/tasks`, async (route: {
      request(): { method(): string }
      fetch(): Promise<unknown>
      abort(errorCode: string): Promise<void>
      continue(): Promise<void>
    }) => {
      if (route.request().method() === 'POST' && uncertain) { uncertain = false; await route.fetch(); await route.abort('failed') }
      else await route.continue()
    })
    await submit(page, '创建任务', { title: `Task ${viewportName}`, description: 'first line\n  second line\n', acceptanceCriteria: '- first\n- second\n', priority: 'high' })
    await page.getByRole('alert').filter({ hasText: '连接失败' }).waitFor()
    await submit(page, '创建任务', { title: `Task ${viewportName}`, description: 'first line\n  second line\n', acceptanceCriteria: '- first\n- second\n', priority: 'high' })
    await page.getByRole('heading', { name: '任务详情', exact: true }).waitFor(); await page.getByLabel('编辑标题', { exact: true }).waitFor()
    const createdTasks = (await api(owner, taskPath)).data.items
    check(createdTasks.length === 1, `${viewportName}: lost create response retries same identity without duplicate Task`)
    const task = createdTasks[0]
    step = `${viewportName}: content editor regressions`
    await checkTaskContentEditors({ page, context: owner, origin, projectId, task, api, viewport, progress: (name: string) => { step = `${viewportName}: ${name}` }, check: (value: unknown, name: string) => check(value, `${viewportName}: ${name}`) })
    await taskNavigationScenarios({ page, owner, api, origin, projectId, task, worker, peer, viewportName, check, progress: (name: string) => { step = `${viewportName}: ${name}` } })
    step = 'cross scope fixtures'; const foreignTeam = (await api(owner, '/teams', { name: `Other ${viewportName}` })).data
    const foreignProject = (await api(owner, '/projects', { name: `Other project ${viewportName}`, teamId: foreignTeam.id, requestId: `other-project-${viewportName}` })).data
    const foreignWorkspace = (await api(owner, '/workspaces', { projectId: foreignProject.id, name: 'Other team workspace', requestId: `other-workspace-${viewportName}` })).data.workspace
    step = 'cross scope binding'; check((await api(owner, `${taskPath}/${task.id}/workspaces/${foreignWorkspace.id}`, {}, 'PUT')).status === 403, `${viewportName}: Workspace cannot implicitly move across Project or Team`)
    step = 'cross scope create'; check((await api(owner, `${taskPath}?teamId=${foreignTeam.id}`, { title: 'Wrong scope', requestId: `scope-${viewportName}` })).status === 403, `${viewportName}: create rejects mismatched Team scope`)

    await submit(page, '绑定工作区', { workspaceId: workspace.id }); await page.getByRole('button', { name: '解绑工作区', exact: true }).waitFor()
    await submit(page, '保存执行指派', { target: JSON.stringify([workspace.id, worker.workerId, 'test', 'test']) }); await page.getByRole('button', { name: '清除指派', exact: true }).waitFor()
    await page.getByRole('button', { name: '清除指派', exact: true }).click(); await page.getByRole('button', { name: '清除指派', exact: true }).waitFor({ state: 'hidden' })
    await submit(page, '添加外部关联', { url: 'https://github.com/example/project/issues/1' }); await page.getByRole('link', { name: 'https://github.com/example/project/issues/1', exact: true }).waitFor()
    await submit(page, '保存任务内容', { description: '已编辑目标' }); await page.getByText('任务内容已保存。', { exact: true }).waitFor()
    const editor = page.getByLabel('编辑描述', { exact: true })
    await editor.fill('保留未提交草稿'); const element = await editor.elementHandle()
    const refreshed = page.waitForResponse((response: { url(): string }) => new URL(response.url()).pathname === '/api/projects')
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await refreshed
    await page.getByRole('heading', { name: '任务详情', exact: true }).waitFor()
    check(await element.evaluate((node: HTMLInputElement) => node.isConnected && node.value === '保留未提交草稿'), `${viewportName}: background authority refresh preserves mounted draft`)
    let latest = (await api(owner, `${taskPath}/${task.id}`)).data
    assert.equal((await api(owner, `${taskPath}/${task.id}`, { status: 'todo', version: latest.version }, 'PATCH')).status, 200)
    await submit(page, '更新任务状态', { status: 'blocked' }); step = 'CAS conflict displayed'; await page.getByRole('alert').filter({ hasText: /Task changed/ }).waitFor()
    await page.getByRole('button', { name: '加载最新版本', exact: true }).click(); step = 'CAS reload version'; await page.getByText(`版本 ${latest.version + 1}，待处理`, { exact: true }).waitFor()
    await submit(page, '更新任务状态', { status: 'in_progress' }); step = 'CAS retry succeeded'; await page.getByText('任务状态已更新。', { exact: true }).waitFor()
    await page.getByRole('button', { name: '解绑工作区', exact: true }).click(); await page.getByRole('button', { name: '解绑工作区', exact: true }).waitFor({ state: 'hidden' })
    check((await api(owner, `/workspaces/${workspace.id}`)).status === 200, `${viewportName}: unbind preserves Workspace (not task deletion)`)
    step = 'board sort'; await page.getByLabel('任务视图', { exact: true }).selectOption('board'); await page.getByLabel('任务排序', { exact: true }).selectOption('priority')
    step = 'open project settings'; await page.getByRole('button', { name: '项目设置', exact: true }).click()
    await submit(page, '保存共享范围', { scope: 'selected-members' }); step = 'scope persisted'; await waitApi(`/projects/${projectId}`, data => data.shareScope === 'selected-members')
    await submit(page, '授予项目权限', { userId: memberAccount.user.id, role: 'contributor' }); await page.getByText('项目权限已保存。', { exact: true }).waitFor()
    check((await api(outsider, `/projects/${projectId}`)).status === 404, `${viewportName}: cross-team detail hidden`)
    check(!(await api(outsider, '/projects')).data.items.some((p: any) => p.id === projectId), `${viewportName}: hidden project absent from list and count`)
    check((await api(owner, `/projects/${projectId}/grants`, { userId: outsiderAccount.user.id, role: 'viewer' })).status === 409, `${viewportName}: cross-team grant refused`)
    const replayBody = { title: 'Member replay', requestId: `member-${viewportName}` }
    const memberWorkspaceBody = { projectId, name: 'Member logical workspace', requestId: `member-workspace-${viewportName}` }
    check((await api(member, '/workspaces', memberWorkspaceBody)).status === 201, `${viewportName}: contributor creates independent logical Workspace`)
    const memberTask = await api(member, taskPath, replayBody)
    check(memberTask.status === 201, `${viewportName}: contributor creates Task`)
    const ownerTask = await api(owner, taskPath, replayBody)
    await api(owner, `${taskPath}/${ownerTask.data.id}`, { title: 'Owner isolated replay' }, 'PATCH')
    check(ownerTask.data.id !== memberTask.data.id, `${viewportName}: create identity isolated by actor`)
    step = 'member opens scoped project'
    const memberPage = await member.newPage(); await memberPage.setViewportSize(viewport); await memberPage.goto(`${origin}/next/teams`)
    await memberPage.locator('select').first().selectOption(teamId)
    await memberPage.getByRole('button', { name: '将此团队设为当前项目范围', exact: true }).click()
    if (viewportName === 'mobile') await memberPage.getByRole('button', { name: '打开导航', exact: true }).click()
    await memberPage.getByRole('navigation', { name: '主导航' }).filter({ visible: true }).getByRole('link', { name: '项目', exact: true }).click()
    await memberPage.getByRole('link').filter({ hasText: `Project ${viewportName}` }).first().click()
    await memberPage.getByRole('heading', { name: `Project ${viewportName}`, exact: true }).waitFor()
    step = `${viewportName}: two-account Workspace visibility in real browsers`
    const memberWorkspaces = await member.newPage(); await memberWorkspaces.setViewportSize(viewport)
    memberWorkspaces.on('dialog', (dialog: any) => dialog.accept())
    await memberWorkspaces.goto(`${origin}/next/projects/${projectId}`)
    await memberWorkspaces.getByRole('button', { name: '工作区', exact: true }).click()
    const memberArticle = memberWorkspaces.locator('article').filter({ has: memberWorkspaces.getByRole('heading', { name: 'Member logical workspace', exact: true }) })
    await memberArticle.getByRole('button', { name: '从我的列表隐藏', exact: true }).click()
    await memberArticle.getByRole('button', { name: '恢复到我的列表', exact: true }).waitFor()
    check((await api(member, `/workspaces?projectId=${projectId}&visibility=hidden`)).data.items.some((item: any) => item.name === memberWorkspaceBody.name), `${viewportName}: member browser hides only own management list entry`)
    check((await api(owner, `/workspaces?projectId=${projectId}`)).data.items.some((item: any) => item.name === memberWorkspaceBody.name), `${viewportName}: owner's authorized browser account retains visible Workspace`)
    check(!(await api(outsider, `/workspaces?projectId=${projectId}&visibility=hidden`)).data.items.some((item: any) => item.name === memberWorkspaceBody.name), `${viewportName}: outsider cannot discover hidden Workspace`)
    if (process.env.WEMUX_VISIBILITY_ONLY === '1') {
      const revoke = await api(owner, `/projects/${projectId}/grants/${memberAccount.user.id}`, undefined, 'DELETE')
      check(revoke.status === 204 || revoke.status === 200, `${viewportName}: revoke member Project grant while Workspace hidden`)
      check(!(await api(member, `/workspaces?projectId=${projectId}&visibility=hidden`)).data.items.some((item: any) => item.name === memberWorkspaceBody.name), `${viewportName}: revoked browser account cannot list hidden Workspace`)
      const deniedRestore = await api(member, `/workspaces/${(await api(owner, `/workspaces?projectId=${projectId}`)).data.items.find((item: any) => item.name === memberWorkspaceBody.name).id}/visibility`, { hidden: false, expectedRevision: 1, requestId: `revoked-restore-${viewportName}` }, 'PUT')
      check(deniedRestore.status === 404, `${viewportName}: revoked browser account cannot restore hidden Workspace`)
      const restoredGrant = await api(owner, `/projects/${projectId}/grants`, { userId: memberAccount.user.id, role: 'viewer' })
      check(restoredGrant.status === 201, `${viewportName}: restore viewer access before personal Workspace recovery`)
    }
    await memberWorkspaces.reload()
    await memberWorkspaces.getByRole('button', { name: '工作区', exact: true }).click()
    await memberArticle.getByRole('button', { name: '恢复到我的列表', exact: true }).click()
    await memberArticle.getByRole('button', { name: '从我的列表隐藏', exact: true }).waitFor()
    await memberWorkspaces.screenshot({ path: `${evidence}.visibility-two-account-${viewportName}.png`, fullPage: true })
    await memberWorkspaces.close()
    check((await api(member, `/workspaces?projectId=${projectId}`)).data.items.some((item: any) => item.name === memberWorkspaceBody.name), `${viewportName}: member browser restores hidden Workspace after reload`)
    // Focused visibility gate can run even while unrelated Task/Session candidate failures remain open.
    if (process.env.WEMUX_VISIBILITY_ONLY === '1') { await memberPage.close(); await page.close(); continue }
    const localBody = { name: 'Actor local workspace', source: 'empty', requestId: `task-local-${viewportName}` }
    const localPath = `${taskPath}/${memberTask.data.id}/workspaces`
    const memberLocal = await api(member, localPath, localBody), ownerLocal = await api(owner, localPath, localBody)
    check(memberLocal.status === 201 && ownerLocal.status === 201 && memberLocal.data.workspace.id !== ownerLocal.data.workspace.id, `${viewportName}: task-local create request identity isolated by actor`)
    step = 'delayed viewer demotion'
    await memberPage.getByRole('button', { name: 'Member replay', exact: true }).click()
    await memberPage.getByLabel('编辑描述', { exact: true }).fill('discard on role change')
    memberPage.on('dialog', () => { throw Error('Authority loss must not prompt') })
    if (process.env.WEMUX_ASYNC_REPRO !== 'retry') await retiredCreateAndSaveScenario({ page: memberPage, owner, member, memberId: memberAccount.user.id, api, projectId, taskId: memberTask.data.id, viewportName, check, progress: (name: string) => { step = `${viewportName}: ${name}` } })
    step = 'capture viewer pending reads'; const releaseViewer = await holdTaskReads(memberPage, projectId, memberTask.data.id)
    step = 'server demotion'; check((await api(owner, `/projects/${projectId}/grants`, { userId: memberAccount.user.id, role: 'viewer' })).status === 201, `${viewportName}: server demotes contributor to viewer`)
    await memberPage.evaluate(() => window.dispatchEvent(new Event('focus')))
    await memberPage.getByRole('button', { name: '创建任务', exact: true }).waitFor({ state: 'hidden' })
    step = 'release held viewer reads'; await releaseViewer()
    await memberPage.getByLabel('编辑描述', { exact: true }).waitFor()
    check(await memberPage.getByRole('button', { name: '保存任务内容', exact: true }).isDisabled(), `${viewportName}: held detail/workspace/activity cannot restore write controls after viewer demotion`)
    check(await memberPage.getByLabel('编辑描述', { exact: true }).inputValue() !== 'discard on role change', `${viewportName}: role change retires dirty baseline without confirmation`)
    await api(owner, `/projects/${projectId}/grants`, { userId: memberAccount.user.id, role: 'contributor' })
    await memberPage.evaluate(() => window.dispatchEvent(new Event('focus')))
    await memberPage.getByRole('button', { name: '创建任务', exact: true }).waitFor()
    const releaseRevoked = await holdTaskReads(memberPage, projectId, memberTask.data.id)
    step = 'revoke project grant'
    await page.getByRole('button', { name: '撤销授权', exact: true }).click(); await page.getByRole('button', { name: '撤销授权', exact: true }).waitFor({ state: 'hidden' })
    check((await api(member, '/workspaces', memberWorkspaceBody)).status === 404, `${viewportName}: revoke denies Workspace replay before disclosing result`)
    check((await api(member, localPath, localBody)).status === 403, `${viewportName}: task-local replay reauthorizes revoked member`)
    check((await api(member, taskPath, replayBody)).status === 403, `${viewportName}: revoke denies even idempotent Task replay`)
    await memberPage.evaluate(() => window.dispatchEvent(new Event('focus'))); await memberPage.getByText('项目不存在或当前账号无权访问', { exact: true }).waitFor()
    await releaseRevoked()
    check(await memberPage.getByRole('heading', { name: `Project ${viewportName}`, exact: true }).count() === 0, `${viewportName}: mounted revoked project clears on revalidation`)
    step = 'delayed Team transition'
    await api(owner, `/projects/${projectId}/grants`, { userId: memberAccount.user.id, role: 'contributor' })
    await memberPage.evaluate(() => window.dispatchEvent(new Event('focus')))
    await memberPage.getByLabel('编辑描述', { exact: true }).waitFor()
    step = 'capture Team reads'; const releaseTeam = await holdTaskReads(memberPage, projectId, memberTask.data.id)
    if (viewportName === 'mobile') await memberPage.getByRole('button', { name: '打开导航', exact: true }).click()
    await memberPage.getByRole('navigation', { name: '主导航' }).filter({ visible: true }).getByRole('link', { name: '团队', exact: true }).click()
    await memberPage.getByRole('heading', { name: '团队与成员', exact: true }).waitFor()
    const isolatedTeam = (await api(member, '/teams', { name: `Isolated ${viewportName}` })).data
    await memberPage.evaluate(() => window.dispatchEvent(new Event('focus')))
    step = 'choose own Team'; await memberPage.locator('select').first().selectOption(isolatedTeam.id)
    await memberPage.getByRole('button', { name: '将此团队设为当前项目范围', exact: true }).click()
    step = 'release Team reads'; await releaseTeam()
    check(await memberPage.getByLabel('编辑描述', { exact: true }).count() === 0, `${viewportName}: held reads cannot restore Task after actual Team scope transition`)
    await memberPage.locator('select').first().selectOption(teamId)
    await memberPage.getByRole('button', { name: '将此团队设为当前项目范围', exact: true }).click()
    if (viewportName === 'mobile') await memberPage.getByRole('button', { name: '打开导航', exact: true }).click()
    await memberPage.getByRole('navigation', { name: '主导航' }).filter({ visible: true }).getByRole('link', { name: '项目', exact: true }).click()
    await memberPage.getByRole('link').filter({ hasText: `Project ${viewportName}` }).first().click()
    await memberPage.getByRole('button', { name: 'Member replay', exact: true }).click()
    await memberPage.getByLabel('编辑描述', { exact: true }).fill('logout discards private draft')
    const releaseIdentity = await holdTaskReads(memberPage, projectId, memberTask.data.id)
    step = 'logout while reads pending'
    if (viewportName === 'mobile') await memberPage.getByRole('button', { name: '打开导航', exact: true }).click()
    await memberPage.getByRole('button', { name: '退出登录', exact: true }).filter({ visible: true }).click()
    await memberPage.getByRole('button', { name: '登录', exact: true }).waitFor()
    await releaseIdentity()
    check(await memberPage.getByLabel('编辑描述', { exact: true }).count() === 0, `${viewportName}: logout bypasses dirty guard and pending reads cannot restore protected data`)
    await memberPage.getByLabel('邮箱或用户名', { exact: true }).fill('member@example.test')
    await memberPage.getByLabel('密码', { exact: true }).fill('synthetic password 12345')
    await memberPage.getByRole('button', { name: '登录', exact: true }).click()
    await memberPage.getByRole('button', { name: '登录', exact: true }).waitFor({ state: 'hidden' })
    check(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), `${viewportName}: no horizontal page overflow`)
    step = 'project lifecycle'
    const disposable = (await api(owner, '/projects', { name: `Disposable ${viewportName}`, teamId, requestId: `disposable-${viewportName}` })).data
    await page.goto(`${origin}/next/projects/${disposable.id}`)
    await page.getByRole('button', { name: '项目设置', exact: true }).click()
    await submit(page, '保存项目名称', { name: `Renamed ${viewportName}` })
    await page.getByRole('heading', { name: `Renamed ${viewportName}`, exact: true }).waitFor()
    await page.getByRole('button', { name: '删除项目', exact: true }).click()
    await page.getByRole('heading', { name: '项目', exact: true }).waitFor()
    check((await api(owner, `/projects/${disposable.id}`)).status === 404, `${viewportName}: empty project rename and delete lifecycle`)
    check((await api(owner, `/projects/${projectId}`, undefined, 'DELETE')).status === 409, `${viewportName}: nonempty project deletion refused`)
    if (process.env.WEMUX_ASYNC_REPRO !== 'navigation') await retryIntentScenario({ page, owner, api, origin, projectId, worker, peer, viewportName, check, progress: (name: string) => { step = `${viewportName}: ${name}` } })
    await lateCreateDepartureScenario({ page, owner, api, origin, projectId, viewportName, teamId, check, progress: (name: string) => { step = `${viewportName}: ${name}` } })
    await taskContentCasScenarios({ page, owner, api, origin, projectId, viewportName, check, progress: (name: string) => { step = name } })
    step = 'Task deletion refusal retains Session history'
    const sessionTask = (await api(owner, `/projects/${projectId}/tasks`, { title: `Session protected ${viewportName}` })).data
    const sessionTaskPath = `/projects/${projectId}/tasks/${sessionTask.id}`
    await api(owner, `${sessionTaskPath}/assignment`, { version: 1, assignee: { workspaceId: workspace.id, workerId: worker.workerId, agentKey: 'test', modelId: 'test' } }, 'PUT')
    const retainedSession = await api(owner, `${sessionTaskPath}/sessions`, { title: 'Retained unsynced history', requestId: `retained-session-${viewportName}` })
    check(retainedSession.status === 201, `${viewportName}: Task-bound Session fixture created without model execution`)
    await page.goto(`${origin}/next/projects/${projectId}?task=${sessionTask.id}`)
    await page.getByRole('button', { name: '永久删除任务', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: 'Task has associated Session history' }).waitFor()
    check((await api(owner, `/sessions/${retainedSession.data.session.id}`)).status === 200 && !(await api(owner, sessionTaskPath)).data.deletedAt, `${viewportName}: UI delete refusal keeps Task and Session; no automatic cancellation/cleanup`)
    check(!errors.length, `${viewportName}: no pageerror`)
    await page.screenshot({ path: `${evidence}.${viewportName}.png`, fullPage: true }); await page.close(); await memberPage.close()
  }
  result.passed = true
} catch (cause) { result.failureStep = step; if (process.env.DIAG) console.error('DIAG-STACK', cause instanceof Error ? cause.stack ?? cause.message : cause); await writeFile(`${evidence}.failure.txt`, String(cause instanceof Error ? cause.stack ?? cause.message : cause).replaceAll(root, '<owned-fixture>')) }
finally { if (peer) await peer.close().catch(() => {}); if (browser) await browser.close(); if (app) await app.close(); await writeFile(evidence, JSON.stringify(result, null, 2)); await rm(root, { recursive: true, force: true }) }
console.log(JSON.stringify(result)); process.exitCode = result.passed ? 0 : 1
