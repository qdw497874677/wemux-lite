import type { AgentLaunchContext } from '../application/ports/agent-adapter.js'

const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false })
const string = { type: 'string' }
const boolean = { type: 'boolean' }
const definitions = [
  ['wemux_session_info', 'Inspect the current Wemux project, workspace, session, caller agent, assets, and available tools.', object({}), 'session.info'],
  ['wemux_agent_list', 'List agents visible in the current Wemux project.', object({}), 'agent.list'],
  ['wemux_agent_send', 'Send a durable message to another agent in the current Wemux project.', object({ toAgentId: string, content: string, idempotencyKey: string }, ['toAgentId', 'content', 'idempotencyKey']), 'agent.send'],
  ['wemux_inbox_list', 'List messages sent to this agent.', object({ unreadOnly: boolean }), 'agent.inbox.list'],
  ['wemux_inbox_read', 'Read one inbox message and mark it read.', object({ messageId: string }, ['messageId']), 'agent.inbox.read'],
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
      const response = await fetch(`${context.capabilityEndpoint!.replace(/\/$/, '')}/${encodeURIComponent(operation)}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${context.capabilityToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(input),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      })
      const result = await response.json() as { error?: string }
      if (!response.ok) throw new Error(result?.error ?? `Wemux capability failed with HTTP ${response.status}`)
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }], details: result }
    },
  }))
}

/** A standalone JS extension loaded by the installed CLI, not by Worker. */
export function piCapabilityExtension(readyPath: string): string {
  return `import { writeFileSync } from 'node:fs';
const definitions = ${JSON.stringify(definitions)};
const endpoint = process.env.WEMUX_PI_CAPABILITY_ENDPOINT;
const token = process.env.WEMUX_PI_CAPABILITY_TOKEN;
export default function(pi) {
  const tools = definitions.map(([name, description, parameters, operation]) => ({
    name, label: name.replaceAll('_', ' '), description, promptSnippet: description, parameters,
    async execute(_id, input, signal) {
      const response = await fetch(endpoint.replace(/\\/$/, '') + '/' + encodeURIComponent(operation), {
        method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify(input),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result?.error ?? ('Wemux capability failed with HTTP ' + response.status));
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
