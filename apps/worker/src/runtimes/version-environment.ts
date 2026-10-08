import type { RuntimeKey } from '../config/agent-settings.js'

/** Probe the selected Pi binary, not the package metadata of a parent Pi process.
 * Keep HOME/PATH and authentication settings unchanged; other runtimes are unaffected.
 */
export function runtimeVersionEnvironment(key: RuntimeKey, environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv | undefined {
  if (key !== 'pi') return undefined
  const env = { ...environment }
  delete env.PI_PACKAGE_DIR
  return env
}
