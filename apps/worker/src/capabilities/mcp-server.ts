#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { realpath } from 'node:fs/promises'
import { invokeCapability } from '../agent-cli.js'

const tools = [
  { name: 'wemux_session_info', description: 'Inspect current Wemux session context.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'wemux_project_list', description: 'List Projects allowed to this Turn.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'wemux_project_get', description: 'Read one authorized Project.', inputSchema: { type: 'object', properties: { projectId: { type: 'string' } }, required: ['projectId'], additionalProperties: false } },
  { name: 'wemux_project_resources', description: 'Discover authorized Workspaces, Worker placements, Agents and models without paths or secrets.', inputSchema: { type: 'object', properties: { projectId: { type: 'string' } }, required: ['projectId'], additionalProperties: false } },
  { name: 'wemux_task_list', description: 'List Tasks with bounded pagination.', inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, limit: { type: 'number' }, cursor: { type: 'string' } }, required: ['projectId'], additionalProperties: false } },
  { name: 'wemux_task_get', description: 'Read one authorized Task.', inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, taskId: { type: 'string' } }, required: ['projectId', 'taskId'], additionalProperties: false } },
  { name: 'wemux_task_create', description: 'Create an ordinary Project Task with an idempotent requestId and write permission.', inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, requestId: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, acceptanceCriteria: { type: 'string' }, priority: { type: 'string' }, metadataJson: { type: 'object' } }, required: ['projectId', 'requestId', 'title'], additionalProperties: false } },
  { name: 'wemux_task_sessions', description: 'List visible Sessions bound to one Task.', inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, taskId: { type: 'string' }, limit: { type: 'number' }, cursor: { type: 'string' } }, required: ['projectId', 'taskId'], additionalProperties: false } },
  { name: 'wemux_session_get', description: 'Read authorized Session binding and freshness.', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'], additionalProperties: false } },
  { name: 'wemux_session_events', description: 'Read authorized Session events and freshness.', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, fromSeq: { type: 'number' }, limit: { type: 'number' } }, required: ['sessionId'], additionalProperties: false } },
  { name: 'wemux_agent_list', description: 'List visible agents in the current project.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'wemux_agent_send', description: 'Send a durable message to another agent.', inputSchema: { type: 'object', properties: { toAgentId: { type: 'string' }, content: { type: 'string' }, idempotencyKey: { type: 'string' } }, required: ['toAgentId', 'content', 'idempotencyKey'], additionalProperties: false } },
  { name: 'wemux_inbox_list', description: 'List messages sent to this agent.', inputSchema: { type: 'object', properties: { unreadOnly: { type: 'boolean' } }, additionalProperties: false } },
  { name: 'wemux_inbox_read', description: 'Read and acknowledge one inbox message.', inputSchema: { type: 'object', properties: { messageId: { type: 'string' } }, required: ['messageId'], additionalProperties: false } },
  { name: 'wemux_delegation_accept', description: 'Accept a same-Worker delegation.', inputSchema: { type: 'object', properties: { delegationId: { type: 'string' }, expectedVersion: { type: 'number' }, requestId: { type: 'string' } }, required: ['delegationId', 'expectedVersion', 'requestId'], additionalProperties: false } },
  { name: 'wemux_delegation_reject', description: 'Reject a delegation.', inputSchema: { type: 'object', properties: { delegationId: { type: 'string' }, expectedVersion: { type: 'number' }, requestId: { type: 'string' }, reason: { type: 'string' } }, required: ['delegationId', 'expectedVersion', 'requestId'], additionalProperties: false } },
  { name: 'wemux_delegation_complete', description: 'Complete a delegation and return a result.', inputSchema: { type: 'object', properties: { delegationId: { type: 'string' }, expectedVersion: { type: 'number' }, requestId: { type: 'string' }, outcome: { type: 'string', enum: ['completed', 'failed', 'cancelled'] }, resultSummary: { type: 'string' } }, required: ['delegationId', 'expectedVersion', 'requestId', 'outcome'], additionalProperties: false } },
  { name: 'mcp_list_tools', description: 'List bounded tools exposed by one approved MCP connector.', inputSchema: { type: 'object', properties: { connectorId: { type: 'string' } }, required: ['connectorId'], additionalProperties: false } },
  { name: 'mcp_call', description: 'Call one approved MCP tool.', inputSchema: { type: 'object', properties: { connectorId: { type: 'string' }, connectorRevision: { type: 'number' }, toolName: { type: 'string' }, requestId: { type: 'string' }, toolCallId: { type: 'string' }, arguments: { type: 'object' } }, required: ['connectorId', 'connectorRevision', 'toolName', 'requestId', 'toolCallId', 'arguments'], additionalProperties: false } },
  { name: 'http_call', description: 'Call one approved HTTP operation.', inputSchema: { type: 'object', properties: { connectorId: { type: 'string' }, connectorRevision: { type: 'number' }, operationId: { type: 'string' }, requestId: { type: 'string' }, toolCallId: { type: 'string' }, input: { type: 'object' } }, required: ['connectorId', 'connectorRevision', 'operationId', 'requestId', 'toolCallId', 'input'], additionalProperties: false } },
] as const
const operations: Record<string, string> = { wemux_project_list: 'project.list', wemux_project_get: 'project.get', wemux_project_resources: 'project.resources', wemux_session_get: 'session.get', wemux_task_list: 'task.list', wemux_task_get: 'task.get', wemux_task_create: 'task.create', wemux_task_sessions: 'task.sessions', wemux_session_events: 'session.events', wemux_session_info: 'session.info', wemux_agent_list: 'agent.list', wemux_agent_send: 'agent.send', wemux_inbox_list: 'agent.inbox.list', wemux_inbox_read: 'agent.inbox.read', wemux_delegation_accept: 'delegation.accept', wemux_delegation_reject: 'delegation.reject', wemux_delegation_complete: 'delegation.complete', mcp_list_tools: 'mcp.list_tools', mcp_call: 'mcp.call', http_call: 'http.call' }

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
