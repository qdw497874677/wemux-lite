# 02-02 SUMMARY — 协调入口 UI 与服务端关闭态

状态：三个自动任务完成并通过全量门与双视口浏览器验收；禁用态 UX 人审 checkpoint **待批**，未批准前不进入 02-05 矩阵签收。

## 交付

- Server（`apps/server/src/http/routes/team-routes.ts` + 新增 `apps/server/src/application/coordination-gate.ts`）：
  - `coordinationGate` 常量（verdict FAIL、原因、`evidencePath`、`remediationSection` 五、`reopenConditions`），唯一事实来源，非请求可翻转开关；
  - `GET /api/teams/:id/coordination/availability`：成员资格先于投影（非成员/跨 Team 403 已由 `assertTeamCoordinationCreator` 语义覆盖，不泄漏 Team 存在性），返回 `{ status: 'disabled', gate }`；
  - `POST /api/teams/:id/coordination/sessions`：资格门 FAIL 下 403 `coordination_gate_closed`（与既有 `write_channel_closed` 同策略拒绝语义；409 保留给 `request_id_conflict`）。
- 契约：`packages/web-contract/src/browser-host.ts` 新增 `TeamCoordinationAvailabilityDTO`；`packages/web-client/src/account-management.ts` 新增 `teamCoordinationAvailability` 路由与方法（request 层带 signal，无 CSRF 需求读接口）。
- Web（`apps/web-next/src/components/TeamCoordination.tsx`、`App.tsx`）：Team 页渲染协调入口；状态卡呈现 FAIL、原因、证据路径（gate 文档 + 02-05 矩阵位置）、解除条件；无发送/上传控件；接口失败呈现 Failure（未知错误归一通用文案）。`account-section` 沿用现有样式类，无新 CSS。
- e2e（`apps/e2e/next-coordination-entry-browser.mjs`）：真实 Server + 真实账号 + 双视口，14 项检查全绿；截图存 `.scratch/web-next-project-agent-platform/evidence/02-02/`。
- 组件测试（`apps/web-next/src/components/__tests__/TeamCoordination.test.mjs`）：esbuild 打包 + 真实 Chromium；断言禁用卡三要素、零交互控件、错误路径 Failure、api 调用参数（teamId）。

## 验证（全量门）

- `npm test --workspace @wemux/server`：925/925（新增 `team-coordination-entry.test.ts`，含可用性投影、关闭态 enqueue、非成员 403、CSRF 缺失下写路径仍先过成员/资格门）。
- `npm run test:prepared --workspace @wemux/web-next`：168/168（带 `PLAYWRIGHT_CORE_PATH`/`PLAYWRIGHT_CHROMIUM_PATH`；不带时 4 项浏览器用例按设计报配置错）。
- `npm run typecheck --workspace @wemux/web-next`：通过；`npm run build:packages` 通过；源码扫描无 `crypto.randomUUID` / `document.execCommand`。
- 浏览器 e2e：HTTP 3 项（投影/关闭态/非成员）+ 桌面 5 项 + 手机 5 项 + 零 pageerror。
- 验收摘要：`docs/acceptance/web-next-phase2-coordination-entry.md`。

## 待决 checkpoint：禁用态 UX 人审（blocking-human）

需人审：状态卡信息层次能否支撑“为何不可用 / 如何解除 / 为何不是风险接受（D-02）”；是否存在隐藏可用入口。批准后方可进入 02-05 矩阵签收（02-04 配对观测不受此 checkpoint 阻塞）。