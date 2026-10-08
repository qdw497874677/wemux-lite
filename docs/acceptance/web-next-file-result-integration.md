# Durable file results: real Worker/Server integration (test-only)

## Status and scope

Implemented and writer-checked; independently reviewed **OK with notes / no issues** by reviewer `cb0f4a30-ae4d-40f3-85cc-8bf54d6411da`, and accepted by the parent for this bounded test/documentation increment only. The reviewer inspected source, incremental diff and recorded writer evidence, but did not rerun tests or independently recompute hashes. Review artifact: `/opt/data/.pi/agent/sessions/--opt-data-profiles-hacker-workspace-project-wemux-mini--/subagent-artifacts/outputs/b9465e2b-104c-4dca-ac76-0338003031f0/tickets/03/real-worker-result-integration-review.md`. Production remains **OFF**; Ticket03/all16 remain **partial**. This increment changes one new Worker test and acceptance documentation only. No product source, schema, wire, dependency, HTTP/bootstrap/dispatcher, build configuration or shared generated assets change.

The preceding Server operational-classification correction independently passed rereview **OK with notes** (2dacb5cc), accepted by the parent with prior P1 resolved. `web-next-server-result-ingress.md` now reflects that accepted static review while preserving the initial BLOCK, writer-run red/green and reviewer-not-rerun distinction. That prior acceptance does not approve this new test slice.

## What actually runs

`apps/worker/test/file-result-integration.test.ts` embeds the real `WorkerRuntime`, executor, `writeWorkspaceFile`, `WebSocketTransport`, `WorkerGateway`, Worker authentication/WorkerService and `ServerService.receiveFileWriteResult`. Both application stores and both transport stores are real temporary SQLite files, each observed through an independent database connection. Actual WebSocket HTTP upgrades use dynamic IPv4 loopback ports (explicitly not 8004), and stored synthetic credentials only. No Agent, external service, paid model, public network, installation, CLI process, production SQLite or browser is used.

The Server admission uses authorized `ServerService.admitFileWrite` for a Task-bound Session owned by the synthetic actor. **There is no Server admission dispatcher.** After composing Runtime/transport and initializing the empty Runtime, the test seeds the new cluster Workspace/Session and invokes Runtime's existing trusted internal `fileWriteIngress.receive` seam with the admitted wire payload. Its test-only admission envelope never enters either transport inbox. The real helper writes `hello` once; the committed retained result and pending marker are independently checked before transport starts. This is explicitly not proof of admission delivery, Server dispatch or a held-state transition. No generic-send bypass is introduced.

Initial Worker start then negotiates real two-sided support. The existing Runtime replay projects the committed result through actual Worker transport, Server gateway/parser/application commit, durable ACK outbox, Worker parser and Runtime ACK transaction. The test does not call `runtime.connected()` (unrelated periodic capability/history/workspace reporting is outside this result seam); ordinary incoming legacy traffic still delegates to real `runtime.receive`.

## Five behavioral cases

1. **Transport receipt first:** test-local Server socket gate delays the real application ACK. Independent observers see Worker result outbox empty, application marker `0`, pending obligation present, and Server ACK outbox retained. Releasing the original ACK reaches real Worker ingress and commits marker `1`.
2. **Application receipt first:** a gate delays only the real Server transport receipt. Worker marker is already `1`, original Worker result envelope remains, and Server ACK envelope has been transport-received. Releasing the transport receipt removes only the Worker envelope.
3. **Actual Server result INSERT failure:** temporary SQLite trigger aborts the real application insertion after transport inbox acceptance. No Server result or application ACK exists; the actual Worker enters ordinary backoff with its result bytes and obligation intact.
4. **Actual application COMMIT failure:** a deferred foreign-key violation is inserted by a result trigger. The real outer COMMIT fails and rolls back both result and probe rows. Same no-ACK/backoff invariants hold.
5. **Actual ACK-outbox INSERT failure:** application result is committed, transport ACK enqueue aborts. The Worker remains application-pending; retry preserves the original committed Server result bytes.

For all three faults, an explicit observed-backoff barrier precedes trigger removal. A bounded next-connection callback gate prevents replay racing fault inspection/removal. Only the existing Worker backoff timer performs the second connection, with test-configured 1ms bounded delay/no jitter. There is no manual `connect`, second `start`, retry, stop/restart or store reconstruction after fault. Tests count actual HTTP upgrades and distinct Server sockets as well as callbacks: exactly two connections, two result projections/receiver calls, no `needs-attention`. The accepted hello transport cursor removes the first envelope and Runtime reprojects a new transport identity with the **same retained application bytes**. No filesystem helper re-entry occurs.

All cases check verified application ACK correlation, independently persisted marker `1`, both outboxes drained, retained Worker admission/result and Server result intact, exact original held admission/intent rows unchanged, and empty Server deliverable commands. A 100-receipt burst in **each direction** does not increase application enqueue/receiver counts. Ordering is established by protocol ping/pong queue checkpoints and explicit promises, not arbitrary sleeps or sleep polling. Each case has an 8s event deadline and a 10s test deadline. Cleanup in `finally` releases gates, stops/drains the Worker socket queue, shuts down Runtime and gateway before closing dependent databases and removing the owned temporary directory; gateway solely owns its transport after composition.

## Sensitivity and disclosed fixture correction

`WEMUX_TEST_PERMANENT_RESULT_SIGNAL=1` is a strictly test-local sensitivity switch. The socket interceptor replaces only the real fault error's wire classification with permanent `invalid-frame`/`retryable:false`. All three actual-Worker fault tests fail immediately with **`needs-attention` instead of `backoff`**, 0/3, exit 1. Clearing the switch passes all five cases. This establishes sensitivity to the original failure **mechanism**, not a source revert or re-execution of the original pre-correction implementation. No preexisting source was overwritten. The prior correction's actual pre-fix red evidence remains separate.

The first focused run failed 0/5, exit 1 due to **test fixture defects**: initialize ran before its transport reference existed, and cleanup double-closed gateway-owned transport SQLite. The writer stopped/reported; parent authorized only test setup/ownership corrections. The fixed fixture composes transport first, initializes before seeding a newly created Session (rather than boot-time history), and assigns one cleanup owner. Initial red is retained, not counted as product or sensitivity evidence. No product defect was found or changed. No tool/model/protocol fallback occurred.

## Commands and evidence

Packet: `/tmp/real-worker-result-integration.8o6XQP`.

- `focused-initial.log`: fixture red 0/5, exit 1.
- `focused-setup-fixed.log`: corrected fixture 5/5, exit 0.
- `sensitivity-red.log`: injected permanent signal 0/3, exit 1, specific state assertion failures.
- `focused-final.log`: final five cases 5/5, exit 0.
- `regression-final.log`: **164/164**, exit 0, including the five new cases; not additive to focused totals.
- `repeat-1.log` through `repeat-3.log`: independent repeated focused executions, each 5/5, exit 0.
- `server-noemit.log`, `worker-noemit.log`, `integration-noemit-final.log`: exit 0. The integration file is outside Worker production tsconfig, so explicit strict direct test typechecking was also executed.
- `commands.log`: exact commands and exits; `incremental.diff`, `postimages/`, `hashes.json`, `final-hashes.json`, `preservation-audit.json`: baseline and final scope/preservation evidence.

```sh
./node_modules/.bin/tsx --test apps/worker/test/file-result-integration.test.ts
WEMUX_TEST_PERMANENT_RESULT_SIGNAL=1 ./node_modules/.bin/tsx --test --test-name-pattern=automatic apps/worker/test/file-result-integration.test.ts
./node_modules/.bin/tsx --test \
  apps/worker/test/file-result-integration.test.ts \
  apps/worker/test/worker-file-ingress.test.ts \
  apps/worker/test/worker-file-executor.test.ts \
  apps/worker/test/worker-file-store.test.ts \
  apps/worker/test/transport-store.test.ts \
  apps/worker/test/websocket-transport.test.ts \
  apps/server/src/test/server-result-ingress.test.ts \
  apps/server/src/test/server-file-results.test.ts \
  apps/server/src/test/server-file-admission.test.ts \
  apps/server/src/test/transport-receipt.test.ts \
  apps/server/src/test/transaction-composition.test.ts \
  apps/server/src/test/transaction-lifecycle.test.ts
./node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit
./node_modules/.bin/tsc -p apps/worker/tsconfig.json --noEmit
./node_modules/.bin/tsc --noEmit --target ES2022 --module ESNext --moduleResolution Bundler --strict --skipLibCheck --resolveJsonModule --isolatedModules --allowImportingTsExtensions --types node apps/worker/test/file-result-integration.test.ts
```

## Preservation and residual gates

Pre-mutation HEAD `93c9f67cab09ca51bd95d8bdb14d7d0ca99f0255`, index/status/dirty diff and **1066** relative-path hashes/preimages captured, including untracked sources and `apps/web/src/features/artifacts/artifacts-section.tsx`. Root generated/private paths excluded; no nested source artifacts excluded (nested dist/node_modules exclusion predicates matched zero enumerated paths). Final expected scope: one existing acceptance document changed, two new files; all other 1065 baseline files unchanged, zero removed; HEAD/index unchanged, no staged files. Previous correction packets are references, not this baseline.

Remaining gates: admission dispatch and activation; CLI/OS-process crash/restore/mixed-version continuity; browser/public TLS/deployment identity; operational recovery/takeover/unknown reconciliation; global filesystem concurrency/history/deletion lifecycle. Runtime runs in-process, not as the Worker CLI. Trigger failures and callback gates are not process-crash evidence. Most importantly, transport-only inbox identity still does **not** bind original payload bytes before first application commit: this suite verifies the honest real Worker's retained replay, not protection against a changed-valid-payload replay in that gap. Production remains OFF and no Ticket03/all16 completion or broader recovery authority is inferred.
