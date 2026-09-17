import type { AgentKey } from '@wemux/domain'
import type { AgentAdapter } from './ports/agent-adapter.js'
import type { RuntimeSessionAdapter } from './ports/runtime-session.js'
import { ClaudeRuntimeSessionAdapter } from '../agents/claude-runtime-session-adapter.js'
import { PiRuntimeSessionAdapter } from '../agents/pi-runtime-session-adapter.js'
import { TestRuntimeSessionAdapter } from '../agents/test-runtime-session-adapter.js'

export interface RuntimeAdapterExecutables {
  readonly pi?: string
  readonly claude?: string
}

/** Builds the closed set of provider runtime adapters enabled by detected Agents. */
export function runtimeAdaptersFor(agents: readonly AgentAdapter[], executables: RuntimeAdapterExecutables = {}): ReadonlyMap<AgentKey, RuntimeSessionAdapter> {
  const adapters = new Map<AgentKey, RuntimeSessionAdapter>()
  for (const agent of agents) {
    if (agent.mode !== 'execution') continue
    if (agent.agentKey === 'test') adapters.set(agent.agentKey, new TestRuntimeSessionAdapter())
    else if (agent.agentKey === 'pi') adapters.set(agent.agentKey, new PiRuntimeSessionAdapter(executables.pi ?? 'pi'))
    else if (agent.agentKey === 'claude-code') adapters.set(agent.agentKey, new ClaudeRuntimeSessionAdapter(executables.claude ?? 'claude'))
  }
  return adapters
}
