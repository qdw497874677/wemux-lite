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
  if (!response.ok) throw new Error(result?.error ?? `Capability request failed with HTTP ${response.status}`)
  return result
}

export function parseInvocation(argv: readonly string[]): Invocation {
  const [resource, action, ...args] = argv
  if (resource === 'session' && action === 'info') return { operation: 'session.info', input: {} }
  if (resource === 'agent' && action === 'list') return { operation: 'agent.list', input: {} }
  if (resource === 'agent' && action === 'send') {
    const to = option(args, '--to')
    const content = option(args, '--content')
    return { operation: 'agent.send', input: { toAgentId: to, content, idempotencyKey: optional(args, '--idempotency-key') ?? randomUUID() } }
  }
  if (resource === 'inbox' && action === 'list') return { operation: 'agent.inbox.list', input: { unreadOnly: args.includes('--unread') } }
  if (resource === 'inbox' && action === 'read') return { operation: 'agent.inbox.read', input: { messageId: option(args, '--message-id') } }
  throw new Error('Usage: wemux-lite-agent session info | agent list | agent send --to AGENT --content TEXT [--idempotency-key KEY] | inbox list [--unread] | inbox read --message-id ID')
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
