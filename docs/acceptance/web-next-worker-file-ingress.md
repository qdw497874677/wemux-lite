# Durable file admission: internal Worker transport/Runtime integration

## Status and ownership

Implemented an explicitly opted-in embedding of the reviewed shared protocol, real Worker application store, executor, Runtime and WebSocket transport. **Production remains OFF. Ticket03/all16 remain partial.** Independent integration review initially returned **BLOCK**; the correction below passed independent rereview **OK with notes**, accepted by the parent for this scoped internal integration only. The prior executor review was OK with notes; that review is not integration acceptance.

Only Runtime, Worker transport/types, the executor composition comment, focused tests and these acceptance documents change. No Server, shared package, SQL schema/table, cluster-lifecycle, CLI, bootstrap, dependency or production constructor changes. All preexisting dirty work is retained.

Embedding requires Runtime's final `fileWrites` option and passing its `fileWriteIngress` port to `WebSocketTransport`. Absence of either does not create an operational feature. Existing lifecycle construction supplies neither. Ordinary `Runtime.receive(payload)` continues to ignore new file admit/ACK messages; generic transport `send` refuses file results. The internal port is trusted in-process composition, not a public authentication API.

## Ingress and trust boundary

- Raw WebSocket bytes are converted to an immutable string synchronously before the asynchronous message queue. Runtime privately clones the complete frame and negotiation before its common commands queue. Caller mutation cannot alter the queued admission.
- File ingress requires an accepted hello on the current socket generation, explicit local support and peer `enabledFeatures: fs-write-admission-v1`, durable framing, correct direction and the existing Node verified-frame parser. ACK verification loads the exact committed retained result. Unsupported, malformed, volatile, wrong-direction and fingerprint-mismatched inputs fail before application reservation/effect.
- The cluster connection boundary is the configured endpoint, supplied credential, accepted hello and current socket generation, **not** an actor/identity boolean or a hash. The synthetic localhost Server asserts the handshake Bearer credential. A configured `ws://`/HTTP endpoint offers no TLS confidentiality or cryptographic Server authentication; hello/fingerprint alone cannot fix endpoint impersonation. Public production TLS and deployment identity remain separate gates.
- The executor rechecks actual registered Worker, Session binding and ready cluster-owned Workspace at execution time, before reservation or retained-result disclosure. Local-host/local-Project denial is preserved; private history is not mistaken for local hosting.
- Transport awaits asynchronous legacy and file handlers and reports rejection through existing diagnostics. The durable inbox/transport ACK commits **before** application processing. A crash in that gap still needs Server durable application-intent redelivery using a fresh delivery sequence and unchanged admission identity. This increment does not implement that Server behavior.

## Execution, closing and unresolved records

The executor is awaited inside Runtime's existing commands queue, not a parallel execution lane. Session deletion/binding changes and file admission are ordered by that queue. Reservation commit precedes the real awaited filesystem helper; exact result plus application delivery obligation commit before publication.

Shutdown rejects future file work and drains already admitted queued/active work before closing the executor. Abort prevents queued/future work but does **not** cancel or prove cessation of an already active filesystem write; active settlement is still awaited by shutdown. Ordinary reconnect/reopen never calls recovery: unresolved reservations remain `await-existing`, without another effect. No takeover, reconciliation, exclusive-owner recovery or Workspace-wide exclusion is supplied. Legacy file operations, Agents, terminals and other processes remain outside any new global file barrier.

## Delivery and two independent receipt layers

- Results are projected only after committed application reads, on new-result/authorized duplicate events or reconnect, never from pure transport ACK/flush. Runtime serializes pending-result reads/rechecks and application ACKs in the same commands owner.
- Outbox deduplication compares the full result domain identity (request, Session, Worker, operation, fingerprint/version, result version/digest) plus retained outcome/JSON. An in-memory per-connection set prevents repeated fresh envelopes after transport receipt within that connection. A reconnect can project a still-application-pending result again only after the old envelope's transport receipt; its application bytes remain exact.
- An outstanding envelope replays with its original transport sequence/message ID. Application ACK commits only the application delivery marker. It does not delete an un-transport-ACKed envelope, advance any transport cursor, erase admission/result tombstones or imply success. The normal transport ACK removes envelopes; accepted reconnect receipt cursors also clean covered rows before dedup/reprojection. This closes the stale covered-row suppression case without changing schema.
- Application ACK before transport ACK can therefore leave a stale transport envelope on disk. Reopen replays that original envelope, but committed application state prevents fresh application re-enqueue. Transport ACK before application ACK removes the envelope while preserving the application obligation for bounded reconnect replay. Send/enqueue failures preserve that obligation and surface diagnostics.
- A retained incompatible envelope on reconnect to a nonnegotiating peer stops the whole opt-in connection in `needs-attention`, emits a diagnostic and sends no file result. It does not skip a sequence, silently block a queue or spin reconnects. A permanent transport rejection while file envelopes are outstanding likewise stops without manufacturing a receipt. These are internal opt-in availability limitations, **not production downgrade compatibility**. Other legacy traffic may be unavailable until an operator resolves the connection. Existing legacy-only rejection behavior is preserved.
- Pure ACK bursts only flush retained transport envelopes. No result re-enqueue loop or reconnect accumulation of duplicate outstanding envelopes is introduced. Pending application replay currently enumerates pending records on a reconnect trigger; no new pagination/storage contract is claimed.

## Checked evidence

New repeatable suite: `apps/worker/test/worker-file-ingress.test.ts`, **19 tests**, actual dynamic-port localhost `ws` Server, synthetic handshake credential, actual `WebSocketTransport` + `WorkerRuntime`, real temporary application and transport SQLite files and temporary filesystem. Assertions include:

- negotiated write exactly once and independently observed committed retained bytes before socket send;
- same/new delivery-sequence duplicates, conflicting identity, malformed/hash/direction/durability/negotiation denial, local Workspace/current binding denial and raw Runtime payload non-bypass;
- exact reconnect replay, both ACK orders, wrong/duplicate ACK, committed application ACK with stale envelope across reopen, lost transport ACK represented by accepted hello cursor, legacy sequence continuity after cleanup;
- 100 transport ACKs without result busy loop; outstanding replay dedup; nonnegotiating reconnect zero leakage and explicit stop; permanent rejection preservation;
- sender-object isolation after serialization and Runtime queue mutation, current-generation stale-frame discard, pre-handshake denial, Session deletion sharing command ordering, shutdown drain and abort non-cancellation; receiver Buffer mutation is proved only by the subsequent correction test below;
- actual socket send callback failure, enqueue failure and awaited asynchronous handler rejection; no lost application obligation;
- ordinary unresolved reopen without recovery; ACK-before-replay serialization preventing application-delivery resurrection.

Tests use controllable promises and protocol ping/pong checkpoints rather than arbitrary sleep polling. Existing WebSocket transport regression tests retain their preexisting timing waits. The socket failure test temporarily intercepts only the first result send callback and restores the original method; the connection, store and executor remain real.

Commands and exit codes:

```sh
# Before interrupted agent recovery: exit 0, 10/10
./node_modules/.bin/tsx --test apps/worker/test/worker-file-ingress.test.ts
# Before interrupted agent recovery: exit 0
./node_modules/.bin/tsc -p apps/worker/tsconfig.json --noEmit
# Expanded intermediate run: exit 0, 17/17
./node_modules/.bin/tsx --test apps/worker/test/worker-file-ingress.test.ts
# Final selected offline/loopback regression: exit 0, 82/82
./node_modules/.bin/tsx --test \
  apps/worker/test/worker-file-ingress.test.ts \
  apps/worker/test/worker-file-executor.test.ts \
  apps/worker/test/worker-file-store.test.ts \
  apps/worker/test/transport-store.test.ts \
  apps/worker/test/websocket-transport.test.ts \
  apps/worker/test/isolation.test.ts \
  apps/worker/test/retention-upgrade.test.ts \
  apps/worker/test/ticket06-evidence.test.ts \
  apps/worker/test/connector-mcp-storage.test.ts \
  apps/worker/test/provider-credential.test.ts \
  apps/worker/src/test/model-swap.test.ts
# Final exit 0
./node_modules/.bin/tsc -p apps/worker/tsconfig.json --noEmit
```

An additional intermediate combined run passed 81/81 before the permanent-rejection test was added. No failing validation command occurred before independent review in the original integration increment; the subsequent correction includes intentional red runs recorded below; earlier executor/storage historical failures remain documented in their own acceptance records. Provider stream interruption was not a code/test failure. No full suites, real Agents, external network, real credentials, installs, root builds, package builds, pack, deployment or live databases were used.

## Preservation and remaining gates

Evidence packet: `/tmp/worker-file-ingress.PuVHUE`. Baseline HEAD `93c9f67cab09ca51bd95d8bdb14d7d0ca99f0255`; original preimages/hash manifest, HEAD/index/status/diff and initial logs were captured before mutation. Parent interruption packet: `/tmp/wemux-ingress-interruption-cL9Lzu`. The recovery compares against the original preimages, not merely HEAD. Final packet includes postimages, incremental diff including new files, exact command logs, hashes and preservation audit. No staging, reset, clean, stash, commit or push.

OPEN: Server application-result integration/intent and application-ACK redelivery; process-crash fault injection (reopen tests are not process-crash proof); whole-system/browser connected acceptance; production activation, mixed-version/deployment/restore continuity, operational recovery/ownership and file concurrency/history/deletion guarantees. The integration is loopback-checked only and does not inflate Ticket03 completion.

## Independent review BLOCK and handshake/snapshot correction

Independent read-only review (`17f98714-c50c-472a-b6fd-08bceb977c6b/tickets/03/worker-file-ingress-review.md`) returned **BLOCK**. P1 identified a production-default regression: the accepted-hello guard preceded `transport.error`, so a valid permanent negotiation rejection became a generic failure/backoff rather than `needs-attention`. P2 noted that the original sender mutation test could not prove the receiver Buffer snapshot. The reviewer inspected prior evidence without rerunning tests. **Fixes below have writer-executed test evidence and independent static rereview acceptance.** Rereview `c37f045d-3c18-438b-b17b-39b557810a5a/tickets/03/worker-ingress-handshake-rereview.md`, child `8809e666-07f6-45b8-b63e-3df3d90bb797`, found both P1/P2 resolved with no new findings and returned **OK with notes**. The reviewer inspected source, incremental diff and logs; neither reviewer nor parent reran tests. This does not approve production activation or close whole-system gates.

Correction production diff is limited to eleven lines in Worker `websocket.ts`. The existing structural parser still validates exact error keys, allowed error code, nonempty message and boolean retryable before handling. Actual Server gateway negotiation failure sends this control frame instead of hello (`apps/server/src/worker-ws/gateway.ts`); no Server code changed.

A valid pre-hello error now reports the code and exact Server message. Permanent rejection sets `stopped`, transitions to `needs-attention` with the exact message as reason, and closes without any outbox deletion, cursor advancement, publication or scheduled retry. Retryable errors preserve all data and explicitly use ordinary close/backoff. Neither path reaches `dropOldestUnacked`. The accepted-hello guard still applies to data/admissions/receipts. Invalid error shape is still a protocol rejection, not a trusted negotiation failure.

Correction tests add twelve cases, bringing ingress to **31**:

- Six real loopback combinations: default-off/opt-in crossed with empty, legacy or real retained file-result outbox. Each asserts Worker-close completion, needs-attention, exact diagnostic/reason, no retry timer/backoff, no data send or drop, unchanged envelope/application records, and zero ingress writes.
- Retryable pre-hello rejection with retained data explicitly schedules backoff without loss.
- Three malformed error shapes and an unnegotiated receipt do not bypass parser/handshake requirements.
- The actual connected Worker socket's registered message listener receives a mutable Buffer while prior processing is gated. The test mutates the Buffer after listener return, releases the queue, and proves the original admission executes. Test-local inspection of TypeScript-private socket/processing state adds **no public production hook**. The original sender test is renamed honestly.

Red/green evidence is separate from the original packet:
`/tmp/worker-ingress-handshake-fix.wc9ZbS`.

| Command/run | Exit | Result |
| --- | --- | --- |
| `tsx --test --test-name-pattern='permanent pre-hello rejection' apps/worker/test/worker-file-ingress.test.ts`, initial Server-close signal | 1 | Intentional red, 0/6; initially observed connecting before Worker close |
| Same command after switching to deterministic Worker-close signal | 1 | Intentional red, 0/6; recorded connecting/backoff instead of needs-attention |
| `tsx --test apps/worker/test/worker-file-ingress.test.ts apps/worker/test/websocket-transport.test.ts` | 0 | Green, 34/34 |
| `tsx --test --test-name-pattern='receiver message listener snapshots' apps/worker/test/worker-file-ingress.test.ts` with temporary deferred-toString mutant | 1 | Intentional sensitivity red, 0/1, writes 0 rather than 1 |
| Same snapshot command after restoring synchronous receiver snapshot | 0 | Green, 1/1 |
| Previously selected full eleven-file offline/loopback family shown above | 0 | Green, **94/94**, including all original 82 cases |
| `./node_modules/.bin/tsc -p apps/worker/tsconfig.json --noEmit` | 0 | No diagnostics |

All `tsx` commands used `./node_modules/.bin/tsx`. Exact commands/logs, correction-specific original preimages/hash manifest, HEAD/index/status, scoped incremental diff, postimages and preservation audit are in the correction packet. The temporary mutation changed only snapshot timing for the sensitivity run and was restored before final verification. The original `/tmp/worker-file-ingress.PuVHUE` evidence remains untouched.

Only `apps/worker/src/transport/websocket.ts`, `apps/worker/test/worker-file-ingress.test.ts` and this acceptance document change in the correction. Production feature remains OFF; no schema/Server/bootstrap/installation/Agent/external-network/live-service changes. All earlier production, crash-gap, process-crash, browser, ownership/recovery and Ticket03 gates remain open.
