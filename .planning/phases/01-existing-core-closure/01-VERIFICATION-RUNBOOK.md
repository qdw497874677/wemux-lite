# Phase 1 验证与候选产物操作协议

本文件是 01-01 至 01-11 各计划中 `test:prepared`/“真实浏览器”验收步骤的**必要前置条件**，不是已经执行过的证明。必须对当前源码快照、构建产物重新运行并记录 exit code；不复用其他会话的 `dist` 或浏览器绿灯。不要并行执行会写同一 `dist`/`artifacts` 的构建。

## 独立执行时的准备

1. 读取 `git status --short` 和相关源码/lockfile/构建输出的 SHA256；不要覆盖共享工作树未提交改动。不自动 Git commit、restore 或清理未知归属数据。
2. 修改 `packages/*` 后先 `npm run build:packages`；Server/Worker/共享客户端有改动时分别构建对应 workspace；Next 生成当前源码私有目录的静态产物（参考 `node_modules/.bin/vite build apps/web-next --config apps/web-next/vite.config.ts --outDir /tmp/<本轮唯一目录>/ui`），核验实际服务使用此产物与本轮 Server/Worker 二进制。构建/打包 Worker 时分别区分 `apps/worker/dist` 与 `artifacts/wemux-lite-worker.tgz`，不能把旧包拿来做真实节点验收。
3. 然后运行 `npm test --workspace @wemux/server`、`npm run test:prepared --workspace @wemux/web-next`、必要 `npm run typecheck --workspace @wemux/server` / `@wemux/worker` / `@wemux/web-next`。`test:prepared` **不执行** `pretest`：跳过第2步会测试旧的构建产物。任何红测保持失败，不修改断言以骗过门槛。
4. 真实浏览器先显式提供两个**绝对路径**变量 `PLAYWRIGHT_CORE_PATH` 与 `PLAYWRIGHT_CHROMIUM_PATH`，用 `node scripts/test-with-browser.mjs -- <实际测试命令>` 预检，不修改/跳过配置门；浏览器入口取 `apps/web-next/tests/acceptance-runtime.mjs`，各票脚本、运行时服务与 `WEMUX_NEXT_TEST_DIST` 等参数从其 `docs/acceptance/web-next-*.md` 当前可重复命令段读取。例如票03 `node scripts/test-with-browser.mjs -- node_modules/.bin/tsx apps/web-next/tests/project-management.browser.mts`。`/tmp/wemux-tailnet-pw/` 与缓存 Chromium 路径只是历史环境示例，需实际核验存在且匹配后才使用。通过验证脚本要求使用它实际读取的私有构建目录、正确 Test Agent/Worker 身份和当前候选，输出脱敏 manifest/hash/截图；真实 Google/SMTP 须受权并真实发出，模拟服务不是等价替代。
5. 所有命令、环境分类（密钥脱敏）、退出码、源码/产物 SHA256、浏览器原始日志与失败/清理记录进 `.scratch/` 或自有 `/tmp`，随 `docs/acceptance/` 留可重复命令和脱敏索引。不要将“截图已生成”当视觉逐图签字。若私有浏览器脚本缺少覆盖，先补可重复脚本再关票。

## 同一候选关门（01-11 专属）

冻结**一次**包含 dirty 工作树在内的源码内容及 package/Server/Worker/Next 产物；先准备，再用该固定产物串行跑所有五票的关联测试、桌面手机/真实 Worker/外部身份/权限负例。记录脚本真实消费的 `WEMUX_NEXT_TEST_DIST`、服务进程二进制与 Browser 配置，逐文件哈希绑定本轮证据。任何修复改变了被消费的源码/产物，即重新冻结并重跑受影响的验收；不同快照的旧绿灯不得拼接签收。独立 Worker 本地双宿主全流程留 Phase 5 的票13/14；此处不冒称已验。任一外部门或人工逐票签收未通过则 Phase 1 保持 OPEN。
