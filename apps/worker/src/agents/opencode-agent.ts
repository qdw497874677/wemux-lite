import { spawn } from 'node:child_process'
import type { AgentKey, ModelId } from '@wemux/domain'
import type { AgentAdapter, LocalAgentDetection } from '../application/ports/agent-adapter.js'
import { modelId } from '../domain/model-id.js'

export class OpenCodeAgent implements Extract<AgentAdapter, { mode: 'execution' }> {
  readonly agentKey = 'opencode' as AgentKey
  readonly mode = 'execution' as const
  constructor(private readonly command = process.env.WEMUX_OPENCODE_COMMAND ?? 'opencode') {}

  async detect(): Promise<LocalAgentDetection> {
    let version: string | null = null
    try {
      version = await probe(this.command, ['--version'])
      const listed = await probe(this.command, ['models'], 10_000)
      const models = listed.split('\n').map(value => value.trim()).filter(value => /^[^/\s]+\/.+/.test(value)).map(value => {
        const slash = value.indexOf('/')
        return { modelId: modelId(value.slice(0, slash), value.slice(slash + 1)), displayName: value, source: 'configured' as const }
      })
      const authorization = await authorizationProbe(this.command)
      return {
        agentKey: this.agentKey,
        displayName: 'OpenCode',
        version,
        mode: this.mode,
        executablePath: this.command,
        diagnostics: models.length ? [] : ['OpenCode returned no available models.'],
        availability: models.length ? { status: 'available' } : { status: 'authentication-required', reason: 'No OpenCode model is available' },
        authorization,
        runtime: { resume: true, tools: true, approvals: false, usage: true, cancel: true, structuredOutput: false, commands: [] },
        models,
      }
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause)
      return { agentKey: this.agentKey, displayName: 'OpenCode', version, mode: this.mode, executablePath: this.command, diagnostics: [reason], availability: { status: 'unavailable', reason }, authorization: { state: 'unknown', instructions: 'Install or repair OpenCode, then run `opencode auth login` if the selected provider requires credentials.' }, runtime: { resume: true, tools: true, approvals: false, usage: true, cancel: true, structuredOutput: false, commands: [] }, models: [] }
    }
  }
}

async function authorizationProbe(command: string): Promise<import('@wemux/domain').RuntimeAuthorization> {
  try {
    const output = await probe(command, ['auth', 'list'], 5_000)
    const match = output.match(/(\d+)\s+credentials?/i)
    if (match && Number(match[1]) > 0) return { state: 'authorized', accountLabel: `${match[1]} configured credential${match[1] === '1' ? '' : 's'}` }
    // OpenCode can expose provider-hosted free models without local credentials.
    return { state: 'unknown', instructions: 'No local credential is configured. Provider-hosted public models may still work; use `opencode auth login` for authenticated providers.' }
  } catch {
    return { state: 'unknown', instructions: 'Run `opencode auth list` on the Worker host to verify provider credentials.' }
  }
}

function probe(command: string, args: readonly string[], timeoutMs = 3_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', settled = false
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error(`${command} probe timed out`)) }, timeoutMs)
    const finish = (error?: Error) => {
      if (settled) return
      settled = true; clearTimeout(timer)
      error ? reject(error) : resolve(stdout.trim())
    }
    child.stdout.setEncoding('utf8').on('data', chunk => stdout += chunk)
    child.stderr.setEncoding('utf8').on('data', chunk => stderr += chunk)
    child.once('error', finish)
    child.once('close', code => code === 0 ? finish() : finish(new Error(stderr.trim() || `${command} exited ${code}`)))
  })
}
