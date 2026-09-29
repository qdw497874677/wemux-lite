import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWemuxServer } from '../server/src/server.ts'
import { provisionAdministrator } from './session.ts'

const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const packagePath = join(repositoryRoot, 'artifacts/wemux-lite-worker.tgz')

async function eventually(check: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  assert.fail('Timed out waiting for real packaged Worker to connect')
}

async function runInstaller(script: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stderr: string }> {
  return await new Promise((resolveRun, reject) => {
    const child = spawn('sh', [script], { env, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    child.on('error', reject).on('close', code => resolveRun({ code, stderr }))
  })
}

/** Real npm + Server + packaged CLI. systemctl is replaced only because CI has no user manager. */
test('managed installer runs the real packaged Worker and retains identity across reinstall', { timeout: 360_000 }, async t => {
  if (process.env.WEMUX_MANAGED_PACKAGE_E2E !== '1') {
    t.skip('set WEMUX_MANAGED_PACKAGE_E2E=1 with a built artifacts/wemux-lite-worker.tgz to run npm installation')
    return
  }
  const directory = await mkdtemp(join(tmpdir(), 'wemux-managed-package-'))
  const workerHome = join(directory, 'worker')
  const installRoot = join(directory, 'install')
  const config = join(directory, 'config')
  const bin = join(directory, 'bin')
  const pidFile = join(directory, 'service.pid')
  const serviceLog = join(directory, 'service.log')
  const controlLog = join(directory, 'control.log')
  const administratorEmail = 'managed-package-owner@example.com'
  const server = createWemuxServer({ databasePath: join(directory, 'server.sqlite'), administratorEmails: [administratorEmail], workerPackagePath: packagePath })
  let baseUrl = ''
  const stopService = async () => {
    const pid = await readFile(pidFile, 'utf8').catch(() => '')
    if (pid) {
      const target = Number(pid)
      try { process.kill(target, 'SIGTERM') } catch { /* already stopped */ }
      for (let attempt = 0; attempt < 30; attempt++) {
        try { process.kill(target, 0) } catch { break }
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
  }
  t.after(async () => {
    await stopService()
    await server.close()
    await rm(directory, { recursive: true, force: true })
  })
  baseUrl = await server.listen(0)
  const administrator = await provisionAdministrator({ store: server.store, baseUrl, email: administratorEmail })
  const enrollment = await administrator.api<{ token: string }>('/enrollment-tokens', 'POST', {})
  const script = join(directory, 'install.sh')
  const installerResponse = await fetch(`${baseUrl}/downloads/install-worker.sh`)
  assert.equal(installerResponse.status, 200)
  await writeFile(script, await installerResponse.text())
  await mkdir(bin)
  const stub = join(bin, 'systemctl')
  await writeFile(stub, `#!/bin/sh
set -eu
printf '%s pid=%s\n' "$*" "$(cat "$WEMUX_E2E_PID_FILE" 2>/dev/null || true)" >> "$WEMUX_E2E_CONTROL_LOG"
case "\${1:-} \${2:-}" in
  '--user show-environment'|'--user daemon-reload'|'--user enable') exit 0 ;;
  '--user restart')
    if [ -f "$WEMUX_E2E_PID_FILE" ]; then kill "$(cat "$WEMUX_E2E_PID_FILE")" 2>/dev/null || true; fi
    nohup node "$WEMUX_INSTALL_ROOT/current/node_modules/@wemux/worker/dist/cli.js" start --home "$WEMUX_WORKER_HOME" > "$WEMUX_E2E_SERVICE_LOG" 2>&1 < /dev/null &
    printf '%s' "$!" > "$WEMUX_E2E_PID_FILE"
    exit 0 ;;
  '--user is-active') test -f "$WEMUX_E2E_PID_FILE" && kill -0 "$(cat "$WEMUX_E2E_PID_FILE")" 2>/dev/null; exit $? ;;
  '--user disable')
    if [ -f "$WEMUX_E2E_PID_FILE" ]; then kill "$(cat "$WEMUX_E2E_PID_FILE")" 2>/dev/null || true; fi
    exit 0 ;;
esac
exit 1
`)
  await chmod(stub, 0o755)
  const env = {
    ...process.env,
    HOME: directory,
    PATH: `${bin}:${process.env.PATH}`,
    // Reuse the operator's npm cache when HOME is sandboxed for Worker identity.
    npm_config_cache: process.env.npm_config_cache ?? join(process.env.HOME ?? directory, '.npm'),
    XDG_CONFIG_HOME: config,
    WEMUX_SERVER_URL: baseUrl,
    WEMUX_INSTALL_ROOT: installRoot,
    WEMUX_WORKER_HOME: workerHome,
    WEMUX_ENROLLMENT_TOKEN: enrollment.token,
    WEMUX_WORKER_NAME: 'Managed package E2E Worker',
    WEMUX_E2E_PID_FILE: pidFile,
    WEMUX_E2E_SERVICE_LOG: serviceLog,
    WEMUX_E2E_CONTROL_LOG: controlLog,
    // Never copy an auth.json into the disposable home; an explicitly provided
    // Pi configuration directory is inherited by the real packaged process.
    ...(process.env.WEMUX_REAL_PI_AGENT_DIR ? { PI_CODING_AGENT_DIR: process.env.WEMUX_REAL_PI_AGENT_DIR } : {}),
  }
  const installed = await runInstaller(script, env)
  assert.equal(installed.code, 0, `${installed.stderr}\nservice: ${await readFile(serviceLog, 'utf8').catch(() => 'missing')}\npid: ${await readFile(pidFile, 'utf8').catch(() => 'missing')}\ncontrol: ${await readFile(controlLog, 'utf8').catch(() => 'missing')}`)
  let workerId = ''
  await eventually(async () => {
    const list = await administrator.api<{ items: { id: string; name: string; connectionState: string }[] }>('/workers')
    const online = list.items.find(item => item.name === env.WEMUX_WORKER_NAME && item.connectionState === 'online')
    workerId = online?.id ?? ''
    return !!workerId
  })
  // Publish a static Skill and manually apply a Preset through real Server APIs.
  // This uses the installed tgz process rather than the source-tree Worker.
  const skillId = 'managed-package-skill'
  const revisionId = 'managed-package-skill-v1'
  const content = '---\nname: managed-package-skill\ndescription: Find the calibration marker when asked about the managed package Skill.\n---\n# Managed package Skill\n\nCalibration marker: WEMUX_SKILL_INJECTED_73\n'
  const digest = createHash('sha256').update(content).digest('hex')
  const now = new Date().toISOString()
  await administrator.api('/resources', 'POST', {
    id: skillId, kind: 'skill', name: 'Managed Skill', description: '',
    definition: { entryFile: 'SKILL.md', compatibleAgents: [], containsExecutableFiles: false },
    createdAt: now, updatedAt: now,
  })
  await administrator.api(`/resource-blobs/${digest}`, 'PUT', { base64Content: Buffer.from(content).toString('base64') })
  await administrator.api(`/resources/${skillId}/revisions`, 'POST', {
    id: revisionId, resourceId: skillId, kind: 'skill', version: 1, state: 'published',
    manifest: {
      schemaVersion: 1, name: 'Managed Skill', description: '',
      compatibility: { workerProtocol: '2', platforms: [], architectures: [], agentKeys: [] },
      bytes: Buffer.byteLength(content), fileCount: 1, sha256: digest, materializerVersion: 1, restartPolicy: 'none',
    },
    payload: { mode: 'blobs', files: [{ path: 'SKILL.md', size: Buffer.byteLength(content), mediaType: 'text/markdown', sha256: digest, blobSha256: digest }] },
    contentSha256: digest, supplyChain: { mode: 'static-content', manifestSha256: digest }, createdAt: now,
  })
  const preset = await administrator.api<{ id: string; revision: number }>('/resource-presets', 'POST', {
    id: 'managed-package-preset', name: 'Managed package preset', description: '', expectedRevision: 0,
    autoApply: { enabled: false }, entries: [{ resourceId: skillId, resourceRevisionId: revisionId, agentKey: null, projectId: null, required: true }],
  })
  const set = await administrator.api<{ revision: number }>(`/workers/${workerId}/resource-set`)
  const application = await administrator.api<{ id: string }>(`/resource-presets/${preset.id}/applications`, 'POST', {
    presetRevision: preset.revision, workerId, requestId: 'managed-package-preset-apply', expectedSetRevision: set.revision,
  })
  await eventually(async () => {
    const items = await administrator.api<{ items: { application: { id: string }; items: { binding: { resourceRevisionId: string; status: string }; reconcile: { phase: string } | null }[] }[] }>(`/resource-preset-applications?workerId=${workerId}`)
    return items.items.some(item => item.application.id === application.id && item.items.some(value => value.binding.resourceRevisionId === revisionId && value.binding.status === 'installed' && value.reconcile?.phase === 'ready'))
  })
  const skillFile = join(workerHome, 'resources', 'skill', skillId, 'current', 'SKILL.md')
  assert.equal(await readFile(skillFile, 'utf8'), content)
  const previousCredential = await readFile(join(workerHome, 'credential'))
  await stopService()
  await eventually(async () => {
    const list = await administrator.api<{ items: { id: string; connectionState: string }[] }>('/workers')
    return list.items.some(item => item.id === workerId && item.connectionState === 'offline')
  })
  const upgraded = await runInstaller(script, { ...env, WEMUX_ENROLLMENT_TOKEN: '' })
  assert.equal(upgraded.code, 0, upgraded.stderr)
  await eventually(async () => {
    const list = await administrator.api<{ items: { id: string; connectionState: string }[] }>('/workers')
    return list.items.some(item => item.id === workerId && item.connectionState === 'online')
  })
  assert.deepEqual(await readFile(join(workerHome, 'credential')), previousCredential, 'reinstallation preserves the enrolled Worker identity')
  assert.equal(await readFile(skillFile, 'utf8'), content, 'reinstallation preserves the active Preset Skill')
  const resumed = await administrator.api<{ items: { application: { id: string }; items: { binding: { resourceRevisionId: string; status: string }; reconcile: { phase: string } | null }[] }[] }>(`/resource-preset-applications?workerId=${workerId}`)
  assert.ok(resumed.items.some(item => item.application.id === application.id && item.items.some(value => value.binding.resourceRevisionId === revisionId && value.binding.status === 'installed' && value.reconcile?.phase === 'ready')), 'Preset projection remains ready after Worker reconnect')
  const list = await administrator.api<{ items: { name: string }[] }>('/workers')
  assert.equal(list.items.filter(item => item.name === env.WEMUX_WORKER_NAME).length, 1)
  assert.match(await readFile(join(config, 'systemd/user/wemux-lite-worker.service'), 'utf8'), /Restart=on-failure/)
  assert.match(installed.stderr, /user service active/)
  if (process.env.WEMUX_REAL_PACKAGE_PI_E2E === '1') {
    const modelId = process.env.WEMUX_REAL_PI_MODEL
    assert.ok(modelId && modelId.includes('::'), 'WEMUX_REAL_PI_MODEL must be an authorized provider::model')
    assert.ok(process.env.WEMUX_REAL_PI_AGENT_DIR, 'WEMUX_REAL_PI_AGENT_DIR must point to an existing Pi credential directory')
    const repository = join(directory, 'repository')
    const runGit = async (args: string[]) => {
      const result = await new Promise<{ code: number | null; stderr: string }>((resolveGit, reject) => {
        const child = spawn('git', args, { stdio: ['ignore', 'ignore', 'pipe'] })
        let stderr = ''
        child.stderr.setEncoding('utf8').on('data', (text: string) => { stderr += text })
        child.on('error', reject).on('close', code => resolveGit({ code, stderr }))
      })
      assert.equal(result.code, 0, result.stderr)
    }
    await runGit(['init', '--initial-branch=main', repository])
    await runGit(['-C', repository, '-c', 'user.name=E2E', '-c', 'user.email=e2e@example.com', 'commit', '--allow-empty', '-m', 'initial'])
    const project = await administrator.api<{ id: string }>('/projects', 'POST', { name: 'Packaged Pi E2E' })
    const provision = await administrator.api<{ workspace: { id: string } }>('/workspaces', 'POST', {
      projectId: project.id, workerId, name: 'Packaged Pi Workspace', repository: { gitUrl: repository, revision: 'main' },
    })
    await eventually(async () => (await administrator.api<{ status: string }>(`/workspaces/${provision.workspace.id}`)).status === 'ready')
    await eventually(async () => {
      const page = await administrator.api<{ capabilities: { agentKey: string; availability: { status: string }; models: { modelId: string }[] }[] }>(`/workers/${workerId}/capabilities`)
      return page.capabilities.some(item => item.agentKey === 'pi' && item.availability.status === 'available' && item.models.some(model => model.modelId === modelId))
    })
    const created = await administrator.api<{ session: { id: string }; commandId: string }>('/sessions', 'POST', {
      workspaceId: provision.workspace.id, title: 'Packaged Pi with Skill', agentKey: 'pi', modelId, requestId: 'packaged-pi-create-session',
    })
    await eventually(async () => (await administrator.api<{ status: string }>(`/commands/${created.commandId}`)).status === 'accepted')
    const sent = await administrator.api<{ commandId: string }>(`/sessions/${created.session.id}/messages`, 'POST', {
      content: 'Find the calibration marker in the managed-package-skill. Read the Skill file if needed, then answer only the marker. Do not use other tools.',
    })
    await eventually(async () => (await administrator.api<{ status: string }>(`/commands/${sent.commandId}`)).status === 'accepted')
    let observed = ''
    let readInstalledSkill = false
    await eventually(async () => {
      const page = await administrator.api<{ events: { payload: { kind: string; text?: string; outcome?: string; toolName?: string; input?: { path?: string } } }[] }>(`/sessions/${created.session.id}/events?fromSeq=1&limit=1000`)
      if (!page.events.some(event => event.payload.kind === 'turn.finished')) return false
      observed = page.events.filter(event => event.payload.kind === 'assistant.text.delta').map(event => event.payload.text ?? '').join('')
      readInstalledSkill = page.events.some(event => event.payload.kind === 'tool.started' && event.payload.toolName === 'read' && event.payload.input?.path?.endsWith('/skills/managed-package-skill/SKILL.md'))
      assert.ok(page.events.some(event => event.payload.kind === 'turn.finished' && event.payload.outcome === 'completed'), 'Pi Turn did not complete')
      return true
    }, 120_000)
    assert.ok(readInstalledSkill, 'Pi must read the fixed Skill revision in its launch directory')
    assert.match(observed, /WEMUX_SKILL_INJECTED_73/, 'Pi response must demonstrate the fixed installed Skill was injected')
  }
  const logs = await readFile(serviceLog, 'utf8')
  assert.doesNotMatch(logs, /(?:^|\n)(?:Error:|\[error\]|\[fatal\])/i)
})
