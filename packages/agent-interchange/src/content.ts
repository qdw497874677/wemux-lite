export interface TextPart {
  readonly text: string
}

export interface FunctionCallPart {
  readonly functionCall: {
    readonly id?: string
    readonly name: string
    readonly args: Readonly<Record<string, unknown>>
  }
}

export interface FunctionResponsePart {
  readonly functionResponse: {
    readonly id?: string
    readonly name: string
    readonly response: unknown
  }
}

export interface FilePart {
  readonly fileData: {
    readonly fileUri: string
    readonly mimeType?: string
  }
}

export type ContentPart = TextPart | FunctionCallPart | FunctionResponsePart | FilePart

/** ADK-compatible conversation content without depending on a model SDK. */
export interface AgentContent {
  readonly role: 'user' | 'model'
  readonly parts: readonly ContentPart[]
}

export function textContent(role: AgentContent['role'], text: string): AgentContent {
  return { role, parts: [{ text }] }
}
