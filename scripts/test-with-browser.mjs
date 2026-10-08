// Browser-required gate: preflight before npm's expensive pretest/build phase.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { launchAcceptanceBrowser } from '../apps/web-next/tests/acceptance-runtime.mjs'

const args = process.argv.slice(2)
if (args.length && (args[0] !== '--' || args.length < 2)) {
  console.error('Usage: node scripts/test-with-browser.mjs [-- command ...args]')
  process.exitCode = 1
} else {
  let ready = false
  try {
    const browser = await launchAcceptanceBrowser()
    await browser.close()
    ready = true
  } catch {
    // Playwright errors may contain environment-specific paths or call logs.
    console.error('Browser preflight failed: supply valid absolute PLAYWRIGHT_CORE_PATH and PLAYWRIGHT_CHROMIUM_PATH (details withheld).')
    process.exitCode = 1
  }
  if (ready) {
    const [command, ...commandArgs] = args.length ? args.slice(1) : ['npm', 'test']
    const child = spawnSync(command, commandArgs, {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      stdio: 'inherit',
      shell: false,
      env: {
        ...process.env,
        PLAYWRIGHT_CORE_PATH: process.env.PLAYWRIGHT_CORE_PATH,
        PLAYWRIGHT_CHROMIUM_PATH: process.env.PLAYWRIGHT_CHROMIUM_PATH,
      },
    })
    if (child.error) console.error('Test command could not start (details withheld).')
    process.exitCode = child.status ?? 1
  }
}
