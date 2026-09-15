declare const valueBrand: unique symbol

export type BrandedValue<Name extends string, Value> = Value & {
  readonly [valueBrand]: Name
}

export type Timestamp = BrandedValue<'Timestamp', string>
export type EventSeq = BrandedValue<'EventSeq', number>
export type AgentKey = BrandedValue<'AgentKey', string>
export type ModelId = BrandedValue<'ModelId', string>
export type NativeSessionRef = BrandedValue<'NativeSessionRef', string>

export function modelId(provider: string, id: string): ModelId {
  return `${provider}::${id}` as ModelId
}

export function splitModelId(value: ModelId): { provider: string; id: string } | null {
  const separator = value.indexOf('::')
  return separator > 0 ? { provider: value.slice(0, separator), id: value.slice(separator + 2) } : null
}

export interface PageRequest {
  readonly offset: number
  readonly limit: number
}

export interface Page<T> {
  readonly items: readonly T[]
  readonly total: number
}
