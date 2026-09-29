import { access, realpath, rm, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ResourceBindingSnapshot, WorkerId } from '@wemux/domain'
import type { AgentAdapter } from '../application/ports/agent-adapter.ts'
import { installCatalog, matchesRuntimeVersion, runRuntimeProcess, stageAgentRuntime, type RuntimeProcess } from '../runtimes/management.ts'
import { readAgentSettings, removeAgentSelection, saveAgentSelection } from '../config/agent-settings.ts'
import { ResourceStateStore, type InstalledResourceState } from './resource-state-store.ts'

/** Called only on a fresh Worker start, before constructing Agent adapters or accepting Turns. */
export async function activateStagedRuntimes(home: string, workerId: WorkerId | undefined, run: RuntimeProcess = runRuntimeProcess): Promise<void> {
  if (!workerId) return
  if (!await access(join(home, 'resources.sqlite')).then(() => true, () => false)) return
  const state = new ResourceStateStore(join(home, 'resources.sqlite'))
  try {
    const desired = state.desired()
    if (!desired || desired.workerId !== workerId) return
    const materializer = new RuntimeMaterializer(home, state, () => new Date().toISOString(), run)
    for (const binding of desired.bindings.filter(binding => binding.kind === 'agent-runtime')) {
      const installed = state.installed(binding.resourceId)
      if (!installed?.executable || !installed.runtimeKey || installed.activation === 'failed' || !await materializer.verify(binding)) continue
      const selected = (await readAgentSettings(home))[installed.runtimeKey]
      if (selected?.executable === installed.executable || installed.activation === 'ready' || installed.activation === 'credential-required') continue
      // Preserve the previous selection for a later health-check rollback.
      state.saveInstalled({ ...installed, previousExecutable: selected?.executable ?? null, previousSelection: selected ?? null, activation: undefined })
      await saveAgentSelection(home, installed.runtimeKey, { executable: installed.executable, source: 'managed', package: `${binding.artifact!.packageName}@${binding.artifact!.packageVersion}`, selectedAt: new Date().toISOString() })
    }
  } finally { state.close() }
}

/** Probe after Worker adapters are constructed; roll back a failed activation before opening transport. */
export async function checkActivatedRuntimes(home: string, workerId: WorkerId | undefined, agents: readonly AgentAdapter[]): Promise<boolean> {
  if (!workerId || !await access(join(home, 'resources.sqlite')).then(() => true, () => false)) return false
  const state = new ResourceStateStore(join(home, 'resources.sqlite'))
  let rolledBack = false
  try {
    const desired = state.desired()
    if (!desired || desired.workerId !== workerId) return false
    for (const binding of desired.bindings.filter(binding => binding.kind === 'agent-runtime')) {
      const installed = state.installed(binding.resourceId)
      if (!installed?.runtimeKey || !installed.executable || installed.resourceRevisionId !== binding.resourceRevisionId) continue
      const selected = (await readAgentSettings(home))[installed.runtimeKey]
      if (selected?.executable !== installed.executable || installed.activation === 'failed') continue
      const agent = agents.find(item => item.agentKey === installed.runtimeKey)
      const detection = await agent?.detect().catch(() => null)
      if (detection?.executablePath === installed.executable && detection.availability.status !== 'unavailable' && matchesRuntimeVersion(detection.version ?? '', binding.artifact?.packageVersion ?? '')) {
        state.saveInstalled({ ...installed, activation: detection.availability.status === 'available' ? 'ready' : 'credential-required' })
        continue
      }
      // A failed probe must not make the new executable available to the runtime.
      if (installed.previousSelection) await saveAgentSelection(home, installed.runtimeKey, installed.previousSelection)
      else if (installed.previousExecutable) await saveAgentSelection(home, installed.runtimeKey, { executable: installed.previousExecutable, source: 'local', selectedAt: new Date().toISOString() })
      else await removeAgentSelection(home, installed.runtimeKey)
      state.saveInstalled({ ...installed, activation: 'failed' })
      rolledBack = true
    }
    return rolledBack
  } finally { state.close() }
}

export class RuntimeMaterializer {
  constructor(private readonly home: string, private readonly state: ResourceStateStore, private readonly now: () => string, private readonly run: RuntimeProcess = runRuntimeProcess, private readonly stage: typeof stageAgentRuntime = stageAgentRuntime) {}

  private approved(binding: ResourceBindingSnapshot) {
    const artifact = binding.artifact
    if (binding.kind !== 'agent-runtime' || !artifact || binding.agentKey === null || binding.projectId !== null || binding.files.length !== 0) throw new Error('invalid_runtime_binding')
    const entry = (Object.entries(installCatalog) as [keyof typeof installCatalog, (typeof installCatalog)[keyof typeof installCatalog]][]).find(([, spec]) => spec.name === artifact.packageName)
    if (!entry || binding.agentKey !== entry[0] || artifact.packageVersion !== entry[1].version || artifact.registryOrigin !== 'https://registry.npmjs.org' || artifact.packageIntegrity !== entry[1].integrity) throw new Error('unapproved_runtime_artifact')
    return { key: entry[0], artifact }
  }

  async verify(binding: ResourceBindingSnapshot): Promise<boolean> {
    const { key } = this.approved(binding)
    const installed = this.state.installed(binding.resourceId)
    if (!installed || installed.kind !== 'agent-runtime' || installed.runtimeKey !== key || installed.resourceRevisionId !== binding.resourceRevisionId || installed.integrity !== binding.contentSha256 || !installed.executable) return false
    const root = resolve(this.home, 'agents', key)
    const path = await realpath(installed.executable).catch(() => null)
    if (!path || !isAbsolute(installed.executable) || !relative(root, path) || relative(root, path).startsWith(`..${sep}`) || relative(root, path) === '..') return false
    try {
      if (!(await stat(path)).isFile()) return false
      await access(path, constants.X_OK)
      const version = await this.run({ command: path, args: ['--version'], timeout: 10_000 })
      return matchesRuntimeVersion(version, binding.artifact!.packageVersion)
    } catch { return false }
  }

  async materialize(binding: ResourceBindingSnapshot): Promise<InstalledResourceState> {
    const { key, artifact } = this.approved(binding)
    const staged = await this.stage(this.home, artifact, this.run)
    try {
      if (staged.key !== key || !matchesRuntimeVersion(staged.version, artifact.packageVersion)) throw new Error('runtime_version_probe_mismatch')
      const state: InstalledResourceState = {
        bindingId: binding.bindingId, resourceId: binding.resourceId, resourceRevisionId: binding.resourceRevisionId,
        kind: 'agent-runtime', runtimeKey: key, executable: staged.executable, integrity: binding.contentSha256,
        files: {}, path: staged.directory, installedAt: this.now(), lastUsedAt: this.now(),
      }
      this.state.saveInstalled(state)
      return state
    } catch (error) {
      await rm(staged.directory, { recursive: true, force: true })
      throw error
    }
  }
}
