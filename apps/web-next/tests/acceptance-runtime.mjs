import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'

export function browserConfiguration(env = process.env) {
  if (!env.PLAYWRIGHT_CORE_PATH || !isAbsolute(env.PLAYWRIGHT_CORE_PATH) || !env.PLAYWRIGHT_CHROMIUM_PATH || !isAbsolute(env.PLAYWRIGHT_CHROMIUM_PATH)) throw Error('Browser acceptance configuration required (details withheld).')
  return { module: pathToFileURL(env.PLAYWRIGHT_CORE_PATH).href, executablePath: env.PLAYWRIGHT_CHROMIUM_PATH }
}
export async function launchAcceptanceBrowser() {
  const config = browserConfiguration()
  const { chromium } = await import(config.module)
  return chromium.launch({ executablePath: config.executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
}

// Never serialize thrown errors: Playwright call logs can include filled secrets.
export function recordAcceptanceFailure(result, step) {
  result.passed = false
  result.failure ??= { kind: 'acceptance-failed', step }
}
export async function finishAcceptance(result, cleanups, persist) {
  for (const cleanup of cleanups) {
    try { await cleanup() } catch { recordAcceptanceFailure(result, 'cleanup'); result.cleanupFailed = true }
  }
  try { await persist(result) } catch { recordAcceptanceFailure(result, 'write-result') }
  return result.passed ? 0 : 1
}

// Call immediately after the successful login response, before UI waits.
// A fresh context is required; the API marks only that context's own Cookie current.
export async function registerCurrentLoginCleanup(request, cleanupLogins) {
  const response = await request.get('/api/auth/sessions')
  const own = response.items.filter(item => item.current)
  if (own.length !== 1 || typeof own[0].id !== 'string' || !own[0].id) throw Error('Current test login unavailable (details withheld).')
  const id = own[0].id
  cleanupLogins.push(() => request.revokeCurrent(id))
  return id
}
