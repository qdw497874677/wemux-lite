# Ticket 02: authenticated Worker command transport harness

Run from repository root after `npm ci --ignore-scripts --no-audit --no-fund`, `npm run build:packages`, and builds of `@wemux/server` and `@wemux/worker`:

```sh
node --import tsx apps/e2e/coordination-command-transport.mjs
# Diagnose one scenario without weakening the default gate:
WEMUX_TICKET02_CASE=positive node --import tsx apps/e2e/coordination-command-transport.mjs
WEMUX_TICKET02_CASE=unsigned node --import tsx apps/e2e/coordination-command-transport.mjs
WEMUX_TICKET02_CASE=revoke node --import tsx apps/e2e/coordination-command-transport.mjs
```

No browser, paid Agent, static dist or external Server is required. The script starts its own loopback Server and TCP pass-through proxy; registers and starts an actual Worker CLI in an exclusively owned temporary home using `owned-worker-fixture.mjs`; provisions an empty Workspace; creates a Task-bound Session via authenticated HTTP; and waits for real command receipts, Worker rows, Test Agent journal output, and observed Server-to-Worker WebSocket deliveries. The Test Agent streams its echo in short deltas, so the harness joins deltas before matching the complete marker. A failed delivery cannot pass as rejection. No credentials, complete frames or raw data are written to disk for evidence. Temporary databases/home are removed **only** from the harness-created `/tmp/wemux-ticket02-*` directory after child processes and sockets close.

Ticket 02 signs **actor-bearing `session.enqueue`** only, not `workspace.provision` or `session.create`. The positive case requires the real enqueue delivery to carry `payload.authorization.signature`. The negative case injects an unsigned `session.enqueue` into the authenticated WebSocket using the observed Server transport epoch and sequence. It requires an explicit Worker `ack` with rejected status, no `message.queued` side effect, and no poisoned Worker command record. The Worker intentionally does not persist rejected unsigned commands, so a mandatory command-record check would incorrectly time out on the intended implementation. The revoke case uses a second contributor's already-delivered queued message: while a prior Test Agent Turn is paused, disable the contributor, restart the **same** Worker home, and assert no `turn.started` and no echo for that queued message. The full default run requires all three checks; isolated modes are diagnostic only, and still require a real legitimate create/enqueue and completed Test Agent echo first.

Verification in isolated worktrees (no paid calls or browser): on baseline `0d918b6`, positive exits 1 at `Ticket02 signature missing on delivered Server command ticket02-positive`, unsigned exits 1 at `unsigned enqueue must receive a rejected ACK` (`actual: accepted`), and revoke exits 1 at `revoked actor must not launch a second Turn after restart` (`actual: 1`). On detached integrated `259d76b`, a separate temporary worktree with its own `npm ci` and builds passes the **default** run and both negative isolated runs. This is a clean-instance, same-version check, **not** legacy queue migration, backup reconciliation, signing-key rotation, OS isolation, or coordination-entry acceptance. Frame injection models a compromised authenticated connection, not a forged network handshake.
