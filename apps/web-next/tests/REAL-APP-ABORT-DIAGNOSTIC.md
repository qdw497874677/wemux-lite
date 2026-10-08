# Actual legacy App abort diagnostic

This is a local diagnostic, **not ticket01 acceptance or a claim about historical deployed-release causation**. It bundles the current dirty-worktree `apps/web/src/main.tsx`, including the real `App`, TanStack Router, Query provider, auth scope, project resources and `useSession`. No product source, router or hooks are replaced. The fixture HTML supplies only `#root` and the bundled entry. CSS is omitted and React uses its production mode; this is not visual or development StrictMode-effect acceptance.

## Scenario and scope

1. A dynamic-port HTTP server bound to `127.0.0.1` serves an explicit small GET-only fixture table for host discovery, authenticated account bootstrap, projects, workspace/session inventory, project reads and history. It has no real database, credentials, login mutation, Task/Session/Run writes or real Worker. Unknown paths and non-GET requests are failures. Browser external requests are blocked and recorded as failures.
2. The actual App opens `/projects/local-project/sessions/local-session`. Its history UI must render the fixture assistant text and the real session surface before proceeding. SSE endpoints stay open normally.
3. The real “刷新当前数据” button starts a new history GET. The server actively holds that read **before headers**, and the driver waits for its received event and browser/document identities.
4. The real global-navigation project link invokes the app's router. `/projects` must be reached, the session surface must detach and its real effect cleanup must abort the signal. A single document navigation request, single document-start and no pagehide distinguish this from reload or synthetic `pushState` simulation. Playwright `framenavigated` is recorded but is not counted as a document commit: it also fires for SPA transitions.
5. The held read has a document `signal-abort`/`fetch-rejected`, Playwright `requestfailed` with **`net::ERR_ABORTED` and no HTTP status**, and server `closed` with `ended:false, headersSent:false`.
6. The green timing control releases the same read and waits for browser completion/history rendering before clicking the same route link. Cleanup still aborts its signal, but the completed request has 200/finished and no requestfailed. This is a control, **not a fix**.

Fetch instrumentation only adds a local correlation header and observes signals/results. It does not abort requests, call product controllers, invoke Query cancellation, replace history, or perform navigation. Exact local request IDs join document, Playwright Request-object identities/status, and server received/finish/close events. Source hashes are persisted for the relevant current app/router/session/transport files. Evidence includes fixture-only URLs and data.

Native favicon requests are separately recorded with their Playwright Request identity (`browserId`), response content type/status, finish and failure events. The test requires native SVG response/finish and no failure. An additional explicit fetch of the same asset has its own correlation ID; it is not substituted for the native icon request. This demonstrates successful favicon delivery here, not historical favicon-abort causation.

## Commands

Explicit browser configuration is mandatory. Missing configuration fails; there are no skips. All evidence/logs below stay in `/tmp`.

```sh
export PLAYWRIGHT_CORE_PATH=/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs
export PLAYWRIGHT_CHROMIUM_PATH=/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome

# RED, expected exit 1 on the exact reproduced browser symptom.
WEMUX_REAL_APP_EVIDENCE=/tmp/wemux-real-app-abort-red \
  node apps/web-next/tests/real-app-abort-diagnostic.mjs --assert-no-abort \
  > /tmp/real-app-red.log 2>&1

# GREEN timing control, expected exit 0. Does not change the product.
WEMUX_REAL_APP_EVIDENCE=/tmp/wemux-real-app-abort-green \
  node apps/web-next/tests/real-app-abort-diagnostic.mjs \
  --release-before-navigation --assert-no-abort > /tmp/real-app-green.log 2>&1

# Diagnostic self-tests: prove the red assertion actually rejects and inspect
# persisted evidence, then verify the completed-read control. Not acceptance.
node --test apps/web-next/tests/real-app-abort-diagnostic.test.mjs

# Optional reproduction evidence without the intentional no-abort assertion.
node apps/web-next/tests/real-app-abort-diagnostic.mjs
```

The standalone red command is intentionally not a green regression acceptance suite. The self-tests are green **because they verify a specific red result**, not because they waive browser failures. Barrier waits are bounded at 12 seconds and each test at 60 seconds. Browser and local server are closed in finally. Standalone command output survives failures; self-tests use independent `mkdtemp` directories under `tmpdir()` and remove only their owned evidence after assertions, including on failure. See [browser test infrastructure](../../../docs/acceptance/browser-test-infrastructure.md) for the preflight wrapper and isolated full-test command.

## Observed results

- Actual current App mounted and fixture history rendered in both cases.
- Standalone held-read oracle: exit 1, `RED: real App route cleanup produced net::ERR_ABORTED on gated history GET`.
- Release-before-route control: exit 0, `actualAppMounted:true`.
- Focused diagnostic tests: 2 passed, 0 skipped.
- Existing browser-safety acceptance: 2 passed, 0 skipped, using only disposable local servers and synthetic credentials.
- No external/write/unknown requests or page errors in diagnostic evidence. No staged files.

Historical sanitized evidence at `/tmp/wemux-ticket01-write-current/result.json` and `/tmp/wemux-ticket01-spa-abort/probe4/result.json` contains multiple mechanisms: same-document project reads, stream cleanup and 401 scope revocation. This bounded scenario proves one current real-App session cleanup mechanism and timing sensitivity only. It does not reproduce every historical endpoint/status, revoke authentication, create entities, exercise mobile viewports, or identify the deployed source revision responsible for those records. Product fixes and changes to the acceptance abort classifier remain out of scope.
