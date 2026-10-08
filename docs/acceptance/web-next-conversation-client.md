# Shared conversation client acceptance slice

Status: implemented and checked as a browser-client contract slice only. Ticket04 and the overall 16-ticket effort remain partial. No Next surface, projection/controller, durable send storage, Worker host adapter, or runtime feature is completed by this increment.

## Scope and source provenance

Source baseline: `93c9f67cab09ca51bd95d8bdb14d7d0ca99f0255` on `main`, with substantial pre-existing uncommitted changes. Existing source, not HEAD alone, is the implementation baseline. No files were staged.

Verified routes and actual wire definitions:

- `apps/server/src/http/routes/session-routes.ts`: authenticated Session view, messages, events and stream.
- `apps/server/src/application/server-service.ts`: Session view, enqueue admission and actual `{commandId,messageId,status}`, separate events/freshness reads.
- `apps/server/src/storage/sqlite/store.ts`: inclusive history cursor, contiguous cache ceiling, nullable next-page cursor.
- `apps/server/src/http/sse.ts`: `session.event`, `freshness`, comments/heartbeats, replay and live notification pump.
- `apps/server/src/http/routes/admin-routes.ts`: **command observation is administrator-only**, not an ordinary Session-member route.
- `packages/server-domain/src/projections.ts`: actual command status vocabulary includes `cancelled`, not `queued`.

Fresh preimages, SHA-256 manifest, source-provenance hashes, incremental patch and raw command logs for this run are retained under `/tmp/wemux-conversation-client-d6ddc000/`. The patch is relative to those preimages, including existing untracked client sources, not a misleading HEAD-only diff.

## Public seam

`createClusterClient` now includes `sessionConversationOperations`:

- `getSession(id, signal?)`: validates requested Session identity, binding, access, queue, send capability and freshness shape. Nullable Task identity is retained for existing legacy wire records; it does not authorize new Task-free Sessions.
- `sessionHistory(id, fromSeq = 1, limit = 500, signal?)`: validates Session identity, safe positive inclusive cursor, limit 1–1000, contiguous page sequence, timestamp/payload envelopes, freshness identity/frontier and advancing continuation cursor. No missing row is silently skipped within a returned page. `nextSeq: null` is not a permanent end-of-history assertion: Server reads freshness separately and that frontier can already be newer than the page. Consumers must retain their validated event position and re-read on invalidation.
- `sendMessage(id, {commandId,messageId,content}, signal?)`: copies exactly these three wire fields before awaiting, preserves text, requires caller-owned identities, validates both receipt identities and actual command status. No IDs are generated; no uncertain POST is automatically retried. The existing single CSRF refresh/retry policy remains and reuses the copied body. Server remains authoritative for byte/envelope limits and admission. A network/contract error can occur after admission; retain the original identity/body. Abort is not message retraction.
- `commandReceipt(commandId, signal?)`: a one-shot validated read of `/api/commands/:commandId`, including command identity. This does not poll and does not imply permission for non-administrators. Existing 403 remains a permission error. Command acceptance/completion is **not** evidence of Turn completion.
- `watchSession(id, {fromSeq, onInvalidate, signal?, maxReconnects?, reconnectDelayMs?})`: returns `{done, dispose}`. Observe `done` for terminal errors. Subscribe before loading history. `fromSeq` is called per connection and must come from caller-owned validated HTTP history, never external SSE IDs. Disposal/caller abort resolves quietly; the originating 401 rejects and invalidates the account scope.

History payloads are deliberately `Record<string, unknown> & {kind: string}`. Envelope validation is not validation of every Journal variant, a reducer, or a projection. Consumers must validate variant fields before interpreting them. No future ADK/invocation or next-turn switching vocabulary is invented.

## Stream ownership and bounds

`createClusterTransport.stream` reuses the same origin/API allowlist, Cookie, team query, no-store, redirect rejection, abort lifetime and HTTP error handling as JSON requests. Team identity is captured at construction instead of following later mutations of the supplied object. Dispose before changing account/team/host. Forbidden GETs never refresh CSRF; 401 invalidates the shared scope once. Non-401 failures preserve HTTP status, reason code and message; 401 retains the existing immediate invalidation/localized error policy.

Watch delivers **invalidation only**, with no payload or ID argument. Even malformed JSON or a forged high `id` can at most trigger a refresh, never advance a verified cursor or enter projected history. Unknown event names/comments are ignored. SSE parsing supports split UTF-8 and CR/LF/CRLF, multiple data lines, and incomplete EOF frames. Invalid UTF-8 and frames exceeding 1,048,576 UTF-16 code units fail closed; ignored fields/comments count toward that frame budget. Input decoding uses at most 4096 bytes at a time. Readers are cancelled and locks released on EOF/error/abort; callbacks after abort or scope disposal are suppressed, including late fetch responses and additional events in the same chunk.

Connection establishment has a 15-second timeout; an established idle stream has no artificial lifetime limit. Reconnect is bounded to three retries by default, configurable 0–10 total per watch, with 10–30000 ms delay (default 1000 ms). Only network failure/EOF reconnects; HTTP errors and contract failures terminate. SSE IDs are ignored on every connection. A higher layer must decide when to start a fresh watch after exhaustion and whether to poll; there is no hidden infinite reconnect loop here.

## Checked evidence

Commands run after package edits, all exit 0:

```sh
npm run build:packages
npm test --workspace @wemux/web-client
npm run typecheck --workspace @wemux/web-client
npm run typecheck --workspace @wemux/web-contract
npm run typecheck --workspace @wemux/web-next
PLAYWRIGHT_MODULE=/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs \
  node --test packages/web-client/tests/session-conversation.browser.mjs
```

- Client workspace: **48/48** tests passed, including **14** added conversation behavioral tests. Exact routes/bodies, permissions, receipt mismatch, network ambiguity, same-identity caller retry, immutable CSRF retry, malformed histories/views/cursors, split streams, parser limits, reconnect bounds, stale identity and cleanup are covered.
- Chromium **149.0.7827.55**: **1/1** browser test passed, exercising actual browser native fetch against a synthetic dynamic-port HTTP/SSE fixture, exact send body, HTTP history, split UTF-8/CRLF, bounded reconnect without SSE-ID cursor advancement, identity disposal, 403 and 401.
- Browser test is a separately invoked test under `packages/web-client/tests`; it is intentionally not hidden in the default Node-only test glob. Set `PLAYWRIGHT_MODULE` to an already installed Playwright-compatible module. Without it the browser test reports skipped, not proven.
- No root build, install, pack, deploy, live credentials/DB, paid runtime call or port 8004 was used. No gate configuration was changed.

## Residual gaps

This is not real Server/Worker/Test Agent browser acceptance. The browser fixture cannot prove backend admission, command replay fingerprint behavior, real authorization, runtime execution, actual Journal projection, mobile/dual-host UI, or permission revocation of an already-open server stream. No existing Server cookie-expiration revalidation guarantee is added. Durable pending send storage, cross-tab coordination, controller reconciliation, turn completion, stop/approval/runtime controls, model switching, and Next UI integration remain outside this seam. HTTP JSON uses the existing transport's parsing/timeouts; the explicit parser memory bound applies to SSE frames. No unrelated gate failure was observed in the checks above; broader backend/runtime suites were not run. Independent reviewer gate remains required.

## Review follow-up: omitted provenance and stalled HTTP error details

The accepted review findings P1/P2 are corrected in the shared client only. This follow-up does not close Ticket04/all16 or expand into Server, Worker, Next UI, discovery E2E or runtime acceptance.

- **P1:** `getSession` normalizes omitted `taskId` and/or `runId` to `null` before validating the read view. Existing strings/null survive unchanged; invalid numbers, booleans, arrays, objects and empty/whitespace strings still fail. The public nullable type is unchanged. Task-bound creation validation is untouched.
- **P2:** Once stream headers arrive, the establishment timer is cleared and optional error-detail parsing owns a separate bounded lifetime. A known 403 remains forbidden even if details stall, fail, exceed the bound, or are malformed; watch never retries that response as a network error. Shared HTTP error details now have a 15-second read limit and 65,536-byte cap. Scope/caller cancellation takes priority. The reader is cancelled and its lock released, with cancellation promises handled but not awaited indefinitely; a late cleanup rejection cannot create an unhandled rejection or hide the received status. No public test-only configuration was added. Successful SSE parsing and normal stream lifetime are unchanged.

Fresh, separate follow-up evidence: `/tmp/wemux-conversation-fixes-d23af334/`. Original `/tmp/wemux-conversation-client-d6ddc000/` evidence is unchanged. New evidence includes preimages, pre/post hashes, source provenance, preservation inventory, exact `followup.patch`, and command logs.

Intentional regression red was recorded **before product edits**: eight review regressions, seven failed and the malformed/present provenance control passed (exit 1). Tests use injected streams and controlled Node timers, not 15-second sleeps or a widened transport configuration. The same eight tests then passed (exit 0). Two additional cases cover failed/malformed/oversized error bodies and delayed cancellation rejection.

Final checks, all exit 0:

- `npm run build:packages`
- `npm test --workspace @wemux/web-client`: **58/58**, including ten new review tests.
- `npm run typecheck --workspace @wemux/web-client`
- `npm run typecheck --workspace @wemux/web-contract`
- `npm run typecheck --workspace @wemux/web-next`
- `PLAYWRIGHT_MODULE=/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs node --test packages/web-client/tests/session-conversation.browser.mjs`: existing unchanged synthetic browser test, **1/1**, Chromium **149.0.7827.55**.
- `git diff --check`

The intentional pre-fix red is not a remaining validation failure. Independent review of this follow-up is still required. Existing administrator-only command observation, envelope-only history validation, bounded watch recovery, and absence of real Server/Worker/Agent and dual-host/mobile acceptance remain unchanged limitations.
