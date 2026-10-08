import type { WorkerDTO } from '@wemux/web-contract/browser-host'
import type { ConversationSession } from '@wemux/web-contract'

/** Discovery is advisory. Submission still uses current Session authority and
 * Server/Worker validation; a retry must not substitute the current catalogue. */
export function conversationModelOptions(teamId: string, session: ConversationSession, workers: readonly WorkerDTO[]) {
  const worker = workers.find(item => item.id === session.binding.agent.workerId && item.teamId === teamId)
  const agent = worker?.capabilities.find(item => item.agentKey === session.binding.agent.agentKey)
  if (!worker || worker.connectionState !== 'online' || !agent?.modelSwap || agent.mode !== 'execution' || agent.availability.status !== 'available') return []
  const customPi = agent.agentKey === 'pi'
  if (customPi && session.binding.modelId?.startsWith('openai-compatible::')) return []
  return agent.models.filter(model => !!model.modelId.trim() && model.modelId.length <= 200 && !model.modelId.includes('\0') && !(customPi && model.modelId.startsWith('openai-compatible::')))
}
