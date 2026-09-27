import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import type { AgentKey, ModelId, NativeSessionRef, ToolCallId } from '@wemux/domain'
import type { AgentAdapter, AgentSignal, AgentTurnInput, LocalAgentDetection } from '../application/ports/agent-adapter.js'

const STDERR_LIMIT = 64 * 1024
const agentCommands = ['/compact', '/model', '/clear'] as const

export class ClaudeAgent implements Extract<AgentAdapter, { mode: 'execution' }> {
  readonly agentKey = 'claude-code' as AgentKey
  readonly mode = 'execution' as const
  constructor(private readonly command = process.env.WEMUX_CLAUDE_COMMAND ?? 'claude') {}

  async detect(): Promise<LocalAgentDetection> {
    try {
      const result = await runVersion(this.command)
      const authorization = await probeAuthorization(this.command)
      const authenticated = authorization.state !== 'unauthorized'
      return { agentKey: this.agentKey, displayName: 'Claude Code', version: result, mode: this.mode, executablePath: this.command,
        diagnostics: authorization.state === 'unknown' ? ['Claude authentication could not be verified non-interactively.'] : [],
        availability: authenticated ? { status: 'available' } : { status: 'authentication-required', reason: 'Claude Code is not authenticated' },
        authorization,
        runtime: { resume: true, tools: true, approvals: false, usage: false, cancel: true, structuredOutput: false, commands: [] }, modelSwap: false,
        agentCommands, compactMode: 'slash-command',
        models: authenticated ? ['sonnet', 'opus', 'haiku'].map(id => ({ modelId: id as ModelId, displayName: id, source: 'detected' as const })) : [] }
    } catch (cause) { const reason = cause instanceof Error ? cause.message : String(cause); return { agentKey: this.agentKey, displayName: 'Claude Code', version: null, mode: this.mode, executablePath: this.command, diagnostics: [reason], availability: { status: 'unavailable', reason }, authorization: { state: 'unknown', instructions: 'Install or repair the local Claude Code CLI before checking credentials.' }, runtime: { resume: true, tools: true, approvals: false, usage: false, cancel: true, structuredOutput: false, commands: [] }, modelSwap: false, agentCommands, compactMode: 'slash-command', models: [] } }
  }

  async startTurn(input: AgentTurnInput) {
    if (this.command.includes('/')) await access(this.command, constants.X_OK)
    const args = ['-p', '--output-format=stream-json', '--input-format=stream-json', '--verbose', '--include-partial-messages', '--replay-user-messages', '--permission-mode', process.env.WEMUX_CLAUDE_PERMISSION_MODE ?? 'bypassPermissions']
    if (input.modelId) args.push('--model', input.modelId)
    const capabilityInstructions = [input.launchContext?.instructions, input.launchContext?.skillsRoot ? `Wemux project skills are materialized under ${input.launchContext.skillsRoot}. Inspect the relevant SKILL.md files before applying a skill.` : null].filter(Boolean).join('\n\n')
    if (capabilityInstructions) args.push('--append-system-prompt', capabilityInstructions)
    if (input.launchContext?.capabilityEndpoint && input.launchContext.capabilityToken) {
      const mcpCommand = fileURLToPath(new URL('../capabilities/mcp-server.js', import.meta.url))
      args.push('--mcp-config', JSON.stringify({ mcpServers: { wemux: { command: process.execPath, args: [mcpCommand] } } }))
    }
    if (input.resume) args.push('--resume', input.resume)
    const child = spawn(this.command, args, { cwd: input.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...input.launchContext?.environment } })
    const queue = new SignalQueue()
    let stopped = false
    let stderr = Buffer.alloc(0)
    let native = input.resume
    let result: ClaudeResult | null = null
    const toolInputs = new Map<number, { id: ToolCallId; name: string; json: string }>()

    const settled = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>(resolve => {
      let done = false
      const finish = (value: { code: number | null; signal: NodeJS.Signals | null; error?: Error }) => { if (!done) { done = true; resolve(value) } }
      child.once('error', error => finish({ code: null, signal: null, error }))
      child.once('close', (code, signal) => finish({ code, signal }))
    })
    child.stdin.on('error', error => { if (!stopped) queue.fail(error) })
    child.stderr.on('data', chunk => { stderr = appendTail(stderr, Buffer.from(chunk), STDERR_LIMIT) })
    child.stdout.setEncoding('utf8')
    let pending = ''
    child.stdout.on('data', chunk => { pending += chunk; const lines = pending.split('\n'); pending = lines.pop()!; for (const line of lines) parseLine(line) })
    child.stdout.on('end', () => { if (pending.trim()) parseLine(pending) })

    const stop = async () => { if (!stopped) { stopped = true; child.kill('SIGTERM') }; await settled }
    child.stdin.end(JSON.stringify({ type: 'user', session_id: input.resume ?? '', message: { role: 'user', content: [{ type: 'text', text: input.message.content }] }, parent_tool_use_id: null }) + '\n')

    void settled.then(exit => {
      if (stopped) queue.end({ kind: 'finished', outcome: { status: 'cancelled' } })
      else if (exit.error) queue.end(failed('agent-unavailable', exit.error.message))
      else if (!result) queue.end(failed('agent-error', `Claude exited without a result (${describeExit(exit)}): ${stderr.toString('utf8')}`))
      else if (result.is_error || result.subtype?.includes('error')) queue.end(failed('agent-error', result.error ?? result.errors?.join('\n') ?? 'Claude reported an error'))
      else if (exit.code !== 0) queue.end(failed('agent-error', `Claude exited ${describeExit(exit)}: ${stderr.toString('utf8')}`))
      else queue.end({ kind: 'finished', outcome: { status: 'completed' } })
    })

    async function* signals(): AsyncGenerator<AgentSignal> { try { yield* queue } finally { if (!queue.isDone) await stop() } }
    return { signals: signals(), stop }

    function parseLine(line: string) {
      if (!line.trim()) return
      let message: any
      try { message = JSON.parse(line) } catch { return }
      if (message.session_id && message.session_id !== native) { native = message.session_id; queue.push({ kind: 'native-session', nativeSession: native as NativeSessionRef }) }
      if (message.type === 'result') { result = message as ClaudeResult; return }
      const event = message.type === 'stream_event' ? message.event : null
      if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') queue.push({ kind: 'event', event: { kind: 'assistant.text.delta', text: event.delta.text, streamKind: 'assistant_text' } })
      else if (event?.type === 'content_block_start' && event.content_block?.type === 'tool_use') toolInputs.set(event.index, { id: event.content_block.id as ToolCallId, name: event.content_block.name, json: JSON.stringify(event.content_block.input ?? {}).replace(/^\{\}$/, '') })
      else if (event?.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') { const tool = toolInputs.get(event.index); if (tool) tool.json += event.delta.partial_json ?? '' }
      else if (event?.type === 'content_block_stop') { const tool = toolInputs.get(event.index); if (tool) { queue.push({ kind: 'event', event: { kind: 'tool.started', toolCallId: tool.id, toolName: tool.name, input: parseJson(tool.json), streamKind: 'command_output' } }); toolInputs.delete(event.index) } }
      if (message.type === 'user') for (const block of message.message?.content ?? []) if (block.type === 'tool_result') { const id = block.tool_use_id as ToolCallId; queue.push({ kind: 'event', event: { kind: 'tool.output.delta', toolCallId: id, text: contentText(block.content), streamKind: 'command_output' } }); queue.push({ kind: 'event', event: { kind: 'tool.finished', toolCallId: id, exitCode: block.is_error ? 1 : 0 } }) }
    }
  }
}

interface ClaudeResult { is_error?: boolean; subtype?: string; error?: string; errors?: string[] }
class SignalQueue implements AsyncIterable<AgentSignal> {
  private values: AgentSignal[] = []; private waiters: Array<(result: IteratorResult<AgentSignal>) => void> = []; private done = false
  get isDone() { return this.done }
  push(value: AgentSignal) { if (this.done) return; const waiter = this.waiters.shift(); if (waiter) waiter({ value, done: false }); else this.values.push(value) }
  fail(error: Error) { this.end(failed('internal-error', error.message)) }
  end(final?: AgentSignal) { if (this.done) return; if (final) this.push(final); this.done = true; while (this.waiters.length) { const waiter = this.waiters.shift()!; if (this.values.length) waiter({ value: this.values.shift()!, done: false }); else waiter({ value: undefined, done: true }) } }
  [Symbol.asyncIterator](): AsyncIterator<AgentSignal> { return { next: () => this.values.length ? Promise.resolve({ value: this.values.shift()!, done: false }) : this.done ? Promise.resolve({ value: undefined, done: true }) : new Promise(resolve => this.waiters.push(resolve)) } }
}
function failed(code: 'agent-error' | 'agent-unavailable' | 'internal-error' | 'interrupted', message: string): AgentSignal { return { kind: 'finished', outcome: { status: 'failed', failure: { code, message } } } }
function appendTail(current: Buffer, chunk: Buffer, limit: number) { const joined = Buffer.concat([current, chunk]); return joined.length <= limit ? joined : joined.subarray(joined.length - limit) }
function describeExit(exit: { code: number | null; signal: NodeJS.Signals | null }) { return exit.signal ? `by ${exit.signal}` : `with code ${exit.code}` }
function parseJson(value: string) { try { return value ? JSON.parse(value) : {} } catch { return { raw: value } } }
function contentText(content: unknown) { if (typeof content === 'string') return content; if (Array.isArray(content)) return content.map(item => typeof item === 'string' ? item : (item as any)?.text ?? JSON.stringify(item)).join('\n'); return JSON.stringify(content ?? '') }
async function probeAuthorization(command: string): Promise<import('@wemux/domain').RuntimeAuthorization> {
  try {
    const output = await runProbe(command, ['auth', 'status', '--json'], 750)
    const value = JSON.parse(output) as Record<string, unknown>
    const loggedIn = value.loggedIn ?? value.authenticated ?? value.isAuthenticated
    const accountLabel = [value.email, value.organizationName, value.subscriptionType].find(item => typeof item === 'string') as string | undefined
    if (loggedIn === true) return { state: 'authorized', ...(accountLabel ? { accountLabel } : {}) }
    if (loggedIn === false) return { state: 'unauthorized', instructions: 'Run `claude auth login` on the Worker host, then refresh Agent detection.' }
  } catch { /* older CLIs may not support a non-interactive auth probe */ }
  return { state: 'unknown', instructions: 'Run `claude auth status` on the Worker host to verify credentials.' }
}
async function runProbe(command: string, args: readonly string[], timeoutMs = 3000) { return new Promise<string>((resolve, reject) => {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = ''; let stderr = ''; let settled = false
  const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error(`${command} probe timed out`)) }, timeoutMs)
  const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(stdout.trim() || 'unknown') }
  child.stdout.setEncoding('utf8').on('data', chunk => stdout += chunk); child.stderr.setEncoding('utf8').on('data', chunk => stderr += chunk)
  child.once('error', finish); child.once('close', code => code === 0 ? finish() : finish(new Error(stderr.trim() || `${command} exited ${code}`)))
}) }
async function runVersion(command: string) { return runProbe(command, ['--version']) }
