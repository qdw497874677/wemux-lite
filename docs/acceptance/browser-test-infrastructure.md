# Browser-required test launcher

`node scripts/test-with-browser.mjs` launches and closes the explicitly configured
Chromium **before** running `npm test` (including its `pretest` builds). Missing,
relative, unloadable or unlaunchable browser inputs fail the gate, not skip it.
The wrapper preserves the caller's environment, explicitly forwards both browser
paths, runs from its own repository root, and forwards the child exit status.
It does not install dependencies, sanitize credentials, or create an isolated
snapshot. Use the clean environment below for an isolated complete run.

An optional `-- command ...args` runs a focused command after the same preflight.
Arguments are passed directly, without a shell. Do not put a shell command string
in that position. Tests that deliberately clear browser configuration still work:
preflight is only at this launcher boundary, not in every test child.

## Future isolated complete root test (not executed for this repair)

Prerequisites:

- `SNAPSHOT`: absolute path to an independently prepared private source snapshot,
  including the candidate's dirty/untracked source and this launcher, with matching
  dependencies already installed. Do not point it at the working repository.
  Workspace dependency links must resolve **inside the snapshot**, not back into
  the original repository. Do not copy credentials or production data.
- `RUN_ROOT`: absolute path to a fresh private evidence/runtime directory outside
  the source tree. Keep it until the complete run is reviewed.
- `PLAYWRIGHT_CORE_PATH`: caller-selected absolute path to the installed
  `playwright-core` entry module; `PLAYWRIGHT_CHROMIUM_PATH`: caller-selected
  absolute path to its compatible Chromium executable. Both must be readable by
  the isolated process; the executable must be runnable. No automatic downloads.
- `PATH` must contain Node >=22.13, npm and any build tools needed by the candidate.
  `timeout` below is the GNU coreutils command. This command intentionally omits
  real-Agent opt-ins, user credentials, proxies and production service settings.
  If a separately approved network gate needs a proxy, explicitly add its isolated
  proxy variables to `env -i`; do not inherit the operator's environment wholesale.

Set those four path variables in the calling shell, then run:

```sh
: "${SNAPSHOT:?private source snapshot required}"
: "${RUN_ROOT:?private run directory required}"
: "${PLAYWRIGHT_CORE_PATH:?absolute module path required}"
: "${PLAYWRIGHT_CHROMIUM_PATH:?absolute executable path required}"
umask 077
mkdir -p "$RUN_ROOT/home" "$RUN_ROOT/tmp" "$RUN_ROOT/npm-cache" "$RUN_ROOT/prefix"
touch "$RUN_ROOT/empty-user.npmrc" "$RUN_ROOT/empty-global.npmrc"

env -i PATH="$PATH" HOME="$RUN_ROOT/home" TMPDIR="$RUN_ROOT/tmp" \
  npm_config_cache="$RUN_ROOT/npm-cache" npm_config_prefix="$RUN_ROOT/prefix" \
  npm_config_userconfig="$RUN_ROOT/empty-user.npmrc" \
  npm_config_globalconfig="$RUN_ROOT/empty-global.npmrc" \
  npm_config_audit=false npm_config_fund=false npm_config_update_notifier=false \
  PLAYWRIGHT_CORE_PATH="$PLAYWRIGHT_CORE_PATH" \
  PLAYWRIGHT_CHROMIUM_PATH="$PLAYWRIGHT_CHROMIUM_PATH" \
  WEMUX_WEB_DIST="$SNAPSHOT/apps/web/dist" \
  WEMUX_WEB_NEXT_DIST="$SNAPSHOT/apps/web-next/dist" \
  WEMUX_NEXT_DIST_PATH="$SNAPSHOT/apps/web-next/dist" \
  timeout --signal=TERM --kill-after=10s 660s \
  node "$SNAPSHOT/scripts/test-with-browser.mjs" \
  > "$RUN_ROOT/root-test.log" 2>&1
code=$?
printf '%s\n' "$code" > "$RUN_ROOT/root-test.exit"
# Preserve this exit status when embedding in another launcher.
(exit "$code")
```

The root `pretest` builds packages, Server, Worker and legacy Web into their
snapshot-local `dist` directories. Some tests import those paths directly;
environment overrides alone cannot isolate those builds. Thus the private source
snapshot is mandatory for this full command. Root tests do not build the Next
Web UI. The explicit Next dist variables above reserve the snapshot-local paths
for supplemental browser commands; those commands require a separately built
snapshot-local Next dist and are not implicitly part of `npm test`. This wrapper
does not replace pack-check or a broader release gate.

## Bounded repair checks

With explicit browser variables set, from the repository root:

```sh
node --test apps/web-next/tests/browser-test-launcher.test.mjs \
  apps/web-next/tests/real-app-abort-evidence.test.mjs \
  apps/web-next/tests/acceptance-runtime.test.mjs

timeout --signal=TERM --kill-after=5s 150s \
  node scripts/test-with-browser.mjs -- node --test \
  apps/web-next/tests/real-app-abort-diagnostic.test.mjs
```

Verified for this repair: 19 unit/regression tests passed (0 skipped), including
missing/invalid configuration, launch/close failure, launch-before-test ordering,
argument/environment propagation, child failure exit status, default `npm test`,
deliberate missing-env acceptance tests, independent temp evidence and owned
cleanup on success/failure. Both actual-browser diagnostic tests passed (2/2,
0 skipped), with a successful real Chromium preflight. They bundle in memory,
so no repository dist/artifact outputs were rebuilt. The held-read case passes
because it verifies the expected RED diagnostic; it is not a product abort fix.

Each diagnostic self-test now uses an independent `mkdtemp` directory under
`tmpdir()` and removes only its own directory after reading/asserting evidence,
even on failure. Standalone diagnostic commands still retain caller-owned
output for investigation.

Parent review independently reran all four test files together through the real
Chromium preflight wrapper with a fresh private `TMPDIR`: 21 passed, 0 failed,
0 skipped, exit 0. No temporary files remained and `rmdir` succeeded.
`node --check scripts/test-with-browser.mjs` and `git diff --check` also passed.

The earlier full root result remains **exit 1**. The complete candidate/root gate
is pending a separate run; this repair is not a rerun or a release approval.
Previously reported supplemental browser 103/103 and pack-check successes are
historical results, not newly rerun claims.
