import { mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import type { AgentKey, CapabilityAsset, ProjectId, Turn } from '@wemux/domain'
import type { AgentLaunchContextProvider, PreparedAgentLaunchContext } from './ports/agent-launch-context.js'

export class FilesystemAgentLaunchContextProvider implements AgentLaunchContextProvider {
  private readonly active = new Set<string>()
  private readonly workerDataDir: string
  private readonly capabilityEndpoint: string | null
  private readonly prepareConnectors?: (turn: Turn) => Promise<{ readonly token: string; readonly snapshot: import('@wemux/domain').CapabilitySnapshot; release(): Promise<void> }>
  private readonly resolveSkills?: (projectId: ProjectId, agentKey: AgentKey) => Promise<readonly { resourceId: string; revisionId: string; content: Uint8Array }[]>
  private readonly sessionScope?: (turn: Turn) => Promise<{ projectId: ProjectId; workspaceId: string; rootPath: string; agentKey: AgentKey } | null>
  constructor(
    workerDataDir: string,
    capabilityEndpoint: string | null,
    prepareConnectors?: (turn: Turn) => Promise<{ readonly token: string; readonly snapshot: import('@wemux/domain').CapabilitySnapshot; release(): Promise<void> }>,
    resolveSkills?: (projectId: ProjectId, agentKey: AgentKey) => Promise<readonly { resourceId: string; revisionId: string; content: Uint8Array }[]>,
    sessionScope?: (turn: Turn) => Promise<{ projectId: ProjectId; workspaceId: string; rootPath: string; agentKey: AgentKey } | null>,
  ) {
    this.workerDataDir = workerDataDir
    this.capabilityEndpoint = capabilityEndpoint
    this.prepareConnectors = prepareConnectors
    this.resolveSkills = resolveSkills
    this.sessionScope = sessionScope
  }

  async prepare(turn: Turn): Promise<PreparedAgentLaunchContext> {
    if (this.active.has(turn.sessionId)) throw new Error(`Capability context is already active for session ${turn.sessionId}`)
    const connectorContext = this.prepareConnectors ? await this.prepareConnectors(turn) : null
    const snapshot = connectorContext?.snapshot ?? turn.capabilitySnapshot
    if (!snapshot) { await connectorContext?.release(); return empty() }
    const root = join(this.workerDataDir, 'runtime', snapshot.sessionId, turn.id)
    this.active.add(turn.sessionId)
    const skillsRoot = join(root, 'skills')
    const promptParts: string[] = []
    let hasSkills = false
    let touchedRoot = false
    try {
      // Validate trusted placement before touching even the temporary runtime directory.
      const scope = this.sessionScope ? await this.sessionScope(turn) : null
      if (this.sessionScope && !scope) throw new Error('agent_launch_binding_unavailable')
      if (scope && (snapshot.projectId !== scope.projectId || snapshot.workspaceId !== scope.workspaceId || snapshot.sessionId !== turn.sessionId)) throw new Error('agent_launch_binding_mismatch')
      if (!this.sessionScope && snapshot.projectId.startsWith('team:')) throw new Error('agent_launch_binding_unavailable')
      const restrictedEnvironment = Boolean(scope?.projectId.startsWith('team:'))
      if (restrictedEnvironment && (!scope?.workspaceId || !scope.rootPath)) throw new Error('agent_launch_placement_unavailable')
      const expected = restrictedEnvironment ? resolve(this.workerDataDir, 'workspaces', createHash('sha256').update(scope!.workspaceId).digest('hex')) : null
      if (restrictedEnvironment && (resolve(scope!.rootPath) !== expected || await realpath(expected!).catch(() => null) !== expected)) throw new Error('agent_launch_placement_mismatch')
      touchedRoot = true
      await rm(root, { recursive: true, force: true })
      await mkdir(root, { recursive: true, mode: 0o700 })
      for (const asset of snapshot.assets) {
        verify(asset)
        if (asset.kind === 'skill') {
          const target = safePath(skillsRoot, asset.targetPath ?? `${asset.name}/SKILL.md`)
          await mkdir(dirname(target), { recursive: true })
          await writeFile(target, asset.content, 'utf8')
          hasSkills = true
        } else if (asset.kind === 'prompt' || asset.kind === 'instruction') {
          promptParts.push(asset.content)
        } else {
          const target = safePath(root, asset.targetPath ?? `files/${asset.name}`)
          await mkdir(dirname(target), { recursive: true })
          await writeFile(target, asset.content, 'utf8')
        }
      }
      if (scope && this.resolveSkills) {
        for (const skill of await this.resolveSkills(scope.projectId, scope.agentKey)) {
          const target = safePath(skillsRoot, `${skill.resourceId}/SKILL.md`)
          await mkdir(dirname(target), { recursive: true })
          await writeFile(target, skill.content, { flag: 'wx' })
          hasSkills = true
        }
      }
      if (snapshot.collaboration) promptParts.push(snapshot.collaboration.instructions)
      const instructions = promptParts.length ? promptParts.join('\n\n') : null
      if (instructions) await writeFile(join(root, 'instructions.md'), instructions, 'utf8')
      await writeFile(join(root, 'execution-spec.json'), JSON.stringify({ snapshot, turnId: turn.id }, null, 2), 'utf8')
      const sessionHome = restrictedEnvironment ? join(expected!, '.wemux-agent', createHash('sha256').update(turn.sessionId).digest('hex')) : null
      if (sessionHome) await mkdir(sessionHome, { recursive: true, mode: 0o700 })
      const environment: Record<string, string> = {
        WEMUX_SESSION_ID: turn.sessionId,
        WEMUX_TURN_ID: turn.id,
        WEMUX_ASSETS_ROOT: root,
      }
      if (sessionHome) {
        environment.HOME = sessionHome
        environment.XDG_CONFIG_HOME = join(sessionHome, '.config')
        environment.XDG_DATA_HOME = join(sessionHome, '.local', 'share')
        environment.XDG_CACHE_HOME = join(sessionHome, '.cache')
        environment.PI_CODING_AGENT_DIR = join(sessionHome, '.pi', 'agent')
        environment.CLAUDE_CONFIG_DIR = join(sessionHome, '.claude')
      }
      const capabilityToken = connectorContext?.token ?? turn.capabilityToken
      if (this.capabilityEndpoint && capabilityToken) {
        environment.WEMUX_CAPABILITY_ENDPOINT = this.capabilityEndpoint
        environment.WEMUX_CAPABILITY_TOKEN = capabilityToken
      }
      return {
        context: {
          assetsRoot: root,
          restrictedEnvironment,
          instructions,
          skillsRoot: hasSkills ? skillsRoot : null,
          capabilityEndpoint: this.capabilityEndpoint,
          capabilityToken,
          capabilitySnapshot: snapshot,
          environment,
        },
        cleanup: async () => {
          this.active.delete(turn.sessionId)
          await connectorContext?.release()
          await rm(root, { recursive: true, force: true })
        },
      }
    } catch (error) {
      this.active.delete(turn.sessionId)
      await connectorContext?.release().catch(() => undefined)
      if (touchedRoot) await rm(root, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }
}

function empty(): PreparedAgentLaunchContext {
  return { context: null, cleanup: async () => undefined }
}

function verify(asset: CapabilityAsset) {
  const actual = createHash('sha256').update(asset.content).digest('hex')
  if (actual !== asset.checksum) throw new Error(`Capability asset checksum mismatch: ${asset.name}`)
}

function safePath(root: string, path: string) {
  if (isAbsolute(path) || path.includes('\0')) throw new Error(`Unsafe capability asset path: ${path}`)
  const target = resolve(root, normalize(path))
  const rel = relative(resolve(root), target)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Unsafe capability asset path: ${path}`)
  return target
}
