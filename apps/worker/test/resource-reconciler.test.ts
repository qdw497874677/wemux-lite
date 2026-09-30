import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { ResourceSetSnapshot, Turn, WorkerId } from '@wemux/domain'
import { FilesystemAgentLaunchContextProvider } from '../src/application/agent-launch-context-provider.ts'
import type { WorkerPayload } from '@wemux/wire-protocol'
import { ResourceReconciler } from '../src/resources/resource-reconciler.ts'
import { activateStagedRuntimes, checkActivatedRuntimes } from '../src/resources/runtime-materializer.ts'
import { readAgentSettings, saveAgentSelection } from '../src/config/agent-settings.ts'
import { installCatalog } from '../src/runtimes/management.ts'
import { WorkerProviderCredentialStore } from '../src/providers/credential-store.ts'
import { SqliteWorkerStore } from '../src/storage/sqlite-store.ts'
import type { AgentAdapter, LocalAgentDetection } from '../src/application/ports/agent-adapter.ts'

const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const workerId = 'worker-resource-test' as WorkerId
function snapshot(revision: number, revisionId: string, content: string): ResourceSetSnapshot {
  return {
    workerId, revision, fingerprint: sha(`set-${revision}`), createdAt: '2026-01-01T00:00:00.000Z' as never,
    bindings: [{ bindingId: 'binding-1', bindingRevision: revision, agentKey: null, projectId: null, resourceRevisionId: revisionId, resourceId: 'skill-1', kind: 'skill', contentSha256: sha(`manifest-${revisionId}`), files: [{ path: 'SKILL.md', size: Buffer.byteLength(content), mediaType: 'text/markdown', sha256: sha(content), blobSha256: sha(content) }] }],
  }
}

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'wemux-resource-reconciler-'))
  const sent: WorkerPayload[] = []
  let reconciler!: ResourceReconciler
  const blobs = new Map<string, Buffer>()
  const transport = { send: async (payload: WorkerPayload) => {
    sent.push(payload)
    if (payload.type === 'resource.blob.fetch') queueMicrotask(() => reconciler.receive(blobs.has(payload.sha256)
      ? { type: 'resource.blob.fetch', action: 'response', requestId: payload.requestId, sha256: payload.sha256, mediaType: 'text/markdown', size: blobs.get(payload.sha256)!.length, base64Content: blobs.get(payload.sha256)!.toString('base64') }
      : { type: 'resource.blob.fetch', action: 'not-found', requestId: payload.requestId, sha256: payload.sha256 }))
  } }
  reconciler = new ResourceReconciler({ workerId, home, databasePath: join(home, 'resources.sqlite'), transport, now: () => '2026-01-01T00:00:00.000Z' as never })
  return { home, sent, blobs, reconciler, close: async () => { await reconciler.close(); await rm(home, { recursive: true, force: true }) } }
}

test('model-provider environment probe is fail closed and never reports ready or leaks values', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wemux-provider-probe-'))
  const sent: WorkerPayload[] = []
  const environment: NodeJS.ProcessEnv = {}
  const config = { providerKey: 'openai-compatible' as const, endpoint: 'https://models.example.test/v1', modelIds: ['test-model'], agentKeys: ['pi' as never], credential: { kind: 'environment' as const, variableNames: ['OPENAI_API_KEY'] } }
  const contentSha256 = sha(JSON.stringify(config))
  const binding = { bindingId: 'provider-binding', bindingRevision: 1, agentKey: 'pi' as never, projectId: null, resourceRevisionId: 'provider-rev', resourceId: 'provider-1', kind: 'model-provider' as const, contentSha256, files: [], provider: { mode: 'inline-config' as const, contentSha256, config } }
  const desired: ResourceSetSnapshot = { workerId, revision: 1, fingerprint: sha('provider-set'), bindings: [binding], createdAt: '2026-01-01T00:00:00Z' as never }
  const reconciler = new ResourceReconciler({ workerId, home, databasePath: join(home, 'resources.sqlite'), transport: { send: payload => { sent.push(payload) } }, environment })
  try {
    await reconciler.reconcile(desired)
    assert.equal(sent.at(-1)?.type === 'resource.reconcile.report' && sent.at(-1).report.errorCode, 'credential_required')
    environment.OPENAI_API_KEY = 'sentinel-secret'
    await reconciler.reconcile(desired)
    assert.equal(sent.at(-1)?.type === 'resource.reconcile.report' && sent.at(-1).report.phase, 'credential-required', 'configured environment alone is not a model probe')
    assert.equal(sent.at(-1)?.type === 'resource.reconcile.report' && sent.at(-1).report.errorCode, null)
    assert.doesNotMatch(JSON.stringify(sent) + await readFile(join(home, 'resources.sqlite')).then(bytes => bytes.toString('utf8')), /sentinel-secret/)
    assert.ok(sent.every(item => item.type !== 'resource.reconcile.report' || item.report.phase !== 'ready'))
  } finally { await reconciler.close(); await rm(home, { recursive: true, force: true }) }
})

test('model-provider local encrypted locator checks exact fields, revocation and invalid keys without leaking Secret', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wemux-provider-local-probe-'))
  const store = new SqliteWorkerStore(join(home, 'worker.sqlite'))
  const credentials = new WorkerProviderCredentialStore(store, { key: 'provider-probe-key' })
  const sent: WorkerPayload[] = []
  const config = { providerKey: 'openai-compatible' as const, endpoint: 'https://models.example.test/v1', modelIds: ['test-model'], agentKeys: ['pi' as never], credential: { kind: 'worker-credential' as const, credentialRef: 'local-ref', variableNames: ['OPENAI_API_KEY'] } }
  const contentSha256 = sha(JSON.stringify(config))
  const binding = { bindingId: 'provider-local-binding', bindingRevision: 1, agentKey: 'pi' as never, projectId: null, resourceRevisionId: 'provider-local-rev', resourceId: 'provider-local', kind: 'model-provider' as const, contentSha256, files: [], provider: { mode: 'inline-config' as const, contentSha256, config } }
  const desired: ResourceSetSnapshot = { workerId, revision: 1, fingerprint: sha('provider-local-set'), bindings: [binding], createdAt: '2026-01-01T00:00:00Z' as never }
  const reconciler = new ResourceReconciler({ workerId, home, databasePath: join(home, 'resources.sqlite'), transport: { send: payload => { sent.push(payload) } }, providerCredentials: credentials })
  const last = () => { const payload = sent.at(-1); assert.equal(payload?.type, 'resource.reconcile.report'); return payload.report }
  const sentinel = 'encrypted-model-secret-8142'
  try {
    await reconciler.reconcile(desired)
    assert.equal(last().errorCode, 'credential_required')
    await credentials.put({ id: 'local-ref', variableNames: ['ANTHROPIC_API_KEY'], secret: { ANTHROPIC_API_KEY: sentinel }, expectedRevision: 0 })
    await reconciler.reconcile(desired)
    assert.equal(last().errorCode, 'credential_required', 'a different declared field must not count as configured')
    await credentials.put({ id: 'local-ref', variableNames: ['OPENAI_API_KEY'], secret: { OPENAI_API_KEY: sentinel }, expectedRevision: 1 })
    await reconciler.reconcile(desired)
    assert.equal(last().phase, 'credential-required', 'resolvable secret is not a model probe')
    assert.equal(last().errorCode, null)
    const unavailable = new ResourceReconciler({ workerId, home, databasePath: join(home, 'resources-missing-key.sqlite'), transport: { send: payload => { sent.push(payload) } }, providerCredentials: new WorkerProviderCredentialStore(store, { key: 'wrong-key' }) })
    try { await unavailable.reconcile(desired); assert.equal(last().errorCode, 'credential_required') } finally { await unavailable.close() }
    await credentials.delete('local-ref', 2)
    await reconciler.reconcile(desired)
    assert.equal(last().errorCode, 'credential_required')
    assert.doesNotMatch(JSON.stringify(sent) + await readFile(join(home, 'resources.sqlite')).then(bytes => bytes.toString('utf8')), /encrypted-model-secret-8142/)
    assert.ok(sent.every(item => item.type !== 'resource.reconcile.report' || item.report.phase !== 'ready'))
  } finally { await reconciler.close(); store.close(); await rm(home, { recursive: true, force: true }) }
})

test('Provider launch selection requires fresh exact Project, Agent and model match; conflicts and revoked credentials fail closed', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wemux-provider-selection-'))
  const store = new SqliteWorkerStore(join(home, 'worker.sqlite'))
  const credentials = new WorkerProviderCredentialStore(store, { key: 'selection-encryption-key' })
  const sent: WorkerPayload[] = []
  const make = (resourceId: string, projectId: string | null, agentKey: string | null, modelIds = ['model-x']) => {
    const config = { providerKey: 'openai-compatible' as const, endpoint: 'https://models.example.test/v1', modelIds, agentKeys: ['pi' as never], credential: { kind: 'worker-credential' as const, credentialRef: resourceId, variableNames: ['OPENAI_API_KEY'] } }
    const contentSha256 = sha(JSON.stringify(config))
    return { bindingId: `${resourceId}-binding`, bindingRevision: 1, resourceId, resourceRevisionId: `${resourceId}-rev`, projectId: projectId as never, agentKey: agentKey as never, kind: 'model-provider' as const, contentSha256, files: [], provider: { mode: 'inline-config' as const, contentSha256, config } }
  }
  const global = make('global-provider', null, 'pi')
  const project = make('project-provider', 'project-a', 'pi')
  const makeSet = (revision: number, bindings: ReturnType<typeof make>[]): ResourceSetSnapshot => ({ workerId, revision, fingerprint: sha(`provider-select-${revision}`), createdAt: '2026-01-01T00:00:00Z' as never, bindings })
  const reconciler = new ResourceReconciler({ workerId, home, databasePath: join(home, 'resources.sqlite'), transport: { send: payload => { sent.push(payload) } }, providerCredentials: credentials })
  const select = (projectId = 'project-a', agentKey = 'pi', modelId = 'openai-compatible::model-x') => reconciler.providerForLaunch(projectId as never, agentKey as never, modelId as never)
  try {
    await credentials.put({ id: 'global-provider', variableNames: ['OPENAI_API_KEY'], secret: { OPENAI_API_KEY: 'sentinel-global-123' }, expectedRevision: 0 })
    await credentials.put({ id: 'project-provider', variableNames: ['OPENAI_API_KEY'], secret: { OPENAI_API_KEY: 'sentinel-project-456' }, expectedRevision: 0 })
    await reconciler.reconcile(makeSet(1, [global, project]))
    assert.deepEqual(await select(), { resourceId: 'project-provider', resourceRevisionId: 'project-provider-rev', bindingId: 'project-provider-binding', providerKey: 'openai-compatible', modelId: 'model-x' })
    const privateLaunch = await reconciler.piProviderForLaunch('project-a' as never, 'openai-compatible::model-x' as never)
    assert.equal(privateLaunch?.environment.OPENAI_API_KEY, 'sentinel-project-456')
    assert.equal(privateLaunch?.definition.endpoint, 'https://models.example.test/v1')
    assert.match(privateLaunch?.credentialStamp ?? '', /^[a-f0-9]{64}$/)
    assert.doesNotMatch(JSON.stringify({ ...privateLaunch, environment: undefined }), /sentinel-project-456/)
    assert.equal(await reconciler.piProviderForLaunch('project-a' as never, 'openai-compatible::different' as never), null)
    const beforeRotation = privateLaunch?.credentialStamp
    await credentials.put({ id: 'project-provider', variableNames: ['OPENAI_API_KEY'], secret: { OPENAI_API_KEY: 'sentinel-project-rotated' }, expectedRevision: 1 })
    const rotatedLaunch = await reconciler.piProviderForLaunch('project-a' as never, 'openai-compatible::model-x' as never)
    assert.equal(rotatedLaunch?.environment.OPENAI_API_KEY, 'sentinel-project-rotated')
    assert.notEqual(rotatedLaunch?.credentialStamp, beforeRotation)
    await credentials.put({ id: 'project-provider', variableNames: ['OPENAI_API_KEY'], secret: { OPENAI_API_KEY: 'sentinel-project-456' }, expectedRevision: 2 })
    assert.equal((await select('project-b'))?.resourceId, 'global-provider')
    assert.equal(await select('project-a', 'claude-code'), null)
    assert.equal(await select('project-a', 'pi', 'openai-compatible::another'), null)
    assert.equal(await select('project-a', 'pi', null as never), null)
    await reconciler.reconcile(makeSet(2, [global, project, make('project-other', 'project-a', 'pi')]))
    await assert.rejects(select(), /provider_binding_conflict/)
    await reconciler.reconcile(makeSet(3, [global, project]))
    const invalidProject = { ...project, provider: { ...project.provider, config: { ...project.provider.config, endpoint: 'https://changed.example.test/v1' } } }
    await reconciler.reconcile(makeSet(4, [global, invalidProject]))
    await assert.rejects(select(), /provider_binding_invalid/, 'tampered revision cannot silently fall back to global Provider')
    await reconciler.reconcile(makeSet(5, [global, project]))
    await credentials.delete('project-provider', 3)
    await assert.rejects(select(), /provider_credential_unavailable/)
    assert.notEqual((await select('project-b'))?.resourceId, 'project-provider')
    const pending = makeSet(6, [global, project])
    const reset = await credentials.put({ id: 'project-provider', variableNames: ['OPENAI_API_KEY'], secret: { OPENAI_API_KEY: 'race-start' }, expectedRevision: 0 })
    assert.equal(reset.revision, 1)
    const raced = new ResourceReconciler({ workerId, home, databasePath: join(home, 'resources-rotate.sqlite'), transport: { send: payload => { sent.push(payload) } }, providerCredentials: {
      resolve: (id, names) => credentials.resolve(id, names),
      resolveWithStamp: async (id, names) => {
        const resolved = await credentials.resolveWithStamp(id, names)
        await credentials.put({ id, variableNames: names, secret: { OPENAI_API_KEY: 'race-rotated' }, expectedRevision: 1 })
        return resolved
      },
      stamp: id => credentials.stamp(id),
    } })
    try {
      await raced.reconcile(pending)
      await assert.rejects(raced.piProviderForLaunch('project-a' as never, 'openai-compatible::model-x' as never), /provider_credential_unavailable/)
    } finally { await raced.close() }
    let finishResolution!: (value: Readonly<Record<string, string>>) => void
    let hold = false
    const delayed = new ResourceReconciler({ workerId, home, databasePath: join(home, 'resources-race.sqlite'), transport: { send: payload => { sent.push(payload) } }, providerCredentials: { resolve: () => hold ? new Promise(resolve => { finishResolution = resolve }) : Promise.resolve({ OPENAI_API_KEY: 'sentinel-before-disconnect' }) } })
    try {
      await delayed.reconcile(pending)
      hold = true
      const launch = delayed.providerForLaunch('project-a' as never, 'pi' as never, 'openai-compatible::model-x' as never)
      delayed.disconnected()
      finishResolution({ OPENAI_API_KEY: 'sentinel-after-disconnect' })
      await assert.rejects(launch, /provider_snapshot_unavailable/)
      // A reconnect with the same desired revision must not revive the old selection.
      hold = false
      await delayed.reconcile(pending)
      hold = true
      const reconnected = delayed.providerForLaunch('project-a' as never, 'pi' as never, 'openai-compatible::model-x' as never)
      delayed.disconnected()
      hold = false
      await delayed.reconcile(pending)
      finishResolution({ OPENAI_API_KEY: 'sentinel-after-reconnect' })
      await assert.rejects(reconnected, /provider_snapshot_unavailable/)
    } finally { await delayed.close() }
    reconciler.disconnected()
    await assert.rejects(select('project-b'), /provider_snapshot_unavailable/)
    assert.doesNotMatch(JSON.stringify(sent) + await readFile(join(home, 'resources.sqlite')).then(bytes => bytes.toString('utf8')), /sentinel-global-123|sentinel-project-456/)
  } finally { await reconciler.close(); store.close(); await rm(home, { recursive: true, force: true }) }
})

test('Agent runtime: pinned artifact stages without changing selection; repeated snapshot reprobes; failed update retains previous', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wemux-runtime-resource-'))
  const sent: WorkerPayload[] = []
  const artifact = { mode: 'artifact' as const, packageName: installCatalog.pi.name, packageVersion: installCatalog.pi.version, registryOrigin: 'https://registry.npmjs.org', packageIntegrity: installCatalog.pi.integrity }
  const binding = (revision: number, id: string) => ({ bindingId: 'runtime-binding', bindingRevision: revision, agentKey: 'pi' as never, projectId: null, resourceRevisionId: id, resourceId: 'runtime-resource', kind: 'agent-runtime' as const, contentSha256: sha(id), files: [], artifact })
  const desired = (revision: number, id: string): ResourceSetSnapshot => ({ workerId, revision, fingerprint: sha(`runtime-${revision}`), createdAt: '2026-01-01T00:00:00.000Z' as never, bindings: [binding(revision, id)] })
  let installs = 0
  let invalid = false
  const stageRuntime = async (_home: string, _artifact: typeof artifact) => {
    if (invalid) throw new Error('artifact integrity mismatch')
    installs++
    const directory = join(home, 'agents', 'pi', `0.85.1-${installs}`)
    const executable = join(directory, 'node_modules', artifact.packageName, installCatalog.pi.bin)
    await mkdir(join(executable, '..'), { recursive: true })
    await writeFile(executable, '#!/bin/sh\nprintf "0.85.1\\n"\n', { mode: 0o755 })
    return { key: 'pi' as const, executable, directory, package: `${artifact.packageName}@${artifact.packageVersion}`, version: '0.85.1' }
  }
  const reconciler = new ResourceReconciler({ workerId, home, databasePath: join(home, 'resources.sqlite'), transport: { send: async payload => { sent.push(payload) } }, stageRuntime, runtimeProcess: async () => '0.85.1' })
  try {
    await reconciler.reconcile(desired(1, 'runtime-rev-1'))
    assert.equal(installs, 1)
    assert.equal(sent.at(-1)?.type === 'resource.reconcile.report' && sent.at(-1).report.phase, 'restart-required')
    assert.equal(await readFile(join(home, 'agents.json'), 'utf8').catch(() => ''), '', 'runtime staging must not activate running Agent')
    await reconciler.reconcile(desired(1, 'runtime-rev-1'))
    assert.equal(installs, 1, 'unchanged revision should only probe staged executable')
    await reconciler.close()
    await activateStagedRuntimes(home, workerId, async () => '0.85.1')
    const selected = await readAgentSettings(home)
    assert.equal(selected.pi?.executable, join(home, 'agents', 'pi', '0.85.1-1', 'node_modules', artifact.packageName, installCatalog.pi.bin), 'next Worker start activates staged runtime')
    await checkActivatedRuntimes(home, workerId, [probeAgent(selected.pi!.executable, 'available')])
    const restarted = new ResourceReconciler({ workerId, home, databasePath: join(home, 'resources.sqlite'), transport: { send: async payload => { sent.push(payload) } }, stageRuntime, runtimeProcess: async () => '0.85.1' })
    try {
      await restarted.reconcile(desired(1, 'runtime-rev-1'))
      assert.equal(installs, 1, 'restart must not reinstall')
      assert.equal(sent.at(-1)?.type === 'resource.reconcile.report' && sent.at(-1).report.phase, 'ready', 'ready requires fresh Agent capability probe')
    } finally { await restarted.close() }
    // New revision is still installed separately; activation only happens at the next start.
    const invalidBinding = { ...binding(2, 'runtime-rev-2'), artifact: { ...artifact, registryOrigin: 'https://untrusted.invalid' } }
    const third = new ResourceReconciler({ workerId, home, databasePath: join(home, 'resources.sqlite'), transport: { send: async payload => { sent.push(payload) } }, stageRuntime, runtimeProcess: async () => '0.85.1' })
    try {
    await third.reconcile({ ...desired(2, 'runtime-rev-2'), bindings: [invalidBinding] })
    assert.equal(installs, 1, 'unapproved artifact must be rejected before invoking installer')
    assert.equal(sent.at(-1)?.type === 'resource.reconcile.report' && sent.at(-1).report.result, 'failed')
    invalid = true
    await third.reconcile(desired(2, 'runtime-rev-2'))
    assert.equal(sent.at(-1)?.type === 'resource.reconcile.report' && sent.at(-1).report.result, 'failed')
    assert.equal(installs, 1)
    assert.equal(await readFile(join(home, 'agents', 'pi', '0.85.1-1', 'node_modules', artifact.packageName, installCatalog.pi.bin), 'utf8').then(text => text.includes('0.85.1')), true)
    assert.equal((await readAgentSettings(home)).pi?.executable, selected.pi?.executable, 'failed update preserves active selection')
    } finally { await third.close() }
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('activation refuses another Worker identity and retains previous Agent selection for rollback', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wemux-runtime-activation-'))
  const executable = join(home, 'agents', 'pi', '0.85.1-staged', 'node_modules', installCatalog.pi.name, installCatalog.pi.bin)
  const previous = join(home, 'previous-agent')
  const artifact = { mode: 'artifact' as const, packageName: installCatalog.pi.name, packageVersion: installCatalog.pi.version, registryOrigin: 'https://registry.npmjs.org', packageIntegrity: installCatalog.pi.integrity }
  const binding = { bindingId: 'bind', bindingRevision: 1, agentKey: 'pi' as never, projectId: null, resourceRevisionId: 'revision-1', resourceId: 'pi-runtime', kind: 'agent-runtime' as const, contentSha256: sha('runtime'), files: [], artifact }
  const desired: ResourceSetSnapshot = { workerId, revision: 1, fingerprint: sha('set'), bindings: [binding], createdAt: '2026-01-01T00:00:00Z' as never }
  const state = new (await import('../src/resources/resource-state-store.ts')).ResourceStateStore(join(home, 'resources.sqlite'))
  try {
    await mkdir(join(executable, '..'), { recursive: true })
    await writeFile(executable, '#!/bin/sh\nprintf "0.85.1\\n"\n', { mode: 0o755 })
    await writeFile(previous, '#!/bin/sh\nprintf "0.85.1\\n"\n', { mode: 0o755 })
    await saveAgentSelection(home, 'pi', { executable: previous, source: 'local', selectedAt: '2026-01-01T00:00:00Z' })
    state.saveDesired(desired)
    state.saveInstalled({ bindingId: binding.bindingId, resourceId: binding.resourceId, resourceRevisionId: binding.resourceRevisionId, kind: 'agent-runtime', integrity: binding.contentSha256, runtimeKey: 'pi', executable, files: {}, path: join(home, 'agents', 'pi', '0.85.1-staged'), installedAt: '2026-01-01T00:00:00Z', lastUsedAt: '2026-01-01T00:00:00Z' })
    state.close()
    await activateStagedRuntimes(home, 'another-worker' as WorkerId, async () => '0.85.1')
    assert.equal((await readAgentSettings(home)).pi?.executable, previous)
    await activateStagedRuntimes(home, workerId, async () => '0.85.1')
    assert.equal((await readAgentSettings(home)).pi?.executable, executable)
    const reopened = new (await import('../src/resources/resource-state-store.ts')).ResourceStateStore(join(home, 'resources.sqlite'))
    assert.equal(reopened.installed(binding.resourceId)?.previousExecutable, previous)
    reopened.close()
    assert.equal(await checkActivatedRuntimes(home, workerId, [probeAgent(executable, 'authentication-required')]), false)
    const authState = new (await import('../src/resources/resource-state-store.ts')).ResourceStateStore(join(home, 'resources.sqlite'))
    assert.equal(authState.installed(binding.resourceId)?.activation, 'credential-required')
    authState.close()
  } finally { await rm(home, { recursive: true, force: true }) }
})

function probeAgent(executable: string, status: 'available' | 'authentication-required' | 'unavailable'): AgentAdapter {
  return { agentKey: 'pi' as never, mode: 'execution', detect: async (): Promise<LocalAgentDetection> => ({
    agentKey: 'pi' as never, displayName: 'Pi', executablePath: executable, diagnostics: [], version: '0.85.1', mode: 'execution',
    availability: status === 'available' ? { status } : { status, reason: 'probe result' }, models: [],
  }) }
}

test('failed Agent capability probe restores exact previous selection and never marks runtime ready', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wemux-runtime-rollback-'))
  const oldExecutable = join(home, 'old-agent')
  const executable = join(home, 'agents', 'pi', 'staged', 'node_modules', installCatalog.pi.name, installCatalog.pi.bin)
  const artifact = { mode: 'artifact' as const, packageName: installCatalog.pi.name, packageVersion: installCatalog.pi.version, registryOrigin: 'https://registry.npmjs.org', packageIntegrity: installCatalog.pi.integrity }
  const binding = { bindingId: 'bind', bindingRevision: 1, agentKey: 'pi' as never, projectId: null, resourceRevisionId: 'revision-1', resourceId: 'pi-runtime', kind: 'agent-runtime' as const, contentSha256: sha('runtime'), files: [], artifact }
  const state = new (await import('../src/resources/resource-state-store.ts')).ResourceStateStore(join(home, 'resources.sqlite'))
  try {
    await mkdir(join(executable, '..'), { recursive: true })
    await writeFile(executable, '#!/bin/sh\nprintf "0.85.1\\n"\n', { mode: 0o755 })
    await writeFile(oldExecutable, '#!/bin/sh\nprintf "old\\n"\n', { mode: 0o755 })
    const oldSelection = { executable: oldExecutable, source: 'managed' as const, package: 'old@1.0.0', selectedAt: '2025-01-01T00:00:00Z' }
    await saveAgentSelection(home, 'pi', oldSelection)
    state.saveDesired({ workerId, revision: 1, fingerprint: sha('set'), bindings: [binding], createdAt: '2026-01-01T00:00:00Z' as never })
    state.saveInstalled({ bindingId: binding.bindingId, resourceId: binding.resourceId, resourceRevisionId: binding.resourceRevisionId, kind: 'agent-runtime', integrity: binding.contentSha256, runtimeKey: 'pi', executable, files: {}, path: join(home, 'agents', 'pi', 'staged'), installedAt: '2026-01-01T00:00:00Z', lastUsedAt: '2026-01-01T00:00:00Z' })
    state.close()
    await activateStagedRuntimes(home, workerId, async () => '0.85.1')
    assert.equal(await checkActivatedRuntimes(home, workerId, [probeAgent(executable, 'unavailable')]), true, 'startup must rebuild adapters from restored selection')
    assert.deepEqual((await readAgentSettings(home)).pi, oldSelection)
    const reopened = new (await import('../src/resources/resource-state-store.ts')).ResourceStateStore(join(home, 'resources.sqlite'))
    assert.equal(reopened.installed(binding.resourceId)?.activation, 'failed')
    reopened.close()
    await activateStagedRuntimes(home, workerId, async () => '0.85.1')
    assert.deepEqual((await readAgentSettings(home)).pi, oldSelection, 'failed revision must not reactivate on next restart')
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('reconcile 差异矩阵：缺失下载，已收敛不重复下载，磁盘漂移重新物化', async () => {
  const f = await fixture()
  try {
    const desired = snapshot(1, 'rev-1', '# skill')
    f.blobs.set(sha('# skill'), Buffer.from('# skill'))
    await f.reconciler.reconcile(desired)
    assert.equal(f.sent.filter(item => item.type === 'resource.blob.fetch').length, 1)
    assert.equal(f.sent.filter(item => item.type === 'resource.reconcile.report' && item.report.phase === 'ready').length, 1)
    await f.reconciler.reconcile(desired)
    assert.equal(f.sent.filter(item => item.type === 'resource.blob.fetch').length, 1)
    await readFile(join(f.home, 'resources', 'skill', 'skill-1', 'current', 'SKILL.md'))
    await import('node:fs/promises').then(fs => fs.writeFile(join(f.home, 'resources', 'skill', 'skill-1', 'current', 'SKILL.md'), '# drift'))
    await f.reconciler.reconcile(desired)
    assert.equal(f.sent.filter(item => item.type === 'resource.blob.fetch').length, 2)
    assert.equal(await readFile(join(f.home, 'resources', 'skill', 'skill-1', 'current', 'SKILL.md'), 'utf8'), '# skill')
  } finally { await f.close() }
})

test('期望态持久化后重启先本地恢复，并请求完整 snapshot', async () => {
  const f = await fixture()
  try {
    const desired = snapshot(1, 'rev-1', '# restart')
    f.blobs.set(sha('# restart'), Buffer.from('# restart'))
    await f.reconciler.reconcile(desired)
    await f.reconciler.close()
    const sent: WorkerPayload[] = []
    let restarted!: ResourceReconciler
    const transport = { send: async (payload: WorkerPayload) => {
      sent.push(payload)
      if (payload.type === 'resource.set.pull') queueMicrotask(() => restarted.receive({ type: 'resource.set.pull', action: 'snapshot', requestId: payload.requestId, resourceSet: desired }))
    } }
    restarted = new ResourceReconciler({ workerId, home: f.home, databasePath: join(f.home, 'resources.sqlite'), transport })
    await restarted.connected()
    assert.equal(sent.some(item => item.type === 'resource.set.pull' && item.knownSetRevision === 1), true)
    assert.equal(sent.some(item => item.type === 'resource.blob.fetch'), false)
    assert.equal(sent.some(item => item.type === 'resource.reconcile.report' && item.report.phase === 'ready'), true)
    await restarted.close()
    await rm(f.home, { recursive: true, force: true })
  } catch (error) { await rm(f.home, { recursive: true, force: true }); throw error }
})

test('无响应的 snapshot pull 不阻塞关闭', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wemux-resource-close-'))
  const reconciler = new ResourceReconciler({ workerId, home, databasePath: join(home, 'resources.sqlite'), transport: { send: async () => {} } })
  try {
    void reconciler.connected().catch(() => undefined)
    await new Promise(resolve => setTimeout(resolve, 20))
    await Promise.race([reconciler.close(), new Promise((_, reject) => setTimeout(() => reject(new Error('close blocked by pending pull')), 500))])
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('Invocation 固定已授权 revision，撤销后新 Invocation 不注入', async () => {
  const f = await fixture()
  try {
    const desired = snapshot(1, 'rev-1', '# old')
    const scoped = { ...desired, bindings: [{ ...desired.bindings[0]!, projectId: 'project-1' as never, agentKey: 'pi' as never }] }
    f.blobs.set(sha('# old'), Buffer.from('# old'))
    await f.reconciler.reconcile(scoped)
    const provider = new FilesystemAgentLaunchContextProvider(f.home, null, undefined,
      (projectId, agentKey) => f.reconciler.skillsForLaunch(projectId, agentKey),
      async () => ({ projectId: 'project-1' as never, agentKey: 'pi' as never }))
    const turn = (id: string, projectId = 'project-1') => ({
      id, sessionId: id, capabilitySnapshot: { id, sessionId: id, projectId, workspaceId: 'workspace-1', version: 1, assets: [], allowedTools: [], allowedConnectorIds: [], createdAt: new Date().toISOString() }, capabilityToken: null,
    }) as Turn
    const denied = await f.reconciler.skillsForLaunch('project-2' as never, 'pi' as never)
    const wrongAgent = await f.reconciler.skillsForLaunch('project-1' as never, 'claude-code' as never)
    assert.deepEqual(denied, []); assert.deepEqual(wrongAgent, [])
    const first = await provider.prepare(turn('turn-old'))
    assert.equal(await readFile(join(first.context!.skillsRoot!, 'skill-1', 'SKILL.md'), 'utf8'), '# old')
    const updated = snapshot(2, 'rev-2', '# new')
    f.blobs.set(sha('# new'), Buffer.from('# new'))
    await f.reconciler.reconcile({ ...updated, bindings: [{ ...updated.bindings[0]!, projectId: 'project-1' as never, agentKey: 'pi' as never }] })
    assert.equal(await readFile(join(first.context!.skillsRoot!, 'skill-1', 'SKILL.md'), 'utf8'), '# old', '活跃 Invocation 不热替换')
    const next = await provider.prepare(turn('turn-new'))
    assert.equal(await readFile(join(next.context!.skillsRoot!, 'skill-1', 'SKILL.md'), 'utf8'), '# new')
    await f.reconciler.reconcile({ workerId, revision: 3, fingerprint: sha('revoked'), bindings: [], createdAt: '2026-01-02T00:00:00.000Z' as never })
    const revoked = await provider.prepare(turn('turn-revoked'))
    assert.equal(revoked.context!.skillsRoot, null, '撤权后新 Invocation 不注入')
    assert.equal(await readFile(join(first.context!.skillsRoot!, 'skill-1', 'SKILL.md'), 'utf8'), '# old')
    const state = new (await import('../src/resources/resource-state-store.ts')).ResourceStateStore(join(f.home, 'resources.sqlite'))
    try {
      const gc = new (await import('../src/resources/skill-materializer.ts')).SkillMaterializer(f.home, state)
      // 运行中 Invocation 的 Skill 是隔离副本；GC 只能清理缓存，不能改变已固定的视图。
      await gc.collectGarbage('skill-1', { maxRetainedRevisions: 0 })
    } finally { state.close() }
    assert.equal(await readFile(join(first.context!.skillsRoot!, 'skill-1', 'SKILL.md'), 'utf8'), '# old')
    await revoked.cleanup(); await next.cleanup(); await first.cleanup()
  } finally { await f.close() }
})

test('撤销旧绑定后重新绑定相同 revision，更新绑定身份且新 Invocation 可用', async () => {
  const f = await fixture()
  try {
    const desired = snapshot(1, 'rev-1', '# authorized')
    f.blobs.set(sha('# authorized'), Buffer.from('# authorized'))
    await f.reconciler.reconcile(desired)
    await f.reconciler.reconcile({ ...desired, revision: 2, fingerprint: sha('revoked'), bindings: [] })
    const replacement = { ...desired, revision: 3, fingerprint: sha('replacement'), bindings: [{ ...desired.bindings[0]!, bindingId: 'binding-new' }] }
    await f.reconciler.reconcile(replacement)
    assert.equal((await f.reconciler.skillsForLaunch('project-1' as never, 'pi' as never)).length, 1)
    assert.equal(f.sent.filter(item => item.type === 'resource.blob.fetch').length, 1, '同一不可变 revision 不需重复下载')
  } finally { await f.close() }
})

test('断线或过时通知期间禁止用旧期望态注入，重新获取快照后才恢复', async () => {
  const f = await fixture()
  try {
    const desired = snapshot(1, 'rev-1', '# authorized')
    f.blobs.set(sha('# authorized'), Buffer.from('# authorized'))
    await f.reconciler.reconcile(desired)
    assert.equal((await f.reconciler.skillsForLaunch('project-1' as never, 'pi' as never)).length, 1)
    f.reconciler.disconnected()
    assert.deepEqual(await f.reconciler.skillsForLaunch('project-1' as never, 'pi' as never), [])
    await f.reconciler.reconcile(desired)
    assert.equal((await f.reconciler.skillsForLaunch('project-1' as never, 'pi' as never)).length, 1)
    f.reconciler.receive({ type: 'resource.set.notify', workerId, setRevision: 2, fingerprint: sha('revoked'), resources: [] })
    assert.deepEqual(await f.reconciler.skillsForLaunch('project-1' as never, 'pi' as never), [])
    const pull = await (async () => { for (let i = 0; i < 100; i++) { const request = f.sent.findLast(item => item.type === 'resource.set.pull'); if (request?.type === 'resource.set.pull') return request; await new Promise(resolve => setTimeout(resolve, 1)) } throw new Error('snapshot pull not sent') })()
    f.reconciler.receive({ type: 'resource.set.pull', action: 'snapshot', requestId: pull.requestId, resourceSet: desired })
    await f.reconciler.reconcile(desired)
    assert.deepEqual(await f.reconciler.skillsForLaunch('project-1' as never, 'pi' as never), [], '旧快照不能解除较新通知的隔离')
    await f.reconciler.reconcile({ ...desired, revision: 2, fingerprint: sha('revoked'), bindings: [] })
    assert.deepEqual(await f.reconciler.skillsForLaunch('project-1' as never, 'pi' as never), [])
  } finally { await f.close() }
})

test('本地缓存 hash 漂移时新 Invocation 不注入且已有隔离视图不变', async () => {
  const f = await fixture()
  try {
    const desired = snapshot(1, 'rev-1', '# trusted')
    f.blobs.set(sha('# trusted'), Buffer.from('# trusted'))
    await f.reconciler.reconcile(desired)
    const pinned = await f.reconciler.skillsForLaunch('project-1' as never, 'pi' as never)
    assert.equal(Buffer.from(pinned[0]!.content).toString('utf8'), '# trusted')
    const entry = join(f.home, 'resources', 'skill', 'skill-1', 'current', 'SKILL.md')
    await import('node:fs/promises').then(fs => fs.writeFile(entry, '# tampered'))
    assert.deepEqual(await f.reconciler.skillsForLaunch('project-1' as never, 'pi' as never), [], '校验失败不可注入')
    assert.equal(Buffer.from(pinned[0]!.content).toString('utf8'), '# trusted', '运行中的内容仍固定')
  } finally { await f.close() }
})

test('期望态移除时上报 pending-gc', async () => {
  const f = await fixture()
  try {
    const desired = snapshot(1, 'rev-1', '# remove')
    f.blobs.set(sha('# remove'), Buffer.from('# remove'))
    await f.reconciler.reconcile(desired)
    await f.reconciler.reconcile({ workerId, revision: 2, fingerprint: sha('empty'), bindings: [], createdAt: '2026-01-02T00:00:00.000Z' as never })
    assert.equal(f.sent.some(item => item.type === 'resource.reconcile.report' && item.report.result === 'pending-gc'), true)
  } finally { await f.close() }
})
