import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'

export async function* parseJsonLines(stream: Readable): AsyncIterable<Record<string, unknown>> {
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  for await (const line of lines) {
    const text = line.trim()
    if (!text) continue
    try {
      const value: unknown = JSON.parse(text)
      if (value && typeof value === 'object' && !Array.isArray(value)) yield value as Record<string, unknown>
    } catch { /* Provider diagnostics may be mixed into stdout. */ }
  }
}
