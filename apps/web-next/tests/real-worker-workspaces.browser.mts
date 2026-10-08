// Explicit integration gate: private real Server, two real Worker runtimes, local Git only.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:net'
import { createWemuxServer } from '../../server/src/server.ts'
import { launchAcceptanceBrowser } from './acceptance-runtime.mjs'
import { startWorkspaceWorker } from './real-workspace-worker.ts'

const root = await mkdtemp(join(tmpdir(), 'wemux-real-workspaces-'))
const state = join(root, 'state'), evidence = join(root, 'evidence')
await mkdir(state, { mode: 0o700 }); await mkdir(evidence, { mode: 0o700 })
const result = { passed: false, checks: [] as string[], failureStep: null as string | null, cleanupFailures: [] as string[], boundary: 'Real WorkerRuntime/WebSocketTransport/LocalProvisioner, two homes on one host; no Agent adapters, CLI installer or external Git', reconnectEvidence: [] as unknown[], visibilityEvidence: [] as { viewport: string; hiddenRevision: number; restoredRevision: number; workerReport: unknown }[], observations: [] as { viewport: string; revision: string; paths: string[]; failureReason: string }[] }
let step = 'setup', app: ReturnType<typeof createWemuxServer> | undefined, browser: any
const workers: Awaited<ReturnType<typeof startWorkspaceWorker>>[] = []
const exec = promisify(execFile)
// Isolate all Git children, including those spawned inside the actual LocalProvisioner.
const gitEnvironment = { HOME: join(state, 'git-home'), XDG_CONFIG_HOME: join(state, 'git-home'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file', GIT_CONFIG_COUNT: '0', GIT_TEMPLATE_DIR: join(state, 'git-template'), GIT_CONFIG_PARAMETERS: undefined, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined, GIT_OBJECT_DIRECTORY: undefined, GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined }
const original = new Map(Object.keys(gitEnvironment).map(key => [key, process.env[key]]))
for (const [key, value] of Object.entries(gitEnvironment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
const git = async (args: string[]) => (await exec('git', args, { timeout: 15000, maxBuffer: 1024 * 1024 })).stdout.trim()
const check = (value: unknown, name: string) => { assert.ok(value, name); result.checks.push(name) }
const safePath = async (path: string, home: string) => {
  const canonical = await realpath(path), base = await realpath(home), subpath = relative(base, canonical)
  assert.ok(subpath && !subpath.startsWith(`..${sep}`) && subpath !== '..' && !subpath.startsWith(sep), 'Worker observation must stay inside its owned home')
  return canonical
}
try {
  await mkdir(gitEnvironment.HOME!, { recursive: true }); await mkdir(gitEnvironment.GIT_TEMPLATE_DIR!, { recursive: true })
  assert.ok(process.env.WEMUX_NEXT_TEST_DIST?.startsWith('/tmp/'), 'Require current-source private Vite dist')
  const reservation = createServer(); await new Promise<void>(done => reservation.listen(0, '127.0.0.1', done))
  const port = (reservation.address() as { port: number }).port; await new Promise<void>(done => reservation.close(() => done()))
  assert.ok(port !== 8004 && port !== 8010)
  const origin = `http://127.0.0.1:${port}`, outbox = join(state, 'outbox'); await mkdir(outbox)
  app = createWemuxServer({ databasePath: join(state, 'server.sqlite'), administratorEmails: ['workspace-owner@example.test'], capabilitySecret: 'private-workspace-capability-secret-no-real-credentials', webNextStaticPath: resolve(process.env.WEMUX_NEXT_TEST_DIST!), mail: { WEMUX_PUBLIC_URL: origin, WEMUX_SMTP_FROM: 'Fixture <fixture@example.test>', WEMUX_MAIL_OUTBOX: outbox }, google: {} })
  await app.listen(port); browser = await launchAcceptanceBrowser()
  const context = await browser.newContext()
  const api = async (path: string, body?: unknown, method?: string) => {
    let csrf: string | undefined
    if (body !== undefined || (method && method !== 'GET')) { const me = await context.request.get(`${origin}/api/auth/me`); if (me.ok()) csrf = (await me.json()).csrfToken }
    const response = await context.request.fetch(`${origin}/api${path}`, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { Origin: origin, ...(csrf ? { 'x-csrf-token': csrf } : {}) }, ...(body === undefined ? {} : { data: body }), timeout: 10000 })
    assert.ok(response.ok(), `HTTP ${response.status()} for fixture API operation`)
    return response.status() === 204 ? null : response.json()
  }
  const wait = async (path: string, accept: (value: any) => boolean) => {
    for (let i = 0; i < 200; i++) { assert.deepEqual(workers.flatMap(worker => worker.failures), []); const value = await api(path); if (accept(value)) return value; await new Promise(done => setTimeout(done, 50)) }
    const last = await api(path)
    await writeFile(join(evidence, 'last-condition.json'), JSON.stringify(last, null, 2).replaceAll(state, '<owned-state>'))
    throw Error('Bounded API condition timed out')
  }
  step = 'public synthetic registration'
  await api('/auth/register', { email: 'workspace-owner@example.test', displayName: 'Workspace owner', password: 'synthetic workspace password 123' })
  const names = await readdir(outbox); assert.equal(names.length, 1)
  const raw = await readFile(join(outbox, names[0]), 'utf8')
  const text = Buffer.from(raw.slice(raw.indexOf('\r\n\r\n') + 4).replace(/\r\n/g, ''), 'base64').toString()
  const link = text.match(/http:\/\/[^\s]+\/next\/auth\/verify-email\?token=([^\s]+)/)
  assert.ok(link)
  await api('/auth/email/verify', { token: new URL(`http://x/?token=${link[1]}`).searchParams.get('token') })
  await api('/auth/me')
  await writeFile(join(evidence, 'git-version.txt'), `${await git(['--version'])}\n`)
  const nodes: { workerId: string; home: string; name: string }[] = []
  for (const name of ['A', 'B']) {
    const token = await api('/enrollment-tokens', {})
    const enrollment = await api('/workers/enroll', { token: token.token, name: `Real Worker ${name}` })
    const home = join(state, `worker-${name}`)
    workers.push(await startWorkspaceWorker({ home, origin, workerId: enrollment.workerId, credential: enrollment.credential, name: `Real Worker ${name}` }))
    nodes.push({ workerId: enrollment.workerId, home, name: `Real Worker ${name}` })
    await wait(`/workers/${enrollment.workerId}`, node => node.connectionState === 'online')
  }
  check(true, 'two public-enrolled real Worker runtimes online with independent SQLite/transport homes')
  check((await api('/workers')).items.every((node: any) => node.capabilities.length === 0), 'no Agent adapter detected or invoked')
  for (const [viewport, size] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]] as const) {
    const page = await context.newPage(); await page.setViewportSize(size); page.setDefaultTimeout(12000)
    const errors: string[] = []; page.on('pageerror', () => errors.push('pageerror')); page.on('dialog', (dialog: any) => dialog.accept())
    const submit = async (label: string, values: Record<string, string>) => {
      const form = page.getByRole('button', { name: label, exact: true }).locator('xpath=ancestor::form')
      for (const [name, value] of Object.entries(values)) { const field = form.locator(`[name="${name}"]`); if (await field.evaluate((element: Element) => element.tagName === 'SELECT')) await field.selectOption(value); else await field.fill(value) }
      await form.getByRole('button', { name: label, exact: true }).click()
    }
    step = `${viewport}: UI create project and empty workspace`
    await page.goto(`${origin}/next/projects`)
    await submit('创建项目', { name: `Real workspaces ${viewport}` })
    await page.getByRole('heading', { name: `Real workspaces ${viewport}`, exact: true }).waitFor()
    const projectId = new URL(page.url()).pathname.split('/').at(-1)!
    await page.getByRole('button', { name: '工作区', exact: true }).click()
    workers[0].disconnect()
    await wait(`/workers/${nodes[0].workerId}`, value => value.connectionState === 'offline')
    await submit('创建工作区', { name: `Empty ${viewport}`, workerId: nodes[0].workerId })
    await page.getByRole('heading', { name: `Empty ${viewport}`, exact: true }).waitFor()
    const empty = (await api(`/workspaces?projectId=${projectId}`)).items.find((item: any) => item.name === `Empty ${viewport}`)
    const pendingPreparation = await api(`/workspaces/${empty.id}`)
    const preparationCommandId = pendingPreparation.placements[0].provisioning.commandId
    const beforeCommand = await api(`/commands/${preparationCommandId}`)
    const csrf = (await api('/auth/me')).csrfToken
    for (let attempt = 0; attempt < 2; attempt++) {
      const refusal = await context.request.delete(`${origin}/api/commands/${preparationCommandId}`, { headers: { Origin: origin, 'x-csrf-token': csrf } })
      assert.equal(refusal.status(), 409); assert.equal((await refusal.json()).error.code, 'protected_command')
    }
    assert.deepEqual(await api(`/commands/${preparationCommandId}`), beforeCommand)
    assert.deepEqual(await api(`/workspaces/${empty.id}`), pendingPreparation)
    await page.getByText('准备取消暂不可用。已提交的准备请求会继续处理；关闭页面或表单不会停止 Worker，也不会回滚或删除文件。', { exact: true }).first().waitFor()
    assert.equal(await page.getByRole('button', { name: '取消排队准备', exact: true }).count(), 0)
    workers[0].reconnect()
    const emptyReady = await wait(`/workspaces/${empty.id}`, value => value.placements[0]?.status === 'ready')
    assert.equal(emptyReady.placements[0].provisioning.commandId, preparationCommandId)
    check(true, `${viewport}: offline protected refusal preserves original command, actual Worker reconnect completes it; UI does not advertise stop`)
    const emptyPath = await safePath(emptyReady.placements[0].location.rootPath, nodes[0].home)
    check((await stat(emptyPath)).isDirectory() && (await readdir(emptyPath)).length === 0, `${viewport}: actual empty Workspace directory exists and is empty`)
    await page.getByRole('button', { name: '刷新准备状态', exact: true }).click()
    await page.locator('article').filter({ has: page.getByRole('heading', { name: `Empty ${viewport}`, exact: true }) }).getByText('Real Worker A：已就绪', { exact: true }).waitFor()

    step = `${viewport}: local Git pinned revision materialization`
    const repository = join(state, `repository-${viewport}`); await git(['init', '--initial-branch=main', repository])
    await writeFile(join(repository, 'synthetic.txt'), 'synthetic pinned revision\n')
    await git(['-C', repository, 'add', 'synthetic.txt'])
    await git(['-C', repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-m', 'pinned'])
    const revision = await git(['-C', repository, 'rev-parse', 'HEAD'])
    await writeFile(join(repository, 'synthetic.txt'), 'newer main content must not replace pin\n')
    await git(['-C', repository, 'add', 'synthetic.txt'])
    await git(['-C', repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-m', 'newer'])
    await submit('创建工作区', { name: `Git ${viewport}`, workerId: nodes[0].workerId, gitUrl: repository, revision })
    await page.getByRole('heading', { name: `Git ${viewport}`, exact: true }).waitFor()
    const linked = (await api(`/workspaces?projectId=${projectId}`)).items.find((item: any) => item.name === `Git ${viewport}`)
    const ready = await wait(`/workspaces/${linked.id}`, value => value.placements[0]?.status === 'ready')
    const a = await safePath(ready.placements[0].location.rootPath, nodes[0].home)
    check(await readFile(join(a, 'synthetic.txt'), 'utf8') === 'synthetic pinned revision\n' && await git(['-C', a, 'rev-parse', 'HEAD']) === revision, `${viewport}: real clone checked out requested commit rather than newer main`)
    await page.getByRole('button', { name: '刷新准备状态', exact: true }).click()
    const article = page.locator('article').filter({ has: page.getByRole('heading', { name: `Git ${viewport}`, exact: true }) })
    await article.getByText(a, { exact: true }).waitFor()

    step = `${viewport}: second physical Placement and independent files`
    await writeFile(join(a, 'synthetic.txt'), 'Worker A independent edit\n')
    await article.locator('select[name="workerId"]').selectOption(nodes[1].workerId)
    await article.getByRole('button', { name: '新增 Worker 落点', exact: true }).click()
    const both = await wait(`/workspaces/${linked.id}`, value => value.placements.length === 2 && value.placements.every((placement: any) => placement.status === 'ready'))
    const b = await safePath(both.placements.find((placement: any) => placement.workerId === nodes[1].workerId).location.rootPath, nodes[1].home)
    check(a !== b && await readFile(join(b, 'synthetic.txt'), 'utf8') === 'synthetic pinned revision\n' && await git(['-C', b, 'rev-parse', 'HEAD']) === revision, `${viewport}: second Worker independently materializes same logical Workspace, not Worker A edits`)
    await writeFile(join(b, 'synthetic.txt'), 'Worker B independent edit\n')
    await page.getByRole('button', { name: '刷新准备状态', exact: true }).click()
    await article.getByText(a, { exact: true }).waitFor(); await article.getByText(b, { exact: true }).waitFor()
    check(await readFile(join(a, 'synthetic.txt'), 'utf8') === 'Worker A independent edit\n', `${viewport}: Worker B edit does not synchronize to Worker A`)
    step = `${viewport}: protected cancellation after real materialization preserves edited files`
    const completedWorkspace = await api(`/workspaces/${linked.id}`)
    for (const placement of completedWorkspace.placements) {
      const commandId = placement.provisioning.commandId
      const completedCommand = await api(`/commands/${commandId}`)
      const csrf = (await api('/auth/me')).csrfToken
      const refusal = await context.request.delete(`${origin}/api/commands/${commandId}`, { headers: { Origin: origin, 'x-csrf-token': csrf } })
      assert.equal(refusal.status(), 409); assert.equal((await refusal.json()).error.code, 'protected_command')
      assert.deepEqual(await api(`/commands/${commandId}`), completedCommand)
    }
    assert.deepEqual(await api(`/workspaces/${linked.id}`), completedWorkspace)
    check(await readFile(join(a, 'synthetic.txt'), 'utf8') === 'Worker A independent edit\n' && await readFile(join(b, 'synthetic.txt'), 'utf8') === 'Worker B independent edit\n', `${viewport}: protected refusal after real ready leaves both edited files, command states and terminal proofs unchanged`)

    step = `${viewport}: personal hide/restore of prepared two-Worker Workspace`
    const visibleBefore = await api(`/workspaces?projectId=${projectId}`)
    const visibleWorkspace = visibleBefore.items.find((item: any) => item.id === linked.id)
    assert.equal(visibleWorkspace.visibilityHidden, false); assert.equal(visibleWorkspace.visibilityRevision, 0)
    const listHeading = () => article.evaluate((element: Element) => {
      let previous = element.previousElementSibling
      while (previous && previous.tagName !== 'H3') previous = previous.previousElementSibling
      return previous?.textContent?.trim()
    })
    assert.equal(await listHeading(), '当前工作区')
    const visibilityCommands = (await api('/commands?limit=500')).items.length
    await article.getByRole('button', { name: '从我的列表隐藏', exact: true }).click()
    await article.getByRole('button', { name: '恢复到我的列表', exact: true }).waitFor()
    assert.equal(await listHeading(), '已隐藏（仅对你）')
    const hiddenList = await api(`/workspaces?projectId=${projectId}&visibility=hidden`)
    const hidden = hiddenList.items.find((item: any) => item.id === linked.id)
    assert.ok(hidden); assert.equal(hidden.visibilityHidden, true); assert.equal(hidden.visibilityRevision, 1)
    assert.ok(!(await api(`/workspaces?projectId=${projectId}`)).items.some((item: any) => item.id === linked.id))
    assert.equal((await api(`/workspaces?projectId=${projectId}&visibility=all`)).items.filter((item: any) => item.id === linked.id).length, 1)
    assert.equal(await article.getByRole('button', { name: '永久删除工作区', exact: true }).count(), 0)
    assert.deepEqual(hidden.placements, visibleWorkspace.placements)
    const visibilityCsrf = (await api('/auth/me')).csrfToken
    const stale = await context.request.put(`${origin}/api/workspaces/${linked.id}/visibility`, {
      headers: { Origin: origin, 'x-csrf-token': visibilityCsrf },
      data: { hidden: false, expectedRevision: 0, requestId: `stale-visibility-${viewport}` },
    })
    assert.equal(stale.status(), 409); assert.equal((await stale.json()).error.code, 'workspace_visibility_conflict')
    assert.equal((await api(`/workspaces?projectId=${projectId}&visibility=hidden`)).items.find((item: any) => item.id === linked.id).visibilityRevision, 1)
    check(true, `${viewport}: UI hides only personal list entry; hidden/all API views retain two placements, stale personal CAS rejected`)
    // Real reconnect emits persisted reports while the Workspace is personally hidden.
    workers[1].disconnect(); await wait(`/workers/${nodes[1].workerId}`, node => node.connectionState === 'offline')
    const hiddenCheckpoint = workers[1].reportCheckpoint()
    workers[1].reconnect(); await wait(`/workers/${nodes[1].workerId}`, node => node.connectionState === 'online')
    const workerReport = await workers[1].waitForReportAcknowledgment(linked.id, both.placements.find((placement: any) => placement.workerId === nodes[1].workerId).provisioning.commandId, hiddenCheckpoint)
    const currentHidden = (await api(`/workspaces?projectId=${projectId}&visibility=hidden`)).items.find((item: any) => item.id === linked.id)
    assert.ok(currentHidden); assert.equal(currentHidden.visibilityRevision, 1)
    assert.ok(currentHidden.placements.every((placement: any) => placement.status === 'ready'))
    assert.deepEqual(currentHidden.placements.map((placement: any) => [placement.workerId, placement.location.rootPath]).sort(), hidden.placements.map((placement: any) => [placement.workerId, placement.location.rootPath]).sort())
    await page.getByRole('button', { name: '刷新准备状态', exact: true }).click()
    await article.getByText('Real Worker B：已就绪', { exact: true }).waitFor()
    await article.getByRole('button', { name: '恢复到我的列表', exact: true }).click()
    await article.getByRole('button', { name: '从我的列表隐藏', exact: true }).waitFor()
    assert.equal(await listHeading(), '当前工作区')
    const restored = (await api(`/workspaces?projectId=${projectId}`)).items.find((item: any) => item.id === linked.id)
    assert.ok(restored); assert.equal(restored.visibilityHidden, false); assert.equal(restored.visibilityRevision, 2)
    assert.ok(!(await api(`/workspaces?projectId=${projectId}&visibility=hidden`)).items.some((item: any) => item.id === linked.id))
    assert.ok(restored.placements.every((placement: any) => placement.status === 'ready'))
    assert.deepEqual(restored.placements.map((placement: any) => [placement.workerId, placement.location.rootPath]).sort(), currentHidden.placements.map((placement: any) => [placement.workerId, placement.location.rootPath]).sort())
    assert.equal((await api('/commands?limit=500')).items.length, visibilityCommands)
    check(await readFile(join(a, 'synthetic.txt'), 'utf8') === 'Worker A independent edit\n' && await readFile(join(b, 'synthetic.txt'), 'utf8') === 'Worker B independent edit\n' && await git(['-C', a, 'rev-parse', 'HEAD']) === revision && await git(['-C', b, 'rev-parse', 'HEAD']) === revision, `${viewport}: UI restore after real Worker reconnect keeps current ready status, both edited disk paths and Git revision without new commands`)
    result.visibilityEvidence.push({ viewport, hiddenRevision: hidden.visibilityRevision, restoredRevision: restored.visibilityRevision, workerReport })

    let repairedPath = '', failureReason = ''
    const repairedWorkspaces: { id: string; name: string; path: string; failedCommandId: string; readyCommandId: string }[] = []
    for (const kind of ['tag', 'branch'] as const) {
      step = `${viewport}: genuine ${kind} revision failure and UI reason`
      const repairedRevision = `repair-${kind}-${viewport}` // Separate genuine tag and non-default branch recovery scenarios.
      await submit('创建工作区', { name: `Repair ${kind} ${viewport}`, workerId: nodes[0].workerId, gitUrl: repository, revision: repairedRevision })
      await page.getByRole('heading', { name: `Repair ${kind} ${viewport}`, exact: true }).waitFor()
      const repair = (await api(`/workspaces?projectId=${projectId}`)).items.find((item: any) => item.name === `Repair ${kind} ${viewport}`)
      const failed = await wait(`/workspaces/${repair.id}`, value => value.placements[0]?.status === 'failed')
      failureReason = failed.placements[0].failureReason
      check(typeof failureReason === 'string' && failureReason.includes('git') && failureReason.includes(repairedRevision), `${viewport}: ${kind} resolution error reported through Worker transport and Server API`)
      const failedKey = createHash('sha256').update(repair.id).digest('hex')
      for (const suffix of ['', '.ready', '.partial']) await assert.rejects(stat(join(nodes[0].home, 'workspaces', failedKey + suffix)), (error: NodeJS.ErrnoException) => error.code === 'ENOENT')
      check(true, `${viewport}: ${kind} failure has no ready marker, materialized root or leftover staging`)
      await page.getByRole('button', { name: '刷新准备状态', exact: true }).click()
      const repairArticle = page.locator('article').filter({ has: page.getByRole('heading', { name: `Repair ${kind} ${viewport}`, exact: true }) })
      await repairArticle.getByRole('alert').waitFor()
      assert.equal(await repairArticle.getByRole('alert').textContent(), failureReason)
      await page.screenshot({ path: join(evidence, `${viewport}-${kind}-failed.png`), fullPage: true })
      check(true, `${viewport}: /next displays exact genuine ${kind} failure reason`)
      step = `${viewport}: create missing local ${kind}`; await git(['-C', repository, kind, repairedRevision, revision])
      const initialCommand = failed.placements[0].provisioning.commandId
      step = `${viewport}: UI retry after local repair`; await repairArticle.getByRole('button', { name: '重试准备', exact: true }).click()
      step = `${viewport}: await actual repaired ready`; const repaired = await wait(`/workspaces/${repair.id}`, value => value.placements[0]?.status === 'ready')
      repairedPath = await safePath(repaired.placements[0].location.rootPath, nodes[0].home)
      step = `${viewport}: verify repaired disk files`; check(repaired.placements[0].provisioning.commandId !== initialCommand && await readFile(join(repairedPath, 'synthetic.txt'), 'utf8') === 'synthetic pinned revision\n' && await git(['-C', repairedPath, 'rev-parse', 'HEAD']) === revision, `${viewport}: repair local ${kind} then UI retry on SAME Workspace produces real files at desired revision`)
      await page.getByRole('button', { name: '刷新准备状态', exact: true }).click()
      await repairArticle.getByText('Real Worker A：已就绪', { exact: true }).waitFor()
      assert.equal(await repairArticle.getByRole('alert').count(), 0)
      check((await stat(join(nodes[0].home, 'workspaces', failedKey + '.ready'))).isFile(), `${viewport}: successful ${kind} retry publishes ready marker only after actual checkout`)
      await page.screenshot({ path: join(evidence, `${viewport}-${kind}-repaired.png`), fullPage: true })
      repairedWorkspaces.push({ id: repair.id, name: `Repair ${kind} ${viewport}`, path: repairedPath, failedCommandId: initialCommand, readyCommandId: repaired.placements[0].provisioning.commandId })
      check(await readFile(join(a, 'synthetic.txt'), 'utf8') === 'Worker A independent edit\n' && await readFile(join(b, 'synthetic.txt'), 'utf8') === 'Worker B independent edit\n', `${viewport}: independent edits remain after subsequent real provisioning and refresh`)
  
    }

    await page.screenshot({ path: join(evidence, `${viewport}-ready-placements.png`), fullPage: true })
    step = `${viewport}: Task binding/unbinding preserves actual files`
    await page.getByRole('button', { name: '任务', exact: true }).click()
    await submit('创建任务', { title: `Binding ${viewport}` })
    await page.getByRole('heading', { name: '任务详情', exact: true }).waitFor()
    await submit('绑定工作区', { workspaceId: linked.id })
    await page.getByRole('button', { name: '解绑工作区', exact: true }).waitFor()
    await page.getByRole('button', { name: '解绑工作区', exact: true }).click()
    await page.getByRole('button', { name: '解绑工作区', exact: true }).waitFor({ state: 'hidden' })
    const taskId = new URL(page.url()).searchParams.get('task')!
    assert.equal((await api(`/projects/${projectId}/tasks/${taskId}`)).workspaces.length, 0)
    check((await api(`/workspaces/${linked.id}`)).placements.length === 2 && await readFile(join(a, 'synthetic.txt'), 'utf8') === 'Worker A independent edit\n' && await readFile(join(b, 'synthetic.txt'), 'utf8') === 'Worker B independent edit\n', `${viewport}: Task unbind retains both real directories and edited files; NOT Task deletion evidence`)
    step = `${viewport}: actual Task deletion retains both Worker files`
    // Rebind before DELETE: unbind above is not substituted for deletion evidence.
    await submit('绑定工作区', { workspaceId: linked.id })
    await page.getByRole('button', { name: '解绑工作区', exact: true }).waitFor()
    const beforeDelete = await api(`/projects/${projectId}/tasks/${taskId}`)
    // Force a real version conflict, then explicit refresh/reconfirmation.
    await api(`/projects/${projectId}/tasks/${taskId}`, { title: `Changed before deletion ${viewport}`, version: beforeDelete.version }, 'PATCH')
    await page.getByRole('button', { name: '永久删除任务', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: 'Task changed' }).waitFor()
    await page.getByRole('button', { name: '加载最新版本', exact: true }).click()
    await page.getByRole('heading', { name: `Changed before deletion ${viewport}`, exact: true }).waitFor()
    const deletePath = `/api/projects/${projectId}/tasks/${taskId}`
    let uncertainDelete = true
    await page.route((url: URL) => url.pathname === deletePath, async (route: any) => {
      if (route.request().method() !== 'DELETE' || !uncertainDelete) return route.continue()
      const response = await route.fetch()
      if (!response.ok()) return route.fulfill({ response })
      uncertainDelete = false; await route.abort('failed')
    })
    await page.getByRole('button', { name: '永久删除任务', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: '连接失败' }).waitFor()
    await page.getByRole('button', { name: '永久删除任务', exact: true }).click()
    await page.getByRole('heading', { name: '任务已永久删除', exact: true }).waitFor()
    const deletedTask = await api(`/projects/${projectId}/tasks/${taskId}`)
    check(!!deletedTask.deletedAt && deletedTask.workspaces.length === 0 && !(await api(`/projects/${projectId}/tasks`)).items.some((item: any) => item.id === taskId), `${viewport}: public Task DELETE tombstone retained, list removed, uncertain response replay succeeds`)
    check((await api(`/workspaces/${linked.id}`)).placements.length === 2 && await readFile(join(a, 'synthetic.txt'), 'utf8') === 'Worker A independent edit\n' && await readFile(join(b, 'synthetic.txt'), 'utf8') === 'Worker B independent edit\n', `${viewport}: ACTUAL Task deletion preserves Workspace identity, both placements and real edited files`)
    assert.equal((await api(`/projects/${projectId}/tasks/${taskId}/activity`)).items.filter((event: any) => event.type === 'task.deleted').length, 1)
    await page.reload(); await page.getByRole('heading', { name: '任务已永久删除', exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: '创建并绑定工作区', exact: true }).count(), 0)
    assert.equal(await page.getByRole('button', { name: '保存任务内容', exact: true }).count(), 0)
    step = `${viewport}: actual logical Workspace DELETE preserves physical files`
    await page.getByRole('button', { name: '工作区', exact: true }).click()
    const deleteArticle = page.locator('article').filter({ has: page.getByRole('heading', { name: `Git ${viewport}`, exact: true }) })
    await deleteArticle.getByRole('button', { name: '永久删除工作区', exact: true }).waitFor()
    // Server state change after UI snapshot creates a genuine confirmation conflict.
    await api(`/workspaces/${linked.id}`, { name: `Renamed Git ${viewport}` }, 'PATCH')
    await deleteArticle.getByRole('button', { name: '永久删除工作区', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: 'Workspace state changed' }).waitFor()
    await page.getByRole('button', { name: '刷新准备状态', exact: true }).click()
    const renamed = page.locator('article').filter({ has: page.getByRole('heading', { name: `Renamed Git ${viewport}`, exact: true }) })
    const beforeWorkspaceDelete = await api(`/workspaces/${linked.id}`)
    const beforeCommands = (await api('/commands?limit=500')).items.length
    let lostWorkspaceDelete = true
    await page.route((url: URL) => url.pathname === `/api/workspaces/${linked.id}`, async (route: any) => {
      if (route.request().method() !== 'DELETE' || !lostWorkspaceDelete) return route.continue()
      const response = await route.fetch()
      if (!response.ok()) return route.fulfill({ response })
      lostWorkspaceDelete = false; await route.abort('failed')
    })
    await renamed.getByRole('button', { name: '永久删除工作区', exact: true }).click()
    await renamed.getByRole('alert').filter({ hasText: '连接失败' }).waitFor()
    await renamed.getByRole('button', { name: '永久删除工作区', exact: true }).click()
    await renamed.waitFor({ state: 'hidden' })
    const workspaceHistory = await api(`/workspaces/${linked.id}`)
    check(!!workspaceHistory.deletedAt && workspaceHistory.placements.length === 2 && workspaceHistory.placements.every((placement: any) => placement.status === 'ready'), `${viewport}: actual Workspace DELETE retains both terminal placement/path observations and authorized tombstone`)
    assert.deepEqual(workspaceHistory.placements, beforeWorkspaceDelete.placements)
    check((await api('/commands?limit=500')).items.length === beforeCommands && await readFile(join(a, 'synthetic.txt'), 'utf8') === 'Worker A independent edit\n' && await readFile(join(b, 'synthetic.txt'), 'utf8') === 'Worker B independent edit\n', `${viewport}: genuine Workspace DELETE sends NO Worker command and preserves independently edited files BEFORE teardown`)
    assert.ok(!(await api(`/workspaces?projectId=${projectId}`)).items.some((workspace: any) => workspace.id === linked.id))
    for (const worker of workers) worker.disconnect()
    for (const node of nodes) await wait(`/workers/${node.workerId}`, value => value.connectionState === 'offline')
    const checkpoints = workers.map(worker => worker.reportCheckpoint())
    for (const worker of workers) worker.reconnect()
    for (const node of nodes) await wait(`/workers/${node.workerId}`, value => value.connectionState === 'online')
    // The actual runtime resends persisted Workspace reports on reconnect. They cannot resurrect metadata.
    const consumed = await Promise.all(workers.map((worker, index) => worker.waitForReportAcknowledgment(linked.id, workspaceHistory.placements.find((placement: any) => placement.workerId === nodes[index].workerId).provisioning.commandId, checkpoints[index])))
    assert.equal(new Set(consumed.map(report => report.workerId)).size, 2)
    result.reconnectEvidence.push({ viewport, reports: consumed })
    assert.deepEqual(await api(`/workspaces/${linked.id}`), workspaceHistory)
    check(await readFile(join(a, 'synthetic.txt'), 'utf8') === 'Worker A independent edit\n' && await readFile(join(b, 'synthetic.txt'), 'utf8') === 'Worker B independent edit\n', `${viewport}: real two-Worker reconnect reports cannot resurrect logical Workspace or remove files`)

    step = `${viewport}: actual DELETE after genuine failed and retried preparation`
    // Reconnect updates current report timestamps; explicitly refresh the UI confirmation snapshot.
    await page.getByRole('button', { name: '刷新准备状态', exact: true }).click()
    const retryTombstones = new Map<string, unknown>()
    for (const repaired of repairedWorkspaces) {
      const repairedArticle = page.locator('article').filter({ has: page.getByRole('heading', { name: repaired.name, exact: true }) })
      await repairedArticle.getByRole('button', { name: '永久删除工作区', exact: true }).waitFor()
      const before = await api(`/workspaces/${repaired.id}`)
      const commands = await Promise.all([repaired.failedCommandId, repaired.readyCommandId].map(id => api(`/commands/${id}`)))
      assert.ok(commands.every(command => command.status === 'accepted'))
      const attemptHistory = await app.store.commands.listWorkspaceProvisions(repaired.id as never)
      assert.equal(attemptHistory.length, 2)
      const proofs = await Promise.all(attemptHistory.map(command => app!.store.resources.getWorkspacePreparationProof({ workspaceId: repaired.id as never, workerId: command.workerId, commandId: command.commandId })))
      assert.deepEqual(proofs.map(proof => proof?.status), ['failed', 'ready'])
      await writeFile(join(repaired.path, 'synthetic.txt'), `Retained after retry ${viewport}\n`)
      const deletionResponse = page.waitForResponse((response: { url(): string; request(): { method(): string }; status(): number }) => new URL(response.url()).pathname === `/api/workspaces/${repaired.id}` && response.request().method() === 'DELETE' && response.status() === 200)
      await repairedArticle.getByRole('button', { name: '永久删除工作区', exact: true }).click()
      await deletionResponse; await repairedArticle.waitFor({ state: 'hidden' })
      const tombstone = await api(`/workspaces/${repaired.id}`); retryTombstones.set(repaired.id, tombstone)
      assert.ok(tombstone.deletedAt); assert.deepEqual(tombstone.placements, before.placements)
      assert.deepEqual(await app.store.commands.listWorkspaceProvisions(repaired.id as never), attemptHistory)
      assert.deepEqual(await Promise.all(attemptHistory.map(command => app!.store.resources.getWorkspacePreparationProof({ workspaceId: repaired.id as never, workerId: command.workerId, commandId: command.commandId }))), proofs)
      assert.deepEqual(await Promise.all([repaired.failedCommandId, repaired.readyCommandId].map(id => api(`/commands/${id}`))), commands)
      assert.ok(!(await api(`/workspaces?projectId=${projectId}`)).items.some((item: { id: string }) => item.id === repaired.id))
      check(await readFile(join(repaired.path, 'synthetic.txt'), 'utf8') === `Retained after retry ${viewport}\n` && await git(['-C', repaired.path, 'rev-parse', 'HEAD']) === revision, `${viewport}: actual UI DELETE of ${repaired.name} keeps edited files, Git HEAD, placement and both proved accepted attempts BEFORE teardown`)
    }
    workers[0].disconnect(); await wait(`/workers/${nodes[0].workerId}`, value => value.connectionState === 'offline')
    const retryCheckpoint = workers[0].reportCheckpoint()
    workers[0].reconnect(); await wait(`/workers/${nodes[0].workerId}`, value => value.connectionState === 'online')
    for (const repaired of repairedWorkspaces) {
      // ACK drain proves delivery only; deletion eligibility came from the two immutable terminal proofs.
      const consumedRetry = await workers[0].waitForReportAcknowledgment(repaired.id, repaired.readyCommandId, retryCheckpoint)
      result.reconnectEvidence.push({ viewport, scenario: 'failed-retry-deleted', reports: [consumedRetry] })
      assert.deepEqual(await api(`/workspaces/${repaired.id}`), retryTombstones.get(repaired.id))
      check(await readFile(join(repaired.path, 'synthetic.txt'), 'utf8') === `Retained after retry ${viewport}\n`, `${viewport}: delivered reconnect report cannot resurrect ${repaired.name} or remove retained files`)
    }
    await page.screenshot({ path: join(evidence, `${viewport}-retried-workspaces-deleted.png`), fullPage: true })
    step = `${viewport}: delayed Workspace DELETE after identity retirement`
    const delayedWorkspace = (await api('/workspaces', { projectId, name: `Delayed deletion ${viewport}`, source: 'empty' })).workspace
    await page.getByRole('button', { name: '刷新准备状态', exact: true }).click()
    const delayedArticle = page.locator('article').filter({ has: page.getByRole('heading', { name: delayedWorkspace.name, exact: true }) })
    let committed!: () => void, release!: () => void, completed!: () => void
    const committedPromise = new Promise<void>(resolve => { committed = resolve }), responseGate = new Promise<void>(resolve => { release = resolve }), responseAttempted = new Promise<void>(resolve => { completed = resolve })
    const delayedPath = `/api/workspaces/${delayedWorkspace.id}`
    const delayedMatcher = (url: URL) => url.pathname === delayedPath
    let held = false
    const delayedHandler = async (route: any) => {
      if (held || route.request().method() !== 'DELETE') return route.continue()
      const response = await route.fetch()
      if (!response.ok()) return route.fulfill({ response })
      held = true; committed(); await responseGate
      await route.fulfill({ response }).catch(() => {})
      completed()
    }
    await page.route(delayedMatcher, delayedHandler)
    step = `${viewport}: hold deletion commit`; await delayedArticle.getByRole('button', { name: '永久删除工作区', exact: true }).click(); await committedPromise
    if (viewport === 'mobile') await page.getByRole('button', { name: '打开导航', exact: true }).click()
    await page.getByRole('navigation', { name: '主导航' }).filter({ visible: true }).getByRole('link', { name: '设置', exact: true }).click()
    step = `${viewport}: Settings after pending deletion`; await page.getByRole('heading', { name: '账号设置', exact: true }).waitFor()
    if (viewport === 'mobile') await page.getByRole('button', { name: '打开导航', exact: true }).click()
    await page.getByRole('button', { name: '退出登录', exact: true }).filter({ visible: true }).click()
    await page.getByRole('button', { name: '登录', exact: true }).waitFor()
    step = `${viewport}: release deletion after logout`; const retiredUrl = page.url()
    // Logout disposes the client and may abort the browser request before fulfillment.
    // The fixture still releases the real committed response; do not require a200 network event after disposal.
    let lateProjectReads = 0, latePrompts = 0
    const readListener = (request: any) => { if (/^\/api\/(projects|workspaces)/.test(new URL(request.url()).pathname)) lateProjectReads++ }
    page.on('request', readListener)
    page.removeAllListeners('dialog'); const rejectDialog = async (dialog: any) => { latePrompts++; await dialog.dismiss() }; page.on('dialog', rejectDialog)
    release(); await responseAttempted
    step = `${viewport}: assert retired deletion callback`
    await page.unroute(delayedMatcher, delayedHandler)
    await page.getByRole('button', { name: '登录', exact: true }).waitFor()
    assert.equal(page.url(), retiredUrl); assert.equal(lateProjectReads, 0); assert.equal(latePrompts, 0)
    assert.equal(await page.getByRole('heading', { name: delayedWorkspace.name, exact: true }).count(), 0)
    page.off('request', readListener); page.off('dialog', rejectDialog)
    check(true, `${viewport}: committed Workspace DELETE response after Settings departure and logout causes no navigation/reload/private restoration`)
    await api('/auth/login', { login: 'workspace-owner@example.test', password: 'synthetic workspace password 123' })
    assert.ok((await api(`/workspaces/${delayedWorkspace.id}`)).deletedAt)
    check((await api('/sessions')).items.length === 0, `${viewport}: no Session or Agent execution created`)
    check(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), `${viewport}: browser page fits viewport`)
    assert.deepEqual(errors, []); check(true, `${viewport}: no browser pageerror`)
    result.observations.push({ viewport, revision, paths: [emptyPath, a, b, repairedPath].map(path => relative(state, path)), failureReason: failureReason.replaceAll(state, '<owned-state>') })
    await page.screenshot({ path: join(evidence, `${viewport}-task-unbound.png`), fullPage: true }); await page.close()
  }
  assert.deepEqual(workers.flatMap(worker => worker.failures), [])
  check(true, 'real runtime and transport recorded no unexpected asynchronous failures')
  result.passed = true
} catch (error) {
  result.failureStep = step
  await writeFile(join(evidence, 'failure.txt'), String(error instanceof Error ? error.stack ?? error.message : error).replaceAll(state, '<owned-state>'))
}
finally {
  const cleanup = async (label: string, work: () => Promise<unknown>) => { try { await work() } catch { result.passed = false; result.cleanupFailures.push(label) } }
  await cleanup('browser', async () => { await browser?.close() })
  for (const worker of workers) await cleanup('worker-stop', worker.stop)
  await cleanup('server', async () => { await app?.close() })
  for (const worker of workers) await cleanup('worker-stores', async () => worker.closeStores())
  for (const [key, value] of original) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  await cleanup('owned-state', () => rm(state, { recursive: true, force: true }))
  await writeFile(join(evidence, 'result.json'), JSON.stringify(result, null, 2))
}
console.log(JSON.stringify({ ...result, evidence })); process.exitCode = result.passed ? 0 : 1
