#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { realpath } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

interface Invocation {
  readonly operation: string
  readonly input: Record<string, unknown>
}

export async function invokeCapability(invocation: Invocation, environment = process.env): Promise<unknown> {
  const endpoint = environment.WEMUX_CAPABILITY_ENDPOINT
  const token = environment.WEMUX_CAPABILITY_TOKEN
  if (!endpoint || !token) throw new Error('WEMUX_CAPABILITY_ENDPOINT and WEMUX_CAPABILITY_TOKEN are required')
  const response = await fetch(`${endpoint.replace(/\/$/, '')}/${encodeURIComponent(invocation.operation)}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(invocation.input),
  })
  const result = await response.json() as any
  if (!response.ok) throw new Error(typeof result?.error === 'object' && result.error !== null
    ? `${result.error.code ?? 'capability_failed'}: ${result.error.message ?? `HTTP ${response.status}`}`
    : result?.error ?? `Capability request failed with HTTP ${response.status}`)
  return result
}

export function parseInvocation(argv: readonly string[]): Invocation {
  const [resource, action, ...args] = argv
  if (resource === 'session' && action === 'info') return { operation: 'session.info', input: {} }
  if (resource === 'project' && action === 'list') return { operation: 'project.list', input: {} }
  if (resource === 'project' && action === 'get') return { operation: 'project.get', input: { projectId: option(args, '--project-id') } }
  if (resource === 'project' && action === 'resources') return { operation: 'project.resources', input: { projectId: option(args, '--project-id') } }
  if (resource === 'task' && action === 'list') return { operation: 'task.list', input: { projectId: option(args, '--project-id'), ...pagination(args) } }
  if (resource === 'task' && action === 'get') return { operation: 'task.get', input: { projectId: option(args, '--project-id'), taskId: option(args, '--task-id') } }
  if (resource === 'task' && action === 'create') return { operation: 'task.create', input: { projectId: option(args, '--project-id'), requestId: option(args, '--request-id'), title: option(args, '--title'), ...(optional(args, '--description') !== null ? { description: option(args, '--description') } : {}) } }
  if (resource === 'task' && action === 'sessions') return { operation: 'task.sessions', input: { projectId: option(args, '--project-id'), taskId: option(args, '--task-id'), ...pagination(args) } }
  if (resource === 'session' && action === 'get') return { operation: 'session.get', input: { sessionId: option(args, '--session-id') } }
  if (resource === 'session' && action === 'events') return { operation: 'session.events', input: { sessionId: option(args, '--session-id'), ...(optional(args, '--from-seq') !== null ? { fromSeq: positiveInteger(option(args, '--from-seq'), '--from-seq') } : {}), ...(optional(args, '--limit') !== null ? { limit: positiveInteger(option(args, '--limit'), '--limit') } : {}) } }
  if (resource === 'agent' && action === 'list') return { operation: 'agent.list', input: {} }
  if (resource === 'agent' && action === 'send') {
    const to = option(args, '--to')
    const content = option(args, '--content')
    return { operation: 'agent.send', input: { toAgentId: to, content, idempotencyKey: optional(args, '--idempotency-key') ?? randomUUID() } }
  }
  if (resource === 'inbox' && action === 'list') return { operation: 'agent.inbox.list', input: { unreadOnly: args.includes('--unread') } }
  if (resource === 'inbox' && action === 'read') return { operation: 'agent.inbox.read', input: { messageId: option(args, '--message-id') } }
  throw new Error('Usage: wemux-lite-agent session info|get|events --session-id ID [--from-seq N] [--limit N] | project list|get|resources --project-id ID | task list|get|create|sessions --project-id ID [--task-id ID] [--request-id ID --title TEXT] [--cursor C] [--limit N] | agent list|send --to AGENT --content TEXT | inbox list|read --message-id ID')
}

function positiveInteger(value: string, field: string): number {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`${field} must be a positive safe integer`)
  return Number(value)
}
function pagination(args: readonly string[]) {
  return { ...(optional(args, '--limit') !== null ? { limit: positiveInteger(option(args, '--limit'), '--limit') } : {}), ...(optional(args, '--cursor') !== null ? { cursor: option(args, '--cursor') } : {}) }
}
function option(args: readonly string[], name: string): string {
  const value = optional(args, name)
  if (!value) throw new Error(`${name} is required`)
  return value
}
function optional(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] ?? null : null
}

async function main() {
  console.log(JSON.stringify(await invokeCapability(parseInvocation(process.argv.slice(2))), null, 2))
}
if (await isEntryPoint()) main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })

async function isEntryPoint(): Promise<boolean> {
  if (!process.argv[1]) return false
  try { return import.meta.url === pathToFileURL(await realpath(process.argv[1])).href }
  catch { return import.meta.url === pathToFileURL(process.argv[1]).href }
}
