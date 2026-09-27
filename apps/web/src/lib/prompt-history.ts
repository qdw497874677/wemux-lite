const PROMPT_HISTORY_LIMIT = 100
const PROMPT_HISTORY_PREFIX = 'wemux:prompt-history:'

type PromptHistoryStorage = Pick<Storage, 'getItem' | 'setItem'>
export type PromptHistoryDirection = 'backward' | 'forward'
export type PromptHistoryStep = { value: string }

export function promptHistoryKey(sessionId: string): string {
  return `${PROMPT_HISTORY_PREFIX}${encodeURIComponent(sessionId)}`
}

function readEntries(key: string, storage: PromptHistoryStorage): string[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(key) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0).slice(-PROMPT_HISTORY_LIMIT)
  } catch {
    return []
  }
}

export class PromptHistory {
  private readonly key: string
  private readonly storage: PromptHistoryStorage
  private prompts: string[]
  private cursor: number | null = null

  constructor(sessionId: string, storage: PromptHistoryStorage = window.localStorage) {
    this.key = promptHistoryKey(sessionId)
    this.storage = storage
    this.prompts = readEntries(this.key, storage)
  }

  entries(): readonly string[] {
    return [...this.prompts]
  }

  push(prompt: string): void {
    const value = prompt.trim()
    if (!value) return
    if (this.prompts.at(-1) !== value) this.prompts = [...this.prompts, value].slice(-PROMPT_HISTORY_LIMIT)
    this.cursor = null
    try { this.storage.setItem(this.key, JSON.stringify(this.prompts)) } catch { /* Browsing remains available in memory when storage is unavailable. */ }
  }

  step(direction: PromptHistoryDirection, currentValue: string): PromptHistoryStep | null {
    if (!this.prompts.length) return null
    if (currentValue === '') {
      if (direction === 'forward') { this.cursor = null; return null }
      this.cursor = this.prompts.length - 1
      return { value: this.prompts[this.cursor]! }
    }

    if (this.cursor === null || this.prompts[this.cursor] !== currentValue) {
      this.cursor = this.prompts.lastIndexOf(currentValue)
      if (this.cursor < 0) { this.cursor = null; return null }
    }

    const next = direction === 'backward' ? this.cursor - 1 : this.cursor + 1
    if (next < 0) return null
    if (next >= this.prompts.length) {
      this.cursor = null
      return { value: '' }
    }
    this.cursor = next
    return { value: this.prompts[next]! }
  }
}
