import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AgentKey } from '@wemux/domain'
import type { AgentAdapter, LocalAgentDetection } from '../application/ports/agent-adapter.js'
import { TestAgent } from './test-agent.js'
import { PiAgent } from './pi-agent.js'
import { ClaudeAgent } from './claude-agent.js'
import { OpenCodeAgent } from './opencode-agent.js'
import { agentCommand, readAgentSettings, type AgentSettings } from '../config/agent-settings.js'

const exec = promisify(execFile)
class DetectedAgent implements Extract<AgentAdapter, { mode: 'detect-only' }> {
  readonly mode = 'detect-only' as const
  readonly agentKey: AgentKey
  constructor(key: string, private readonly executable: string) { this.agentKey = key as AgentKey }
  async detect(): Promise<LocalAgentDetection> {
    let executablePath: string | null = null
    if (isAbsolute(this.executable)) {
      try { await access(this.executable, constants.X_OK); executablePath = this.executable } catch { /* unavailable selected executable */ }
    }
    for (const directory of (isAbsolute(this.executable) ? [] : (process.env.PATH ?? '').split(delimiter).filter(Boolean))) {
      for (const suffix of process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']) {
        const candidate = join(directory, this.executable + suffix)
        try { await access(candidate, constants.X_OK); executablePath = candidate; break } catch { /* next PATH entry */ }
      }
      if (executablePath) break
    }
    let version: string | null = null
    const diagnostics = ['Detection only; authentication and available models are not verified.']
    if (executablePath) {
      try { version = (await exec(executablePath, ['--version'], { timeout: 3000, maxBuffer: 65536 })).stdout.trim().slice(0, 256) }
      catch { diagnostics.push('Version probe failed.') }
    }
    return { agentKey: this.agentKey, displayName: this.executable, version, mode: this.mode, executablePath, diagnostics,
      availability: executablePath ? { status: 'available' } : { status: 'unavailable', reason: 'Executable not found in PATH' },
      authorization: { state: 'unknown', instructions: 'This Agent is detection-only; verify credentials in its local CLI.' }, models: [] }
  }
}
export function defaultAgents(settings: AgentSettings = {}): readonly AgentAdapter[] {
  return [new TestAgent(), new PiAgent(agentCommand('pi', settings)), new OpenCodeAgent(agentCommand('opencode', settings)), new ClaudeAgent(agentCommand('claude-code', settings)), new DetectedAgent('codex', agentCommand('codex', settings))]
}

export async function agentsForHome(home: string): Promise<readonly AgentAdapter[]> {
  return defaultAgents(await readAgentSettings(home))
}
