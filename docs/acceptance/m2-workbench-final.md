# M2 

：2026-09-16  
：**； Agent HTTPS **

## 

 M2 （S1–S6） Worker （W1–W3）：

- Workspace Placement / Worker / Agent / Model ； Agent 。
- 、 URL 、。
- 、Markdown、、、/、。
- 、、、、。
- Session 、/、。
- Worker 、、、、。
- Worker 、、/， Agent 。

## 

```bash
npm run typecheck
npm test
npm run build
npm run pack:check --workspace @wemux/worker
git diff --check
```

：

- TypeScript ：。
-：Server/Worker/packages `396 tests`（`392 passed`、`4 skipped`、`0 failed`）；Web `125 passed`、`0 failed`。
-：Server、Worker、packages、Web 。
- Worker ：， tgz 。
- ：。
- Web bundle ：817.78 kB（gzip 257.83 kB）； Vite 500 kB ， M2 。

## 

### Server Session 

：`apps/server/src/test/session-workbench.test.ts`

```text
4 passed, 0 failed
```

：

- submission command ， Session 。
- active Turn、 Journal 。
- stop command  Turn 。
- runtime command approval 。
- Session /、/，。

### Worker 

：

- `apps/worker/test/cluster-lifecycle.test.ts`
- `apps/worker/test/cluster-enrollment.test.ts`
- `apps/worker/test/local-workbench.test.ts`
- `apps/worker/test/local-control.test.ts`

```text
22 focused non-browser tests: 21 passed, 0 failed, 1 skipped
11 Chromium tests: 11 passed, 0 failed
```

：

- identity URL `ws/wss → http/https origin`， 5 。
- Server ，，。
- connect ，。
- CLI ，。
- Worker Web 、、、、。
- 、， Pi `compact` 。
- Journal ，SSE `Last-Event-ID` ，。

### Web 

：

- `apps/web/src/api/cluster-m2.test.mjs`
- `apps/web/tests/quick-start.test.mjs`
- `apps/web/tests/conversation-ux.test.mjs`
- `apps/web/tests/runtime-usage.test.mjs`

```text
27 passed, 0 failed
```

：

- Placement ， `workerId`。
- Agent 。
- lost-response `requestId` / `commandId` / `messageId` 。
- Journal 、 active Turn、。
- /、、请求。
- 、 partial 、。

 Mock HTTP Chromium：

- 900px Placement、、、/。
-：`/tmp/wemux-cluster-m2-tablet.png`

 Worker Chromium：

- 、、、Agent/、、、、、、、。
-：`/tmp/local-m2-browser.png`

## 

1. ** Agent **： Pi/Claude 、，；。
2. ** HTTPS **：Cookie `Secure` ； Worker `--allowed-origin` / `WEMUX_WORKER_ALLOWED_ORIGINS`，。
3. ** Agent **：Pi ，Claude Code ， UI 。
4. **：**Worker ；，；。
5. ** bundle ：**Web  500 kB， M2 ，。

## 

M2 、、、 Web、、 Server API Worker ，。

 M2.5/M3：Agent Network 、Project、 Task 。
