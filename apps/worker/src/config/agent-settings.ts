import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const runtimeKeys = ['pi', 'claude-code', 'codex', 'opencode'] as const
export type RuntimeKey = typeof runtimeKeys[number]
export interface AgentSelection {
  executable: string
  source: 'local' | 'managed'
  package?: string
  selectedAt: string
}
export type AgentSettings = Partial<Record<RuntimeKey, AgentSelection>>

export function runtimeKey(value: string | undefined): RuntimeKey {
  const key = value === 'claude' ? 'claude-code' : value
  if (!runtimeKeys.includes(key as RuntimeKey)) throw new Error('Agent 可选 pi、claude（claude-code）、codex、opencode')
  return key as RuntimeKey
}

export async function readAgentSettings(home: string): Promise<AgentSettings> {
  let text: string
  try { text = await readFile(join(home, 'agents.json'), 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error }
  const settings = JSON.parse(text)
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid agents.json')
  for (const [key, value] of Object.entries(settings)) {
    const selection = value as AgentSelection | null
    if (!runtimeKeys.includes(key as RuntimeKey) || !selection || typeof selection.executable !== 'string' || !isAbsolute(selection.executable) || !['local', 'managed'].includes(selection.source) || typeof selection.selectedAt !== 'string' || (selection.package !== undefined && typeof selection.package !== 'string')) throw new Error('Invalid agents.json selection')
  }
  return settings
}

/** A short write lock and atomic rename preserve other selections and the previous file on failure. */
export async function saveAgentSelection(home: string, key: RuntimeKey, selection: AgentSelection): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 })
  const lockPath = join(home, 'agents.lock')
  const lock = await open(lockPath, 'wx', 0o600).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Agent 配置正在修改；请稍后重试（崩溃后请检查 agents.lock）')
    throw error
  })
  const temporary = join(home, `agents.${randomUUID()}.tmp`)
  try {
    const settings = await readAgentSettings(home)
    settings[key] = selection
    await writeFile(temporary, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    await rename(temporary, join(home, 'agents.json'))
  } finally {
    await lock.close()
    await rm(temporary, { force: true })
    await rm(lockPath, { force: true })
  }
}

export function agentCommand(key: RuntimeKey, settings: AgentSettings, env: NodeJS.ProcessEnv = process.env): string {
  return settings[key]?.executable ?? (key === 'pi' ? env.WEMUX_PI_COMMAND : key === 'claude-code' ? env.WEMUX_CLAUDE_COMMAND : undefined) ?? (key === 'claude-code' ? 'claude' : key)
}

export function agentSelections(settings: AgentSettings, env: NodeJS.ProcessEnv = process.env) {
  return runtimeKeys.map(key => ({ key, executable: agentCommand(key, settings, env), source: settings[key]?.source ?? ((key === 'pi' && env.WEMUX_PI_COMMAND != null) || (key === 'claude-code' && env.WEMUX_CLAUDE_COMMAND != null) ? 'environment' : 'PATH'), package: settings[key]?.package ?? null, selectedAt: settings[key]?.selectedAt ?? null }))
}
