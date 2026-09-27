export type ApprovalPresentation =
  | { kind: 'command'; title: string; command: string; cwd?: string }
  | { kind: 'files'; title: string; paths: string[] }
  | { kind: 'summary'; title: string; summary: string }

const commandKinds = new Set(['command', 'shell', 'exec', 'execute', 'bash'])
const fileKinds = new Set(['write', 'file', 'file_write', 'write_file', 'edit', 'file_edit', 'create_file', 'delete_file'])

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) return value.join(' ')
  return undefined
}

function filePaths(action: Record<string, unknown>): string[] {
  const values = [action.path, action.filePath, action.target, action.paths, action.files]
  const paths = values.flatMap(value => {
    if (typeof value === 'string') return [value]
    if (!Array.isArray(value)) return []
    return value.flatMap(item => {
      if (typeof item === 'string') return [item]
      const entry = record(item)
      return [text(entry.path) ?? text(entry.filePath) ?? text(entry.target)].filter((path): path is string => Boolean(path))
    })
  })
  return [...new Set(paths)]
}

function friendlyKind(kind: string) {
  return kind.replaceAll('_', ' ').replaceAll('-', ' ')
}

export function approvalPresentation(actionValue: unknown, reason?: string): ApprovalPresentation {
  const action = record(actionValue)
  const kind = text(action.kind)?.toLowerCase() ?? ''
  if (commandKinds.has(kind)) {
    const command = text(action.command) ?? text(action.cmd) ?? text(action.script) ?? text(record(action.input).command)
    return { kind: 'command', title: reason || 'Agent 请求执行命令', command: command || '未提供命令文本', ...(text(action.cwd) ? { cwd: text(action.cwd) } : {}) }
  }
  if (fileKinds.has(kind)) {
    const paths = filePaths(action)
    return { kind: 'files', title: reason || 'Agent 请求修改文件', paths: paths.length ? paths : ['未提供目标文件路径'] }
  }
  const summary = reason || text(action.summary) || text(action.description) || text(action.message) || (kind ? `Agent 请求执行 ${friendlyKind(kind)} 操作` : 'Agent 请求执行一项需要确认的操作')
  return { kind: 'summary', title: '待审批操作', summary }
}
