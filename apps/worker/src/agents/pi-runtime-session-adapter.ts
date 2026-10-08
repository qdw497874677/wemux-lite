import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApprovalId } from '@wemux/domain'
import type { AgentRuntimeSession, RuntimeCommand, RuntimeOperationInput, RuntimeSessionAdapter, RuntimeSessionOpenInput } from '../application/ports/runtime-session.js'
import type { AgentSignal, AgentTurnHandle } from '../application/ports/agent-adapter.js'
import { preparePiProviderDirectory } from '../providers/pi-provider-directory.js'
import { parseJsonLines } from './json-lines.js'
import { mapRuntimeRecord } from './runtime-event-mapper.js'
import { splitModelId } from '../domain/model-id.js'
import { piCapabilityExtension } from '../capabilities/pi-tools.js'

/** Pi CLI expects `provider/model`, while the platform modelId convention is `provider::model`. */
function piModelArgument(modelId: string): string {
  const parsed = splitModelId(modelId as import('@wemux/domain').ModelId)
  return parsed ? `${parsed.provider}/${parsed.id}` : modelId
}

/** Bounded stderr tail kept for diagnostics when the child dies unexpectedly. */
const MAX_STDERR_BYTES = 8192

/**
 * Writes one JSON line to the child's stdin.
 *
 * The persistent `'error'` listener installed in {@link PiRuntimeSession.ensureChild}
 * prevents unhandled stream errors from crashing the Worker process. This function
 * only needs to surface the write-callback error (if any) to the caller so that the
 * awaiting operation rejects with a meaningful reason instead of hanging.
 */
async function writeLine(child: ReturnType<typeof spawn>, value: Record<string, unknown>) {
  const stdin = child.stdin
  if (!stdin || stdin.destroyed || !child.pid) throw new Error('Pi runtime input unavailable')
  return new Promise<void>((resolve, reject) => {
    stdin.write(`${JSON.stringify(value)}\n`, error => error ? reject(error) : resolve())
  })
}

export class PiRuntimeSessionAdapter implements RuntimeSessionAdapter {
  constructor(private readonly executable: string) {}
  async openSession(input: RuntimeSessionOpenInput): Promise<AgentRuntimeSession> { return new PiRuntimeSession(this.executable, input) }
}

class PiRuntimeSession implements AgentRuntimeSession {
  private child: ReturnType<typeof spawn> | null = null
  private activeOperation: RuntimeOperationInput['operationId'] | null = null
  /** Most recent failure reason captured from stdin/child error or exit events. */
  private childFailure: { code: string; message: string } | null = null
  /** Rolling tail of the child's stderr, capped at {@link MAX_STDERR_BYTES}. */
  private stderrTail = ''
  /** Set once the child process has exited; prevents reuse of a dead child. */
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null
  /** Resolves when the current child's stdio streams and process have fully closed. */
  private childClosed: Promise<void> = Promise.resolve()
  private launchKey: string | null = null
  private extensionDir: string | null = null
  private capabilityReadyPath: string | null = null
  private providerDirectory: { readonly directory: string; cleanup(): Promise<void> } | null = null

  constructor(private readonly executable: string, private readonly input: RuntimeSessionOpenInput) {}

  async execute(request: RuntimeOperationInput): Promise<AgentTurnHandle> {
    if (this.activeOperation) throw new Error('Pi runtime session is busy')
    const child = await this.ensureChild(request.launchContext)
    this.activeOperation = request.operationId
    await this.requireCapabilityToolsReady()
    await writeLine(child, { type: 'prompt', id: request.operationId, message: request.message.content })
    return { signals: this.signals(request.operationId, child), stop: async () => this.interrupt(request.operationId) }
  }

  async command(command: RuntimeCommand): Promise<void> {
    if (this.input.piProvider && command.name === 'set_model') throw new Error('pi_provider_model_locked')
    const child = await this.ensureChild(null)
    const type = command.name === 'interrupt' ? 'abort' : command.name
    if (command.name === 'set_model') {
      const selected = typeof command.arguments.modelId === 'string' ? splitModelId(command.arguments.modelId as import('@wemux/domain').ModelId) : null
      if (!selected) throw new Error('Pi set_model requires a provider-qualified modelId')
      await writeLine(child, { type, id: command.operationId, provider: selected.provider, modelId: selected.id })
      return
    }
    await writeLine(child, { type, id: command.operationId, ...command.arguments })
  }

  async resolveApproval(approvalId: ApprovalId, decision: 'approve' | 'deny'): Promise<void> {
    const child = await this.ensureChild(null)
    await writeLine(child, { type: 'approval_response', id: approvalId, approved: decision === 'approve' })
  }

  async close(): Promise<void> {
    const child = this.child
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      await this.childClosed
      await this.cleanupExtension()
      return
    }
    child.kill('SIGTERM')
    const forceTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGKILL') } catch { /* already exited */ }
      }
    }, 3000)
    forceTimer.unref()
    try { await this.childClosed }
    finally { clearTimeout(forceTimer); await this.cleanupExtension() }
  }

  /** 同步强杀：即使已经发送过 SIGTERM，也必须能升级为 SIGKILL。 */
  kill(): void {
    const child = this.child
    if (child && child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL') } catch { /* already exited */ }
    }
  }

  /**
   * Returns a live child process, spawning a fresh one when the previous child has
   * exited or was never started.
   *
   * A persistent `'error'` listener is attached to `child.stdin` for the child's
   * entire lifetime. Without it, an asynchronous EPIPE (child dies while a write is
   * buffered) becomes an unhandled `'error'` event and crashes the whole Worker
   * process — the root cause of sessions stuck in "正在处理" with 0/1 nodes online.
   */
  private async ensureChild(context: import('../application/ports/agent-adapter.js').AgentLaunchContext | null) {
    const nextLaunchKey = context ? JSON.stringify({
      assetsRoot: context.assetsRoot,
      capabilityEndpoint: context.capabilityEndpoint,
      capabilityToken: context.capabilityToken,
      instructions: context.instructions,
      skillsRoot: context.skillsRoot,
    }) : this.launchKey
    if (this.child && !this.child.killed && !this.exitInfo && nextLaunchKey === this.launchKey) return this.child
    if (this.child && !this.child.killed && !this.exitInfo) await this.close()
    else { await this.childClosed; await this.cleanupExtension() }

    // Reset per-child diagnostic state before spawning.
    this.childFailure = null
    this.stderrTail = ''
    this.exitInfo = null

    const provider = this.input.piProvider
    if (provider) {
      if (this.input.resume) throw new Error('pi_provider_resume_unsupported')
      if (this.input.modelId !== `openai-compatible::${provider.definition.modelIds[0]}`) throw new Error('pi_provider_model_mismatch')
      const names = Object.keys(provider.environment)
      if (names.length !== 1 || names[0] !== 'OPENAI_API_KEY' || !provider.environment.OPENAI_API_KEY?.trim()) throw new Error('pi_provider_credential_unavailable')
      if (context?.environment && Object.keys(context.environment).some(key => !key.startsWith('WEMUX_'))) throw new Error('pi_provider_environment_conflict')
    }
    const args = ['--mode', 'rpc']
    if (this.input.modelId) args.push('--model', piModelArgument(this.input.modelId))
    if (this.input.resume) args.push('--session', this.input.resume)
    if (context?.skillsRoot) args.push('--skill', context.skillsRoot)
    if (context?.instructions) args.push('--append-system-prompt', context.instructions)
    try {
      if (context?.capabilityEndpoint || context?.capabilityToken) {
        if (!context.capabilityEndpoint || !context.capabilityToken) throw new Error('Pi capability injection requires both endpoint and token')
        this.extensionDir = await mkdtemp(join(tmpdir(), 'wemux-pi-runtime-extension-'))
        this.capabilityReadyPath = join(this.extensionDir, 'ready')
        const extensionPath = join(this.extensionDir, 'capabilities.mjs')
        await writeFile(extensionPath, piCapabilityExtension(this.capabilityReadyPath), { mode: 0o600 })
        args.push('--extension', extensionPath)
      }
      if (provider) this.providerDirectory = await preparePiProviderDirectory(provider.definition)
    } catch (error) {
      await this.cleanupExtension()
      throw error
    }
    this.launchKey = nextLaunchKey
    // A configured Provider deliberately opts out of the user's Pi auth/settings
    // and every ambient model credential. Passing through process.env would
    // silently expose unrelated accounts to this Agent (and its shell tools).
    const environment: NodeJS.ProcessEnv = provider ? {
      PATH: process.env.PATH, LANG: process.env.LANG,
      // Operator-provided trust bundle for private HTTPS endpoints; do not
      // inherit the rest of the Worker's ambient model credentials.
      NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
      HOME: this.providerDirectory!.directory,
      PI_CODING_AGENT_DIR: this.providerDirectory!.directory,
      OPENAI_API_KEY: provider.environment.OPENAI_API_KEY,
    } : { ...process.env }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(this.executable, args, {
        cwd: this.input.cwd,
        env: { ...environment, ...context?.environment, WEMUX_PI_CAPABILITY_ENDPOINT: context?.capabilityEndpoint ?? '', WEMUX_PI_CAPABILITY_TOKEN: context?.capabilityToken ?? '' },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      if (!child.stdin || !child.stdout || !child.stderr) throw new Error('Pi runtime streams unavailable')
    } catch (error) {
      await this.cleanupExtension()
      throw error
    }

    // Persistent listeners — never removed while the child lives.
    child.stdin.on('error', error => {
      if (!this.childFailure) this.childFailure = { code: 'stdin-error', message: this.redactProviderSecret(error.message) }
    })
    child.on('error', error => {
      if (!this.childFailure) this.childFailure = { code: 'spawn-error', message: this.redactProviderSecret(error.message) }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-MAX_STDERR_BYTES)
    })
    // 'close' fires after all stdio streams end AND the process exits, guaranteeing
    // that childFailure/exitInfo are populated before any awaiting code proceeds.
    this.childClosed = new Promise<void>(resolve => {
      child.once('close', (code, signal) => {
        if (this.child === child) this.child = null
        this.exitInfo = { code, signal }
        if (!this.childFailure) {
          const detail = [
            code !== null ? `code ${code}` : null,
            signal ? `signal ${signal}` : null,
          ].filter(Boolean).join(', ')
          const stderr = this.stderrTail.trim()
          this.childFailure = {
            code: 'child-exited',
            message: this.redactProviderSecret(`Pi runtime exited unexpectedly${detail ? ` (${detail})` : ''}${stderr ? `: ${stderr}` : ''}`),
          }
        }
        resolve()
      })
    })

    this.child = child
    return child
  }

  private redactProviderSecret(message: string): string {
    const secret = this.input.piProvider?.environment.OPENAI_API_KEY
    return secret ? message.replaceAll(secret, '[redacted]') : message
  }

  private async requireCapabilityToolsReady(): Promise<void> {
    if (!this.capabilityReadyPath) return
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      try {
        const state = await readFile(this.capabilityReadyPath, 'utf8')
        if (state === 'ready') return
        if (state === 'inactive') break
      } catch { /* Pi 可能尚未触发 session_start。 */ }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error('Pi capability extension did not load or its tools are disabled; refusing to silently omit Wemux tools')
  }

  private async cleanupExtension(): Promise<void> {
    const directory = this.extensionDir
    this.extensionDir = null
    this.capabilityReadyPath = null
    this.launchKey = null
    if (directory) await rm(directory, { recursive: true, force: true })
    const provider = this.providerDirectory
    this.providerDirectory = null
    if (provider) await provider.cleanup()
  }

  private async interrupt(operationId: RuntimeOperationInput['operationId']) {
    if (this.activeOperation !== operationId) return
    if (!this.child || this.child.killed || this.exitInfo) return
    await writeLine(this.child, { type: 'abort', id: operationId })
  }

  private async *signals(operationId: RuntimeOperationInput['operationId'], child: ReturnType<typeof spawn>): AsyncIterable<AgentSignal> {
    if (!this.input.piProvider) { yield* this.rawSignals(operationId, child); return }
    // Provider-mode output cannot be published incrementally: a secret may be
    // split across multiple RPC deltas. Buffer one turn, then inspect *all*
    // string fields before allowing even a native Session reference to escape.
    const buffered: AgentSignal[] = []
    let bytes = 0
    for await (const signal of this.rawSignals(operationId, child)) {
      bytes += Buffer.byteLength(JSON.stringify(signal))
      if (bytes > 1024 * 1024) {
        this.kill()
        yield { kind: 'finished', outcome: { status: 'failed', failure: { code: 'agent-error', message: 'Provider 输出超过安全检查上限' } } }
        return
      }
      buffered.push(signal)
    }
    const secret = this.input.piProvider.environment.OPENAI_API_KEY
    const strings: string[] = []
    const collect = (value: unknown): void => {
      if (typeof value === 'string') strings.push(value)
      else if (Array.isArray(value)) value.forEach(collect)
      else if (value && typeof value === 'object') Object.values(value).forEach(collect)
    }
    collect(buffered)
    if (secret && strings.join('').includes(secret)) {
      yield { kind: 'finished', outcome: { status: 'failed', failure: { code: 'agent-error', message: 'Provider 输出包含本机凭据，已阻止发布 [redacted]' } } }
      return
    }
    for (const signal of buffered) yield signal
  }

  private async *rawSignals(operationId: RuntimeOperationInput['operationId'], child: ReturnType<typeof spawn>): AsyncIterable<AgentSignal> {
    if (!child.stdout) throw new Error('Pi runtime output unavailable')
    let emittedText = ''
    let sawToolActivity = false
    let usageRevision = 0
    let countedMessage = false
    let usageIncomplete = false
    const usageTotal: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; totalTokens?: number; costUsd?: number } = {}
    const usageCoverage = new Set<string>()
    const unusableUsageFields = new Set<string>()
    let pendingOutcome: Extract<AgentSignal, { kind: 'finished' }> | null = null
    const dedupeText = (signal: AgentSignal): AgentSignal | null => {
      if (signal.kind !== 'event' || signal.event.kind !== 'assistant.text.delta') return signal
      const text = signal.event.text
      // message_end carries the full message; earlier message_update deltas may
      // already have streamed it (or a cumulative prefix). Emit only the unseen suffix.
      const suffix = text.startsWith(emittedText) ? text.slice(emittedText.length) : null
      emittedText += suffix ?? ''
      return suffix ? { ...signal, event: { ...signal.event, text: suffix } } : null
    }
    try {
      for await (const record of parseJsonLines(child.stdout)) {
        if (typeof record.sessionId === 'string') yield { kind: 'native-session', nativeSession: record.sessionId as never }
        // Each assistant message streams its own cumulative text and message_end
        // may replay it in full. A new message_start opens a fresh dedupe
        // baseline; otherwise a multi-message turn would mis-diff the second
        // message against the first message's text and drop it entirely.
        if (record.type === 'message_start') {
          emittedText = ''
          countedMessage = false
          pendingOutcome = null
        }
        if (record.type === 'auto_retry_start') pendingOutcome = null
        const assistantEnd = record.type === 'message_end' && (record.message as { role?: string } | undefined)?.role === 'assistant'
        const mapped = mapRuntimeRecord('pi', operationId, record)
        if (assistantEnd && !countedMessage && !mapped.some(signal => signal.kind === 'event' && signal.event.kind === 'usage.updated')) {
          countedMessage = true
          usageIncomplete = true
          // An unmetered response makes the operation-wide reported total unknown;
          // a later response cannot restore its missing contribution.
          unusableUsageFields.add('totalTokens')
          usageCoverage.delete('totalTokens')
          delete usageTotal.totalTokens
          if (usageRevision > 0) {
            usageRevision++
            yield { kind: 'event', event: { kind: 'usage.updated', usage: {
              scope: 'operation', subjectId: operationId, source: 'runtime', revision: usageRevision,
              completeness: 'partial', ...usageTotal,
              ...(usageTotal.costUsd !== undefined ? { currency: 'USD' as const } : {}),
            } } }
          }
        }
        for (const signal of mapped) {
          // turn_end closes one assistant response (including a tool call), not
          // the prompt. agent_end can still be followed by recovery or follow-up.
          // Only agent_settled ends Pi's complete session-level run.
          if (record.type === 'turn_end' || record.type === 'agent_end') {
            if (signal.kind === 'finished' && signal.outcome.status !== 'completed') pendingOutcome = signal
            continue
          }
          const completed = record.type === 'agent_settled' && signal.kind === 'finished' ? pendingOutcome ?? signal : signal
          if (signal.kind === 'event' && signal.event.kind.startsWith('tool.')) sawToolActivity = true
          if (record.type === 'message_end' && completed.kind === 'event' && completed.event.kind === 'usage.updated') {
            if (countedMessage) continue
            countedMessage = true
            const response = completed.event.usage
            for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens', 'costUsd'] as const) {
              const current = response[key]
              if (current === undefined || unusableUsageFields.has(key)) {
                usageIncomplete = true
                if (key === 'totalTokens') { unusableUsageFields.add(key); usageCoverage.delete(key); delete usageTotal[key] }
                continue
              }
              const sum = (usageTotal[key] ?? 0) + current
              if (key === 'costUsd' ? !Number.isFinite(sum) || sum < 0 : !Number.isSafeInteger(sum) || sum < 0) {
                usageIncomplete = true
                unusableUsageFields.add(key)
                usageCoverage.delete(key)
                delete usageTotal[key]
                continue
              }
              if (!usageCoverage.has(key) && usageRevision > 0) usageIncomplete = true
              usageTotal[key] = sum
              usageCoverage.add(key)
            }
            usageRevision++
            yield { kind: 'event', event: { kind: 'usage.updated', usage: {
              scope: 'operation', subjectId: operationId, source: 'runtime', revision: usageRevision,
              completeness: usageIncomplete || usageTotal.inputTokens === undefined || usageTotal.outputTokens === undefined || usageTotal.totalTokens === undefined ? 'partial' : 'complete',
              ...usageTotal,
              ...(usageTotal.costUsd !== undefined ? { currency: 'USD' as const } : {}),
            } } }
            continue
          }
          const deduped = dedupeText(completed)
          if (!deduped) continue
          // Pi 在模型拒绝、额度用尽或凭据失效时会结束回合但不产生任何正文；把它当成完成会让界面
          // 空白（历史 P0：发送消息一直没有响应）。宁可显式失败，也不要假成功。
          if (deduped.kind === 'finished' && deduped.outcome.status === 'completed' && !sawToolActivity && !emittedText.trim()) {
            yield {
              kind: 'finished',
              outcome: {
                status: 'failed',
                failure: {
                  code: 'agent-error',
                  message: `Pi 结束回合但没有输出任何内容，模型可能拒绝请求、额度已用尽或凭据失效${this.childFailure ? `（${this.childFailure.message}）` : ''}`,
                },
              },
            }
            return
          }
          yield deduped
          if (deduped.kind === 'finished') return
        }
      }
      // stdout closed without a terminal record — wait for the child to fully close
      // so that childFailure captures the exit code and stderr tail, then surface it.
      await this.childClosed
      const failure = this.childFailure
      yield {
        kind: 'finished',
        outcome: {
          status: 'failed',
          failure: {
            code: 'agent-error',
            message: this.redactProviderSecret(failure?.message ?? 'Pi RPC stream closed before completion'),
          },
        },
      }
    } catch (error) {
      yield { kind: 'finished', outcome: { status: 'failed', failure: { code: 'agent-error', message: this.redactProviderSecret(error instanceof Error ? error.message : 'Pi runtime failed') } } }
    } finally { if (this.activeOperation === operationId) this.activeOperation = null }
  }
}
