# Credential-free abort race fixture

This is diagnostic mechanism evidence, **not Ticket01 acceptance**. It never loads account credentials or contacts the deployed instance. Only GETs reach a dynamically allocated loopback HTTP server. No Task, Session, model execution, database or release is created/modified.

```sh
PLAYWRIGHT_CORE_PATH=/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs \
PLAYWRIGHT_CHROMIUM_PATH=/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome \
WEMUX_ABORT_FIXTURE_EVIDENCE=/tmp/wemux-ticket01-abort-fixture/browser \
node --test apps/web-next/tests/abort-race-fixture.test.mjs
```

The browser test explicitly skips if Chromium configuration is absent; the classifier counterexample test always runs. `npm test --workspace @wemux/web-next` runs both when these variables are exported. Evidence defaults to `/tmp/wemux-ticket01-abort-fixture/browser/events.json` (0600). Use distinct directories to retain multiple runs.

## Boundaries

- esbuild bundles the **current source** `apps/web/src/api/client.ts`, with `@wemux/web-client` explicitly resolved to `packages/web-client/src/index.ts`. Project/Session SSE subscriptions and shared transport scope cancellation are real library code, not a reimplementation. Imports do not bootstrap the application. The fake HTTP service implements no identity/domain persistence.
- Real `QueryClient` from `@tanstack/react-query` calls `fetchQuery` and `cancelQueries`; the query functions call the real API transport. `history.pushState` and explicit cleanup are a **synthetic route host**. The actual router, React component unmount and `useProject` hook are not mounted. This proves Query cancellation can cause the observed class of short read, not that it caused any historical request.
- Local request IDs (`fixture-<scenario>-<counter>`) are carried in `x-fixture-request-id`. Document signal events, Playwright request/response/failure events and server events use the exact same ID, rather than path/time proximity. Only synthetic paths and closed event metadata are persisted; no URLs, request/response bodies, cookies, account IDs or credential headers are retained.
- `documentSeq` orders events within a page. `hostMs`/`seq` order arrival at the Node collector, not a synchronized distributed clock. Server headers/finish/close record what the fixture actually sent and whether the response completed; they do not claim that every sent byte reached Chromium. Chromium can retry a disconnected GET under the same request ID; all server attempts are preserved.
- The SSE test waits for browser/document 200 before calling the real unsubscribe closures. The scope test sends incomplete 401 headers through the real Session events reader, aborting the existing Project/Session SSE scope. The Query test holds all headers until explicit cancellation. The late-request test holds navigation response headers while an old-document timer starts then aborts a fetch. Timing assertions require navigation intent < request < commit and old epoch/no pending-at-intent evidence. The 100/200 ms timers induce this window; a slow scheduler causing a different order must fail, not be silently waived.
- Network loss is a server socket destruction without client abort. Completed private 401 and 500 requests demonstrate that `requestfinished` is possible for HTTP errors. A fetched `/favicon.ico?fixture=1` is explicitly aborted as a **path counterexample**, not a reproduction of Chromium's automatic favicon loader. Its query avoids Chromium's special bare-favicon interception in this environment; the original favicon incident remains unproven.
- All demonstrated cancellation failures remain false under the unchanged `expectedAcceptanceAbort` when lacking its required navigation evidence. The fixture does not modify the acceptance classifier or console policy. The earlier broad console exception was already repaired by a separate console writer before this fixture run, using `acceptance-auth-diagnostics.mjs` and its tests; the orchestrator confirms independent review passed. This fixture does not claim that repair.

## Red control

To verify the race depends on Query cleanup rather than the failure classifier, call `runAbortRaceFixture({ mutation: 'omit-query-cancel', evidence: '/tmp/wemux-ticket01-abort-fixture/mutation' })` from an ESM Node entry with the same browser environment. It must fail the bounded event barrier: requests reach the server, but no Query signal abort appears before cleanup. The mutation only removes the test host's cancellation call, never edits product code or classifier policy.

The local mechanisms do not establish the source/release executing on the older deployed Web. Historical requests lacked the shared ID and server ledger. Retain all original 28 and probe4 13 unexpected failures and the favicon incident until separately authorized investigation closes them. The historical console-policy finding is resolved by the separate prior repair, not an open blocker attributed to this fixture. The original fixture worker run timed out after writing its artifacts; bounded follow-up corrected documentation and checked existing evidence without rerunning browsers or builds.
