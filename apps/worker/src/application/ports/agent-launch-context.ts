import type { Turn } from '@wemux/domain'
import type { AgentLaunchContext } from './agent-adapter.js'

export interface PreparedAgentLaunchContext {
  readonly context: AgentLaunchContext | null
  cleanup(): Promise<void>
}

export interface AgentLaunchContextProvider {
  prepare(turn: Turn): Promise<PreparedAgentLaunchContext>
}
