import type { AgentKey, ModelId } from '@wemux/domain'
import type { AgentAdapter } from '../application/ports/agent-adapter.js'

/** No subprocess, credentials or model service; repeatable E2E fixture. */
export class TestAgent implements Extract<AgentAdapter, { mode: 'execution' }> {
  readonly agentKey = 'test' as AgentKey
  readonly mode = 'execution' as const
  async detect() {
    return { agentKey: this.agentKey, displayName: 'Deterministic Test Agent', version: '1', mode: this.mode,
      availability: { status: 'available' as const }, runtime: { resume: false, tools: true, approvals: true, usage: true, cancel: true, structuredOutput: false, commands: ['compact'] }, agentCommands: [], models: [{ modelId: 'test' as ModelId, displayName: 'Test', source: 'configured' as const }],
      executablePath: null, diagnostics: [] }
  }
}
