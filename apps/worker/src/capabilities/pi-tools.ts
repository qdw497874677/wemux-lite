import { request } from 'node:http'
import type { AgentLaunchContext } from '../application/ports/agent-adapter.js'

const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false })
const string = { type: 'string' }
const boolean = { type: 'boolean' }
// Connector approval can remain actionable for five minutes. Leave a bounded
// minute for publishing the terminal result; other capability calls stay short.
const connectorToolTimeoutMs = 6 * 60_000

// The gateway waits for approval before emitting headers. Native fetch has a
// separate five-minute Undici header timer, independent of AbortSignal. This
// loopback-only request uses Node HTTP's caller-controlled signal instead.
async function connectorRequest(url: string, token: string, input: unknown, signal: AbortSignal): Promise<{ ok: boolean; status: number; result: any }> {
  const target = new URL(url)
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !target.port || target.username || target.password) throw new Error('Connector capability endpoint must be local loopback HTTP')
  const body = JSON.stringify(input)
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, signal }, res => {
      const chunks: Buffer[] = []
      let length = 0
      res.on('data', (chunk: Buffer) => {
        length += chunk.length
        if (length > 1024 * 1024) { req.destroy(new Error('Capability response too large')); return }
        chunks.push(chunk)
      })
      res.on('error', reject)
      res.on('end', () => {
        try { resolve({ ok: (res.statusCode ?? 500) >= 200 && (res.statusCode ?? 500) < 300, status: res.statusCode ?? 500, result: JSON.parse(Buffer.concat(chunks).toString('utf8')) }) }
        catch (error) { reject(error) }
      })
    })
    req.on('error', reject)
    req.end(body)
  })
}
const definitions = [
  ['wemux_session_info', 'Inspect the current Wemux project, workspace, session, caller agent, assets, and available tools.', object({}), 'session.info'],
  ['wemux_project_list', 'List Projects allowed to this Turn.', object({}), 'project.list'],
  ['wemux_project_get', 'Read one authorized Project.', object({ projectId: string }, ['projectId']), 'project.get'],
  ['wemux_project_resources', 'Discover authorized Workspaces, Worker placements, Agents and models with limited metadata.', object({ projectId: string }, ['projectId']), 'project.resources'],
  ['wemux_task_list', 'List Tasks with bounded pagination in the authorized Project.', object({ projectId: string, limit: { type: 'number' }, cursor: string }, ['projectId']), 'task.list'],
  ['wemux_task_get', 'Read one authorized Task.', object({ projectId: string, taskId: string }, ['projectId', 'taskId']), 'task.get'],
  ['wemux_task_create', 'Create an ordinary Project Task with an idempotent requestId and current actor write permission.', object({ projectId: string, requestId: string, title: string, description: string, acceptanceCriteria: string, priority: string, metadataJson: { type: 'object' } }, ['projectId', 'requestId', 'title']), 'task.create'],
  ['wemux_task_sessions', 'List visible Sessions bound to one Task, independent of Runs.', object({ projectId: string, taskId: string, limit: { type: 'number' }, cursor: string }, ['projectId', 'taskId']), 'task.sessions'],
  ['wemux_session_get', 'Read an authorized Session binding, execution status and freshness.', object({ sessionId: string }, ['sessionId']), 'session.get'],
  ['wemux_session_events', 'Read authorized Session Journal events with freshness and bounded cursor.', object({ sessionId: string, fromSeq: { type: 'number' }, limit: { type: 'number' } }, ['sessionId']), 'session.events'],
  ['wemux_agent_list', 'List agents visible in the current Wemux project.', object({}), 'agent.list'],
  ['wemux_agent_send', 'Send a durable message to another agent in the current Wemux project.', object({ toAgentId: string, content: string, idempotencyKey: string }, ['toAgentId', 'content', 'idempotencyKey']), 'agent.send'],
  ['wemux_inbox_list', 'List messages sent to this agent.', object({ unreadOnly: boolean }), 'agent.inbox.list'],
  ['wemux_inbox_read', 'Read one inbox message and mark it read.', object({ messageId: string }, ['messageId']), 'agent.inbox.read'],
  ['wemux_delegation_accept', 'Accept a delegation request and authorize a same-Worker child Run.', object({ delegationId: string, expectedVersion: { type: 'number' }, requestId: string }, ['delegationId', 'expectedVersion', 'requestId']), 'delegation.accept'],
  ['wemux_delegation_reject', 'Reject a delegation request.', object({ delegationId: string, expectedVersion: { type: 'number' }, requestId: string, reason: string }, ['delegationId', 'expectedVersion', 'requestId']), 'delegation.reject'],
  ['wemux_delegation_complete', 'Complete a running delegation and return its result to the parent canonical session.', object({ delegationId: string, expectedVersion: { type: 'number' }, requestId: string, outcome: { type: 'string', enum: ['completed', 'failed', 'cancelled'] }, resultSummary: string }, ['delegationId', 'expectedVersion', 'requestId', 'outcome']), 'delegation.complete'],
  ['mcp_list_tools', 'List bounded tools exposed by one approved MCP connector.', object({ connectorId: string }, ['connectorId']), 'mcp.list_tools'],
  ['mcp_call', 'Call one tool on an approved MCP connector. Writes require per-call approval.', object({ connectorId: string, connectorRevision: { type: 'number' }, toolName: string, requestId: string, toolCallId: string, arguments: { type: 'object' } }, ['connectorId', 'connectorRevision', 'toolName', 'requestId', 'toolCallId', 'arguments']), 'mcp.call'],
  ['http_call', 'Call one operation on an approved HTTP connector. Writes require per-call approval.', object({ connectorId: string, connectorRevision: { type: 'number' }, operationId: string, requestId: string, toolCallId: string, input: { type: 'object' } }, ['connectorId', 'connectorRevision', 'operationId', 'requestId', 'toolCallId', 'input']), 'http.call'],
] as const

// Structural tool definitions: Worker never imports or bundles the Pi SDK.
export function createPiCapabilityTools(context?: AgentLaunchContext) {
  if (!context?.capabilityEndpoint || !context.capabilityToken) return []
  return definitions.map(([name, description, parameters, operation]) => ({
    name, label: name.replaceAll('_', ' '), description, promptSnippet: description, parameters,
    execute: async (_id: string, input: unknown, signal?: AbortSignal) => {
      const endpoint = `${context.capabilityEndpoint!.replace(/\/$/, '')}/${encodeURIComponent(operation)}`
      const connector = ['mcp.call', 'http.call'].includes(operation)
      const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(connector ? connectorToolTimeoutMs : 30_000)]) : AbortSignal.timeout(connector ? connectorToolTimeoutMs : 30_000)
      const response = connector ? await connectorRequest(endpoint, context.capabilityToken!, input, deadline) : null
      const ordinary = response ? null : await fetch(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${context.capabilityToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(input),
        signal: deadline,
      })
      const result = response ? response.result : await ordinary!.json() as { ok?: boolean; error?: { code?: string; message?: string } | string }
      const ok = response ? response.ok : ordinary!.ok
      const status = response ? response.status : ordinary!.status
      if (!ok || (connector && result?.ok === false)) throw new Error(typeof result?.error === 'object' ? `${result.error.code ?? 'connector_failed'}: ${result.error.message ?? 'Connector call failed'}` : result?.error ?? `Wemux capability failed with HTTP ${status}`)
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }], details: result }
    },
  }))
}

/** A standalone JS extension loaded by the installed CLI, not by Worker. */
export function piCapabilityExtension(readyPath: string): string {
  return `import { writeFileSync } from 'node:fs';
import { request } from 'node:http';
const connectorRequest = ${connectorRequest.toString()};
const definitions = ${JSON.stringify(definitions)};
const endpoint = process.env.WEMUX_PI_CAPABILITY_ENDPOINT;
const token = process.env.WEMUX_PI_CAPABILITY_TOKEN;
export default function(pi) {
  const tools = definitions.map(([name, description, parameters, operation]) => ({
    name, label: name.replaceAll('_', ' '), description, promptSnippet: description, parameters,
    async execute(_id, input, signal) {
      const url = endpoint.replace(/\\/$/, '') + '/' + encodeURIComponent(operation);
      const connector = ['mcp.call', 'http.call'].includes(operation);
      const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(connector ? ${connectorToolTimeoutMs} : 30000)]) : AbortSignal.timeout(connector ? ${connectorToolTimeoutMs} : 30000);
      const response = connector ? await connectorRequest(url, token, input, deadline) : null;
      const ordinary = response ? null : await fetch(url, {
        method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify(input),
        signal: deadline,
      });
      const result = response ? response.result : await ordinary.json();
      const ok = response ? response.ok : ordinary.ok;
      const status = response ? response.status : ordinary.status;
      if (!ok || (connector && result?.ok === false)) throw new Error(typeof result?.error === 'object' ? ((result.error.code ?? 'connector_failed') + ': ' + (result.error.message ?? 'Connector call failed')) : result?.error ?? ('Wemux capability failed with HTTP ' + status));
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], details: result };
    },
  }));
  for (const tool of tools) pi.registerTool(tool);
  let failed = false;
  let monitor;
  const check = () => {
    const active = new Set(pi.getActiveTools());
    if (tools.some(tool => !active.has(tool.name))) failed = true;
    if (failed) {
      writeFileSync(${JSON.stringify(readyPath)}, 'inactive', { mode: 0o600 });
      throw new Error('Wemux capability tools became inactive; local tool restrictions were preserved');
    }
  };
  pi.on('session_start', () => {
    check();
    writeFileSync(${JSON.stringify(readyPath)}, 'ready', { mode: 0o600 });
    clearInterval(monitor);
    monitor = setInterval(() => { try { check(); } catch { /* Worker reads sticky failure marker */ } }, 50);
    monitor.unref();
  });
  // Never setActiveTools: a local restriction must cause failure, not be overridden.
  for (const event of ['before_agent_start', 'agent_start', 'turn_start', 'before_provider_request', 'tool_call', 'tool_result', 'turn_end', 'agent_end', 'agent_settled']) pi.on(event, check);
  pi.on('session_shutdown', () => clearInterval(monitor));
}
`
}
