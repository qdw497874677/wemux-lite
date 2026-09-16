import type { ServerToWorker } from '@wemux/wire-protocol'

type Rule = (value: unknown) => boolean
const text: Rule = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0')
const literal = (...values: unknown[]): Rule => value => values.includes(value)
const array = (rule: Rule): Rule => value => Array.isArray(value) && value.length <= 1000 && value.every(rule)
const object = (fields: Record<string, Rule>): Rule => value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return Object.keys(record).every(key => key in fields) && Object.entries(fields).every(([key, rule]) => rule(record[key]))
}
const union = (...rules: Rule[]): Rule => value => rules.some(rule => rule(value))
const nullable = (rule: Rule): Rule => union(literal(null), rule)
const timestamp: Rule = value => text(value) && Number.isFinite(Date.parse(String(value)))
const positive: Rule = value => Number.isSafeInteger(value) && Number(value) >= 1
const ownership = union(object({ kind: literal('standalone') }), object({ kind: literal('composite-member'), compositeWorkspaceId: text, role: literal('ordinary', 'coordination') }))
const spec = union(object({ kind: literal('repository'), repositoryId: text, ownership }), object({ kind: literal('composite'), memberWorkspaceIds: array(text) }))
const capabilityTool = literal('session.info', 'agent.list', 'agent.send', 'agent.inbox.list', 'agent.inbox.read')
const capabilityAsset = object({ id: text, kind: literal('skill', 'prompt', 'instruction', 'file'), name: text, version: text, content: value => typeof value === 'string', checksum: text, targetPath: nullable(text) })
const capabilityRuntime = object({
  snapshot: object({ id: text, projectId: text, workspaceId: text, sessionId: text, version: positive, assets: array(capabilityAsset), allowedTools: array(capabilityTool), createdAt: timestamp }),
  grant: object({ grantId: text, sessionId: text, turnId: text, actorAgentId: text, projectId: text, workspaceId: text, allowedTools: array(capabilityTool), issuedAt: timestamp, expiresAt: timestamp }),
  token: text,
})
const command = union(
  object({ kind: literal('workspace.provision'), workspace: object({
    workspace: object({ id: text, projectId: text, name: text, spec }),
    repositories: array(object({ repositoryId: text, gitUrl: text, revision: text })),
  }) }),
  object({ kind: literal('workspace.delete'), workspaceId: text }),
  object({ kind: literal('session.create'), session: object({ sessionId: text, binding: object({ workspaceId: text, agent: object({ workerId: text, agentKey: text }), modelId: text }) }) }),
  union(
    object({ kind: literal('session.enqueue'), sessionId: text, message: object({ messageId: text, content: value => typeof value === 'string' && value.length > 0 && !value.includes('\0') && Buffer.byteLength(JSON.stringify(value)) <= 200000 }) }),
    object({ kind: literal('session.enqueue'), sessionId: text, message: object({ messageId: text, content: value => typeof value === 'string' && value.length > 0 && !value.includes('\0') && Buffer.byteLength(JSON.stringify(value)) <= 200000 }), capabilities: capabilityRuntime }),
  ),
  object({ kind: literal('session.cancel-queued'), sessionId: text, submissionCommandId: text }),
  object({ kind: literal('session.delete'), sessionId: text }),
  object({ kind: literal('turn.stop'), sessionId: text, turnId: text }),
)
const envelope = { protocolVersion: literal(1), messageId: text }
const message = union(
  object({ ...envelope, type: literal('hello'), side: literal('server'), connectionId: text, acceptedAt: timestamp }),
  object({ ...envelope, type: literal('heartbeat'), nonce: text, sentAt: timestamp }),
  object({ ...envelope, type: literal('command'), commandId: text, command }),
  object({ ...envelope, type: literal('sync'), kind: literal('request'), sessionId: text, fromSeq: positive, limit: value => positive(value) && Number(value) <= 1000 }),
  object({ ...envelope, type: literal('error'), error: object({ code: literal('unsupported-version', 'unauthorized', 'invalid-message', 'integrity-error', 'internal-error'), message: text, retryable: literal(true, false), relatedMessageId: nullable(text) }) }),
)
export function parseServerMessage(raw: string): ServerToWorker {
  const value: unknown = JSON.parse(raw)
  if (!message(value)) throw new Error('Invalid protocol v1 Server message')
  return value as ServerToWorker
}
