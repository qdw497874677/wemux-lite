# Ticket01 new-only bounded closeout

Recorded 2026-10-01. Status proposal: **in-progress**, not complete.

## Scope

`real-instance.mjs` no longer visits the old `/projects` route, captures old-UI screenshots, or reports `legacySameCookie`. It retains desktop/mobile deep-link login, an actual authorized project response and rendered name, reload, back, logout and fail-closed browser diagnostics. The return hash is now asserted as well as path/query. No old UI, Test Agent, Task or Session write is a completion gate.

`real-instance.test.mjs` is a supplemental source guard, not a browser substitute. It failed before removal of the legacy gate and passed afterwards.

## Validation

Private raw evidence: `/tmp/wemux-ticket01-new-only-closeout/` (outside the repository).

- `node --test apps/web-next/tests/real-instance.test.mjs`: red before implementation (`red.log`).
- Targeted `real-instance`, `acceptance-runtime` and `real-instance-credentials` tests: **10/10 passed** (`green.log`).
- `npm run acceptance:safety --workspace @wemux/web-next`: **2/2 passed** before the real login (`safety.log`). This includes the retained historical script's credential sentinel only, not historical UI acceptance.
- `node apps/web-next/tests/real-instance.mjs`: **passed**, bounded to 120 seconds, existing `http://127.0.0.1:8010` only (`real/result.json`). Both 1440×900 desktop and 390×844 mobile completed login, API-confirmed authorized project rendering, deep-link return, refresh, back and logout. Zero unexpected diagnostics; only the existing explicitly classified identity 401/completed-logout 204 events were expected. Loopback HTTP is a potentially trustworthy context, so this run alone does not prove insecure-context clipboard behavior.
- `timeout 90 node apps/web-next/tests/browser.mjs`: **failed** at its final unexpected-diagnostics assertion (`fixture.log`). Controlled fixture completed its preceding assertions for a concealed project, empty/error/retry UI, expired-session notice and re-login, desktop keyboard and mobile focus, insecure-context clipboard fallback, intentional render-error recovery, and Worker host branch. However, one `/next/favicon.svg` request failed with `net::ERR_ABORTED`, no response status, and `expected: false`. This is **not** waived, not a successful fixture run, and not the historical old-UI abort investigation. No diagnostic spiral or classifier relaxation was undertaken.
- Both changed `.mjs` files pass `node --check`; `git diff --check` passed; no staged files.

Browser tooling was explicit: `playwright-core` at `/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs`, Chromium at `/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`. Existing private login input was checked to be mode 0600 and supplied only through `WEMUX_NEXT_LOGIN_FILE`; no credentials, cookies or storage were printed or committed. Screenshots remain under the private evidence directory. No account creation/revocation, Task/Session writes, model calls, deployment or build over the running release occurred.

## Version boundary

HEAD was `93c9f67cab09ca51bd95d8bdb14d7d0ca99f0255` with pre-existing dirty work preserved. Before real login, `/next/` returned 200 and these served assets matched the existing local `apps/web-next/dist` bytes:

- `/next/assets/index-CNwUn9E3.js`: SHA-256 `32357f92a7d657ceeb67937cd9ab8b1d44cd37dc6be6bef766433b4558183693`
- `/next/assets/index-BS5jd1Wd.css`: SHA-256 `7836a22f775ebdc2a44d632b6d6c944c22874fa506d89bba874041156134e12f`

`fingerprint.json` records origin/HTML/assets. `source-fingerprint.json` separately records current source hashes. No release-to-source manifest was verified: matching existing dist is **not** proof that the deployed release represents all current dirty source. These are deployed-asset browser results, not a claim that current source was deployed.

## Remaining Ticket01 closeout gaps

1. Real run establishes positive authorized-project visibility, not negative filtering of a known existing unauthorized project for a restricted identity. The fixture's concealed-project branch is UI behavior only, not backend authorization proof. No restricted identity/project pair was established within this bounded run; no account or access-rule mutation was attempted.
2. Expiry behavior was exercised only in the controlled fixture, whose final diagnostic gate failed. Real-account expiry was not induced or claimed; no other login was revoked or modified.
3. Controlled new-UI browser diagnostics must pass without ignoring unknown failures. The favicon failure remains precise unresolved evidence.
4. Deployed-source provenance is not established. Paperclip licensing/migration inventory/runtime audit and shared-contract coverage were not re-audited in this narrow closeout; existing evidence remains subject to independent review.

Do not mark Ticket01 complete from these results. Legacy frontend failures remain separate historical risks and are not prerequisites. Future complete frontend replacement still requires all effective functionality, both hosts and mobile acceptance; this ticket does not claim that broader completion.
