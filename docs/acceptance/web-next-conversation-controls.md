# Ticket04 shared queue-cancel and Turn-stop admission (partial)

## Delivered boundary

This slice adds typed shared-client admission for two **existing** cluster HTTP routes:

| Shared client method | Existing route | Exact body |
| --- | --- | --- |
| `cancelQueuedMessage(sessionId, submissionCommandId, body, signal?)` | `POST /api/sessions/:sessionId/messages/:submissionCommandId/cancel` | `{ commandId }` |
| `stopTurn(sessionId, body, signal?)` | `POST /api/sessions/:sessionId/turn/stop` | `{ commandId, turnId }` |

The caller owns every ID. IDs are nonblank strings, at most 200 characters, without NUL. Queue cancellation targets the **enqueue commandId**, not the messageId. Stop always names one explicit Turn. Wire fields are copied before any transport/CSRF await. Both methods reuse `createClusterTransport`, preserving origin, team, cookie, CSRF, error, and identity-lifetime behavior. The returned `ConversationControlReceipt` contains only the matching `commandId`. Extra response fields are not interpreted as execution outcomes.

HTTP202 means admission only. It does **not** mean a queued message was cancelled, a Turn stopped, a race was won, or a no-op succeeded. Server still owns authorization and command identity conflict detection. There are no Server/Worker product changes, administrative command polling, Journal mutation/confirmation input, UI changes, new dependencies, or alternate transport stack.

## Durable helper API and ownership

`createConversationControls(scope, { storage, port })` exports:

- `key`, `getSnapshot()`, `subscribe(listener)`;
- `load()` (read only, never sends);
- `submit(intent)` (caller-owned identity; never mints);
- `retry()` (explicit replay of the observed immutable intent only);
- `dispose()` (ends this observer, not remote execution or other observers).

`ConversationControlIntent` is either:

```ts
{ operation: 'cancel-queued', submissionCommandId, body: { commandId } }
{ operation: 'stop-turn', body: { commandId, turnId } }
```

The immutable snapshot contains `scope`, `status`, `intent`, `admission`, and `error`. Status is `unloaded | ready | sending | uncertain | admitted | blocked | disposed`, never `cancelled` or `stopped`. Scope includes normalized HTTP host origin, account, team, project, task and session. All snapshot children and intent copies are frozen. The durable record includes version, full scope key, exact operation/target/body, and optional validated admission receipt. No message draft/schema is reused.

**One unresolved control per scope deliberately serializes both actions.** An uncertain cancel cannot silently be replaced with a stop. Explicit retry never mints or selects a newer active Turn. A new intent requires the previous admission to be durably saved and validated through this authenticated port. This is admission serialization, not a guarantee of execution ordering or an outbox. There is no reset/clear/abandon API hiding unresolved work.

Supply the same `sessionStorage` object through the lazy storage callback. This module reads no browser global during import or construction. Read denial, corruption, nonpersistent/throwing writes, readback failure, and changed/missing identities fail closed. A write that committed then threw retains the attempted identity. Every thrown HTTP error, including 4xx, preserves the original because it may follow an earlier committed attempt. A receipt received before settlement persistence fails may remain in memory, but cannot authorize replacement. A stale instance, including one that previously observed an empty slot, cannot overwrite changed/missing durable identity. Recovery from externally deleted/corrupted storage requires investigation, not minting through that stale controller.

### Authenticated port contract (required integration work)

The **authenticated client owner**, not a component or a caller's storage record, owns the `ConversationControlPort`:

1. Create a port for one immutable full scope and authenticated client lifetime. Bind its `cancelQueuedMessage` and `stopTurn` to the shared client above, and expose the client's identity abort signal.
2. Supply synchronous `assertCurrent(scope, intent): void`. It must throw when this is no longer the current authorized client/scope, or current target-specific permissions disallow the action. It must not return a Promise. Scope and storage alone are not authorization.
3. Keep the **same port object** across same-client remounts. Dispose helper observers on unmount; abort the port/client signal **before** changing authenticated identity/team/client. Do not recycle the port object for a new client. Server authorization remains final, including across transport CSRF refresh.
4. The helper invokes current-authority checks immediately before **both** new and retry dispatch, on explicit join, and before receipt settlement/adoption. Current permission loss prevents dispatch. Aborted old ports cannot settle late receipts. Changes after a client-side check are still enforced by Server.
5. Same-port, same-storage, same-scope duplicate calls and explicit remount retries share a flight. Each observer independently validates and adopts settlement, so disposing one or changing storage during another's callback does not falsely admit the others. Load/subscription never joins or sends automatically.
6. A different port cannot join an old port's flight or use its receipt to authorize a replacement. A durable receipt loaded after a true refresh/new client is visible as historical admission but remains `uncertain` for replacement authority until an **explicit same-intent retry through the new current client** validates it. Retry can be denied by current Server authorization; preserve the original.

Coordination is same JavaScript realm/tab and same injected storage object only. No cross-tab compare-and-swap, tamper resistance, distributed exactly-once, or automatic permission refresh is claimed. No native/paid runtime is invoked.

## Behavioral verification

Reproducible from repository root (Node supports strip-types; dependencies already installed):

```sh
node --experimental-strip-types --test packages/web-client/tests/conversation-controls*.test.mjs
npm run build:packages
npm test --workspace @wemux/web-client
npm run typecheck --workspace @wemux/web-client
npm run typecheck --workspace @wemux/web-contract
./node_modules/.bin/tsx --test apps/server/src/test/session-workbench.test.ts apps/server/src/test/session-authorization-http.test.ts apps/server/src/test/session-effect-authorization.test.ts apps/server/src/test/conversation-controls-admission-http.test.ts
./node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit
./node_modules/.bin/tsc -p apps/web-next/tsconfig.json --noEmit
```

New shared behavior covers exact escaped routes/body and matching receipts, bounded IDs, CSRF-await mutation, duplicate clicks, synchronous observer reentrancy, commit-then-lost 4xx retry, reopen without auto-send, fixed Turn target, scope/port change, permission loss before new/retry dispatch, stale/empty/missing/replaced/corrupt storage, write/read/settlement failures, immutable snapshots, independent concurrent joiner settlement, local disposal, and late old-client receipts. The public HTTP fixture uses real cookie login and isolated in-memory SQLite; tests consume an admitted response then replay it, verify one persisted command, reject same-ID changed targets, deny both new and replay after Project permission loss, and verify enqueue commands remain pending. No Worker executes these commands. Ports are dynamically allocated and owned fixtures close.

Raw red/green logs and provenance are in `/tmp/queue-stop-evidence/`. `client-red.log` establishes the missing API (20/20 expected failures). `client-reentrancy-red.log` captures 2 new failures (duplicate observer dispatch and joiner adopting changed storage) before fixes. `client-snapshot-red.log` captures a mismatched old receipt after failed next persistence; `client-empty-stale-red.log` captures an empty stale observer replacing a newer identity. All are implementation regression evidence, not baseline failures. The new Server admission cases were green against existing product code; no artificial backend red or product patch was introduced.

Final validation: focused new client controls 30/30, full shared client 200/200, public HTTP plus relevant Server regressions 10/10 (2 new cases); package builds, shared client/contract typechecks, Server noEmit and Next noEmit all passed. Preservation manifest and exact logs are recorded in the run report. `before-hashes.json`, copied preimages, initial HEAD/status/index patch, `incremental.patch`, and `after-hashes.json` distinguish this increment from extensive pre-existing untracked work. Ordinary `git diff` alone is insufficient for these files. No staging, commit, reset, stash, clean, install, deployment, root/legacy build, or Worker pack was performed.

## Provenance, limits and handoff

Contracts were checked against `packages/web-client/src/cluster-transport.ts`, `apps/server/src/http/routes/session-routes.ts`, `apps/server/src/application/server-service.ts` (`cancelQueued`, `stopTurn`, `sessionControl`), and existing `session-workbench`/`session-authorization-http` fixtures. The earlier execution-controls scout was a discovery aid, not validation evidence. Existing submission/controller/projector code was read for principles but not changed.

Ticket04 and the broader 16-ticket acceptance remain **partial**. No acceptance boxes are checked. This is not approval/model selection or execution-outcome integration. Next UI, real browser/mobile, visual, real Worker/native Runtime, reliable connection execution races, and dual-host behavior remain unverified here. Next noEmit only detects composition type breaks, not UI integration. A future owner must bind the authenticated port to actual current permission/target observations, render admission/uncertainty distinctly from execution, and combine authorized read metadata with validated Journal outcomes without inventing confirmation authority. Independent review is required before accepting this shared-client slice.

## Next integration increment (Ticket04 still partial)

Prior shared slice accepted independently: review `cd8e3f73` was **OK with notes**, with parent verification of 30/30 focused tests and nine source hashes. This records that bounded acceptance only, not the whole Ticket04 or all16. The earlier shared-slice history above is retained.

This increment mounts `ConversationControls` beside the existing composer. It renders authoritative queued messages, targets the enqueue **commandId**, and stops only the explicitly displayed Turn. Chinese accessible names include exact targets. Buttons reuse existing mobile-capable tokens/layout. No approval/model-decision UI, composer/submission/controller/projector redesign, global styles, Server/Worker product changes, admin command polling or parallel API stack was added.

### Identity and lifetime

`createClusterClient` accepts an optional fourth `authenticatedAccountId` and exposes immutable `controlIdentity: { accountId, signal }`. `application` supplies the verified login/me `user.id`, preserves it across a same-account team replacement, and clears it on retirement/logout/401/account replacement. Missing or invalid ID fails closed; username is never an ownership substitute. The transport **already exposed** its lifetime signal, so its implementation was not changed.

A client-keyed WeakMap owns normalized full-scope ports. Components attach current readers with lease tokens; an older cleanup cannot detach a newer reader. Detach removes authority without aborting the client-owned port or other observers. Actual client retirement aborts the existing transport signal. Shared helper observers are locally disposed. Same-client remounts reuse the port but never auto-dispatch. New clients cannot adopt old flights/receipts to authorize replacement.

Compatibility boundary: existing reader/composer partitions still use the client username. Controls separately check that exact reader partition and team/project/task/session, while control storage and target ownership use verified server account ID. No old draft/storage migration is attempted. Execution binding pins Workspace/Worker/Agent, not Model (which may legitimately change for subsequent Turns). Current ready metadata, read/write access, lifecycle, binding and own-target-or-canControl policy are checked for both new and retry requests; `sendCapability` is not a control permission. New actions require the currently observed target. A missing old target disables ownership-only retry with an explanation; current controllers may explicitly retry that exact old target, subject to Server authorization.

Every explicit new click fixes target and new command ID before awaits. Original retry never mints or follows a newer Turn. One unresolved request visibly blocks both actions. Storage denial produces zero POST; missing/corrupt/failed persistence stays fail-closed. Explicit storage reload is not a promise to recover deleted data or erase unresolved identity. A receipt means only **request received**; it does not remove queue entries or claim cancelled/stopped/no-op/queue-drain success. Metadata and validated Journal remain independent observations.

### Reproducible checks and evidence

Run from repository root, using existing installed browser configuration (do not weaken the gate):

```sh
node --experimental-strip-types --test apps/web-next/tests/conversation-control*.test.mjs apps/web-next/tests/control-application-lifetime.test.mjs packages/web-client/tests/control-identity.test.mjs
npm run build:packages
npm test --workspace @wemux/web-client
PLAYWRIGHT_CORE_PATH=/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs PLAYWRIGHT_CHROMIUM_PATH=/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome npm run test:prepared --workspace @wemux/web-next
npm run typecheck --workspace @wemux/web-next
npm run typecheck --workspace @wemux/web-client
node --experimental-strip-types --test packages/web-client/tests/client.test.mjs packages/web-client/tests/control-identity.test.mjs packages/web-client/tests/conversation-controls*.test.mjs
./node_modules/.bin/vite build --config apps/web-next/vite.config.ts --outDir /tmp/next-controls-dist
PLAYWRIGHT_CORE_PATH=/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs PLAYWRIGHT_CHROMIUM_PATH=/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome WEMUX_NEXT_TEST_DIST=/tmp/next-controls-dist ./node_modules/.bin/tsx apps/e2e/next-controls-browser.mjs
# Same environment for existing next-composer-browser.mjs and next-conversation-browser.mjs.
```

Verified: new focused 11/11; full shared client 202/202; full Next 150/150; relevant transport/control regression 45/45; package build, Next/client typechecks and private Vite build. Real owned Chromium desktop+mobile controls 22 checks, existing composer 30 checks, existing conversation 45 checks. All browser fixtures use isolated temporary SQLite/dynamic ports and close owned fixtures. No paid/native runtime or live database was used.

Controls browser cases consume actual HTTP202 bodies before injected loss or hold. They verify exact cancel/stop bodies, remount original retry, zero POST on persistence denial, double-click deduplication, unresolved cancel blocking stop, old Turn retention after next Turn, archive/stale metadata denial, independent held response release after Session and Task changes and after team/account disposal, contributor ownership with server ID unequal to username, live viewer role loss, and disappeared own-Turn retry denial followed by controller replay. Persisted details are read through `getPendingCommand` after bounded summary enumeration; all observed identities match unique persisted controls and remaining enqueues stay pending. Synthetic cache events are explicitly **not real Worker execution proof**.

Raw evidence: `/tmp/next-controls-evidence/`; controls `/tmp/wemux-next-controls-browser-LLf9Fo/`; composer `/tmp/wemux-next-composer-browser-YFslOt/`; conversation `/tmp/wemux-next-conversation-browser-G3PKAB/`. Gate test was red before implementation; glue regression also fails against copied preimages. Initial new-test failures (incomplete Response stub, assuming a failed initial storage write could be reset, expired fixture login token) were corrected only in tests; no baseline or backend failure was patched around. Source preimages, pre/post hashes, incremental new-file-aware patch, HEAD/index preservation and exact command logs accompany the worker report.

Independent review is required for this integration. Screenshots were captured, but are **not visual approval** (the execution model could not inspect image pixels). Strict Mode effect replay is covered by helper/port lifecycle behavior tests, not a separate React StrictMode browser mount. Real Worker/native Runtime, cancellation/finish race execution outcomes, dual-host controls, approval/model UI, full mobile workflow and the whole-ticket acceptance remain unverified/partial. No acceptance boxes changed.
