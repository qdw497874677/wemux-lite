# Durable file admission: internal Server result retention

## Status and bounded scope

Implemented the real `ServerStore.fileWrites` / `SqliteServerStore` result persistence seam and an internal `ServerService.receiveFileWriteResult` entry. **Independent review: OK with notes; accepted by the parent for this bounded persistence seam only. Production remains OFF; Ticket03/all16 remain partial.** This is not gateway activation or connected/browser/process-crash acceptance.

No Worker, shared wire package, HTTP route, gateway, bootstrap, dispatcher, UI, dependencies or Task/history deletion logic changed. No operational caller invokes the receiver or advertises the feature. Existing admission/held-intent bytes and their recorded migrations remain unchanged. Held is still non-deliverable, even when a historical result is retained separately. There is no new delivery-state transition, queue, transport-ACK handling or waiter notification.

## API and ordering contract

- `ServerService.receiveFileWriteResult(authenticatedWorkerId, input)` is for a trusted in-process caller that independently authenticated the Worker. It does not authenticate a payload or connection itself. The future gateway must enforce the existing verified durable-frame parser, direction and two-sided negotiation before calling this seam; none of that integration is enabled here.
- Caller data is cloned, structurally validated and frozen synchronously before the first queue/await. Both receiver and repository snapshot their input. Shared Node verified parsers validate the retained admission fingerprint, exact immutable mapping (`requestId = admissionId`, `clientRequestId = original client requestId`), authenticated Worker, Session, operation, fingerprint/version, result version/digest, canonical exact `resultJson`, and success path/size. Incompatible old internal admission IDs fail closed without rewriting admission bytes.
- `tx.fileWrites.retainResult(authenticatedWorkerId, input)` verifies and inserts the immutable `file-write-result` document in the existing application `records` table. Its return is provisional inside the callback; only successful outer transaction resolution means committed. Exact duplicate fields replay retained bytes regardless of envelope property ordering. Any changed valid result conflicts permanently, including unknown-to-success. Denials never overwrite a prior result.
- The receiver regenerates a verified `fs.write.result.ack` from the retained result **after the transaction commits**. Callback rollback, failed statement or failed COMMIT returns no ACK. An exact duplicate after reopen produces the same ACK, without a persisted ACK queue. Future publication must occur after the receiver resolves.
- `store.fileWrites.getResult(admissionId)` is an internal committed-only FIFO reader. Inside transactions use `tx.fileWrites.getResult`; escaped readers/writers reject after commit/rollback, including during later transactions. There is no browser result-read API. Any future actor-facing read must check current access before disclosure.
- Historical result retention deliberately does not require a current actor grant, current Session existence, or an HTTP waiter. Revocation is not cancellation of an already observed effect. `unknown` remains uncertainty, never success, safe retry permission or settlement/recovery authority. An application ACK confirms durable correlation only.

## Append-only migration and newly found rowid issue

Schema **34** appends result identity/shape/immutability triggers. Node parsers remain responsible for cryptographic/canonical validation; SQL guards are not a substitute for authenticated application ingestion. `BEFORE INSERT` result-key guards reject logical replacement with `recursive_triggers=OFF`.

Implementation found an additional Server storage vulnerability not covered by the earlier admission review: explicit `rowid` replacement could erase a protected admission/held intent by inserting a different kind/id. Three real SQLite alias tests failed before the correction (`rowid`, `_rowid_`, `oid`, exit 1). The supervisor approved protecting all three file record kinds in this append-only migration, without changing old migrations or held semantics.

New rowid insert/update collision guards inspect the **old protected destination**, not merely the incoming kind. Existing immutable update guards also prevent protected rows moving rowid or changing kind. AFTER INSERT rejects persisted rowid **-1 only for these three kinds**: SQLite uses NEW.rowid=-1 before automatic allocation. Ordinary automatic positive inserts remain valid, including when an unrelated kind legitimately occupies -1. Statement abort also rolls back admission-trigger-created held intent. Negative rowids other than -1 are not globally forbidden or rewritten.

Migration preflight refuses an old protected -1 row with `File storage migration refuses protected rowid -1`. It rolls back schema/version/data changes and does not attempt repair or grant recovery authority. Tests verify repeated failed reopen preserves original bytes, schema and version. An ordinary schema33 upgrade preserves all prior schema objects/admission/held bytes, appends version34, accepts new results/admissions and reopens exactly. The historical stage1 upgrade test now explicitly reconstructs schema32 rather than assuming the current last migration is schema33; its original assertions still run.

## Checked evidence

New `apps/server/src/test/server-file-results.test.ts`: **19/19 passed**, real temporary SQLite databases, independent observer connections, no live services. Coverage includes all three outcomes, duplicate/reopen exact bytes and ACK, 20 concurrent duplicates per outcome, conflicts, authenticated cross-Worker and every result identity/version/digest/malformed denial, stored admission verification, caller mutation while queued, direct repository snapshots, FIFO committed reads, independent commit boundary, actual deferred-FK COMMIT failure, rollback/no ACK, escaped leases, raw replacement/update/delete guards with recursion off, rowid aliases/cross-kind collisions, sentinel behavior, upgrade/fail-closed preservation, post-admission access revocation and static absence of production callers/feature negotiation/dispatch.

Initial focused expansion passed 11/11, then 17/17. Initial regression passed 143/143. Final regression (including the last two additional cases): **145/145 passed**. Server noEmit passed. The only failing validation run was intentional pre-fix rowid red (0/3). No validation infrastructure failure or dependency/tool fallback occurred. A provider stream disconnection interrupted report finalization after these commands; implementation was not reviewed or accepted by that interrupted workflow. The resumed writer inspected existing files/logs and reran focused 19/19, regression 145/145, Server noEmit and `git diff --check`, all exit 0 (`focused-resumed.log`, `regression-resumed.log`, `typecheck-resumed.log`, `diff-check-resumed.log`).

```sh
./node_modules/.bin/tsx --test apps/server/src/test/server-file-results.test.ts
./node_modules/.bin/tsx --test \
  apps/server/src/test/server-file-results.test.ts \
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

Existing regression tests use temporary loopback HTTP/WebSocket fixtures where applicable; no new connected feature test, live database, real credentials, external network, install, Agent execution, root/package build, artifact regeneration or deployment was performed.

## Evidence packet and residual gates

Packet: `/tmp/wemux-server-file-results-otBQQ3TG/`. Contains original tracked/untracked source hashes/preimages (1058 files), exclusions, HEAD/index/status/dirty diff, intentional red and final green logs with exits, incremental diff/new files, final hashes/postimages and preservation audit. Baseline HEAD: `93c9f67cab09ca51bd95d8bdb14d7d0ca99f0255`. No staging, commit, reset or clean. Preservation audit matches all 1053 unrelated baseline file hashes; five approved existing files changed, four scoped files were added, no baseline files disappeared, and HEAD/index are unchanged. The original exclusion filter accidentally excluded one source file, `apps/web/src/features/artifacts/artifacts-section.tsx`, because its directory is named `artifacts`. This file was never edited by this work, but there is no captured pre-task hash for it; its current hash is recorded separately and full baseline preservation cannot be claimed for that one file. The parent interruption packet `/tmp/ticket03-server-results-interruption.HZJMaL/` contains an empty `hashes.json` and cannot close that evidence gap.

Independent read-only review `30a7c973-90a2-4e23-a166-86d67ba66751` found no introduced issues and returned **OK with notes**. Report: `tickets/03/server-file-results-review.md` in that run's durable output. The reviewer inspected source, incremental diff, tests and logs; neither reviewer nor parent reran validation. The preservation limitation above remains unresolved. This acceptance does not establish process-crash safety or authorize production activation.

OPEN: authenticated negotiated Server gateway ingress/application-ACK publication and replay ownership; dispatcher/held-to-deliverable lifecycle (not defined here); HTTP/browser result access; connected crash barriers and browser acceptance; deployment/exclusive recovery authority, restore/mixed-version continuity and all history/deletion/concurrency gates. Reopen tests are not process-crash proof. This increment does not claim production activation or all16/Ticket03 completion.
