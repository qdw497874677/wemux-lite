# Approval receipt replay isolation (partial)

## Scope and API decisions

This increment changes only Server approval receipt replay. Ticket04 and all16 remain partial, pending independent review. No Worker, wire, Next or shared-client changes, browser rebuild, deployment, live database access or native Runtime execution occurred.

`POST /api/approvals/:projectionKey/decisions` retains its request format and client SHA-256 fingerprint (`decision`, `note`, `requestId`, `sourceRevision`). The existing durable `result.approval.projectionKey` binds the resource, without a schema migration. Identical actor/requestId/body can retrieve only that exact projection. Another projection or changed body returns a non-disclosing 409. Actor partitions remain separate. Malformed or legacy receipts without a trustworthy binding fail closed rather than becoming cache misses and executing again. Existing valid pre-fix receipts remain readable.

Every successful replay now checks:

- Current Project visibility through `ProjectAccessService.require`, independently of pending projection enumeration. Missing/deleted/inaccessible Projects yield the existing 404 pattern.
- Task review: `TaskService.writeTask` (current owner or Team member with Project contributor/manager grant; not viewer), live Task/non-deletion and the actual Run/Review identity and Project/Task relationships. `reviewById` permits a completed review to be retrieved without being the current pending cycle. CAS, pending status and freshness are not replay authority.
- Session tool: existing Session write authorization (`requireSessionAccessInTx`), Project identity, explicitly recorded Task/Run bindings when present, and `assertSessionTaskMutable` for deleted linked Tasks (including legacy Run associations). Root-created Sessions may have neither Task nor Run; that absence is not a replay denial. Session grant revocation, Project membership loss, deletion and a non-owner's read-only downgrade reject replay. Session owners retain write authority with a viewer Project grant, but still require Project visibility/Team membership. Existing owner exceptions are preserved, not replaced by a new permission policy.
- Task authority errors at the projection HTTP boundary retain their status/code instead of becoming generic 500 responses.

Authorized, non-deleted archived Sessions may retrieve their stored receipt. This is retrieval only, with no command/review redispatch, notification or optimistic overlay write. Existing approval authority does not separately prohibit archive admission; this change neither introduces an archive execution policy nor proves new archived approvals safe. Project currently has no archive field. No pending-review lookup is required after a completed task decision.

## Tests and results

Commands run from repository root using existing dependencies:

```sh
./node_modules/.bin/tsx --test apps/server/src/test/approval-decision-router.test.ts apps/server/src/test/approval-decision-persistence.test.ts apps/server/src/test/approval-replay-http.test.ts
./node_modules/.bin/tsx --test apps/server/src/test/projection-service.test.ts apps/server/src/test/projection-routes.test.ts apps/server/src/test/session-authorization-http.test.ts apps/server/src/test/task-runs.test.ts apps/server/src/test/task-delete.test.ts apps/server/src/test/task-session-contract.test.ts
./node_modules/.bin/tsx --test apps/server/src/test/task-delete.test.ts
./node_modules/.bin/tsx --test apps/server/src/test/projection-service.test.ts apps/server/src/test/projection-routes.test.ts apps/server/src/test/session-authorization-http.test.ts apps/server/src/test/task-runs.test.ts apps/server/src/test/task-session-contract.test.ts
npm run typecheck --workspace @wemux/server
npm run typecheck --workspace @wemux/server-domain --workspace @wemux/web-contract
./node_modules/.bin/tsx --test packages/web-contract/src/action-capability.test.ts packages/web-contract/src/task-platform.test.ts
```

- Initial red: 3 existing router/persistence tests passed; 14 new HTTP cases failed. Both receipt kinds disclosed stored 200 results on a different projection, permission downgrade/revocation or resource deletion.
- Final targeted green: **25/25**. Public HTTP uses real local login cookies, CSRF rejection/success, real scoped PATs and isolated temporary SQLite. Assertions cover exact-key/body/actor isolation, six concurrent committed-receipt retries, SQLite reopen, archived Session retrieval, revoked/downgraded permissions, deleted resources, malformed/missing bindings, visible-but-wrong Project, missing authoritative Session/Review, unchanged command/activity/review/receipt/overlay tables on replay or denial. Both `session_tool` and `task_review` are covered.
- Related combined gate: **103/104**, not all green. `task-delete.test.ts:87` expects 201 for a Session create body containing only `title`; current contract returns 400 `invalid_request`, `Session title and requestId required; unknown fields are not allowed`.
- Isolated current task-delete: **2/3**. Independent `/tmp` source copy replacing only this increment's six production files with preimages reproduces **2/3**, same failure, unchanged original test/config/dependencies. A separate temporary diagnostic adds only an assertion message to expose the error body. No unrelated test or product fix made.
- Related gate excluding that separately documented baseline-red file: **101/101**.
- Server typecheck and server-domain/web-contract typechecks passed. Relevant package tests: **49/49**. Server typecheck invokes existing domain/wire builds; no package source changed, root build, web build, Worker package or installation ran.
- Initial implementation checks caught TaskError HTTP mapping and a missing synthetic event `action`; both fixed. A discarded extra corruption fixture attempted to change immutable Session provenance and was rejected by SQLite before reaching replay; it is not counted as replay evidence.

## Concurrency and lifecycle limits

A temporary HTTP probe sent six new decisions concurrently for each kind: all returned 200, one non-replay and five replays; Session command delta was one, task command delta zero with review approved. This observed scheduling is not a forced interleaving or crash exactly-once proof. Existing router receipt read, lower authority transaction and receipt save remain separate. A crash between authority and receipt, expired receipt, or adversarial first-decision race is outside this seam. Committed receipt replay performs no authority mutation.

The stored Session approval result is still an **optimistic terminal overlay**, not proof of Worker/native Runtime approval success. Turn ownership registry, expiry/reconciliation, approval admission lifecycle and optimistic overlay correctness remain unresolved and explicitly out of scope. Browser/dual-host/native Runtime verification is not implied by these backend tests; prior controls browser evidence remains untouched.

## Evidence and review

Owned evidence root: `/tmp/wemux-approval-replay-evidence/`.

- `red.log`, `green.log`, `related.log`, `related-excluding-baseline-red.log`, `typecheck.log`, `package-typecheck.log`, `package-tests.log`.
- `task-delete-current.log`, `task-delete-baseline.log`, `task-delete-baseline-diagnostic.log`, `baseline-comparison-hashes.json`, `baseline-copy/`.
- `concurrency-probe.log` (temporary current-code probe; baseline copy production files restored to preimages afterward).
- `preimages/`, `incremental.patch` (includes newly created files, relative to this run's preimages, not dirty HEAD), `baseline-hashes.json`, `final-hashes.json`, `preservation.json`, `head`, `index-before`, `index-after`, `status-before`, `status-after`.

HEAD remains `93c9f67cab09ca51bd95d8bdb14d7d0ca99f0255`; index unchanged, no staged files. Acceptance is limited to this receipt security seam and remains subject to the required independent reviewer gate.

## P1 follow-up: retained root Session compatibility (awaiting fresh review)

The initial implementation was **blocked**, not accepted: independent review found that the replay helper required a Task Run for every Session without `taskId`, although public root creation and initial approval still support Sessions with neither Task nor Run. The earlier 25-test green did not cover that shape. The product Task-bound direction did not authorize changing retained backend compatibility in this seam.

The follow-up removes only that mandatory inferred-association branch in `ServerService.authorizeRuntimeApprovalReplay`. Current Project/Session authorization, explicitly recorded Task/Run existence and relationship checks, and `assertSessionTaskMutable` remain. Root creation, first-decision admission, deletion policy, client fingerprints and all other product paths are unchanged.

Six added HTTP cases use real cookie+CSRF root creation, real actor PAT approval decisions, synthetic Journal approval requests and owned temporary SQLite. The root actor owns the Session but not its Project. Cases cover absent and explicit-null optional associations, identical receipt content except `replayed` before/after SQLite reopen, unchanged command/activity/review/receipt/overlay tables, owner viewer-downgrade allowance, and owner Team-membership-loss denial. Additional corrupt-record fixtures verify missing Task, missing Run, a Run belonging to another Session, and deleted linked Task still reject without effects. These last fixtures temporarily bypass and restore validation triggers within a disposable SQLite transaction; their private corruption connection disables foreign keys. No production validation is relaxed.

Follow-up commands:

```sh
./node_modules/.bin/tsx --test apps/server/src/test/approval-decision-router.test.ts apps/server/src/test/approval-decision-persistence.test.ts apps/server/src/test/approval-replay-http.test.ts
./node_modules/.bin/tsx --test apps/server/src/test/task-session-contract.test.ts apps/server/src/test/session-authorization-http.test.ts apps/server/src/test/projection-service.test.ts apps/server/src/test/projection-routes.test.ts
npm run typecheck --workspace @wemux/server
git diff --check -- apps/server/src/application/server-service.ts apps/server/src/test/approval-replay-http.test.ts docs/acceptance/web-next-approval-replay.md
```

Results: clean test-first reproduction **29 passed / 2 failed**, both valid root receipt retries returning 404 after a successful first decision. After the narrow fix, focused **31/31** and related compatibility/authorization/projection **14/14** passed. Server typecheck and diff check passed. Two earlier fixture-construction iterations hit existing SQLite provenance/source or foreign-key constraints before corruption tests reached replay; those logs are retained separately, not counted as additional product findings. The known `task-delete.test.ts:87` baseline failure from the original gate remains explicitly unresolved and was neither rerun nor changed. These focused greens do not mean the original combined gate is fully green.

Original seam evidence remains untouched at `/tmp/wemux-approval-replay-evidence/`. Follow-up preimages, red/green/typecheck/related logs, incremental patch, hashes, HEAD/index and preservation proof are separate at `/tmp/wemux-approval-replay-root-fix-evidence/`. Reviewer finding: `/opt/data/.pi/agent/sessions/--opt-data-profiles-hacker-workspace-project-wemux-mini--/subagent-artifacts/outputs/271b24c8-6db0-441b-8373-a43bf2a5f57e/tickets/04/approval-replay-security-review.md`. Original writer artifact is `approval-replay-security.md` in that same directory; follow-up artifact: `/opt/data/.pi/agent/sessions/--opt-data-profiles-hacker-workspace-project-wemux-mini--/subagent-artifacts/outputs/36eb02b6-63da-4da0-9b44-abf85bffcec7/tickets/04/approval-replay-root-fix.md`.

Fresh independent review is required for the original seam plus this fix. Ticket04/all16 remain partial. Optimistic approval lifecycle, native Runtime outcome, expiry and crash-atomicity exclusions above remain unchanged.

## Bounded related-gate fixture repair (awaiting repair review)

After approval replay review `8d0f00b2` and the parent's 31/31 confirmation, this separate increment changes only three Session-creation request bodies in `apps/server/src/test/task-delete.test.ts`. The accepted approval replay implementation and its tests are untouched. `TaskService.createSession` requires an explicit non-empty body `requestId`; Session creation receipts are scoped by owner and Project, not merely by Task. The initial protected Session uses `protected-session`, the ordered cases use `ordered-session-delete-first` and `ordered-session-create-first`, and the simultaneous case uses `concurrent-session`. These deterministic identities are distinct for each logical operation in the shared fixture, so different Tasks cannot accidentally reuse another creation receipt. They remain stable if that same operation is retried. No product, schema or fixture API changes were made.

Fresh preimage reproduction: isolated task-delete **2 passed / 1 failed**, with the same line 87 `400 !== 201`. The original current/baseline/baseline-diagnostic logs under `/tmp/wemux-approval-replay-evidence/` remain unchanged; the diagnostic records `invalid_request`, `Session title and requestId required; unknown fields are not allowed`. After adding only the three requestId fields:

- Isolated task-delete: **3/3**, zero failures/skips/cancellations.
- Complete six-file related gate shown above (including task-delete): **104/104**, zero failures/skips/cancellations.
- Focused approval-decision-router, approval-decision-persistence and approval-replay-http gate: **31/31**, zero failures/skips/cancellations.

All existing assertions remain unchanged: durable CAS tombstones and replay, Workspace independence, no deletion Worker command, forbidden mutation/resurrection, offline/idle/archived/queued/deleted-unsettled Session protection and unchanged Session records, both ordered delete/create outcomes, exactly one simultaneous success, active Run/review protection, authorization before CAS/replay, revoked rights, audit rollback and concurrent idempotent deletion. No additional failure appeared after creation was repaired. The simultaneous assertion is retained as-is, not a forced-interleaving or crash-atomicity proof.

New evidence root: `/tmp/wemux-task-delete-fixture-repair.TQTj7U/`. It contains preimages, `red.log`, `green.log`, `related.log`, `approval.log`, exact `.command`/`.exit` records, `incremental.patch`, before/after hashes, historical-log preservation hashes and HEAD/index preservation evidence. A summary is also recorded in ignored `.scratch/web-next-project-agent-platform/evidence/ticket-04-task-delete-fixture-repair.md`. HEAD remains `93c9f67cab09ca51bd95d8bdb14d7d0ca99f0255`, index unchanged with no staged files. Tests used existing dependencies, isolated temporary/in-memory SQLite, synthetic Workers and dynamically assigned HTTP ports; no installation, build, live database, paid/native Runtime or browser run occurred. This clears only the documented related-gate blocker, pending independent repair review. It is not another whole-ticket acceptance: Ticket04/all16 remain partial and the lifecycle/dual-host/native Runtime limits above remain unchanged.
