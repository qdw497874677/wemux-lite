# Durable file admission: stage 2 shared contract preparation

## Status and boundary

Implemented shared types, structural parsers, deterministic serialization, Node SHA-256 verification, verified direction-aware frame entrypoints, and explicit two-sided `fs-write-admission-v1` negotiation. This is **disabled preparation**, not an executable admission or filesystem boundary. Independent review returned **OK with notes** for this bounded increment (workflow `b1604c3b-7651-4d0a-9e0c-70dc35015ef7`, reviewer `d5f1f5c9-9da2-442e-a1ff-38d5067ee2bf`, `tickets/03/file-admission-contract-review.md`). The reviewer inspected source and recorded validation evidence without rerunning tests. Stage 1 persisted records and implementation are unchanged.

No Server/Worker producer advertises the new feature; no dispatcher, consumer, HTTP mode, application database format, Worker reservation, result persistence, or activation is added. Existing legacy messages retain their previous parsing and operational semantics. Supporting transport v2, `durable-ack`, or `bounded-replay` does not imply this feature. A future sender must require explicit local and peer support before sending **any** of the new messages, with no fallback to legacy writes. Worker hello `features` and Server hello `enabledFeatures` supply the peer declaration; local implementation readiness supplies the local declaration, not merely a transport version. Existing producers remain untouched.

## Admission identity and persisted fingerprint

`fs.write.admit` carries exactly:

- `type`, `requestId` (Server admissionId, not the client key), `actorId`, `sessionId`, `clientRequestId`, `operation: 'fs.write'`, `workerId`;
- full `binding: { workspaceId, agent: { workerId, agentKey }, modelId }`, with explicit nullable `modelId`;
- exact `subpath`, `base64Content`, `fingerprintVersion: 1`, lowercase 64-hex `fingerprint`.

Actor/client identity is provenance and correlation, **not** Worker authorization. Worker identity must equal `binding.agent.workerId`. Future consumers must authenticate the connected origin and verify local Session binding, Workspace eligibility and filesystem sandboxing independently.

Fingerprint v1 remains SHA-256 of UTF-8 `JSON.stringify` of this exact tuple:

```text
[1, actorId, sessionId, clientRequestId, 'fs.write', workerId,
 binding.workspaceId, binding.agent.workerId, binding.agent.agentKey,
 binding.modelId, subpath, base64Content]
```

No normalization, field reordering, or admissionId insertion is permitted. Every hashed field is on the wire. The admissionId is intentionally NOT part of the persisted v1 fingerprint; result/admission comparison and the result digest separately bind it. The contract test executes the real unchanged stage 1 `admitFileWriteInTx` with a narrow transaction-port fixture and compares its retained fingerprint to a literal vector. This proves serialization compatibility, not SQLite or authorization behavior (those belong to stage 1).

IDs, including binding keys/model ID, are bounded to 200 UTF-16 code units, nonblank, valid Unicode, without C0/DEL controls. Path is a nonempty relative path of at most 4096 UTF-8 bytes, with no empty/dot/dot-dot segment, backslash, colon or controls. These checks are lexical, not symlink safety. Content is canonical padded RFC 4648 base64 with zero pad bits, at most 10 MiB decoded; empty content is valid. Inputs are never silently normalized. This wire boundary can reject out-of-contract legacy internal IDs; it does not rewrite held records.

Stable fingerprint vector:

```text
[1,"actor-1","session-1","client-1","fs.write","worker-1","workspace-1","worker-1","pi","provider/model","notes/你好.txt","aGVsbG8="]
SHA-256: 6dcceaa3ae2d054eaa01af990ed912bb3ef4357d12f2141704171fc1b91815df
```

## Results and ACK

`fs.write.result` carries exactly `type`, `requestId`, `sessionId`, `workerId`, `operation: 'fs.write'`, `fingerprintVersion: 1`, `fingerprint`, `resultVersion: 1`, `outcome`, `resultJson`, `resultDigest`.

Result schema v1 is a concrete **new contract**, not a claim that the runtime implements it. The successful shape follows existing write results (`subpath` and decoded byte `size`), while errors explicitly distinguish effect certainty:

| outcome | Exact retained JSON schema, in property order |
| --- | --- |
| `succeeded` | `{ "ok": true, "operation": "write", "subpath": string, "size": integer }` |
| `rejected-before-effect` | `{ "ok": false, "operation": "write", "effect": "not-started", "error": string }` |
| `unknown` | `{ "ok": false, "operation": "write", "effect": "uncertain", "error": string }` |

`resultJson` is the exact retained canonical `JSON.stringify` representation (no spaces); parsers compare it byte-for-byte with the shared serializer, rejecting reordered/noncanonical JSON, duplicate keys, extra/missing fields, invalid outcome combinations and malformed values. The retained representation is never reserialized for delivery. Error is nonblank valid Unicode, no NUL, at most 4096 UTF-8 bytes. Size is a safe nonnegative integer at most 10 MiB. Verified success must equal the admitted path and decoded content size. `resultVersion: 1` versions both schema and digest representation.

Result digest is SHA-256 of UTF-8 `JSON.stringify` of:

```text
['fs.write.result', resultVersion, requestId, sessionId, workerId, operation,
 fingerprintVersion, fingerprint, outcome, resultJson]
```

Thus identity, outcome, fingerprint and exact immutable result bytes are bound, without hashing mutable transport metadata. For the fingerprint fixture above, admissionId `admission-1` and `resultJson` `{"ok":true,"operation":"write","subpath":"notes/你好.txt","size":5}`, digest is `53530c7acdf9b7c02d1ed87af9ce09888a43c86a1dfb001e471da12a661d534c`.

`fs.write.result.ack` carries exactly `type`, `requestId`, `sessionId`, `workerId`, `operation`, `fingerprintVersion`, `fingerprint`, `resultVersion`, `resultDigest`. Verification requires equality with the retained result's identity and digest. It acknowledges application result correlation, not filesystem success or transport receipt. `unknown` remains uncertain effect, never success or permission for safe retry; neither a result nor its ACK grants recovery or terminal-settlement authority. Reservation, uncertainty policy and durable retention remain future integration work.

## Runtime boundary and browser compatibility

The browser-safe root exports types, serialization and explicitly named `*Structure` parsers only. Existing `parseServerTransportFrame` / `parseWorkerTransportFrame` recognize the new strict structures and directions, rejecting all three new messages in volatile frames. They remain **structural-only** and are not admission integrity checks.

The separately approved package subpath `@wemux/wire-protocol/file-admission-node` imports `node:crypto` and exposes synchronous full parsers and verified frame entrypoints. No root re-export or transitive browser-root import reaches it; no dependency or bespoke hash implementation was added.

Mandatory future integration gates:

1. `parseVerifiedServerFileWriteFrame(rawFrame, negotiation, retainedResult?)` validates raw envelope, direction, durable framing, explicit two-sided support and admission fingerprint or ACK correlation. An ACK requires the exact retained result.
2. `parseVerifiedWorkerFileWriteFrame(rawFrame, negotiation, admission)` additionally requires the immutable admitted snapshot, checks its fingerprint, verifies result digest and compares identities and success path/size.
3. Use these before reservation/I/O/result persistence, not the structural root parser alone. Verify authenticated peer identity and actual authorization/binding separately. Digests are integrity/correlation tools, not MACs or authentication.

These entrypoints do not add a sender or consumer; their presence does not enable a feature. New payload directions are Server→Worker admit/ACK, Worker→Server result. All require durable frames. Other existing frame envelope rules are unchanged.

## Verification and open gates

Repeatable commands (installed dependencies only):

```sh
./node_modules/.bin/tsx --test packages/wire-protocol/test/file-admission.test.ts
./node_modules/.bin/tsx --test packages/wire-protocol/src/*.test.ts packages/wire-protocol/test/*.test.ts
npm run build:packages
node --test packages/wire-protocol/test/*.test.mjs
./node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit
./node_modules/.bin/tsc -p apps/worker/tsconfig.json --noEmit
```

Checked: focused 27/27, TypeScript wire suite 39/39 (including focused), JavaScript wire suite 3/3, package build, downstream Server/Worker noEmit checks. Coverage includes stable real-stage-1 fixture, tampered fingerprint fields and full binding, result/ACK identity and digest tampering, canonical base64/path/size/ID bounds, strict outcome schemas and result bytes, round trips, direction/durability, missing/one-sided negotiation, old-message compatibility, public built subpath and transitive browser-root isolation. An initial browser-isolation test used CommonJS resolution against import-only package exports and failed; the test now uses ESM resolution. No production change was needed for that fixture failure.

Pre-activation compatibility gate: wire identifier validation is stricter than stage 1 internal admission validation. Each held record must pass verified wire validation before any dispatch; incompatible records must remain held without rewriting their immutable identity or falling back to legacy execution.

Deferred: Worker durable reservation/execution/replay; Server result integration and dispatcher; opt-in HTTP and connected end-to-end filesystem effects; process-crash, mixed-version/deployment/restore and recovery authority gates. No browser acceptance was run for this internal seam; connected/crash/browser gates remain OPEN. Ticket03 and history/deletion gates remain partial and unrelaxed.
