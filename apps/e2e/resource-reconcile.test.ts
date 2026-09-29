import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, type ChildProcess } from 'node:child_process'
import test from 'node:test'
import { SqliteServerStore } from '../server/src/storage/sqlite/store.ts'
import { hashPassword } from '../server/src/application/password.ts'
import type { Resource, ResourceRevision } from '@wemux/domain'
import { installCatalog } from '../worker/src/runtimes/management.ts'
import { readAgentSettings } from '../worker/src/config/agent-settings.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../')
const serverEntry = join(root, 'apps/server/dist/main.js')
const workerEntry = join(root, 'apps/worker/dist/cli.js')
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const sleep = (ms: number) => new Promise(resolvePromise => setTimeout(resolvePromise, ms))
async function waitFor(predicate: () => Promise<boolean>, timeout = 20_000) { const started = Date.now(); while (Date.now() - started < timeout) { if (await predicate()) return; await sleep(100) } throw new Error('Timed out waiting for resource convergence') }
async function stop(child: ChildProcess | null) { if (!child || child.exitCode !== null) return; child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), sleep(2_000)]); if (child.exitCode === null) child.kill('SIGKILL') }
async function freePort() { const net = await import('node:net'); const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); const port = typeof address === 'object' && address ? address.port : 0; await new Promise<void>(resolveClose => server.close(() => resolveClose())); return port }
async function request(base: string, path: string, init?: RequestInit) { const response = await fetch(`${base}${path}`, init); const body = await response.text(); return { response, body: body ? JSON.parse(body) : null } }
async function login(base: string, loginName: string, password: string) { const result = await request(base, '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: loginName, password }) }); assert.equal(result.response.status, 200); const cookie = result.response.headers.get('set-cookie')!.split(';', 1)[0]!; const me = await request(base, '/api/auth/me', { headers: { cookie } }); return { cookie, csrf: me.body.csrfToken as string } }
function adminHeaders(auth: { cookie: string; csrf: string }, json = true): Record<string, string> { return { cookie: auth.cookie, 'x-csrf-token': auth.csrf, ...(json ? { 'content-type': 'application/json' } : {}) } }
async function createAccount(databasePath: string, email: string, password: string) {
  const store = new SqliteServerStore(databasePath)
  const id = randomUUID(), teamId = randomUUID(), now = new Date().toISOString()
  try {
    await store.transaction(async tx => {
      await tx.identity.saveTeam({ id: teamId as never, name: 'E2E Team', createdAt: now as never })
      await tx.identity.saveUser({ id: id as never, username: 'resource-admin', email, createdAt: now as never })
      await tx.identity.saveMembership({ teamId: teamId as never, userId: id as never, role: 'owner', joinedAt: now as never })
      await tx.identity.saveLocalAccountCredential({ userId: id as never, passwordHash: await hashPassword(password), updatedAt: now as never })
    })
  } finally { store.close() }
}
function revision(resourceId: string, id: string, version: number, content: string): { revision: ResourceRevision; blobHash: string } { const blobHash = sha(content); const manifestHash = sha(`manifest-${id}`); return { blobHash, revision: { id, resourceId, kind: 'skill', version, state: 'published', manifest: { schemaVersion: 1, name: 'E2E Skill', description: '', compatibility: { workerProtocol: '2', platforms: [], architectures: [], agentKeys: [] }, bytes: Buffer.byteLength(content), fileCount: 1, sha256: manifestHash, materializerVersion: 1, restartPolicy: 'none' }, payload: { mode: 'blobs', files: [{ path: 'SKILL.md', size: Buffer.byteLength(content), mediaType: 'text/markdown', sha256: blobHash, blobSha256: blobHash }] }, contentSha256: manifestHash, supplyChain: { mode: 'static-content', manifestSha256: manifestHash }, createdBy: 'e2e-admin' as never, createdAt: new Date().toISOString() as never } } }

async function runScenario() {
  const scratch = join(root, '.scratch/r1-stage4')
  await mkdir(scratch, { recursive: true })
  const temp = await mkdtemp(join(tmpdir(), 'wemux-resource-e2e-'))
  const databasePath = join(temp, 'server.sqlite'), workerHome = join(temp, 'worker'), secondHome = join(temp, 'worker-2')
  const port = await freePort(), base = `http://127.0.0.1:${port}`
  const email = 'admin@example.com', password = 'resource-e2e-password'
  let server: ChildProcess | null = null, worker: ChildProcess | null = null, secondWorker: ChildProcess | null = null
  const output: string[] = []
  try {
    server = spawn(process.execPath, [serverEntry], { cwd: root, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', WEMUX_ADMIN_EMAILS: email, WEMUX_DATABASE_PATH: databasePath, WEMUX_CAPABILITY_SECRET: 'resource-e2e-capability-secret-long-enough' }, stdio: ['ignore', 'pipe', 'pipe'] })
    server.stdout!.on('data', chunk => output.push(`[server] ${chunk}`)); server.stderr!.on('data', chunk => output.push(`[server-err] ${chunk}`))
    await waitFor(async () => fetch(`${base}/health`).then(response => response.ok).catch(() => false))
    await createAccount(databasePath, email, password)
    const auth = await login(base, email, password)
    const tokenResult = await request(base, '/api/enrollment-tokens', { method: 'POST', headers: adminHeaders(auth), body: JSON.stringify({ expiresInSeconds: 3600 }) }); assert.equal(tokenResult.response.status, 201)
    const register = spawn(process.execPath, [workerEntry, 'register', '--home', workerHome, '--server', base, '--token', tokenResult.body.token, '--name', 'resource-e2e-worker'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }); await once(register, 'exit'); assert.equal(register.exitCode, 0)
    worker = spawn(process.execPath, [workerEntry, 'start', '--home', workerHome], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }); worker.stdout!.on('data', chunk => output.push(`[worker] ${chunk}`)); worker.stderr!.on('data', chunk => output.push(`[worker-err] ${chunk}`))
    let workerId = ''
    await waitFor(async () => {
      const workers = await request(base, '/api/workers', { headers: { cookie: auth.cookie } })
      workerId = workers.body.items.find((item: { name: string }) => item.name === 'resource-e2e-worker')?.id ?? ''
      return !!workerId
    })
    const secondToken = await request(base, '/api/enrollment-tokens', { method: 'POST', headers: adminHeaders(auth), body: JSON.stringify({ expiresInSeconds: 3600 }) }); assert.equal(secondToken.response.status, 201)
    const registerSecond = spawn(process.execPath, [workerEntry, 'register', '--home', secondHome, '--server', base, '--token', secondToken.body.token, '--name', 'resource-e2e-worker-2'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }); await once(registerSecond, 'exit'); assert.equal(registerSecond.exitCode, 0)
    secondWorker = spawn(process.execPath, [workerEntry, 'start', '--home', secondHome], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }); secondWorker.stdout!.on('data', chunk => output.push(`[worker-2] ${chunk}`)); secondWorker.stderr!.on('data', chunk => output.push(`[worker-2-err] ${chunk}`))
    let secondWorkerId = ''
    await waitFor(async () => { const result = await request(base, '/api/workers', { headers: { cookie: auth.cookie } }); secondWorkerId = result.body.items.find((item: { name: string }) => item.name === 'resource-e2e-worker-2')?.id ?? ''; return !!secondWorkerId })
    const resourceId = 'e2e-skill', resource: Resource = { id: resourceId, kind: 'skill', name: 'E2E Skill', description: '', definition: { entryFile: 'SKILL.md', compatibleAgents: [], containsExecutableFiles: false }, createdBy: 'e2e-admin' as never, createdAt: new Date().toISOString() as never, updatedAt: new Date().toISOString() as never }
    assert.equal((await request(base, '/api/resources', { method: 'POST', headers: adminHeaders(auth), body: JSON.stringify(resource) })).response.status, 201)
    const first = revision(resourceId, 'e2e-rev-1', 1, '# revision one')
    assert.equal((await request(base, `/api/resource-blobs/${first.blobHash}`, { method: 'PUT', headers: adminHeaders(auth), body: JSON.stringify({ base64Content: Buffer.from('# revision one').toString('base64') }) })).response.status, 201)
    assert.equal((await request(base, `/api/resources/${resourceId}/revisions`, { method: 'POST', headers: adminHeaders(auth), body: JSON.stringify(first.revision) })).response.status, 201)
    assert.equal((await request(base, '/api/resource-bindings', { method: 'POST', headers: adminHeaders(auth), body: JSON.stringify({ id: 'e2e-binding-1', workerId, resourceRevisionId: first.revision.id }) })).response.status, 201)
    assert.equal((await request(base, '/api/resource-bindings', { method: 'POST', headers: adminHeaders(auth), body: JSON.stringify({ id: 'e2e-binding-worker-2', workerId: secondWorkerId, resourceRevisionId: first.revision.id }) })).response.status, 201)
    const current = join(workerHome, 'resources', 'skill', resourceId, 'current', 'SKILL.md')
    const secondCurrent = join(secondHome, 'resources', 'skill', resourceId, 'current', 'SKILL.md')
    await waitFor(async () => readFile(current, 'utf8').then(value => value === '# revision one').catch(() => false))
    await waitFor(async () => readFile(secondCurrent, 'utf8').then(value => value === '# revision one').catch(() => false))
    await waitFor(async () => { const result = await request(base, '/api/resource-bindings', { headers: { cookie: auth.cookie } }); return ['e2e-binding-1', 'e2e-binding-worker-2'].every(id => result.body.items.some((item: { binding: { id: string; status: string }; reconcile: { phase: string } | null }) => item.binding.id === id && item.binding.status === 'installed' && item.reconcile?.phase === 'ready')) })
    await stop(worker); worker = null
    const second = revision(resourceId, 'e2e-rev-2', 2, '# revision two')
    assert.equal((await request(base, `/api/resource-blobs/${second.blobHash}`, { method: 'PUT', headers: adminHeaders(auth), body: JSON.stringify({ base64Content: Buffer.from('# revision two').toString('base64') }) })).response.status, 201)
    assert.equal((await request(base, `/api/resources/${resourceId}/revisions`, { method: 'POST', headers: adminHeaders(auth), body: JSON.stringify(second.revision) })).response.status, 201)
    const existing = await request(base, `/api/resource-bindings?workerId=${workerId}`, { headers: { cookie: auth.cookie } })
    const firstBinding = existing.body.items.find((item: { binding: { id: string } }) => item.binding.id === 'e2e-binding-1').binding
    assert.equal((await request(base, '/api/resource-bindings/e2e-binding-1', { method: 'PATCH', headers: adminHeaders(auth), body: JSON.stringify({ status: 'pending-gc', expectedRevision: firstBinding.revision }) })).response.status, 200)
    assert.equal((await request(base, '/api/resource-bindings', { method: 'POST', headers: adminHeaders(auth), body: JSON.stringify({ id: 'e2e-binding-2', workerId, resourceRevisionId: second.revision.id }) })).response.status, 201)
    worker = spawn(process.execPath, [workerEntry, 'start', '--home', workerHome], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }); worker.stdout!.on('data', chunk => output.push(`[worker-reconnect] ${chunk}`)); worker.stderr!.on('data', chunk => output.push(`[worker-reconnect-err] ${chunk}`))
    await waitFor(async () => readFile(current, 'utf8').then(value => value === '# revision two').catch(() => false))
    await waitFor(async () => { const result = await request(base, `/api/resource-bindings?workerId=${workerId}`, { headers: { cookie: auth.cookie } }); return result.body.items.some((item: { binding: { id: string; status: string }; reconcile: { phase: string } | null }) => item.binding.id === 'e2e-binding-2' && item.binding.status === 'installed' && item.reconcile?.phase === 'ready') })
    assert.equal(await readFile(secondCurrent, 'utf8'), '# revision one', '第二个 Worker 未更新绑定时保持旧版本')
    // Exercise the real registry-backed runtime path with a real Server/Worker.
    // Do not infer authenticated model availability merely from npm installation.
    const pi = installCatalog.pi, runtimeId = 'e2e-pi-runtime', runtimeHash = sha('pi-runtime-manifest')
    const runtime: Resource = { id: runtimeId, kind: 'agent-runtime', name: 'Pi runtime', description: '', definition: {}, createdBy: 'e2e-admin' as never, createdAt: new Date().toISOString() as never, updatedAt: new Date().toISOString() as never }
    const runtimeRevision: ResourceRevision = { id: 'e2e-pi-runtime-rev-1', resourceId: runtimeId, kind: 'agent-runtime', version: 1, state: 'published', manifest: { schemaVersion: 1, name: 'Pi runtime', description: '', compatibility: { workerProtocol: '2', platforms: ['linux'], architectures: ['x64'], agentKeys: ['pi' as never] }, bytes: 0, fileCount: 0, sha256: runtimeHash, materializerVersion: 1, restartPolicy: 'worker' }, payload: { mode: 'artifact', packageName: pi.name, packageVersion: pi.version, registryOrigin: 'https://registry.npmjs.org', packageIntegrity: pi.integrity }, supplyChain: { mode: 'registry-package', packageName: pi.name, packageVersion: pi.version, registryOrigin: 'https://registry.npmjs.org', packageIntegrity: pi.integrity }, contentSha256: runtimeHash, createdBy: 'e2e-admin' as never, createdAt: new Date().toISOString() as never }
    assert.equal((await request(base, '/api/resources', { method: 'POST', headers: adminHeaders(auth), body: JSON.stringify(runtime) })).response.status, 201)
    assert.equal((await request(base, `/api/resources/${runtimeId}/revisions`, { method: 'POST', headers: adminHeaders(auth), body: JSON.stringify(runtimeRevision) })).response.status, 201)
    const runtimeBindingId = 'e2e-pi-runtime-binding'
    assert.equal((await request(base, '/api/resource-bindings', { method: 'POST', headers: adminHeaders(auth), body: JSON.stringify({ id: runtimeBindingId, workerId: secondWorkerId, resourceRevisionId: runtimeRevision.id, agentKey: 'pi' }) })).response.status, 201)
    const runtimeProjection = async () => (await request(base, `/api/resource-bindings?workerId=${secondWorkerId}`, { headers: { cookie: auth.cookie } })).body.items.find((item: { binding: { id: string } }) => item.binding.id === runtimeBindingId)
    await waitFor(async () => (await runtimeProjection())?.reconcile?.phase === 'restart-required', 420_000)
    assert.equal((await runtimeProjection()).binding.status, 'notified', 'installation alone is not ready')
    assert.equal((await readAgentSettings(secondHome)).pi, undefined, 'running Worker must retain its previous Agent selection')
    await stop(secondWorker); secondWorker = null
    secondWorker = spawn(process.execPath, [workerEntry, 'start', '--home', secondHome], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }); secondWorker.stdout!.on('data', chunk => output.push(`[worker-2-restarted] ${chunk}`)); secondWorker.stderr!.on('data', chunk => output.push(`[worker-2-restarted-err] ${chunk}`))
    await waitFor(async () => (await readAgentSettings(secondHome)).pi?.package === `${pi.name}@${pi.version}`, 30_000)
    await waitFor(async () => ['ready', 'credential-required'].includes((await runtimeProjection())?.reconcile?.phase), 50_000)
    const runtimePhase = (await runtimeProjection()).reconcile.phase
    // A Preset expands to ResourceBindings in one CAS-protected ResourceSet
    // update; the real Worker must converge and report back through the same API.
    const presetSkillId = 'e2e-preset-skill', presetSkill: Resource = { ...resource, id: presetSkillId, name: 'Preset E2E Skill' }
    const presetRevision = revision(presetSkillId, 'e2e-preset-rev-1', 1, '# from preset')
    assert.equal((await request(base, '/api/resources', { method: 'POST', headers: adminHeaders(auth), body: JSON.stringify(presetSkill) })).response.status, 201)
    assert.equal((await request(base, `/api/resource-blobs/${presetRevision.blobHash}`, { method: 'PUT', headers: adminHeaders(auth), body: JSON.stringify({ base64Content: Buffer.from('# from preset').toString('base64') }) })).response.status, 201)
    assert.equal((await request(base, `/api/resources/${presetSkillId}/revisions`, { method: 'POST', headers: adminHeaders(auth), body: JSON.stringify(presetRevision.revision) })).response.status, 201)
    const publishedPreset = await request(base, '/api/resource-presets', { method: 'POST', headers: adminHeaders(auth), body: JSON.stringify({ id: 'e2e-preset', name: '标准节点', description: '', expectedRevision: 0, autoApply: { enabled: false }, entries: [{ resourceId: presetSkillId, resourceRevisionId: presetRevision.revision.id, agentKey: null, projectId: null, required: true }] }) })
    assert.equal(publishedPreset.response.status, 201, JSON.stringify(publishedPreset.body))
    const presetSet = await request(base, `/api/workers/${workerId}/resource-set`, { headers: { cookie: auth.cookie } })
    const appliedPreset = await request(base, '/api/resource-presets/e2e-preset/applications', { method: 'POST', headers: adminHeaders(auth), body: JSON.stringify({ presetRevision: 1, workerId, requestId: 'e2e-preset-apply-1', expectedSetRevision: presetSet.body.revision }) })
    assert.equal(appliedPreset.response.status, 201, JSON.stringify(appliedPreset.body))
    const appliedAgain = await request(base, '/api/resource-presets/e2e-preset/applications', { method: 'POST', headers: adminHeaders(auth), body: JSON.stringify({ presetRevision: 1, workerId, requestId: 'e2e-preset-apply-1', expectedSetRevision: presetSet.body.revision }) })
    assert.equal(appliedAgain.response.status, 201)
    assert.equal(appliedAgain.body.id, appliedPreset.body.id)
    const presetCurrent = join(workerHome, 'resources', 'skill', presetSkillId, 'current', 'SKILL.md')
    await waitFor(async () => readFile(presetCurrent, 'utf8').then(value => value === '# from preset').catch(() => false))
    await waitFor(async () => { const result = await request(base, `/api/resource-preset-applications?workerId=${workerId}`, { headers: { cookie: auth.cookie } }); return result.body.items[0]?.items[0]?.reconcile?.phase === 'ready' })
    const presetConflict = await request(base, '/api/resource-presets/e2e-preset/applications', { method: 'POST', headers: adminHeaders(auth), body: JSON.stringify({ presetRevision: 1, workerId, requestId: 'e2e-preset-apply-2', expectedSetRevision: presetSet.body.revision }) })
    assert.equal(presetConflict.response.status, 409, 'stale ResourceSet CAS cannot apply twice')
    const tree = await import('node:child_process').then(({ execFile }) => new Promise<string>((resolveTree, reject) => execFile('find', [join(workerHome, 'resources'), join(secondHome, 'resources'), '-maxdepth', '6', '-printf', '%y %p -> %l\n'], (error, stdout) => error ? reject(error) : resolveTree(stdout))))
    const bindings = await request(base, `/api/resource-bindings?workerId=${workerId}`, { headers: { cookie: auth.cookie } })
    const statuses = bindings.body.items.map((item: { binding: { id: string; status: string }; reconcile: { phase: string } | null }) => `${item.binding.id}: ${item.binding.status} (${item.reconcile?.phase ?? 'none'})`)
    const evidence = ['real Server + two Worker processes: succeeded', 'first convergence: revision one installed and reported ready on both Workers', 'offline update: revision two assigned only to Worker one while it was stopped', 'reconnect convergence: Worker one revision two, Worker two revision one', `Pi official artifact installation: restart-required before restart, ${runtimePhase} after actual Worker restart`, 'Preset manual application: one CAS ResourceSet update, idempotent replay, Worker ready and stale CAS conflict', `bindings: ${statuses.join(', ')}`].join('\n') + '\n'
    const safeTree = tree.replaceAll(secondHome, '<worker-2-home>').replaceAll(workerHome, '<worker-1-home>')
    await writeFile(join(scratch, 'resource-reconcile-e2e.txt'), evidence)
    await writeFile(join(scratch, 'worker-resource-tree.txt'), safeTree)
  } catch (error) { console.error('E2E process output (diagnostic):', output.join('').replaceAll(temp, '<temp>').slice(-5000)); throw error }
  finally { await stop(worker); await stop(secondWorker); await stop(server); if (!process.env.WEMUX_RESOURCE_E2E_KEEP) await rm(temp, { recursive: true, force: true }); else console.error(`KEEP dir: ${temp}`) }
}

test('真实 Server + 两 Worker 完成 Skill 分发及 Pi runtime 安装、重启、探测', { timeout: 540_000 }, runScenario)
