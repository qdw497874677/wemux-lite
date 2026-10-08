# Durable file admission: stage 3 Worker application executor

## Status and bounded ownership

Implemented `WorkerFileWriteExecutor` against the reviewed real `WorkerStore` / `SqliteWorkerStore` and the real awaited `writeWorkspaceFile`. This is an **application-only, disconnected preparation seam**, reusable by a future WorkerRuntime integration. Independent review of the disconnected executor returned **OK with notes**, with no issues found (review artifact `c6977688-dcc8-40c2-b29a-ab1c2c7aea5b/tickets/03/worker-file-executor-review.md`). The reviewer inspected the recorded evidence rather than rerunning tests. Ticket03/all16 remain partial.

**Historical scope of that reviewed increment:** `WorkerRuntime`, default constructors, `receive`, initialize/reconnect behavior, transport, SQL/schema, shared protocol, Server, Web, CLI and bootstrap are unchanged. No production caller constructs this executor, advertises readiness or accepts new frames. There is no network sender, new authenticated-origin flag, private database or implicit recovery caller. The storage correction's previously stale review status is corrected separately; its historical failures and validation remain preserved.

The new executor does **not authenticate a Server connection**. The future ingress owner must authenticate the actual cluster peer and invoke the existing verified durable-frame parser with explicit two-sided negotiation before passing an admission to this application seam. Fingerprints prove integrity/correlation, not origin or actor authorization. `actorId` is not treated as a credential. Offline tests invoke the seam directly, not through an authenticated transport. This limitation is intentional within the approved disconnected boundary, not end-to-end acceptance.

## Ordering and behavior

1. `execute(input)` synchronously clones, validates with the existing Node admission parser, and freezes the complete nested admission before its first queue or authorization await. Invalid structure/hash rejects without reservation, effect or result disclosure.
2. Its own queue serializes execution. Before reservation **and before duplicate/result disclosure**, real store reads check the registered cluster Worker identity, target Worker, actual Session and full Workspace/Agent/nullable Model binding. Missing Session/Workspace, local-host Worker/Session, local Project Workspace, non-ready/wrong-owner/empty-root Workspace are denied. Session `storageMode: local` means private history and is **not** confused with local-host identity: cluster-host Sessions with private history remain eligible.
3. Only the successful outer `store.transaction(tx => tx.fileWrites.reserve(snapshot))` resolution is consumed. Provisional callback decisions never invoke the helper. A rolled-back or rejected outer transaction grants no I/O authority, including an ambiguous post-commit rejection.
4. `execute` reservations invoke and await the real helper (default), with its existing filesystem sandbox checks. Every thrown error after entry becomes `unknown`, including a missing root, symlink denial, mkdir/truncation/partial-write failure, or invalid success metadata. No caught helper error is labeled `rejected-before-effect`. The retained uncertainty error is a bounded fixed message rather than leaking filesystem paths/raw exceptions. No new filesystem sandbox or Workspace-wide exclusion guarantee is claimed.
5. Result JSON/digest use the existing shared serializers and Node verification. Result plus pending application delivery commit atomically through the real store; then the committed immutable retained result is read back and exposed. Settlement failures reject the call without publishing provisional success or manufacturing a second result. An unresolved reservation remains a dedupe barrier and does not grant retry.
6. Identical unresolved duplicates return `await-existing` without waiting for or invoking another effect; settled duplicates expose exact retained result JSON/digest, including immutable unknown. Changed identity returns only `reject/identity-conflict`; current binding/Workspace denials throw before accessing a prior result. No implicit `recoverUnresolved` occurs on construction, normal reopen or reconnect.

`close()` synchronously stops new/queued execution and drains the already active authorization/reservation/effect/settlement/publication. This queue/lifecycle belongs only to this disconnected executor. A future Runtime integration must compose with Runtime's existing command queue and closing/stop lifecycle, not add a parallel execution lane. No claim is made about serialization with current legacy file writes, Agents, terminals, other processes, Workspace mutation/deletion or external filesystem writers.

## Publication and ACK boundary

An optional trusted `publish(result): Promise<void>` consumer receives only committed frozen result records. With no consumer, the committed record is returned to the application caller. There is **no default transport send**, capability declaration, automatic reconnect replay, or clearing of delivery on publication. A consumer failure rejects the call but preserves the retained result and pending obligation, so an authorized duplicate replays identical bytes without another write. Result consumers must not mutate retained bytes or reenter this executor while awaiting their own publication.

This increment does not implement application ACK ingress or a pending-delivery dispatcher. The reviewed store already provides exact matching ACK validation and committed pending-result reads; its matching/mismatched/rollback ACK regressions were rerun unchanged. Only a subsequent authenticated/negotiated ingress and delivery owner may wire those ports into network behavior. A transport ACK or successful consumer call is not an application ACK.

## Checked evidence

New repeatable offline suite: `apps/worker/test/worker-file-executor.test.ts`, **15/15 passed** using real temporary Worker databases, independent SQLite observers and temporary filesystem roots. It covers:

- committed reservation visible before real helper entry; actual write and canonical success bytes; committed result/delivery visible to publication;
- outer rollback and post-commit rejected resolution with zero writes;
- synchronous complete snapshot before an authorization await and before queueing, despite caller mutations;
- malformed/hash-invalid, unregistered/wrong Worker, full Session binding, local host and Workspace eligibility denial before reservation/effect/publication;
- 20 concurrent identical submissions, changed identities, unauthorized retained-result retries, and a second executor observing an in-flight unresolved reservation without invoking again;
- ordinary reopened unresolved reservations remaining unresolved; exact success and unknown replay after reopen;
- partial write then throw conservatively unknown; real helper missing-root and symlink sandbox errors unknown, with the outside target unchanged;
- settlement rollback, ambiguous committed-settlement failure and publication failure preserving dedupe/delivery safety;
- close draining active effect/settlement and rejecting queued/new work;
- real default Runtime legacy write/local-host rejection/shutdown behavior unchanged; new admit/ACK ignored; initialize/reconnect neither recovers unresolved records nor publishes retained results or advertises support.

Initial focused run: **12/13 passed, exit 1**. The unresolved-reopen test eagerly evaluated `[f.store, f.reopen()]`, closing the first store before using it (`Error: database is not open`). The test was corrected to reopen sequentially; no application change was needed. Two additional concurrency/sandbox cases were then added. Raw initial failure remains in the evidence packet.

Final focused run: **15/15**, exit 0. Expanded offline regression run: **60/60**, exit 0 (15 executor tests plus the unchanged 45 storage/affected regression tests). Worker TypeScript noEmit passed. No shared package rebuild was necessary; installed built package exports typechecked and executed successfully.

```sh
./node_modules/.bin/tsx --test apps/worker/test/worker-file-executor.test.ts
./node_modules/.bin/tsx --test \
  apps/worker/test/worker-file-executor.test.ts \
  apps/worker/test/worker-file-store.test.ts \
  apps/worker/test/isolation.test.ts \
  apps/worker/test/retention-upgrade.test.ts \
  apps/worker/test/ticket06-evidence.test.ts \
  apps/worker/test/connector-mcp-storage.test.ts \
  apps/worker/test/provider-credential.test.ts \
  apps/worker/test/transport-store.test.ts \
  apps/worker/src/test/model-swap.test.ts
./node_modules/.bin/tsc -p apps/worker/tsconfig.json --noEmit
```

These are internal/offline assertions, **not browser, connected transport or process-crash acceptance**. No shell or Agent invocation is performed by the new tests. Existing credential regressions use only synthetic temporary data. No network, live database, actual credentials, paid Agent, install, root build, pack, deployment or activation was used. The full Worker suite was not run because it contains out-of-bound operational scenarios.

## Evidence and remaining gates

Packet: `/tmp/wemux-worker-file-executor-gbdxis11/`. It preserves baseline tracked/untracked source preimages and hashes, HEAD/index/status/dirty diff, initial and final command/exit logs, scoped incremental diff including new files, postimages and unrelated-file preservation audit. Baseline HEAD: `93c9f67cab09ca51bd95d8bdb14d7d0ca99f0255`. No files staged, committed or reset; unrelated dirty work is preserved.

Deferred at the executor-only boundary: authenticated verified-frame ingress, two-sided advertisement, integration into Runtime's common execution/lifecycle queue, application ACK and reconnect result delivery, Server result integration, HTTP/dispatcher activation, process-crash and browser/connected validation, recovery ownership, takeover/repair/unknown reconciliation, restore/mixed-version/deployment continuity. No new operational recovery authority or history/deletion safety is supplied. The existing helper's filesystem concurrency limitations and store's documented negative-rowid limitations remain unchanged.

## Subsequent internal integration

The opt-in Runtime/real WebSocket integration is recorded separately in
`web-next-worker-file-ingress.md`. It composes this executor inside Runtime's common
command queue, with shutdown draining admitted work; the executor itself changes
only its composition comment. That integration has its own tests and requires its
own review. Production lifecycle/CLI/bootstrap constructors still do not opt in.
The prior review does not certify this later integration or close any production,
process-crash, whole-system, history/deletion or browser gate.
