import type { ModelId } from '@wemux/domain'

export function modelId(provider: string, id: string): ModelId {
  return `${provider}::${id}` as ModelId
}

export function splitModelId(value: ModelId): { provider: string; id: string } | null {
  const separator = value.indexOf('::')
  return separator > 0
    ? { provider: value.slice(0, separator), id: value.slice(separator + 2) }
    : null
}
