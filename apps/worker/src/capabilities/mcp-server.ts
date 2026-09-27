#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { realpath } from 'node:fs/promises'
import { invokeCapability } from '../agent-cli.js'

const tools = [
  { name: 'wemux_session_info', description: 'Inspect current Wemux session context.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'wemux_agent_list', description: 'List visible agents in the current project.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'wemux_agent_send', description: 'Send a durable message to another agent.', inputSchema: { type: 'object', properties: { toAgentId: { type: 'string' }, content: { type: 'string' }, idempotencyKey: { type: 'string' } }, required: ['toAgentId', 'content', 'idempotencyKey'], additionalProperties: false } },
  { name: 'wemux_inbox_list', description: 'List messages sent to this agent.', inputSchema: { type: 'object', properties: { unreadOnly: { type: 'boolean' } }, additionalProperties: false } },
  { name: 'wemux_inbox_read', description: 'Read and acknowledge one inbox message.', inputSchema: { type: 'object', properties: { messageId: { type: 'string' } }, required: ['messageId'], additionalProperties: false } },
  { name: 'mcp_list_tools', description: 'List bounded tools exposed by one approved MCP connector.', inputSchema: { type: 'object', properties: { connectorId: { type: 'string' } }, required: ['connectorId'], additionalProperties: false } },
  { name: 'mcp_call', description: 'Call one approved MCP tool.', inputSchema: { type: 'object', properties: { connectorId: { type: 'string' }, connectorRevision: { type: 'number' }, toolName: { type: 'string' }, requestId: { type: 'string' }, toolCallId: { type: 'string' }, arguments: { type: 'object' } }, required: ['connectorId', 'connectorRevision', 'toolName', 'requestId', 'toolCallId', 'arguments'], additionalProperties: false } },
] as const
const operations: Record<string, string> = { wemux_session_info: 'session.info', wemux_agent_list: 'agent.list', wemux_agent_send: 'agent.send', wemux_inbox_list: 'agent.inbox.list', wemux_inbox_read: 'agent.inbox.read', mcp_list_tools: 'mcp.list_tools', mcp_call: 'mcp.call' }

export async function handleMcpRequest(request: any): Promise<any> {
  if (request.method === 'initialize') return { protocolVersion: request.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'wemux-lite-agent', version: '0.1.0' } }
  if (request.method === 'notifications/initialized') return undefined
  if (request.method === 'tools/list') return { tools }
  if (request.method === 'tools/call') {
    const operation = operations[request.params?.name]
    if (!operation) throw new Error(`Unknown tool: ${request.params?.name}`)
    const result = await invokeCapability({ operation, input: request.params?.arguments ?? {} })
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result }
  }
  if (request.method === 'ping') return {}
  throw new Error(`Method not found: ${request.method}`)
}

function main() {
  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => {
    buffer += chunk
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      void dispatch(line)
    }
  })
}

async function dispatch(line: string) {
  let request: any
  try {
    request = JSON.parse(line)
    const result = await handleMcpRequest(request)
    if (request.id !== undefined) send({ jsonrpc: '2.0', id: request.id, result })
  } catch (error) {
    if (request?.id !== undefined) send({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } })
  }
}
function send(value: unknown) { process.stdout.write(`${JSON.stringify(value)}\n`) }
if (await isEntryPoint()) main()

async function isEntryPoint(): Promise<boolean> {
  if (!process.argv[1]) return false
  try { return import.meta.url === pathToFileURL(await realpath(process.argv[1])).href }
  catch { return import.meta.url === pathToFileURL(process.argv[1]).href }
}
