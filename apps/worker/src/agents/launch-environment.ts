import type { AgentLaunchContext } from '../application/ports/agent-adapter.js'

/** Process scoping, not a filesystem or network sandbox. Ordinary Sessions keep ambient behavior. */
export function agentEnvironment(context: AgentLaunchContext | null, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  if (!context?.restrictedEnvironment) return { ...process.env, ...extra, ...context?.environment }
  const environment: NodeJS.ProcessEnv = {}
  for (const name of ['PATH', 'LANG', 'LC_ALL', 'TERM', 'TZ', 'TMPDIR', 'NODE_EXTRA_CA_CERTS', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT']) {
    if (process.env[name] !== undefined) environment[name] = process.env[name]
  }
  return { ...environment, ...extra, ...context.environment }
}
