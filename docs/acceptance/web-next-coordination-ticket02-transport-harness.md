# Ticket 02: authenticated Worker command transport harness

Run from repository root after `npm ci` and `npm run build:packages`:

```sh
node --import tsx apps/e2e/coordination-command-transport.mjs
# Isolate a failing scenario without weakening the full gate:
WEMUX_TICKET02_CASE=unsigned node --import tsx apps/e2e/coordination-command-transport.mjs
WEMUX_TICKET02_CASE=revoke node --import tsx apps/e2e/coordination-command-transport.mjs
```

No browser, real/paid Agent, static dist or external Server is required. The script makes its own loopback Server and TCP pass-through proxy; registers and starts an actual Worker CLI in an exclusively owned temporary home using `owned-worker-fixture.mjs`; provisions an empty Workspace; creates a Task-bound Session via authenticated HTTP; and waits for real command receipts, Worker rows, Test Agent journal output, and observed Server-to-Worker WebSocket command frames. This deliberately cannot pass just because a command was never delivered. The negative proxy frame construction follows `coordination-write-channel-probes.mjs`: real Server transport epoch/sequence are observed from the handshake, and unsigned durable commands are injected into the same live socket. A Worker command record plus rejected receipt must exist; absence of a receipt times out, not passes. No credentials, complete frames or raw data are written to disk for evidence. Temporary databases/home are removed **only** from the harness-created `/tmp/wemux-ticket02-*` directory after all child processes and sockets close.

Expected on baseline `7843efa`: **red**, not a release gate that silently skips. The first failure should be `Ticket02 signature missing on delivered Server command` because the authorization assertion is not yet implemented. `WEMUX_TICKET02_CASE=unsigned` bypasses only that *positive signature check*, then must go red on an accepted injected `session.create` (or provisioning). `WEMUX_TICKET02_CASE=revoke` bypasses the signature/unsigned assertions to test a second contributor's already-delivered queued Turn: wait for the prior Test Agent Turn, disable contributor, restart the **same** Worker home, assert no `turn.started` and no echo for the queued message. This case is expected red before online pre-launch revocation checks exist. Isolated negative modes still require the legitimate create/enqueue, delivery and completed Test Agent Turn to succeed first.

After Ticket 02 lands, run the **default** case again on the integrated branch. The exact signed-envelope field is intentionally read from the real command payload (`command.authorization` or `payload.authorization`); if the final protocol names it differently, adapt *only* the observation to the versioned contract and keep the mandatory `signed === true` assertion. Likewise, adapt the injected envelope to the final protocol rather than removing receipt, side-effect, or delivery assertions. A pass proves the narrow clean-instance, same-version path, **not** legacy queue migration, backup reconciliation, signing-key rotation, OS isolation, or coordination-entry acceptance. Transport frame injection relies on the actual authenticated WebSocket but intentionally models a compromised connection; it is not a forged network handshake.

At preparation time this worktree had no `node_modules`/`tsx`, so only `node --check apps/e2e/coordination-command-transport.mjs` was runnable. No paid/runtime or unrelated instances were started or cleaned.
