# Explicit approval command identity (partial, recovered writer run)

## Recovery and bounded scope

This writer resumed the same protocol/session after an infrastructure stream disconnect. Recovery inspection compared every initial source SHA-256: **no existing product file had been edited before the interruption**. Only the new Worker identity test file and its initial red log existed (15 tests: 2 passed, 13 failed). Implementation described earlier was planned, not previously applied. Parent recovery snapshot `/tmp/wemux-approval-recovery.qDZQP2` remains untouched. New evidence continues at `/tmp/approval-identity-evidence`.

Ticket04 and all16 remain partial; independent review is required. This is one command identity seam, not an approval lifecycle rewrite. No UI/shared browser client, model switching, schema, timeout policy, installation, deployment, native/paid Runtime or browser execution was changed/performed.

The supervisor approved four additional implementation files beyond the initial seams: `apps/worker/src/application/ports/worker-store.ts`, `apps/worker/src/storage/sqlite-store.ts` (transaction-scoped read ports); `apps/worker/src/application/agent-runner.ts`, `apps/worker/src/application/runtime-session-manager.ts` (invocation guard inside existing manager lock). Connector runtime and cluster-lifecycle changes close the direct local bypass.

## Contract and migration

- `runtime.approval.resolve` now requires immutable `sessionId`, `turnId`, `approvalId`, and decision. The richer projection endpoint forwards its original source Turn. Receipt replay remains before pending-projection lookup and rechecks current authorization, without redispatch.
- Direct cluster approval HTTP requires explicit `turnId`. Both local approval routes require explicit Turn; the connector-specific route additionally requires `sessionId`. Missing identities fail closed. They never infer the current Turn from approvalId alone.
- Worker snapshots queued approval bodies. Existing command serialization covers local and cluster decisions and remains held through adapter acceptance and receipt/Journal persistence, so concurrent decisions cannot both invoke the adapter for one pending identity. Same commandId/body replays without native invocation; changed bodies conflict. Worker receipt retrieval still checks local/cluster host scope. HTTP layers retain current authorization and CSRF checks.
- Worker checks Session ownership, exact active Turn record, and complete contiguous paginated Journal history before native/connector resolution. Identity is Session+Turn+approval. First request fixes existence; matching post-request resolution or Turn finish closes it; pre-request resolutions are ignored; duplicates cannot reopen. The accepted command's exact Turn is used in Journal, never a later active Turn.
- Native manager lock acquisition now synchronously rechecks the captured active object and invocationId immediately before the bound native resolver call. Native session ports remain Session-bound, and invocation identity is the execute operation ID; there is no new native DTO. The callback is required at the sole production manager caller.
- Connector pending records are keyed by full identity and require an active registered Turn before consumption. Identity mismatch cannot consume another pending approval. A Journal connector request with no live connector pending record cannot fall through into the Agent adapter. Local connector decisions use LocalWorkbench and cannot bypass host checks to operate cluster Sessions.
- Local automatic command identities include Turn. Explicit caller commandId participates in a stable installation/operation namespace and is not discarded: replay works after finish and changed Turn/body conflicts. A confirmed old hash record with the same Session+approval and no Turn produces a `legacy-unbound ... migration` error; no record is rewritten/deleted or rebound. An unrelated record at the old hash is not treated as legacy approval authority. A legacy record can block later Turns reusing that approvalId indefinitely; automatic migration is deliberately not supplied.

**Mixed versions:** deploy Server and Worker support together before using new decisions. New Worker rejects newly delivered unbound commands; it does not assign a current Turn. Already persisted receipts remain replay-only and do not execute. New Server cannot safely retrofit an old stored command body with a Turn: the old ID conflicts rather than migrating. Old Workers lack the new ownership enforcement even if they ignore the extra field, so this safety contract must not be claimed for them. Existing legacy/Next/shared-browser callers that omit Turn now fail closed until a separately authorized caller update; this increment does not change them.

## Native acceptance and terminal ordering

Native calls stay outside SQLite transactions. After acceptance, the same transaction that records receipt/resolution rereads exact Session/Turn and folds pending Journal state using transaction-scoped readers (no public-reader tail deadlock or nested transaction).

If termination or another resolution wins, it persists a nonretryable rejected receipt with: `Runtime accepted the decision, but terminal confirmation raced; execution outcome is unconfirmed by this receipt`. No successful resolution is fabricated and no next Turn is substituted. Same-ID retry retrieves this uncertainty receipt; a new identity fails terminal checks. Rejection here **does not mean the native decision was not executed**.

Two different proofs are deliberately distinguished:

1. Controlled native barrier plus a competing real store finish/resolution transaction proves defensive consistency and immutable uncertainty receipt, not a natural runner race reproduction.
2. Natural fake-adapter finish triggered during native resolve proves current runner release/finish ordering: resolution precedes natural `turn.finished`. A separate runner barrier holds a manager command, queues approval, ends the invocation, and unlocks: the lock-local guard rejects without another native resolve and lease/queue cleanup completes.

No native transaction/exactly-once claim is made. Crash after native effects and before receipt, persistence failure, cross-process ownership, actual native adapter ambiguity, and timeout ownership/reconciliation remain separate gaps. An adapter that throws after performing an external effect cannot be proven effect-free by these tests. Admission is not tool completion. Optimistic Server receipt overlays remain admission records, not Worker success.

## Validation and evidence

All final commands are recorded verbatim as `.command`, output `.log`, and exit `.exit` under `/tmp/approval-identity-evidence`; `run-gates.sh` is the repeatable final gate list.

- `npm run build:packages`: passed after wire change.
- Worker focused runtime, runner, manager, local-workbench/control, connector and cluster-lifecycle gate: 106 passed, 0 failed, 1 skipped; final rerun recorded under `complete-worker-focused.*`; one pre-existing opt-in browser test is skipped because browser execution was not authorized.
- Server approval replay/persistence/router, projection HTTP/service/routes, session-workbench and Session authorization gate: 66/66 passed.
- Wire transport/resource/file-admission/connector contract: 40/40 passed, including unchanged full approval-body transport retry identity.
- Worker and Server typecheck, Next `tsc -p apps/web-next/tsconfig.json --noEmit`: passed.
- New real WorkerRuntime suite uses temporary SQLite and deterministic fake native sessions, not paid/native runtime: 23/23 passed. It covers missing/wrong/stale Turn, unknown/terminal approvals, multi-page ordering, reused IDs, concurrent decisions, adapter rejection, immutable replay after finish, changed payload, legacy blocks, local host boundary, connector fallback, body snapshots, transaction rollback/read visibility and both acceptance race orderings.
- Connector pending test uses actual ConnectorRuntime/gateway with a fake HTTP transport; local HTTP propagation/auth tests use login and CSRF with a recording service. Real WorkerRuntime host tests supply the complementary ownership enforcement evidence. Cluster public HTTP tests include explicit Turn validation/propagation/conflict and current authority; prior richer replay authorization/reopen gates remain green.

Historical failures retained, not rewritten: original 2/13 expected red; first focused 43/1 due to new assertion expecting an absent undefined field; first HTTP/connector run had a duplicate new test variable transform failure plus one old local fixture missing newly required Turn; initial wire command used a nonexistent test path (not execution evidence); first post-connector-marker Worker typecheck required narrowing unknown action. Each setup/typing error was corrected narrowly. Existing local-workbench fake executor now appends a resolution event instead of treating admission as execution; its retry uses the same caller ID, reflecting the approved contract change. No unrelated failing baseline test was relaxed.

Final preservation artifacts: initial preimages and SHA manifest, new-file-aware incremental patch relative to initial dirty source (not HEAD), final hashes, changed-file manifest, HEAD/index/status and preservation report. No staged files or git mutations. Parent must independently review before accepting this increment.

## Unfinished acceptance

No browser/mobile/visual, genuine native Runtime, full dual-host user journey, crash-recovery, native exactly-once or timeout acceptance was performed. The existing browser opt-in test remains skipped. A different active object with an artificially identical invocationId is guarded in code but not separately forced through a public lifecycle test (the manager prevents replacement until lease release). Full Ticket04/all16 remain partial; caller migration and those open validations belong to later authorized work.
