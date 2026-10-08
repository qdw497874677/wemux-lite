# Turn-correlated approval read projection (partial)

## Scope and decisions

This increment changes only `apps/server/src/application/projection-service.ts`, focused projection tests and a new public HTTP lifecycle test. No router, repository, Worker, wire, shared-client, Next, schema or endpoint changes. Ticket04/all16 remain partial; independent review is required.

Session tool approvals are folded from the reliable contiguous Session Journal prefix in ascending `seq`, not timestamp or input-array order:

- Identity is `(sessionId, turnId, approvalId)`. Reuse of an approvalId in another Turn or Session is independent, including opposite decisions. Foreign Session events are ignored.
- The first request for that identity fixes request content, `requestedAt`, `sourceRevision` and the stable projection key. Duplicate requests/observations do not create rows, change cursor position or reset lifecycle. A new Turn is a new identity.
- A matching resolution applies only to an already requested, pending identity. The first applicable resolution before that Turn finishes establishes approved/denied. Pre-request resolutions are not applied to later requests; later conflicting resolutions cannot replace an established decision.
- Any matching `turn.finished` outcome (completed/cancelled/failed) expires unresolved requests with no decision capabilities. A first request observed after its Turn finished is also expired. Late resolutions and duplicate requests cannot resurrect expiration. A resolution established before finish is retained.
- Expiration leaves `decidedAt=null`: it does not invent a human decision or elapsed timeout. Authoritative resolution uses that event's time while preserving the original request revision.
- Existing cross-entity pagination still sorts by request timestamp and stable source identity, with status/source filters before pagination. Journal sequence determines lifecycle; it does not replace the public cursor format. Freshness can advance as observations arrive without moving the request's cursor identity.

Session overlays apply only when the authoritative request is still pending and projection key, Project, full Session/Turn/approval identity and request revision match. Authoritative approved/denied/expired always wins. Task review overlay behavior is unchanged.

The supervisor explicitly approved a bounded timeline policy: Session overlay rows also require current actor Session visibility and that same pending identity/revision match. Unknown requests, missing contiguous history, revoked Session access and terminal Journal history suppress the Session overlay row, even if the Project remains visible. No authoritative replacement event or DTO is synthesized. This is **not a complete approval timeline**; eventual authoritative timeline display is later work.

## Public HTTP and replay contract

`approval-projection-http.test.ts` runs the real temporary Server with owned SQLite, a non-admin contributor's read/write PAT and dynamically allocated ports. It exercises existing `GET /api/approvals`, `GET /api/timeline` and `POST /api/approvals/:projectionKey/decisions`. Setup uses synthetic Worker capability and synthetic Journal events, not a real Worker or native Runtime.

For every finish outcome, expired pending requests disappear from pending filtering, appear as expired without capabilities, and reject a new rich-endpoint decision with 409 `approval_stale`. Snapshot assertions verify no command, Task activity, review, receipt or overlay mutation. Reused IDs in a next Turn stay independent, duplicate requests keep their first revision, and repeated reads/cursor pages are deterministic.

For an already admitted optimistic decision, later Journal expiration or an opposite authoritative denial overrides the read projection and removes the optimistic timeline row. New decision identities are rejected. Exact old receipt replay still returns the original immutable admission result (except `replayed=true`), including after SQLite reopen, subject to current authority. It does not append another command or rewrite the overlay/receipt. Revoking the Session grant blocks replay and removes Session projection/timeline visibility. Retrieval of an old approved admission receipt alongside a current expired/denied projection is intentional, not a new execution or acknowledgement.

## Validation

Exact commands from the repository root, using existing dependencies:

```sh
# Baseline before edits: all nine files, 135/135
./node_modules/.bin/tsx --test apps/server/src/test/projection-service.test.ts apps/server/src/test/projection-routes.test.ts apps/server/src/test/session-authorization-http.test.ts apps/server/src/test/task-runs.test.ts apps/server/src/test/task-delete.test.ts apps/server/src/test/task-session-contract.test.ts apps/server/src/test/approval-decision-router.test.ts apps/server/src/test/approval-decision-persistence.test.ts apps/server/src/test/approval-replay-http.test.ts
# Focused red/green; final 28/28
./node_modules/.bin/tsx --test apps/server/src/test/projection-service.test.ts apps/server/src/test/approval-projection-http.test.ts
# Complete six-file related gate: final 122/122
./node_modules/.bin/tsx --test apps/server/src/test/projection-service.test.ts apps/server/src/test/projection-routes.test.ts apps/server/src/test/session-authorization-http.test.ts apps/server/src/test/task-runs.test.ts apps/server/src/test/task-delete.test.ts apps/server/src/test/task-session-contract.test.ts
# Prior router, persistence and replay behavior: 31/31
./node_modules/.bin/tsx --test apps/server/src/test/approval-decision-router.test.ts apps/server/src/test/approval-decision-persistence.test.ts apps/server/src/test/approval-replay-http.test.ts
npm run typecheck --workspace @wemux/server
/usr/bin/git diff --check -- apps/server/src/application/projection-service.ts apps/server/src/test/projection-service.test.ts
```

Added 24 tests (18 projection behavior, 6 public HTTP). Final focused 28/28 includes the 4 existing projection tests. All final gates have zero failures/skips/cancellations. The prior task-delete fixture repair was already accepted by parent (isolated 3/3, prior related 104/104); prior approval replay review `8d0f00b2` and parent 31/31 acceptance are unchanged. Historical failed reports were not rewritten.

Test-first history is preserved, not replaced by final green:

- Baseline 135/135 before edits.
- Initial new-test red: 5 passed / 21 failed. Three HTTP expired-filter assertions initially dereferenced the absent expected row; those were made explicit assertions. One order test was strengthened to distinguish sequence from input order.
- Strengthened pre-implementation red: 4 passed / 22 failed, covering all then-added 22 tests.
- First implementation run: 21 passed / 5 failed because new tests read the error code at `data.code` instead of the established `data.error.code`; fixture assertions were corrected, no HTTP product change. Next green 26/26.
- First Server typecheck caught a new overlay fixture's unbranded Timestamp/ID types. Fixture typing corrected; final Server typecheck passed. Two additional duplicate/foreign-Session defenses bring focused final to 28/28 and related final to 122/122.

Server typecheck's existing script builds domain/wire declaration outputs before noEmit. No package sources changed; no root/web build, install, deployment, live database, paid/native Runtime or browser run occurred. Temporary HTTP Servers/SQLite were closed and removed by owned cleanup. No admin polling occurred.

## Evidence and preservation

New owned evidence: `/tmp/wemux-approval-projection.xQkSmk/`.

- `baseline`, `red`, `red-assertions`, `green`, `green-final`, `focused-final`, `related`, `related-final`, `approval`, `typecheck`, `typecheck-final`: each has exact `.command`, `.log`, `.exit` records.
- `preimages/`, `incremental.patch` (new-file-aware, relative to this run's preimages, not dirty HEAD), `baseline-hashes.json`, `final-hashes.json`, `prior-evidence-hashes.json`, `preservation.json`, HEAD/index/status records and diff-check evidence.
- Only the allowed production file, focused test, new HTTP test, this new document and appended ignored Ticket04 record differ from the starting source snapshot. Prior evidence directories and unrelated dirty files remain unchanged; no staged files, no git mutation. HEAD remains `93c9f67cab09ca51bd95d8bdb14d7d0ca99f0255`.

## Remaining limits

Matching overlays on genuinely pending Journal requests still use the existing optimistic approved/denied display and timeline wording. They are admission records, **not Worker/native success**. This seam deliberately adds no pending-admission status/API. Missing/unseen terminal events cannot be inferred from wall-clock time; current freshness and contiguous-cache limitations remain. Read and subsequent authority mutation are not made atomic here.

The direct legacy approval route, Worker Turn/approval enforcement, timeout ownership, real runtime outcomes, crash-window receipt atomicity and full authoritative timeline integration remain later work. No complete approval-safety, exactly-once, dual-host, browser/mobile or whole-ticket acceptance is claimed.
