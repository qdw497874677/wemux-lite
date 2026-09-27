export interface WorkLogEntry {
  tone: 'thinking' | 'tool' | 'info' | 'error'
  action?: 'read' | 'edit' | 'command' | 'browser' | 'search'
  toolTitle: string
  changedFiles?: string[]
  detail: string
}

interface ToolEventView {
  toolName: string
  input: unknown
  output: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  exitCode: number | null
}

const asRecord = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined
const firstText = (record: Record<string, unknown> | undefined, keys: string[]) => keys.map(key => text(record?.[key])).find(Boolean)

function classifyTool(name: string): { action?: WorkLogEntry['action']; title: string } {
  const normalized = name.toLowerCase().replaceAll('-', '_')
  if (/^(bash|shell|exec|command|echo)$|terminal/.test(normalized)) return { action: 'command', title: '运行命令' }
  if (/^(read|cat|open_file)$|file_read/.test(normalized)) return { action: 'read', title: '读取文件' }
  if (/^(write|edit|apply_patch|patch|replace)$|file_(write|edit)/.test(normalized)) return { action: 'edit', title: '编辑文件' }
  if (/browser|navigate|page|screenshot/.test(normalized)) return { action: 'browser', title: '浏览网页' }
  if (/search|grep|find|glob/.test(normalized)) return { action: 'search', title: '搜索' }
  return { title: name || '工具' }
}

function extractFile(input: Record<string, unknown> | undefined): string | undefined {
  return firstText(input, ['path', 'filePath', 'file_path', 'filename'])
}

function detailForTool(action: WorkLogEntry['action'], inputValue: unknown, output: string, failed: boolean): string {
  if (failed && output.trim()) return output.trim()
  const input = asRecord(inputValue)
  if (action === 'command') return firstText(input, ['command', 'cmd', 'script']) ?? output.trim()
  if (action === 'read' || action === 'edit') return extractFile(input) ?? output.trim()
  if (action === 'browser') return firstText(input, ['url', 'href', 'target']) ?? output.trim()
  if (action === 'search') return firstText(input, ['query', 'pattern', 'term']) ?? output.trim()
  if (typeof inputValue === 'string') return inputValue.trim()
  return output.trim()
}

export function normalizeWorkLogEntry(tool: ToolEventView): WorkLogEntry {
  const presentation = classifyTool(tool.toolName)
  const failed = tool.status === 'failed' || (tool.exitCode !== null && tool.exitCode !== 0)
  const file = presentation.action === 'edit' ? extractFile(asRecord(tool.input)) : undefined
  return {
    tone: failed ? 'error' : 'tool',
    ...(presentation.action ? { action: presentation.action } : {}),
    toolTitle: failed ? `${presentation.title}失败` : presentation.title,
    ...(file ? { changedFiles: [file] } : {}),
    detail: detailForTool(presentation.action, tool.input, tool.output, failed),
  }
}
