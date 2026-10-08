# Durable file admission: internal Server result ingress

## Status and scope

Implemented and loopback-checked the explicitly opted-in `WorkerGateway` / `ServerTransportStore` result ingress into the previously reviewed `ServerService.receiveFileWriteResult`. **Initial independent review BLOCKed an operational error-classification P1. Correction below is writer-checked and independently rereviewed OK with notes (2dacb5cc), accepted by the parent; the prior P1 is resolved. Production remains OFF; Ticket03/all16 remain partial.** This is not dispatch, HTTP activation, filesystem-effect acceptance, or recovery authority.

The original increment changed only Server gateway/transport, a small adjacent internal port, related tests and this document. The subsequent supervisor-approved correction additionally tags intentional receiver validation rejections and transaction failures in the existing application helper/service and `retainResult` method. Validation logic/order, schema and persisted bytes remain unchanged. No Worker/shared-wire/bootstrap/HTTP/UI/dependency/build-output changes. Held intent remains held and non-deliverable; historical result retention does not dispatch or settle it.

## API and trust boundaries

- `WorkerGateway` has an optional final `ServerFileResultIngress` argument: committed `admissions.get` plus `receiveFileWriteResult(authenticatedWorkerId, input)`. The test embedding delegates to the real application store and `ServerService`. No production constructor supplies it. This is trusted in-process composition, not a new public authentication API.
- The Worker ID comes from the real HTTP upgrade's `AuthenticationService.authenticateWorker`, not result/hello claims. The gateway requires the current connection generation, accepted hello, local opt-in and current peer `features: fs-write-admission-v1`. Only that intersection is advertised in the Server hello. Default legacy negotiation remains unchanged.
- WebSocket input is converted synchronously to an immutable string before the asynchronous connection queue. Structural parsing rejects malformed/direction/volatile messages; the Node `parseVerifiedWorkerFileWriteFrame` verifies durable framing and exact stored admission mapping/fingerprint/result digest. The existing receiver independently revalidates authenticated Worker and immutable admission/result before retention.
- The receiver is awaited without a legacy HTTP waiter. Only after receiver commit/resolution and another current-generation check can `enqueueFileResultAck` persist the verified ACK. No stale generation may enqueue a newly completed ACK or publish it through a replacement connection. Shutdown drains tracked receiver work before transport close; an already executing receiver may commit without publication during shutdown.
- Generic gateway `send` and transport `enqueue` reject file messages, including admission and ACK; they are not a negotiation bypass. The dedicated ACK enqueue is an internal port used after gateway validation/commit. It is not a claim that arbitrary trusted in-process callers cannot misuse storage APIs.

## Two receipts, replay and a deliberate integrity limitation

Transport inbox commit and application retention are **not atomic**. Existing transport receipt/cursor semantics are preserved. The inbox can advance before application retention fails, and a later hello can report that transport cursor. It is not an application ACK or settlement signal. Worker application-retained results remain the retry source until application ACK.

Every verified result re-enters the receiver, including a duplicate transport sequence. For an already accepted file sequence, the transport must find the exact `workerId + deliveryEpoch + seq + messageId` in its existing inbox and match the current epoch. Missing rows, changed message IDs, other Workers and wrong epochs fail closed. Ordinary legacy duplicate handling is unchanged. Exact application duplicates regenerate ACKs; changed valid outcomes/JSON/digests cannot overwrite an already retained result, including unknown-to-success.

**Approved bounded limitation:** the existing inbox stores no payload digest. If the transport accepted a frame but the application has no result, a replay with the same inbox identity and a different valid, admission-matching result cannot be distinguished from the original bytes. The authenticated Worker's first successfully committed application result becomes immutable authority. Tests explicitly demonstrate this boundary, rather than claiming pre-gap byte equality. Production activation must explicitly decide whether additional payload binding is required. No new digest ledger/schema or recovery authority is added; integrity/process-crash gates remain open.

ACK envelopes deduplicate while outstanding by the full domain identity: request, Session, Worker, operation, fingerprint/version, result version/digest. An outstanding ACK replays with the same sequence/message ID. Once transport receipt removes it, a new verified result event may regenerate the same application ACK on a fresh sequence. Reconnect replays retained ACK envelopes; if the envelope was already transport-ACKed, a still-pending Worker result replay regenerates it. There is no independent application ACK enumeration/dispatcher.

Pure transport ACK/periodic flush only replay retained outbox rows, never regenerate file ACKs. Tests send 100 transport ACKs with no application enqueue loop. Application ACK first may leave an un-transport-ACKed ACK envelope for exact reopen replay; transport receipt first removes the envelope but does not settle the Worker's application obligation. Neither order deletes admission/result tombstones or changes held intent.

Receiver rollback/failure publishes no application ACK. Enqueue failure leaves committed application result available for exact result replay; socket send/callback failure preserves the durable ACK envelope. These are retryable through retained Worker results or ACK outbox, not false application receipts.

Reconnect to a nonnegotiating peer while file envelopes remain fails before hello with a permanent `invalid-frame` diagnostic containing `File result ingress needs attention: retained envelopes require negotiation`. It sends no file data, advances no sequence, and preserves retained rows; no server-side reconnect loop exists. This intentionally fails closed for the whole connection, including legacy traffic. It is an internal availability limitation, not production downgrade compatibility. No silent row dropping or sequence skipping is allowed.

## Checked evidence

`apps/server/src/test/server-result-ingress.test.ts`: **30/30 passed**. Uses actual dynamic-port loopback WebSocket, real gateway/auth/WorkerService, authorized `ServerService.admitFileWrite`, and temporary real application/transport SQLite with independent observers. No real credentials, external network, live services or Agents. Coverage includes:

- independently observed committed result before durable ACK enqueue, no waiter, exact duplicates, full outstanding ACK dedup and 100 transport ACKs without re-enqueue;
- malformed/digest/direction/volatile/binary/prehello/identity/cross-Worker denial, default off and one-sided negotiation, generic-send rejection;
- original accepted-sequence convergence after injected receiver failure and actual transaction rollback; exact inbox identity checks; explicit transport-only-gap changed-valid-result limitation;
- already retained unknown-to-success conflicts on original and new sequence, both receipt orders, disconnect/reopen exact ACK/result replay;
- downgrade rejection with no data disclosure/row loss, real socket callback and enqueue failures;
- mutable receiver Buffer snapshot while queued, paused stale generation with zero new ACK enqueues, shutdown waiting for active receiver without stale publication;
- default legacy handshake, heartbeat/duplicate semantics, prehello unsupported-major rejection, real credential rejection.

Tests use controllable barriers and ping/pong checkpoints, not arbitrary sleeps. Test-local access to the actual Server socket and one send-method interception create no public production hooks. The receipt-order test models the synthetic Worker's application receipt by observing the ACK; it does not run the real Worker runtime or prove its delivery marker. Reopen/fault injection is not an OS process-crash or browser proof.

Existing `server-file-results.test.ts` changes only its static integration-boundary assertion: allow the internal gateway/port reference while asserting the actual production constructor still supplies no opt-in. Existing behavioral retention tests remain intact.

### Commands and results

Installed offline tools only; no installs/root or package builds/pack.

```sh
./node_modules/.bin/tsx --test apps/server/src/test/server-result-ingress.test.ts
./node_modules/.bin/tsx --test \
  apps/server/src/test/server-result-ingress.test.ts \
  apps/server/src/test/server-file-results.test.ts \
  apps/server/src/test/server-file-admission.test.ts \
  apps/server/src/test/transport-receipt.test.ts \
  apps/server/src/test/server.test.ts \
  apps/server/src/test/worker-authorization-http.test.ts \
  apps/server/src/test/auth-routes.test.ts \
  apps/server/src/test/transaction-composition.test.ts \
  apps/server/src/test/transaction-lifecycle.test.ts \
  apps/server/src/test/session-effect-authorization.test.ts \
  apps/server/src/test/session-effect-service.test.ts \
  apps/server/src/test/task-delete.test.ts \
  apps/server/src/test/task-delete-artifacts.test.ts \
  apps/server/src/test/task-runs.test.ts \
  apps/server/src/test/account-upgrade.test.ts \
  apps/server/src/test/ticket06-evidence.test.ts
./node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit
```

| Run | Exit | Result |
| --- | --- | --- |
| Initial noEmit | 0 | No diagnostics |
| Initial focused | 0 | 27/27 |
| Test noEmit | 0 | No diagnostics |
| Expanded focused | 1 | 29 passed, 1 timeout: new legacy heartbeat fixture omitted mandatory nonce; fixture corrected |
| Initial 11-file regression | 1 | 101/102: new static constructor assertion assumed wrong variable names; corrected to unchanged actual constructor |
| Final 16-file regression | 0 | 201/201, including gateway/auth/reconnect and transaction/retention lifecycle |
| Final focused | 0 | 30/30 |
| Final noEmit | 0 | No diagnostics |

Two provider stream disconnections interrupted earlier implementation attempts; the parent confirmed process termination and resumed the same protocol. No execution/model/CLI fallback occurred. The final resumed test runs had no validation infrastructure failure. Early exploratory inspection of guessed nonexistent source paths exited 1; these were path discovery errors, not hidden test successes.

## Preservation and remaining gates

Original pre-mutation packet: `/tmp/server-result-ingress.WqZsFV`. HEAD `93c9f67cab09ca51bd95d8bdb14d7d0ca99f0255`. Baseline has 1063 relative-path source hashes/preimages, HEAD/index/status/dirty diff, root-only generated/private exclusions and an explicit assertion including `apps/web/src/features/artifacts/artifacts-section.tsx`. Nested source artifacts were not filtered out. This does not retroactively repair any previous writer's preservation evidence gap.

Parent interruption snapshots `/tmp/server-result-ingress-interruption.ro9zra67` and `/tmp/server-ingress-retry2.2dhhogi3` are interruption evidence only, never substituted for the original baseline. The packet records checkpoints, validation commands/exits/logs, incremental baseline-to-final diff including new files, final hashes/postimages and preservation audit. No staging/reset/clean/stash/commit/push.

Pending at this Server-only boundary: full-system real Worker/application ACK-marker integration, OS process-crash fault injection, explicit pre-gap payload-binding decision, dispatcher/HTTP/production activation, browser/filesystem-effect proof, mixed-version/deployment/restore continuity, operational recovery/ownership and concurrency/history/deletion guarantees. No such authority or acceptance is inferred from this bounded Server integration.


## Independent review P1 and operational error-classification correction

Initial independent review `ebe25397`, report `0722f94c-132f-43f4-befa-b30349984111/tickets/03/server-result-ingress-review.md`, returned **BLOCK**. The gateway classified all receiver/enqueue exceptions as permanent `transport.error`. Actual Worker transport stops permanently on that signal, so earlier synthetic reconnect tests proved retained-state recoverability but not operational retryability. **The correction is writer-checked and independently accepted for this bounded seam: rereview 2dacb5cc returned OK with notes, no issues found, prior P1 resolved; parent accepted.** The durable rereview report at `/opt/data/.pi/agent/sessions/--opt-data-profiles-hacker-workspace-project-wemux-mini--/subagent-artifacts/outputs/0722f94c-132f-43f4-befa-b30349984111/tickets/03/server-result-ingress-review.md` inspected source, incremental diff and recorded evidence, including the Worker handling path. Reviewer and parent did not rerun tests or independently recompute all repository hashes. This supersedes only the unresolved status, not the historical BLOCK or its diagnosis.

The diagnosing-bugs skill was read. Competing speculative hypotheses were skipped because review supplied a concrete cause; actual red/green was not skipped. Before any product edit, the real gateway tests injected a SQLite result INSERT abort, a deferred-foreign-key failure at actual COMMIT, and an ACK outbox INSERT abort. All three failed the assertion `retryable === true` (`false !== true`, 0/3, exit 1). After the correction all three passed, exit 0.

### Explicit taxonomy, unchanged authority

- `FileWriteResultRejectedError` marks intentional receiver structure, admission/Worker ownership, digest/binding validation, retained-result verification and committed-result conflicts. A pure `validateFileWriteResult` wrapper encloses only existing parsing/validation; SQL reads/writes remain outside. The `retainResult` change is throw tagging only, with original validation and transaction ordering intact.
- `ServerService.receiveFileWriteResult` rethrows intentional rejections unchanged. Other failures of its existing transaction become `FileWriteResultUnavailableError`, retaining the original `cause` in-process. Snapshot and post-commit ACK verification remain outside that operational mapping.
- `enqueueFileResultAck` still parses the ACK against the result and checks authenticated target Worker **before** mapping only its persistence phase to Unavailable. Invalid ACK/digest/Worker correlation remains permanent, even if outbox persistence would also fail. Generic `enqueuePayload` behavior is unchanged.
- The gateway maps only the explicit Unavailable category to `temporary-unavailable`, `retryable: true`, then a recoverable 1013 close. The peer sees the fixed message `File result storage temporarily unavailable`, not SQL/path/cause details. Unknown internal-port exceptions remain permanent. No new classification uses message-text heuristics; existing legacy permanent-code selection is unchanged.
- Unavailable means an operation can be retried without manufacturing a receipt, not that every underlying storage fault will resolve automatically. The trusted internal port documents this error contract. Intentional validation/conflict exceptions must never be labeled Unavailable.
- Application ACK still follows receiver commit and current-generation checks. Rollback/failed COMMIT has no result or application ACK; enqueue failure preserves committed result without pretending an ACK exists. Dedup, outstanding envelopes, no ACK-driven re-enqueue, default-off construction, downgrade denial, transport-only gap limitation and held semantics are unchanged.

### Correction evidence and limits

Separate pre-mutation packet: `/tmp/server-result-classification.oFSc3B` (1066 relative-path source hashes/preimages, HEAD/index/status/diff; nested `apps/web/src/features/artifacts/artifacts-section.tsx` included). The original `/tmp/server-result-ingress.WqZsFV` is not replaced. A provider stream interruption occurred after the completed red run; recovery verified only the intended test file had changed versus this correction baseline before implementing the fix. Parent `/tmp/server-ingress-p1-interruption.4f8yexik` is interruption evidence only. No CLI/model/protocol fallback, installs/builds or staging.

Correction tests additionally assert permanent malformed/direction/volatile/digest/admission/Worker and inbox identity failures, committed unknown-to-success conflicts, invalid ACK/digest/Worker-target failures, direct receiver error categories, retained cause on operational rollback/COMMIT failure, and no retry classification from matching error text. Existing snapshot/stale-generation/no-early-ACK/100-ACK/no-loop tests continue to run. Actual Worker backoff/reconnect convergence is still a separate integration gate; the tests assert the existing wire retry contract and manually reconstruct the synthetic connection. No process-crash/browser claim is added.

Commands use installed `./node_modules/.bin/tsx` / `tsc`:

- `tsx --test --test-name-pattern='enqueue failure|real application (rollback|commit)' apps/server/src/test/server-result-ingress.test.ts`: pre-fix **0/3 exit 1**, post-fix **3/3 exit 0**, `red.log` / `green.log`.
- `tsx --test apps/server/src/test/server-result-ingress.test.ts apps/server/src/test/server-file-results.test.ts`: intermediate **54/54 exit 0**, `focused.log`.
- Same 16-file regression command documented above: intermediate **206/206 exit 0**, `regression.log`.
- Final focused (35 gateway + 20 persistence cases): **55/55 exit 0**, `focused-final.log`. Final 16-file regression: **207/207 exit 0**, `regression-final.log`.
- Server `tsc --noEmit`: exit 0, `typecheck.log`.

The packet contains final correction-only diff/postimages, hashes and HEAD/index preservation audit. Source edits are limited to the six gateway/application error-classification files, two tests and this document; no schema or broader store/lifecycle changes. The independent static rereview is accepted as recorded above; the writer-run evidence remains distinct from review. All earlier production, full-system, payload-binding and recovery gates stay open.
