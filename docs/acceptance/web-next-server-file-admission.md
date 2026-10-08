# Server file admission: stage 1 preparation

## Boundary

This is production-store preparation only. `ServerService.admitFileWrite` is an internal, currently uncalled application entry. No HTTP route/mode, feature flag, dispatcher, wire message, Worker execution, or outcome handling is added. Ordinary file/terminal endpoints are unchanged. Ticket03 and the wider rollout remain partial. Independent review of the bounded stage 1 persistence correction is complete; downstream activation is not approved.

The entry requires an explicit actor and configured Session authorization, even in compositions that still allow actorless legacy effects. Current Session write access and Task mutability are checked inside the same `ServerStore` transaction as admission, before replay/conflict disclosure. The previous `requireSessionEffectAccess` logic was extracted without changing its legacy authorization behavior.

## Persisted contract

- Key: actor + Session + client requestId. Separate random admissionId.
- Immutable record: operation `fs.write`, Worker from the authorized Session, full Session binding (Workspace/Worker/Agent/model), exact subpath and canonical base64 content, timestamp, fingerprint version 1 and SHA-256 fingerprint.
- Version 1 hashes the fixed-order JSON tuple documented in `apps/server/src/application/file-write-admission.ts`. It is an internal persisted format, **not** an approved shared-wire contract.
- Exact authorized retries return the retained record. Changed input or binding conflicts with 409. Revoked access and deleted Task/Session/Project still refuse replay.
- Inputs are reduced to primitive snapshots before the first await. Unknown fields, including caller-supplied binding or Worker, are rejected after authorization.
- Validation bounds requestId to 200 characters, relative path to 4096 UTF-8 bytes and decoded content to 10 MiB. Base64 must round-trip canonically; empty content is valid. Path validation is lexical only, **not** proof of filesystem sandboxing, symlink safety or Worker eligibility.
- The normal application `records` table holds admission and held intent documents. An append-only migration supplies uniqueness/shape/immutability guards; an insert trigger creates the held intent in the same SQL statement, so even a caught statement failure cannot leave an orphan admission.
- The typed `fileWrites` repository uses the existing committed-reader FIFO and transaction-lease guards. It exposes no update, settlement, delivery-list or deletion operation. Held intent is not a pending command and causes no notification.

## Checked evidence

`apps/server/src/test/server-file-admission.test.ts` uses real temporary `SqliteServerStore` databases and independent observer connections. It checks the actor/Session authorization matrix, private 404s, missing actor and missing authorization service, concurrent retry (20 requests), actor-scoped keys, exact input conflicts, full binding conflicts, pre-await caller mutation, input validation/size limits, ordered revocation and lifecycle checks on replay, committed-only reads, escaped transaction leases, rollback after both records, SQL-statement failure while creating the intent, uniqueness/immutability, and exact reopen replay.

Workspace/Worker/Agent changes are already forbidden by existing Session provenance guards. Their conflict tests inject only an alternate authorized transaction-reader snapshot; the guards are not removed. Model change is exercised through real persisted Session update. No test invokes a real filesystem write effect or infers settlement from ACK/timeout.

Focused and affected Server regression command (installed dependencies only):

```sh
./node_modules/.bin/tsx --test \
  apps/server/src/test/server-file-admission.test.ts \
  apps/server/src/test/session-effect-authorization.test.ts \
  apps/server/src/test/session-effect-service.test.ts \
  apps/server/src/test/transaction-composition.test.ts \
  apps/server/src/test/transaction-lifecycle.test.ts \
  apps/server/src/test/task-delete.test.ts \
  apps/server/src/test/task-delete-artifacts.test.ts \
  apps/server/src/test/task-runs.test.ts \
  apps/server/src/test/account-upgrade.test.ts \
  apps/server/src/test/ticket06-evidence.test.ts
./node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit
```

Original stage 1 execution: 121/121 tests passed (including 9 new admission tests), and Server `tsc --noEmit` passed. A static production-reference assertion found only the internal application/repository seams, with no operational caller or dispatcher.

### Review correction: SQLite replacement immutability

Review identified a P1 persistence gap: with `recursive_triggers=OFF`, `INSERT OR REPLACE` could bypass the explicit delete/update guards. Real SQLite tests reproduced all four replacement cases before the fix (9 passed, 4 failed). In the reviewer's fresh-admissionId/same-request case, the original admission disappeared and two held intents remained for one admission. Same admissionId with changed payload/request identity and direct held-intent replacement also changed retained raw bytes.

An append-only corrective migration (version 33, following stage 1 version 32) adds `BEFORE INSERT` guards for an existing admissionId **or** actor/Session/requestId identity, and for an existing held-intent id. The recorded stage 1 migration is unchanged; no connection-local recursive-trigger setting is required. This follows the repository's existing insert-time replacement-guard pattern. It prevents replacement; it does not repair a database already corrupted through out-of-band SQL.

Four replacement tests explicitly disable recursive triggers and assert rejection, unchanged raw admission/intent bytes and counts, committed readers, exact retry, and reopen preservation. A fifth test reconstructs the immediately preceding schema with retained stage 1 records/version, upgrades through the normal store constructor, verifies unchanged original schema objects/bytes and the appended version, rejects all replacement cases, and proves ordinary new admission/retry across another reopen. An intermediate upgrade-test assertion failed because SQLite rows have null prototypes; comparing version values fixed the test without changing production behavior.

Correction validation: focused suite **14/14 passed**; the full command above now runs **126/126 passing tests** (the original 121 plus 5); direct Server `tsc --noEmit` passed. Logs include both pre-fix red runs, the intermediate test failure, and final green results. Independent re-review returned scoped **OK**, closing the SQLite replacement P1 after inspecting the correction diff, source, and recorded red/green, upgrade and reopen evidence. The reviewer did not independently rerun tests or rehash files. Review artifact: workflow `b7b36901-76c2-4dc2-9c1d-4675794988d0`, child `3a5a9f46-201e-459b-a42d-2d1e5fd1cc80`, `tickets/03/admission-replace-rereview.md`. This correction changes only persistence guards/tests/documentation; all operational and subsequent gates below remain open.

The first regression run exposed migration replay collision in the historical upgrade fixture, fixed by matching the existing `IF NOT EXISTS` migration pattern. Early new-test failures were fixture defects (missing `runId: null`, incorrect command-reader argument count, and attempted tombstone resurrection), corrected without weakening production invariants. Raw red/green logs and pre/post manifests remain in the external implementation evidence packet, not in this document.

## Open gates

Shared-wire review/negotiation, Worker durable reservation and uncertainty handling, Server result integration, dispatcher, authenticated HTTP activation, process-crash tests, end-to-end filesystem-effect proof, deployment/recovery authority, restore continuity, and mixed-version exclusion remain open. No history/deletion gate is relaxed. A held admission is neither dispatched nor settled, and this change cannot be activated by an HTTP flag. There is no user-visible delivery claim or connected acceptance claim.
