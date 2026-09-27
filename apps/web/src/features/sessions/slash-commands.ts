import type { AgentDTO } from '../../api/dto.ts'

export type SlashCommand = {
  name: string
  label: string
  description: string
  group: 'platform' | 'agent'
}

const platformCommands: readonly SlashCommand[] = [
  { name: '/compact', label: '压缩上下文', description: '请求 Agent 压缩当前会话上下文', group: 'platform' },
  { name: '/stop', label: '停止回合', description: '停止当前正在运行的回合', group: 'platform' },
  { name: '/help', label: '命令帮助', description: '查看输入区支持的命令', group: 'platform' },
]

const normalizeCommand = (command: string) => {
  const value = command.trim().split(/\s+/, 1)[0]
  if (!value) return null
  return value.startsWith('/') ? value : `/${value}`
}

export function commandsForAgent(agent: AgentDTO | undefined): readonly SlashCommand[] {
  const native = [...new Set((agent?.agentCommands ?? []).map(normalizeCommand).filter((value): value is string => Boolean(value)))]
    .filter(name => !platformCommands.some(command => command.name === name))
    .map(name => ({ name, label: name.slice(1) || name, description: ` ${agent?.displayName ?? 'Agent'} `, group: 'agent' as const }))
  return [...platformCommands, ...native]
}

export function commandGroups(commands: readonly SlashCommand[], query: string) {
  const matching = query ? commands.filter(command => command.name.toLowerCase().startsWith(query.toLowerCase())) : []
  return [
    { key: 'platform' as const, label: '', commands: matching.filter(command => command.group === 'platform') },
    { key: 'agent' as const, label: 'Agent ', commands: matching.filter(command => command.group === 'agent') },
  ].filter(group => group.commands.length > 0)
}

export function compactRoute(agent: AgentDTO | undefined): 'native' | 'slash-command' {
  return agent?.compactMode === 'slash-command' ? 'slash-command' : 'native'
}

export function isAgentCommandInput(agent: AgentDTO | undefined, input: string) {
  const name = normalizeCommand(input)
  if (!name) return false
  if (name === '/compact') return compactRoute(agent) === 'slash-command'
  if (platformCommands.some(command => command.name === name)) return false
  return (agent?.agentCommands ?? []).map(normalizeCommand).includes(name)
}
