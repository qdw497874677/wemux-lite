import type { ConnectorDefinition, McpConnectorDefinition } from '@wemux/connector'
import { LocalWorkbenchError } from '../application/local-workbench.js'

function invalid(): never { throw new LocalWorkbenchError('本地连接器定义无效') }
export function redactLocalConnector(definition: ConnectorDefinition): ConnectorDefinition {
  if (definition.kind === 'mcp' && definition.config.transport === 'stdio') return { ...definition, config: { ...definition.config, publicEnvironment: Object.fromEntries(Object.keys(definition.config.publicEnvironment).map(key => [key, '[configured]'])) } }
  if (definition.kind === 'mcp' && definition.config.transport === 'streamable_http') return { ...definition, config: { ...definition.config, publicHeaders: Object.fromEntries(Object.keys(definition.config.publicHeaders).map(key => [key, '[configured]'])) } }
  if (definition.kind === 'http') return { ...definition, config: { ...definition.config, publicHeaders: Object.fromEntries(Object.keys(definition.config.publicHeaders).map(key => [key, '[configured]'])) } }
  return definition
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const fields = value as Record<string, unknown>
  if (Object.keys(fields).some(key => !keys.includes(key))) invalid()
  return fields
}
function identifier(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) }
function strings(value: unknown, max = 64): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every(item => typeof item === 'string' && item.length <= 512)
}
function stringRecord(value: unknown): value is Record<string, string> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length <= 64 && Object.entries(value).every(([key, item]) => /^[A-Za-z_][A-Za-z0-9_-]{0,127}$/.test(key) && typeof item === 'string' && item.length <= 2048)
}
function endpoint(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash } catch { return false }
}

/** Only the MCP subset is editable on the local Worker; reject unknown fields before persistence. */
export function parseLocalConnector(value: unknown): McpConnectorDefinition {
  const input = record(value, ['id', 'projectId', 'kind', 'name', 'description', 'revision', 'enabled', 'allowedWorkerIds', 'credentialRef', 'credentialAvailability', 'riskDefaults', 'createdAt', 'updatedAt', 'config'])
  if (input.kind !== 'mcp' || !identifier(input.id) || !input.id.startsWith('local-') || input.projectId !== 'local' || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 200 || (input.description !== null && (typeof input.description !== 'string' || input.description.length > 2048)) || !Number.isSafeInteger(input.revision) || (input.revision as number) < 1 || typeof input.enabled !== 'boolean' || !Array.isArray(input.allowedWorkerIds) || input.allowedWorkerIds.length > 64 || !input.allowedWorkerIds.every(identifier) || (input.credentialRef !== null && !identifier(input.credentialRef)) || !['not_required', 'unconfigured', 'available', 'unavailable', 'invalid'].includes(input.credentialAvailability as string) || typeof input.createdAt !== 'string' || !Number.isFinite(Date.parse(input.createdAt)) || typeof input.updatedAt !== 'string' || !Number.isFinite(Date.parse(input.updatedAt))) invalid()
  const risk = record(input.riskDefaults, ['requireApprovalForRead', 'allowMcpReadOnlyHint'])
  if (typeof risk.requireApprovalForRead !== 'boolean' || typeof risk.allowMcpReadOnlyHint !== 'boolean') invalid()
  const config = record(input.config, ['transport', 'command', 'args', 'cwd', 'publicEnvironment', 'secretEnvironmentNames', 'url', 'publicHeaders', 'authentication', 'allowPrivateNetwork'])
  if (typeof input.id === 'string' && !/^local-[A-Za-z0-9_-]{1,122}$/.test(input.id)) invalid()
  if (input.credentialRef === null && input.credentialAvailability !== 'not_required') invalid()
  if (input.credentialRef !== null && (!/^local-[A-Za-z0-9_-]{1,122}$/.test(input.credentialRef as string) || input.credentialAvailability === 'not_required')) invalid()
  if (input.allowedWorkerIds.length) invalid()
  if (config.transport === 'stdio') {
    if (Object.keys(config).some(key => !['transport', 'command', 'args', 'cwd', 'publicEnvironment', 'secretEnvironmentNames'].includes(key)) || typeof config.command !== 'string' || !config.command.trim() || config.command.length > 2048 || !strings(config.args) || (config.cwd !== null && (typeof config.cwd !== 'string' || !config.cwd.startsWith('/'))) || !stringRecord(config.publicEnvironment) || !strings(config.secretEnvironmentNames) || !config.secretEnvironmentNames.every(name => /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) || Object.keys(config.publicEnvironment).some(name => (config.secretEnvironmentNames as string[]).includes(name))) invalid()
    if (config.secretEnvironmentNames.length && input.credentialRef === null) invalid()
  } else if (config.transport === 'streamable_http') {
    if ((config.authentication !== 'none') !== (input.credentialRef !== null)) invalid()
    if (Object.keys(config).some(key => !['transport', 'url', 'publicHeaders', 'authentication', 'allowPrivateNetwork'].includes(key)) || !endpoint(config.url) || !stringRecord(config.publicHeaders) || !['none', 'api_key', 'custom_credential'].includes(config.authentication as string) || typeof config.allowPrivateNetwork !== 'boolean') invalid()
  } else invalid()
  return input as unknown as McpConnectorDefinition
}
