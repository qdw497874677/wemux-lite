# Next read-only conversation view acceptance slice

Status: implemented and behaviorally checked; independent review and visual approval pending. **Ticket04 and the overall 16-ticket effort remain partial.** This is a product-dashboard increment, not a landing redesign or complete conversation execution delivery.

## Scope and baseline

Baseline HEAD: `93c9f67cab09ca51bd95d8bdb14d7d0ca99f0255`, with the existing dirty/untracked work preserved as the actual preimage. The accepted shared recovery/controller/projector follow-up is consumed unchanged. See [web-next-conversation-recovery.md](web-next-conversation-recovery.md) for those separate stages.

Exactly seven paths belong to this increment:

- New `apps/web-next/src/components/SessionConversation.tsx`.
- Modified `apps/web-next/src/components/TaskSessions.tsx`: opening controls, selected-session surface and accurate read-only copy; creation/retry operation body unchanged.
- Modified `apps/web-next/src/components/TaskDetailPanel.tsx`: selection prop plumbing only.
- Modified `apps/web-next/src/components/ProjectTasks.tsx`: Task/Session URL state and preservation of unrelated search/hash state.
- Modified `apps/web-next/src/styles.css`: scoped token-based wrapping, disclosure, focus and mobile styles.
- New `apps/e2e/next-conversation-browser.mjs`.
- New this acceptance document.

No shared client, controller, projection, contract, Server, Worker, authentication, existing browser test, package or dependency changes. No staging/commit/reset/clean/stash/push, root build, pack, deploy, live DB access or paid model requests. All fixtures bind ephemeral ports, never port 8004. Next Vite builds are under the owned `/tmp` evidence directory only.

## Public API and lifetime

`SessionConversation` accepts the existing `ProjectClient`, `ProjectDTO`, fixed Task and requested Session IDs plus a close callback. It uses the same client’s `taskSessionScope` (`host`, `account`, `teamId`), without inventing a team ID or building another transport/projection stack. Missing/blank account/team identity or a project/team mismatch displays a local error without constructing a controller. A whitespace-only Session selection also fails locally.

One immutable host/account/team/project/task/session scope creates one `createConversationController` in an effect, not during render. The component subscribes, reads snapshots and disposes/unsubscribes on replacement/unmount. Both client-object and scope-key checks hide old snapshots during render before effects run; callback lifetime guards prevent delayed responses from restoring old content. Explicit retry of a blocked controller creates a fresh lifetime for the **same** selected Session and requires fresh authorization; normal retry/refresh call the existing controller methods.

Authorization and fixed Project/Task/Session checks remain the shared controller and public Server read responsibility. Unknown, unauthorized or wrongly bound Session URLs never select another Session. URL `?task=...&session=...` survives reload/back; changing or closing Task clears Session. Closing Session keeps Task. Unrelated query parameters and hash are preserved.

The surface separates authoritative current metadata/runtime/queue count and metadata freshness from validated Journal facts, HTTP-page freshness and the applied contiguous cursor. `watching` is explicitly not proof of a connected stream or complete Worker history. Loading, empty, refreshing, read error, blocked, offline, `needsRefresh`, retry and refresh are visible. Messages, merged assistant/reasoning/plan segments, tools, approvals, model history, notices, usage, compaction and Turn failures are rendered from shared projection types. Unsupported events are explicitly identified.

Tools are keyboard-operable native disclosures. Strings are escaped React text, initially limited to 4,000 characters with repeatable “show more”; all available text remains selectable/reachable. Structured data uses lazy nested field/list disclosures, 30 fields at a time, rather than unlimited eager JSON stringification. Long text wraps within a bounded vertical scroll area. There is no raw HTML execution and no send/stop/approval/model mutation control. Pending approval is display-only even after Turn termination.

## Browser evidence and limits

Repeatable browser script: `apps/e2e/next-conversation-browser.mjs`.

Final confirmation: **45 checks passed**, desktop 1440×1000 and mobile 390×844, Chromium 149.0.7827.55. Evidence: `/tmp/wemux-next-conversation-browser-WmA3YM/`. A preceding repaired-oracle run also passed 45 checks at `/tmp/wemux-next-conversation-browser-6wCAEU/`.

The script creates its own temporary Server/SQLite and synthetic owner/viewer identities, Worker capability/Workspace fixtures, Task-bound Sessions through public HTTP, and synthetic Journal/cache ingress through the isolated store. UI reads use the actual authenticated shared client, actual public HTTP history, native SSE, controller and projector. It observes real HTTP read/reconnect cursors and verifies zero browser conversation writes. Session permission removal/restoration uses actual public Server access APIs. **Synthetic ingress is not real Worker transport, Agent Runtime, actual tool execution or paid model evidence.**

Covered in both viewports:

- Actual Task Session list opens via keyboard; focus reaches conversation heading; reload/back retains selection.
- Empty history and authoritative metadata, reasoning/plan, unresolved approval, notices, failure, usage and model history.
- Escaped tool input/output, keyboard disclosure, incremental access to output tail, no injected HTML or enabled mutation controls.
- Incremental SSE invalidation triggers HTTP catch-up without duplicate text; missed events recover after native stream reconnect at the exact contiguous cursor.
- Offline freshness; injected HTTP 503 preserves validated history with an explicit error/refresh requirement; explicit retry recovers.
- Browser-consumed prior history is deliberately held, selection changes, then the old body is released; a DOM observer plus two frames and a following MessageChannel task observes no old transcript flash.
- Task switch/close clears Session while preserving unrelated search, Session close retains Task.
- Wrong Task binding, missing Session and whitespace-only Session fail without fallback.
- Real Server Session permission loss scrubs metadata/history; retry while denied stays blocked; retry after restoration reauthorizes the same Session.

Final screenshots (preserved):

- `/tmp/wemux-next-conversation-browser-WmA3YM/desktop-conversation.png`
- `/tmp/wemux-next-conversation-browser-WmA3YM/desktop-expanded.png`
- `/tmp/wemux-next-conversation-browser-WmA3YM/desktop-blocked.png`
- `/tmp/wemux-next-conversation-browser-WmA3YM/mobile-conversation.png`
- `/tmp/wemux-next-conversation-browser-WmA3YM/mobile-expanded.png`
- `/tmp/wemux-next-conversation-browser-WmA3YM/mobile-blocked.png`

**Visual inspection is not claimed.** The writer image reader reported that this model cannot view images. Parent explicitly approved continued behavioral/geometry validation and retained visual approval as a parent/reviewer task. Measured DOM observations (`desktop-geometry.json`, `mobile-geometry.json`): desktop document width 1440/viewport 1440, panel 858; mobile document width 390/viewport 390, panel 332; three keyboard-native summaries in the expanded surface. Keyboard Enter opens the tool and list selection, and heading focus is asserted. These observations do not replace visual review. Parent subsequently attempted `vision_analyze`, but its configured visual model was unavailable (`my-codex/gpt-5.6-luna` not found). No image provider was configured, installed or substituted. Visual acceptance therefore remains explicitly unverified, not merely awaiting an already available inspection result.

Each browser run retains `result.json` (or failure evidence), `*-delayed.json`, `*-reconnect.json`, screenshots and `cleanup.json`. Owned browser/Server are closed and both application and transport SQLite files removed by the new script. No fixture cookies/passwords/database are persisted as evidence.

### Reconnect oracle red, repair and negative control

The first browser iteration passed 41 checks at `/tmp/wemux-next-conversation-browser-hqKuUG/`. After adding blank-identity/restored-permission checks, a concurrent final run failed on mobile's reconnect cursor assertion at `/tmp/wemux-next-conversation-browser-j14xGH/`; desktop passed. This historical red is retained, not represented as green.

The old test clicked refresh and awaited a cursor already visible, then destroyed the stream. That was not a drain-completion or reconnect-request barrier: an outstanding HTTP drain could catch up before the scheduled reconnect. The old failure did not persist complete read/stream arrays, so its exact alternative request ordering cannot be reconstructed. This is a bounded oracle diagnosis, not proof of a product bug or an invented historical trace. Parent approved new-test-only synchronization repair; no product/shared source changed for this repair.

The repaired test holds an actually browser-consumed `Response.json` history body before projection application. The serial controller drain cannot advance past validated prefix 14 while held. It independently awaits a new native reconnect request observed by the owned Server and checks exactly `fromSeq=15`, with `consumed=true`, `released=false`, then releases history and verifies catch-up through 16 without duplicates. No fixed sleeps, network-idle surrogate or later-DOM cursor comparison.

Bounded negative control `WEMUX_CONVERSATION_RECONNECT_NEGATIVE_CONTROL=1` rewrites only the owned browser’s reconnect request cursor to 9999. `/tmp/wemux-next-conversation-browser-o8K3Vi/desktop-reconnect.json` records expected 15/observed 9999 while the body is held, and the exact assertion rejects with expected exit 1. It validates the cursor oracle’s sensitivity, not a product-source mutation or a claim of comprehensive forged-SSE UI coverage. Normal repaired runs passed both viewports twice afterward/around this control. Failure logs, repair preimage and diagnosis are preserved in the main evidence directory.

## Commands and provenance

Main evidence root: `/tmp/wemux-next-conversation-view-6HiJBW/`.

`preimages/` contains exact originals of the four modified paths; the other three are new. `repository-before.json`, `preservation.json`, `hashes-before-after.json`, `incremental.patch`, `build-provenance.json`, `commands.tsv`, status/index records and logs permit independent reconstruction relative to the dirty baseline. `reconnect-preimage.mjs`, `reconnect-initial-red.log` and `reconnect-diagnosis.txt` preserve the intermediate browser repair boundary. Product source hashes, final assets and screenshots have explicit provenance. Non-owned source preservation and empty index are checked, not inferred from a large HEAD diff.

All final normal commands exit 0:

```sh
npm run typecheck --workspace @wemux/web-next
npm run typecheck --workspace @wemux/web-client
node --experimental-strip-types --test packages/web-client/tests/conversation-{projection,controller,recovery.integration}.test.mjs
npm test --workspace @wemux/web-client
PLAYWRIGHT_CORE_PATH=/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs \
PLAYWRIGHT_CHROMIUM_PATH=/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome \
  npm run test:prepared --workspace @wemux/web-next
node_modules/.bin/vite build --config apps/web-next/vite.config.ts \
  --outDir /tmp/wemux-next-conversation-view-6HiJBW/final-dist
# Both browser commands also use the explicit Playwright paths above:
WEMUX_NEXT_TEST_DIST=/tmp/wemux-next-conversation-view-6HiJBW/final-dist \
  node --import tsx apps/e2e/next-conversation-browser.mjs
WEMUX_NEXT_TEST_DIST=/tmp/wemux-next-conversation-view-6HiJBW/final-dist \
  node --import tsx apps/e2e/next-task-session-browser.mjs
git diff --check
```

Results: targeted projection/controller/public integration **80/80**, full shared client **138/138**, existing full Next **139/139**, all zero skips; both typechecks pass. Existing unmodified Task Session browser regression **29 checks** on final build, final evidence `/tmp/wemux-next-task-session-browser-jKmhRM/` (also passed `/tmp/wemux-next-task-session-browser-q6jA2S/`). New browser final **45 checks**. The historical mobile oracle failure exits 1 and bounded negative control intentionally exits 1; neither is silently counted as a passing normal run.

Next `test:prepared` runs the entire existing test glob with documented explicit installed browser paths and existing prepared dependencies. Its automatic standalone pretest was not invoked because it builds the legacy Web repository dist, outside this owned-/tmp-build scope. No gate/config changes or skipped test substitutions were made. Existing build artifacts used by tests are recorded in provenance; no root build/deploy was run.

## Remaining work

- Independent code review and parent visual screenshot approval are still required.
- No dual-host Worker Web UI, real Runtime execution, durable send, queue editing, cancellation/stop, approval mutation, model mutation or complete Ticket04 acceptance.
- Missing-team handling is implemented explicitly but not an actual authenticated browser missing-team fixture; client-object/identity replacement safety uses existing application lifetime and component guard, while the new browser directly exercises Session and Task replacement.
- Full Journal retention/projection rebuild remains the inherited unbenchmarked long-history risk; this view bounds tool text/field disclosure, not retained Journal memory or total list virtualization.
- Permission loss is detected by existing HTTP/SSE authorization failures/refresh; no new instantaneous revocation guarantee is introduced.

Recommended next step: review the seven-path preimage-relative patch and screenshots, then accept only this read-only Next slice. Keep Ticket04/all16 partial and plan execution/dual-host/real Runtime acceptance separately.
