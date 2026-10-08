# Browser acceptance prerequisites

`npm test` and `npm test --workspace @wemux/web-next` are platform-independent default suites. They do not launch the safety browser sentinel. They build fresh dependencies once per entry point; root calls `test:prepared` only after its centralized build. `test:prepared` is an internal composition entry, not a substitute for standalone `test`.

## Required explicit security gate

Before running the new-frontend real-identity script, CI/operators **must** run:

```sh
PLAYWRIGHT_CORE_PATH=/absolute/path/to/playwright-core/index.mjs \
PLAYWRIGHT_CHROMIUM_PATH=/absolute/path/to/chromium/chrome \
  npm run acceptance:safety --workspace @wemux/web-next
```

Both paths are required. Missing configuration exits nonzero immediately with a fixed diagnostic; there is no default machine-private path and no silent skip. The gate retains security coverage for both `real-instance.mjs` and the optional historical diagnostic `real-legacy-regression.mjs` against an ephemeral local HTTP fixture with a readonly password input and fake sentinel credentials. It checks stdout/stderr/result, nonzero exit and the precise password-fill failure step. It performs no real login or model execution.

The CI image must separately provision Node >=22.13, the repository's locked npm dependencies, `playwright-core@1.61.0` and its compatible Chromium (validated here with Chromium revision 1228), plus Chromium system libraries. For a separately managed tool directory, an operator may install the fixed package with `npm install --prefix <tool-dir> --save-exact playwright-core@1.61.0`, then provision its matching Chromium using that package's browser installer or an approved prebuilt CI image. Pin and cache that tool/image version in CI. Browser installation may require network and OS packages; these scripts neither install nor download/upgrade anything automatically. The package is an explicit acceptance tool, not a Web/Worker production dependency.

The same two path variables are required by the real-identity scripts if invoked. Supply credentials only through the documented private input, never command-line arguments. Successful default tests do not waive this mandatory browser gate. Default tests still exercise configuration failure, initialization errors in both actual scripts, cleanup/persistence failure safety, and own-login cleanup using platform-independent simulation.

Real instance work needs separate authorization, an existing project/identity and safe targets. A successful sentinel test grants no permission to mutate accounts or run paid Agents. Keep browser diagnostics free of arbitrary error text, request bodies, cookies, headers, storage and traces. Unknown request cancellations remain failures; epoch changes alone are not proof of expected cancellation.

## Controlled new-UI browser gate

`browser.mjs` uses the same two explicit Playwright path variables. By default it
serves `apps/web-next/dist`; set `WEMUX_NEXT_DIST_PATH` to an absolute isolated
build directory to test that build without replacing repository or deployed
artifacts. Set `WEMUX_NEXT_EVIDENCE` to a separate `/tmp` directory. The result
records the selected dist and whether it was explicitly overridden.

This desktop/mobile gate uses synthetic HTTP responses, including injected
permission/network/render failures. It is not real-account or release acceptance.
The separate `isolated-auth-browser.mts` uses synthetic identities with the real
Server implementation and a real session TTL; its result also does not establish
that a deployed instance serves the selected build. Neither script contacts a
deployed instance. Run `acceptance:safety` first.

## Retained Ticket01 readback and diagnostic probe

To investigate the old UI without creating another Task/Session, set
`WEMUX_LEGACY_RETAINED_FILE` to the protected `retained-private.json` from the
previous authorized write gate and run `real-legacy-regression.mjs`. Do **not**
set `WEMUX_LEGACY_TEST_WRITE`; conflicting flags fail before credential reading
or login. The readback verifies exact Project/Task/Workspace/Worker/Session
bindings through public GET APIs, Task activity association, Test Agent,
terminal history and no Run, then opens the existing Session through the UI.
It does not recreate the transient post-create link. Login and revocation of
only that newly created current login remain the script's identity writes.
Run `acceptance:safety` before every real-identity invocation as above.

Optional `WEMUX_ACCEPTANCE_FETCH_DIAGNOSTICS=1` records a diagnostic-only fetch
observer: local fetch ID, page-local document ID, monotonic time, signal abort,
response status/type, SPA pathname change and pagehide. Browser request IDs
and document fetch IDs are separate namespaces; do not join them by number.
Match kind/order/timing only for investigation, never as automatic acceptance
proof. Paths are immediately reduced to closed request kinds in the binding;
queries, cookies, headers, bodies, exception text, signal reason text and stack
traces are not persisted. The observer leaves response bodies unread and never
changes the classifier. Signal abort alone is **not** an expected-error waiver,
especially after a completed response or a timeout. Instrumentation may affect
scheduling, and a missing binding event is not evidence of no client abort.

Navigation epochs change at observed main-frame confirmation, not when the
script calls goto/reload/goBack. Requests starting after intent but before commit
still belong to the old epoch, but do not acquire pending-at-intent proof.
A failed/unconfirmed navigation never justifies a request failure.

The historical old-frontend SPA/abort investigation remains **unresolved**, not an acceptance gate for the new frontend: the retained read-only probe completed desktop/mobile UI and identity checks but kept unknown cancellations as failures. Ticket01 still needs a bounded new-frontend real-browser gate covering its login/project flows and authorized-project filtering; unverified conditions must be recorded explicitly. Diagnostic unit tests passing is not a substitute for that gate. Do not run the optional old-frontend probe as a prerequisite for subsequent tickets.

## Explicit real Worker Workspace gate (Ticket03)

`real-worker-workspaces.browser.mts` is an opt-in integration test, not part of the
platform-independent default glob. It runs the current Server, two in-process
WorkerRuntime/WebSocketTransport/LocalProvisioner instances with separate SQLite
homes, and desktop/mobile Next UI. No Agent adapters, external Git, installs or
sessions are needed. All projects/workspaces/tasks/enrollment use public HTTP;
Worker ready/failed reports come from actual filesystem/Git execution, never from
injected protocol events.

Build current UI into a newly allocated private directory, then use the browser
preflight (requires already installed compatible Playwright/Chromium):

```sh
RUN=$(mktemp -d /tmp/wemux-real-workspace-run-XXXXXX)
node_modules/.bin/vite build apps/web-next --config apps/web-next/vite.config.ts --outDir "$RUN/ui" > "$RUN/vite.log" 2>&1
# Export absolute PLAYWRIGHT_CORE_PATH and PLAYWRIGHT_CHROMIUM_PATH as above.
WEMUX_NEXT_TEST_DIST="$RUN/ui" timeout --signal=TERM --kill-after=5s 100s \
  node scripts/test-with-browser.mjs -- node_modules/.bin/tsx apps/web-next/tests/real-worker-workspaces.browser.mts \
  > "$RUN/browser.log" 2>&1
```

The script owns a fresh `mkdtemp` root, prints its evidence directory in its final
JSON, and removes only its state directory in `finally` after closing Workers,
transport/stores, Server and browser. Evidence persists outside state. Git children
are restricted to `file` protocol and isolated config/HOME; source repository has
synthetic commits only. No fixed services/evidence directories are used. The
launcher timeout is an emergency bound, not a substitute for normal finally
cleanup; inspect its exit status and `cleanupFailures`.

Pass proves empty directory, pinned commit, genuine missing-tag failure displayed
by Next, tag repair + UI retry, two independent Worker-home placements, and Task
unbind preserving actual files. It does **not** prove Task deletion, Worker CLI
packaging, cross-host isolation, or arbitrary Git branch support. Non-default
remote-only branch resolution is an open defect captured during this gate; see
`docs/acceptance/web-next-project-workspace-task-management.md` latest section.
