# R3 非秘密 Provider 新版本发布与旧绑定保持

Server `POST /api/resources/:resourceId/provider-revisions` 仅管理员可用；Body `{expectedVersion,revision}`。在 SQLite 同一事务内检查当前最高版本 CAS、校验不可变 revision 配置 SHA-256 与严格非秘密结构、更新当前资源 definition 并创建 vN；失败回滚两者并返回 409/400/404。已发布 v1 不可修改；已绑定 v1 的 Preset/Worker 仍固定 v1，新版本只有显式选中/再应用后下发。`apps/web/src/features/presets/preset-studio.tsx` 可从下拉选已有 Provider、修改 endpoint/model/本机凭据 ref 后发布 v2；表单不能填写明文密钥，页面说明尚未认证不能创建 Session。

验证：`apps/server/src/test/resource-repository.test.ts` CAS/事务/旧绑定 1/1；HTTP 路由鉴权与冲突测试、Web 编辑表单源码/行为测试；生产 Web + Chromium 自动脚本 `apps/e2e/resource-preset-browser.mjs` 真实浏览器从 v1 发布 v2、确认 v1 不变、v2 可被 Preset 选择、原 v1 绑定保持，`/tmp/provider-v2-browser-final.log` 通过。`npm run typecheck` 通过（`/tmp/provider-v2-all-typecheck.log`）；最终全量 `npm test` Node 870/862 pass/0 fail/8 skipped、packages 10 pass、Web 293 pass（`/tmp/provider-v2-full-final.log`）。未进行 Provider 真实认证/计费调用；`credential-required` 状态不变。
