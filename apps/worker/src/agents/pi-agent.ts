import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentKey, NativeSessionRef, ToolCallId } from '@wemux/domain'
import type { AgentAdapter, AgentSignal, AgentTurnInput, AgentTurnOutcome, LocalAgentDetection } from '../application/ports/agent-adapter.js'
import { modelId, splitModelId } from '../domain/model-id.js'
import { piCapabilityExtension } from '../capabilities/pi-tools.js'
import { findPi, PiRpc } from './pi-rpc.js'

const exec = promisify(execFile)
const agentCommands = ['/compact', '/model'] as const
// 0.80.4 introduced settlement; 0.85.1 is our validated lifecycle/extension baseline.
async function supportedVersion(executable: string, timeout: number) {
  const version = (await exec(executable, ['--version'], { timeout, killSignal: 'SIGKILL', maxBuffer: 65536 })).stdout.trim().slice(0, 256)
  const match = /^(?:pi\s+)?v?(\d+)\.(\d+)\.(\d+)(?:\+[\w.-]+)?$/.exec(version)
  const supported = match && (Number(match[1]) > 0 || Number(match[2]) > 85 || (Number(match[2]) === 85 && Number(match[3]) >= 1))
  if (!supported) throw new Error(`Unsupported Pi CLI version ${JSON.stringify(version)}; upgrade to Pi >=0.85.1 (validated baseline; agent_settled requires >=0.80.4)`)
  return version
}
export class PiAgent implements Extract<AgentAdapter, { mode: 'execution' }> {
  readonly agentKey = 'pi' as AgentKey
  readonly mode = 'execution' as const
  constructor(private readonly command = 'pi', private readonly requestTimeout = 15_000, private readonly turnTimeout = 30 * 60_000) {}

  async detect(): Promise<LocalAgentDetection> {
    let executablePath: string | null = null
    let version: string | null = null
    let rpc: PiRpc | undefined
    try {
      executablePath = await findPi(this.command)
      version = await supportedVersion(executablePath, this.requestTimeout)
      rpc = new PiRpc(executablePath, ['--no-session'], process.cwd(), process.env, this.requestTimeout)
      const { models } = await rpc.request('get_available_models')
      if (!Array.isArray(models)) throw new Error('Pi RPC returned no model inventory')
      return { agentKey: this.agentKey, displayName: 'Pi', version, mode: this.mode, executablePath,
        diagnostics: models.length ? [] : ['Pi CLI has no authenticated model available.'],
        availability: models.length ? { status: 'available' } : { status: 'authentication-required', reason: 'No authenticated Pi model is available' },
        authorization: models.length
          ? { state: 'authorized', accountLabel: `${models.length} configured model${models.length === 1 ? '' : 's'}` }
          : { state: 'unauthorized', instructions: 'Authenticate a provider in the local Pi CLI, then restart or refresh the Worker.' },
        runtime: { resume: true, tools: true, approvals: true, usage: false, cancel: true, structuredOutput: false, commands: ['compact', 'set_model', 'set_thinking_level'] }, modelSwap: true,
        agentCommands, compactMode: 'slash-command',
        models: models.map(model => ({ modelId: modelId(model.provider, model.id), displayName: `${model.name ?? model.id} (${model.provider})`, source: 'configured' })) }
    } catch (cause) {
      const reason = errorText(cause)
      return { agentKey: this.agentKey, displayName: 'Pi', version, mode: this.mode, executablePath, diagnostics: [reason], availability: { status: 'unavailable', reason }, authorization: { state: 'unknown', instructions: 'Install or repair the local Pi CLI before checking credentials.' }, runtime: { resume: true, tools: true, approvals: true, usage: false, cancel: true, structuredOutput: false, commands: ['compact', 'set_model', 'set_thinking_level'] }, modelSwap: true, agentCommands, compactMode: 'slash-command', models: [] }
    } finally { await rpc?.close() }
  }

  async startTurn(input: AgentTurnInput) {
    // modelId is optional: when null, Pi uses its own default model.
    const selected = input.modelId ? splitModelId(input.modelId) : null
    if (input.modelId && !selected) throw new Error(`Pi model ${input.modelId} is ambiguous; refresh Agent capabilities and select provider-qualified model`)
    if (input.resume) await validateResume(input.resume)
    const executable = await findPi(this.command)
    await supportedVersion(executable, this.requestTimeout)
    const args: string[] = input.resume ? ['--session', input.resume] : []
    const context = input.launchContext
    if (context?.skillsRoot) args.push('--skill', context.skillsRoot)
    if (context?.instructions) args.push('--append-system-prompt', context.instructions)
    let extensionDir: string | undefined
    let rpc: PiRpc | undefined
    let startupError: Error | undefined
    try {
      if (Boolean(context?.capabilityEndpoint) !== Boolean(context?.capabilityToken)) throw new Error('Pi capability injection requires both endpoint and token')
      let readyPath: string | undefined
      if (context?.capabilityEndpoint && context.capabilityToken) {
        extensionDir = await mkdtemp(join(tmpdir(), 'wemux-pi-extension-'))
        readyPath = join(extensionDir, 'ready')
        const extensionPath = join(extensionDir, 'capabilities.mjs')
        await writeFile(extensionPath, piCapabilityExtension(readyPath), { mode: 0o600 })
        args.push('--extension', extensionPath)
      }
      rpc = new PiRpc(executable, args, input.cwd, { ...process.env, ...context?.environment,
        WEMUX_PI_CAPABILITY_ENDPOINT: context?.capabilityEndpoint ?? '', WEMUX_PI_CAPABILITY_TOKEN: context?.capabilityToken ?? '',
      }, this.requestTimeout)
      rpc.onFailure = error => { startupError = error }
      rpc.onEvent = event => { if (event.type === 'extension_error') startupError = new Error(`Pi extension failed: ${event.error ?? event.message}`) }
      const { models } = await rpc.request('get_available_models')
      // When modelId is null the Agent uses its own default; skip validation and set_model.
      if (selected) {
        if (!models?.some((model: any) => model.provider === selected.provider && model.id === selected.id)) throw new Error(`Pi model ${selected.provider}/${selected.id} is not configured or authenticated`)
        await rpc.request('set_model', { provider: selected.provider, modelId: selected.id })
      }
      const state = await rpc.request('get_state')
      if (startupError) throw startupError
      if (readyPath) {
        try { if (await readFile(readyPath, 'utf8') !== 'ready') throw new Error('inactive') } catch { throw new Error('Pi capability extension did not load or its tools are disabled; refusing to silently omit Wemux tools') }
      }
      if (!state?.sessionFile) throw new Error('Pi RPC did not provide a persistent native session')
      const connection = rpc
      const queue = new AsyncQueue<AgentSignal>()
      let sessionFile = state.sessionFile as NativeSessionRef
      const toolOutput = new Map<string, string>()
      const output = (id: string, result: unknown) => {
        const snapshot = resultText(result)
        const previous = toolOutput.get(id) ?? ''
        // Journal is append-only: replacement snapshots cannot retract prior text.
        const text = snapshot.startsWith(previous) ? snapshot.slice(previous.length) : `\n[Pi tool output replaced]\n${snapshot}`
        toolOutput.set(id, snapshot)
        if (text) queue.push({ kind: 'event', event: { kind: 'tool.output.delta', toolCallId: id as ToolCallId, text, streamKind: 'command_output' } })
      }
      let stopped = false
      let finished = false
      let assistant: { stopReason?: string; errorMessage?: string } | undefined
      let cleanup: Promise<void> | undefined
      const dispose = () => cleanup ??= (async () => { await connection.close(); if (extensionDir) await rm(extensionDir, { recursive: true, force: true }) })()
      const finish = (outcome: AgentTurnOutcome) => {
        if (finished) return
        finished = true; clearTimeout(timer); clearInterval(readinessTimer)
        void (async () => {
          await dispose()
          // Pi allocates the path eagerly but flushes lazily. Never publish a dangling reference.
          if (sessionFile !== input.resume) {
            try { await validateResume(sessionFile); queue.push({ kind: 'native-session', nativeSession: sessionFile }) } catch { /* a fresh turn remains possible */ }
          }
          queue.end({ kind: 'finished', outcome })
        })().catch(error => queue.end({ kind: 'finished', outcome: { status: 'failed', failure: { code: 'agent-error', message: errorText(error) } } }))
      }
      const fail = (cause: unknown) => finish(stopped ? { status: 'cancelled' } : { status: 'failed', failure: { code: 'agent-error', message: errorText(cause) } })
      const timer = setTimeout(() => fail(new Error(`Pi turn timed out after ${this.turnTimeout}ms`)), this.turnTimeout)
      const checkReadiness = async () => {
        if (readyPath && await readFile(readyPath, 'utf8') !== 'ready') throw new Error('Wemux capability tools became inactive; local tool restrictions were preserved')
      }
      let checking = false
      const readinessTimer = setInterval(() => {
        if (finished || checking || !readyPath) return
        checking = true
        void checkReadiness().catch(fail).finally(() => { checking = false })
      }, 100)
      connection.onFailure = fail
      connection.onEvent = event => {
        if (finished) return
        if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') queue.push({ kind: 'event', event: { kind: 'assistant.text.delta', text: event.assistantMessageEvent.delta, streamKind: 'assistant_text' } })
        else if (event.type === 'message_end' && event.message?.role === 'assistant') assistant = event.message
        else if (event.type === 'agent_end') assistant = [...(event.messages ?? [])].reverse().find(message => message.role === 'assistant') ?? assistant
        else if (event.type === 'tool_execution_start') queue.push({ kind: 'event', event: { kind: 'tool.started', toolCallId: event.toolCallId as ToolCallId, toolName: event.toolName, input: event.args, streamKind: 'command_output' } })
        else if (event.type === 'tool_execution_update') output(event.toolCallId, event.partialResult)
        else if (event.type === 'tool_execution_end') {
          output(event.toolCallId, event.result)
          toolOutput.delete(event.toolCallId)
          queue.push({ kind: 'event', event: { kind: 'tool.finished', toolCallId: event.toolCallId as ToolCallId, exitCode: event.isError ? 1 : 0 } })
        } else if (event.type === 'extension_error') fail(new Error(`Pi extension failed: ${event.error ?? event.message}`))
        else if (event.type === 'extension_ui_request' && ['select', 'confirm', 'input', 'editor'].includes(event.method)) fail(new Error(`Pi extension requires unsupported interactive UI: ${event.method}`))
        else if (event.type === 'agent_settled') {
          void (async () => {
            await checkReadiness()
            const latest = await connection.request('get_state')
            if (typeof latest?.sessionFile !== 'string') throw new Error('Pi RPC lost its native session path')
            sessionFile = latest.sessionFile as NativeSessionRef
            await checkReadiness()
            if (stopped) finish({ status: 'cancelled' })
            else if (assistant?.stopReason === 'error' || assistant?.stopReason === 'aborted') finish({ status: 'failed', failure: { code: assistant.stopReason === 'aborted' ? 'interrupted' : 'agent-error', message: assistant.errorMessage ?? `Pi ended with ${assistant.stopReason}` } })
            else finish({ status: 'completed' })
          })().catch(fail)
        }
      }
      const stop = async () => {
        if (finished) { await dispose(); return }
        stopped = true
        try { await connection.request('abort') } catch { /* teardown still required */ }
        finish({ status: 'cancelled' })
        await dispose()
      }
      void connection.request('prompt', { message: input.message.content }).catch(fail)
      async function* signals(): AsyncGenerator<AgentSignal> { try { yield* queue } finally { if (!finished) await stop(); await dispose() } }
      return { signals: signals(), stop }
    } catch (cause) {
      await rpc?.close()
      if (extensionDir) await rm(extensionDir, { recursive: true, force: true })
      throw cause
    }
  }
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = []; private waiters: Array<(result: IteratorResult<T>) => void> = []; private done = false
  push(value: T) { if (this.done) return; const waiter = this.waiters.shift(); if (waiter) waiter({ value, done: false }); else this.values.push(value) }
  end(final?: T) { if (this.done) return; if (final !== undefined) this.push(final); this.done = true; while (this.waiters.length) this.waiters.shift()!({ value: undefined, done: true }) }
  [Symbol.asyncIterator](): AsyncIterator<T> { return { next: () => { if (this.values.length) return Promise.resolve({ value: this.values.shift()!, done: false }); if (this.done) return Promise.resolve({ value: undefined, done: true }); return new Promise(resolve => this.waiters.push(resolve)) } } }
}
async function validateResume(path: NativeSessionRef) {
  if (!(await stat(path)).isFile()) throw new Error(`Pi native session is not a regular file: ${path}`)
  const entries = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const header = entries[0]
  if (header?.type !== 'session' || typeof header.id !== 'string' || !header.id || entries.some(entry => !entry || typeof entry.type !== 'string')) throw new Error(`Pi native session is invalid: ${path}`)
}
function errorText(cause: unknown) { return cause instanceof Error ? cause.message : String(cause) }
function resultText(result: any): string { if (typeof result === 'string') return result; if (Array.isArray(result?.content)) return result.content.map((item: any) => item?.text ?? JSON.stringify(item)).join('\n'); return JSON.stringify(result ?? '') }
