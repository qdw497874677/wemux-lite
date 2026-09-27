export const HIGHLIGHT_CACHE_LIMIT = 200
export const HIGHLIGHT_LINE_LIMIT = 500

export type SyntaxTheme = 'light' | 'dark'
export type HighlightedToken = { content: string; color?: string; fontStyle?: number }
export type HighlightedLine = HighlightedToken[]

const aliases = {
  ts: 'typescript', typescript: 'typescript',
  tsx: 'tsx',
  js: 'javascript', jsx: 'javascript', javascript: 'javascript',
  json: 'json', jsonc: 'json',
  bash: 'bash', sh: 'bash', shell: 'bash', zsh: 'bash',
  py: 'python', python: 'python',
  go: 'go', golang: 'go',
  rs: 'rust', rust: 'rust',
  java: 'java',
  sql: 'sql',
  html: 'html', htm: 'html',
  css: 'css',
  yaml: 'yaml', yml: 'yaml',
  md: 'markdown', markdown: 'markdown',
  docker: 'dockerfile', dockerfile: 'dockerfile',
} as const

export type SupportedSyntaxLanguage = typeof aliases[keyof typeof aliases]

export function normalizeSyntaxLanguage(language: string | undefined): SupportedSyntaxLanguage | null {
  return language ? aliases[language.trim().toLowerCase() as keyof typeof aliases] ?? null : null
}

export function truncateHighlightCode(code: string, limit = HIGHLIGHT_LINE_LIMIT) {
  const lines = code.split('\n')
  if (lines.length <= limit) return { code, omittedLines: 0 }
  return { code: lines.slice(0, limit).join('\n'), omittedLines: lines.length - limit }
}

export class LruCache<K, V> {
  readonly values = new Map<K, V>()
  readonly limit: number
  constructor(limit: number) { this.limit = limit }
  get(key: K): V | undefined {
    const value = this.values.get(key)
    if (value === undefined) return undefined
    this.values.delete(key)
    this.values.set(key, value)
    return value
  }
  set(key: K, value: V) {
    this.values.delete(key)
    this.values.set(key, value)
    while (this.values.size > this.limit) this.values.delete(this.values.keys().next().value!)
  }
}

export function codeHash(code: string): string {
  let hash = 2166136261
  for (let index = 0; index < code.length; index++) {
    hash ^= code.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

type HighlightFunction = (code: string, language: SupportedSyntaxLanguage, theme: SyntaxTheme) => Promise<HighlightedLine[] | null>

async function loadShikiHighlight(code: string, language: SupportedSyntaxLanguage, theme: SyntaxTheme) {
  const { highlightCodeWithShiki } = await import('./shiki-highlighter.ts')
  return highlightCodeWithShiki(code, language, theme)
}

export async function prepareSyntaxHighlight(
  code: string,
  language: string | undefined,
  partial: boolean,
  theme: SyntaxTheme,
  highlighter: HighlightFunction = loadShikiHighlight,
): Promise<{ code: string; omittedLines: number; highlighted: HighlightedLine[] | null }> {
  const truncated = truncateHighlightCode(code)
  const normalizedLanguage = normalizeSyntaxLanguage(language)
  if (partial || !normalizedLanguage) return { ...truncated, highlighted: null }
  return { ...truncated, highlighted: await highlighter(truncated.code, normalizedLanguage, theme) }
}
