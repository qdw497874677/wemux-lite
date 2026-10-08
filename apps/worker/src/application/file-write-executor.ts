import type { WorkerId } from '@wemux/domain'
import { serializeFileWriteRetainedResult, type FileWriteAdmitPayload, type FileWriteResultPayload } from '@wemux/wire-protocol'
import { computeFileWriteResultDigest, parseFileWriteAdmit, parseFileWriteResult } from '@wemux/wire-protocol/file-admission-node'
import { writeWorkspaceFile } from '../files/workspace-files.js'
import type { LocalState } from './ports/local-state.js'
import type { WorkerStore } from './ports/worker-store.js'

export type FileWriteExecution =
  | { readonly status: 'result'; readonly result: FileWriteResultPayload }
  | { readonly status: 'await-existing' }
  | { readonly status: 'reject'; readonly reason: 'identity-conflict' }

function snapshot(input: unknown): FileWriteAdmitPayload {
  const value = parseFileWriteAdmit(structuredClone(input))
  Object.freeze(value.binding.agent)
  Object.freeze(value.binding)
  return Object.freeze(value)
}

/**
 * Application executor; optionally composed inside the Runtime command queue.
 * The ingress caller must authenticate the cluster connection and use the verified
 * durable-frame/negotiation boundary before calling execute. Hashes are not auth.
 * This queue serializes only this executor, not other Workspace writers. Runtime
 * awaits execute within its common command queue and drains it at shutdown.
 */
export class WorkerFileWriteExecutor {
  private tail: Promise<unknown> = Promise.resolve()
  private closing = false

  constructor(
    private readonly store: WorkerStore & Pick<LocalState, 'identity' | 'localInstallation'>,
    private readonly workerId: WorkerId,
    private readonly options: {
      /** Offline fault-injection seam; production default is the real awaited helper. */
      readonly write?: typeof writeWorkspaceFile
      /** Committed immutable results only. No default sender or ACK-on-send behavior. */
      readonly publish?: (result: FileWriteResultPayload) => Promise<void>
    } = {},
  ) {}

  async execute(input: unknown): Promise<FileWriteExecution> {
    // This must run synchronously, before even joining the execution queue.
    const admission = snapshot(input)
    if (this.closing) throw new Error('File executor is closing')
    const next = this.tail.then(async (): Promise<FileWriteExecution> => {
      if (this.closing) throw new Error('File executor is closing')
      const rootPath = await this.authorize(admission)
      // The callback decision is provisional; only the outer promise grants I/O.
      const decision = await this.store.transaction(tx => tx.fileWrites.reserve(admission))
      if (decision.status === 'reject') return decision
      if (decision.status === 'await-existing') return { status: 'await-existing' }
      if (decision.status !== 'execute') return this.publish(decision.result)

      let result: FileWriteResultPayload
      try {
        const written = await (this.options.write ?? writeWorkspaceFile)(rootPath, admission.subpath, admission.base64Content)
        result = this.result(admission, 'succeeded', serializeFileWriteRetainedResult('succeeded', {
          ok: true, operation: 'write', subpath: written.subpath, size: written.size,
        }))
      } catch {
        // Once entered, even a validation-looking error may follow mkdir/truncation.
        result = this.result(admission, 'unknown', serializeFileWriteRetainedResult('unknown', {
          ok: false, operation: 'write', effect: 'uncertain', error: 'File write outcome is uncertain',
        }))
      }
      // Settlement/publication errors must not become a second effect or rejection.
      await this.store.transaction(tx => tx.fileWrites.retainResult(result))
      const retained = await this.store.fileWrites.get(admission.requestId)
      if (!retained?.result) throw new Error('Committed file result missing')
      return this.publish(retained.result)
    })
    this.tail = next.catch(() => {})
    return next
  }

  /** Stop new/queued work, but drain the current reservation/effect/settlement. */
  async close(): Promise<void> {
    this.closing = true
    await this.tail
  }

  private async authorize(admission: FileWriteAdmitPayload): Promise<string> {
    const installation = this.store.localInstallation()
    const localWorkerId = installation ? `local-${installation.installationId}` : null
    const identity = this.store.identity()
    if (!identity || identity.workerId !== this.workerId ||
        admission.workerId !== this.workerId || this.workerId === localWorkerId) {
      throw new Error('File admission Worker mismatch')
    }
    const session = await this.store.sessions.get(admission.sessionId)
    const binding = session?.binding
    if (!session || session.sessionId !== admission.sessionId || !binding ||
        binding.workspaceId !== admission.binding.workspaceId ||
        binding.agent.workerId !== this.workerId || binding.agent.workerId === localWorkerId ||
        binding.agent.agentKey !== admission.binding.agent.agentKey || binding.modelId !== admission.binding.modelId) {
      throw new Error('File admission Session binding mismatch')
    }
    const workspace = await this.store.workspaces.get(binding.workspaceId)
    if (!workspace || workspace.id !== binding.workspaceId || workspace.workerId !== this.workerId ||
        workspace.workerId === localWorkerId || workspace.projectId === 'local' ||
        workspace.status !== 'ready' || !workspace.rootPath) {
      throw new Error('File admission Workspace is not eligible')
    }
    return workspace.rootPath
  }

  private result(admission: FileWriteAdmitPayload, outcome: FileWriteResultPayload['outcome'], resultJson: string): FileWriteResultPayload {
    const value: Omit<FileWriteResultPayload, 'resultDigest'> = {
      type: 'fs.write.result', requestId: admission.requestId, sessionId: admission.sessionId,
      workerId: admission.workerId, operation: admission.operation,
      fingerprintVersion: admission.fingerprintVersion, fingerprint: admission.fingerprint,
      resultVersion: 1, outcome, resultJson,
    }
    return parseFileWriteResult({ ...value, resultDigest: computeFileWriteResultDigest(value) }, admission)
  }

  private async publish(result: FileWriteResultPayload): Promise<FileWriteExecution> {
    await this.options.publish?.(result)
    return { status: 'result', result }
  }
}
