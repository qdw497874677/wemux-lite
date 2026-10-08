# Shared conversation recovery acceptance slice

Status: implemented and checked as a read-only client recovery increment. **Ticket04 and the overall 16-ticket effort remain partial.** Independent reviewer gate is still required. There is no new Next UI, Worker host, durable send, Runtime control, mobile or real Server/Worker/Agent acceptance claim.

## Baseline and per-stage provenance

HEAD: `93c9f67cab09ca51bd95d8bdb14d7d0ca99f0255` on `main`. Existing dirty/untracked source is the baseline, not HEAD alone. No staging, commit, dependency install, root build/pack/deploy, live data/credential access or paid runtime was performed. Tests never use port 8004.

The earlier conversation client and accepted provenance/error-body repairs are described separately in [web-next-conversation-client.md](web-next-conversation-client.md):

- Original transport/contract increment: `/tmp/wemux-conversation-client-d6ddc000/`, `increment.patch`, preimages, `increment-sha256.json` and logs. It introduced validated Session/history/send/receipt operations, invalidation-only SSE and the existing native Chromium fixture.
- Accepted P1/P2 follow-up: `/tmp/wemux-conversation-fixes-d23af334/`, `followup.patch`, preimages, `increment-sha256.json` and logs. Omitted `taskId`/`runId` normalize to null without weakening creation. Optional error-body reads are bounded by 15 seconds and 65,536 bytes, preserve known HTTP status and handle cancellation cleanup safely. These repairs are retained unchanged here. Their intentional pre-fix regression failures are historical, not remaining failures.

This recovery increment has three serial ownership stages:

| Stage | Exact files | Evidence directory |
| --- | --- | --- |
| Journal projection | `packages/web-client/src/conversation-projection.ts`; `packages/web-client/tests/conversation-projection.test.mjs` | `/tmp/wemux-journal-projection-wjMmpB/` |
| Read-only controller | `packages/web-client/src/conversation-controller.ts`; `packages/web-client/tests/conversation-controller.test.mjs` | `/tmp/wemux-conversation-controller-r0M4is/` |
| Public integration | `packages/web-client/src/index.ts`; `packages/web-client/tests/conversation-recovery.integration.test.mjs`; `docs/acceptance/web-next-conversation-recovery.md` | `/tmp/wemux-conversation-recovery-ovAIJC/` |

Those **seven paths are the complete integrated recovery changed-file manifest**, not the repository's much larger dirty-file list. All are new relative to their respective stage preimages except `packages/web-client/src/index.ts`, whose pre-existing untracked contents are preserved and extended. Each stage has an exact `incremental.patch` and `hashes-before-after.json`. The integration stage additionally records all 1,091 pre-existing source hashes, verifies the 1,090 non-owned paths unchanged, and records the barrel's exact before/after hash. No component algorithm, transport, contract, server or UI changes were made by the integration stage.

For reviewers tracing the earlier work separately, the original client manifest is `docs/acceptance/web-next-conversation-client.md`, `packages/web-client/src/cluster-client.ts`, `packages/web-client/src/cluster-transport.ts`, `packages/web-client/src/event-stream.ts`, `packages/web-client/src/index.ts`, `packages/web-client/src/session-conversation.ts`, `packages/web-client/tests/session-conversation.browser.mjs`, `packages/web-client/tests/session-conversation.test.mjs`, `packages/web-contract/src/conversation.ts`, `packages/web-contract/src/index.ts`. The P1/P2 repair stage modifies only the earlier acceptance document, transport, conversation operations and conversation Node tests. These earlier manifests are not additional recovery edits.

## Public API handoff

The package barrel now exposes:

- `createConversationProjection(sessionId)`, `appendConversationEvents(previous, events)`, `projectConversationEvents(sessionId, events)` and `ConversationProjectionError`.
- All explicit projection read types, including `ConversationProjection`, `ConversationTimelineEntry`, `ConversationJournalPayload`, text/tool/message/approval/Turn types, usage, runtime/outcome types and projection error codes.
- `createConversationController(scope, port, options?)` and `ConversationScope`, `ConversationReadPort`, `ConversationControllerOptions`, `ConversationReadError`, `ConversationSnapshot`, `ConversationController`.

`createClusterClient(...)` itself satisfies the read port. Construct it for the authenticated account/team, then construct one controller for the immutable account/team/project/task/session scope. The controller subscribes before loading metadata/history, exposes `getSnapshot`, `subscribe`, `refresh`, `retry`, `dispose`, and owns a bounded serial history drain. It does not submit commands, own pending send identities, or infer Task/Turn success from admission. Account/team identity still depends on the authenticated port; HTTP Session records cannot attest those fields. Dispose controller and client when replacing identity, and drop already-delivered snapshots.

Only successfully validated contiguous HTTP history advances the cursor. SSE is invalidation only; forged IDs, payloads, replay and freshness notifications cannot directly modify the transcript. Known Journal variants are validated atomically; unknown kinds remain explicit unsupported entries. Exact replay is idempotent, conflicting sequences fail. Projection snapshots are detached/frozen. Metadata runtime/queue, Journal facts, last-page freshness, subscription state and `needsRefresh` remain separately observable. `ready` is not proof that Worker history is complete; `watching` is not proof of an established connection. Refresh/retry affordances and honest unsupported/error/freshness rendering remain the future UI owner's responsibility.

Permission loss or fixed-scope mismatch scrubs retained controller state and terminates its listeners. Other read errors preserve the last validated projection. Bounded catch-up and separate history/freshness read races await a later invalidation or explicit refresh, rather than timer polling. Previously returned immutable snapshots cannot be retroactively erased.

## Behavioral checks

`packages/web-client/tests/conversation-recovery.integration.test.mjs` imports the built **public package**, creates the actual `createClusterClient`, and supplies `Response`/`ReadableStream` HTTP/SSE fixtures through its existing fetch injection seam. The real transport, operations, controller and projector execute together; controller methods are not mocked. Four tests check:

1. Stream request starts before Session/history reads; initial history paginates; one invalidation recovers multiple missed events; replay notifications do not duplicate output; direct Journal replay is idempotent; conflicting replay rejects; real bounded watch reconnect requests the validated cursor, never an SSE ID.
2. A held old HTTP response resolving after disposal cannot restore old content or notify listeners; retained data is scrubbed and read/watch signals abort.
3. Terminal reconnect HTTP 403 after loaded history blocks and scrubs the controller, exposes only the sanitized permission error, makes no account/CSRF call and does not retry, including after the normal reconnect delay or explicit blocked-controller retry.
4. A known malformed payload that passes envelope checks fails the projection atomically; no partial text or cursor/freshness advancement occurs; there is no spontaneous retry and explicit correction/refresh resumes from the same cursor.

These are **Node injected-response tests, not browser evidence**. The component tests add 16 projection and 47 controller cases, covering variant validation, replay, immutable snapshots, bounded catch-up, races, cleanup and scope isolation in more detail.

## Validation and raw evidence

All final commands exit 0:

```sh
npm run build:packages
node --experimental-strip-types --test packages/web-client/tests/conversation-recovery.integration.test.mjs
npm test --workspace @wemux/web-client
npm run typecheck --workspace @wemux/web-client
npm run typecheck --workspace @wemux/web-contract
npm run typecheck --workspace @wemux/web-next
PLAYWRIGHT_MODULE=/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs \
  node --test packages/web-client/tests/session-conversation.browser.mjs
git diff --check
```

Results: integration **4/4**; full client suite **125/125**; existing native Chromium synthetic test **1/1**, no skips, Chromium **149.0.7827.55**. No unexplained final failure occurred. The unchanged browser fixture proves native fetch/SSE transport behavior only. It does **not** exercise the new controller/projector or new UI, and it does not prove actual Runtime or real Server/Worker authorization/execution.

Integration raw evidence is under `/tmp/wemux-conversation-recovery-ovAIJC/`: `preimages/`, `preimages.json`, `repository-before.json`, `hashes-before-after.json`, `incremental.patch`, `commands.tsv`, full build/test/typecheck/browser logs, `preservation.log`, `diff-check.log`, `status-before.txt`, `status-after.txt`, `staged-before.txt`, `staged-after.txt`, `integrated-manifest.json`. Generated build outputs are ignored; no repository scratch evidence is added. The manifest records stage provenance and final hashes for the seven recovery files.

## Residual risks and next step

- Independent review of the exact three-stage patches and API/state invariants is required before accepting this partial increment.
- No new UI/dual-host/mobile or real Server/Worker/Agent acceptance has been performed. The existing browser transport fixture cannot substitute for those gates.
- Full Journal projection retention/rebuilding is not benchmarked for very long histories. No pruning/checkpoint protocol is added.
- There is no new instantaneous stream permission revalidation guarantee. Revocation becomes known through existing responses/failures; account/team binding and replacement lifetime remain caller responsibilities.
- Durable pending send storage, cross-tab coordination, stop/approval/model controls and Next integration are outside this increment.

Recommended next step: independent review, then a separately scoped UI/host integration with real browser and Worker acceptance. Ticket04/all16 remain partial.

## P2 follow-up: opaque projection extensions

The read-only review identified that checking for a property (`'turnId' in payload`) could treat opaque extensions on non-Turn variants as authoritative Turn identities. The same local boundary existed for `streamKind` extensions on `tool.finished`. Both are repaired by explicit variant discrimination, not by rejecting additional payload fields.

- Only the eleven authoritative Turn-bearing variants create/ensure a projected Turn. `message.queued`, `message.cancelled`, `model.changed`, `runtime.notice`, and `session.runtime.changed` retain string/non-string `turnId` extensions exclusively in their timeline payloads.
- Only `tool.started` and `tool.output.delta` define the projected tool stream classification. A `tool.finished` extension cannot overwrite it or supply a missing classification; the opaque extension is still retained for replay equality and inspection.
- Public APIs, strict known-field validation, contiguous cursor, atomic append, immutable snapshots and exact/conflicting replay policies are unchanged. No controller, transport, UI or protocol edits were made.

Follow-up ownership is exactly `packages/web-client/src/conversation-projection.ts`, `packages/web-client/tests/conversation-projection.test.mjs`, and this append-only acceptance update. The stage started at the same HEAD with 175 dirty entries and an empty index, taking the integrated recovery work as its baseline. Original projector SHA-256: `a44270e37f65cbc10663d2319cb52b630a83775df73e9138c0f8a739eec6596b`. Earlier stage evidence remains untouched.

Evidence directory: `/tmp/wemux-projection-extension-REANUC/`. It contains fresh full preimages of these three files, `repository-before.json`, `followup.patch` (strictly preimage-relative), `hashes-before-after.json`, `preservation.json`, before/after status and index records, and `commands.tsv` with complete validation logs.

Red/green behavioral evidence:

| Check | Result |
| --- | --- |
| New tests against unchanged projector | Expected exit 1: 17 passed, 12 failed (all ten non-Turn extension cases and both tool-finish extension cases) |
| Focused projection tests after fix | Exit 0: 29/29 passed |
| `npm run build:packages` | Exit 0 |
| `npm test --workspace @wemux/web-client` | Exit 0: 138/138 passed, including recovery integration |
| Client and Next typechecks | Both exit 0 |
| `git diff --check` | Exit 0 |

The thirteen added cases also verify all authoritative Turn-bearing variants still ensure Turns, malformed required Turn identities reject a whole append without mutation, retained extras participate in conflicting replay detection, and genuine start/output stream classifications remain effective. The unchanged existing suite covers the remaining strict malformed known fields and atomic/idempotent replay behavior.

This addresses the accepted P2 and its same-seam tool classification issue only. Full-history retention/rebuild remains unbenchmarked; Next UI, dual-host/mobile, durable send, Runtime controls and real Server/Worker/Agent browser acceptance remain deferred. Independent follow-up review is still required. **Ticket04 and all16 remain partial.**
