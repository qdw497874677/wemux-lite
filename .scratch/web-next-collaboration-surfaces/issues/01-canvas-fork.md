# 01: 画布共享与 Fork 血缘

Status: done
Blocked by: 无未完成 ticket 前置；复用现有账号授权与 Task Session 基线，不依赖计划交接或跨 Runtime 闭环验收。

**Spec:** [会话协作界面](../spec.md)
**合并来源:** `43966aa` 的原票 01（范围不变）。
**What to build:** 会话画布按权限共享与访问；用户可在同 Task 下从固定 cursor Fork 出新会话，保留血缘；撤权后列表、血缘、缓存与实时流同步过滤，清理受控客户端缓存并阻断后续访问；已下载副本不能回收。

## 实现计划

1. 盘点 Session 关系、cursor 和权限投影，在 `apps/server/src/application` 的关系查询中统一过滤列表、标题、计数与血缘。
2. 实现同 Task 固定 cursor Fork 及 web-next 画布入口，明确共享 Placement 文件不因私有 Session 隔离。
3. 两用户真实浏览器验证撤权后四出口过滤与断流、刷新和重连，保留原会话历史及证据。

## 验收

- [x] 画布内容只对获权成员可见，未获权访问被拒
- [x] 同 Task 下 Fork 固定 cursor，血缘可追溯
- [x] 撤权后列表、血缘、受控客户端缓存与实时流四个出口停止提供并清理；不承诺回收已下载副本
- [x] Fork 不修改原会话历史
- [x] 断言与截图作为证据留存

## 验收记录（2026-10-14）

分支 `collab-01-canvas-fork`，基点 `8cf9bff`，已 `git merge main`（合并进来 `c6d0771`），合并后重跑全部验证。

提交（按实现顺序）：

- `44c70d8` feat(server): 画布与 Fork 血缘按会话权限对项目成员开放
- `9da968f` feat(web-client): 增加画布图、血缘与 Fork 命令的集群客户端
- `6ee31c6` feat(web-next): 会话图确定性布局投影
- `dc9ef7e` feat(web-client): 增加画布协作实时流订阅
- `455d678` refactor(web-next): 抽出创建意图 hook 到 lib
- `acf8414` fix(web-next): 会话图布局沿用品牌会话标识类型
- `739e6de` refactor(web-contract): Fork 请求与响应 DTO 使用纯字符串标识
- `b144a20` feat(web-next): 会话画布与固定游标 Fork 入口
- `21471d5` fix(server): 会话血缘成员测试改用品牌标识类型
- `921457c` test(e2e): 画布与 Fork 的两用户真实浏览器验收
- `5d650c7` Merge branch 'main' into collab-01-canvas-fork
- `750b566` test(e2e): 覆盖撤权后的刷新与重连出口

### 交付内容

- 服务端：`GET /api/projects/:projectId/session-graph`、`GET /api/sessions/:sessionId/lineage`、`GET /api/session-forks/:forkId`、`POST /api/projects/:projectId/session-forks` 由管理员鉴权放宽到项目成员鉴权，节点摘要、边、血缘与 Fork 全部经 `SessionAccessService` 逐会话判定，未获权会话整体省略（不返回标识与标题），两端不可读的关系不出现在图、血缘与边详情中。Fork 目标在事务内创建并要求 `contributor`，仍固定在来源 Task 上。
- web-contract：`SessionForkRequest`/`SessionForkResponse` 改为纯字符串 DTO，浏览器只依赖字符串标识，不转发领域品牌类型。
- web-client：`sessionGraph` / `sessionLineage` / `sessionForkPoint` / `forkSession` 与 `watchCanvasCollaboration`（只透传 `snapshot` / `presence.updated` / `presence.left` / `authorization` 四个事件名，`authorization` 为终止态，断线按预算重连）。
- web-next：`会话画布` tab（深链 `/next/projects/:projectId?canvas=1&session=<sessionId>`），画布只投影服务端事实：可读节点、受限占位、Fork 边、画布版本、权限未显示关系计数提示；选中节点后读取权威血缘与持久化游标，从固定游标创建分支（requestId 与草稿内容绑定，重试不重复创建），成功后重读权威图而不是本地建节点；`authorization` 事件到达即停止订阅并清空图、血缘、分支草稿与选择。

### 验证命令与结果（退出码全 0）

| 命令 | 结果 | 日志 |
| --- | --- | --- |
| `npm run build:packages` | exit 0 | `/var/tmp/wemux-c01-merge-build-packages.log` |
| `npm run typecheck` | exit 0（全部 workspace） | `/var/tmp/wemux-c01-merge-typecheck.log` |
| `npm run build --workspace @wemux/server` / `@wemux/worker` | exit 0 | `/var/tmp/wemux-c01-merge-build-server.log`、`/var/tmp/wemux-c01-merge-build-worker.log` |
| `npm test --workspace @wemux/web-client` | 325 pass / 0 fail | `/var/tmp/wemux-c01-merge-webclient.log` |
| `node --import tsx --test apps/server/src/test/*.test.ts` | 998 pass / 0 fail | `/var/tmp/wemux-c01-merge-server-tests.log` |
| `npm run test:prepared --workspace @wemux/web-next`（含组件浏览器用例 `SessionCanvas`） | 187 pass / 0 fail | `/var/tmp/wemux-c01-merge-webnext.log` |
| `node --import tsx apps/e2e/next-canvas-fork-browser.mjs`（真实 Chromium，desktop 1440x1000 + mobile 390x844） | exit 0，23 checks | `/var/tmp/wemux-c01-merge-canvas-e2e.log` |

真实浏览器验收每次运行的证据目录（截图、`result.json`、`revocations.json`、`cleanup.json`）形如
`/var/tmp/wemux-c01-tmp/wemux-next-canvas-fork-*`，本轮为 `/var/tmp/wemux-c01-tmp/wemux-next-canvas-fork-vZBToU`；
脚本本身已入库，可重复生成同等证据：

```bash
mkdir -p /var/tmp/wemux-c01-tmp
node_modules/.bin/vite build --config apps/web-next/vite.config.ts --outDir /tmp/wemux-c01-next-canvas-dist
TMPDIR=/var/tmp/wemux-c01-tmp \
PLAYWRIGHT_CORE_PATH=/home/qdw/.cache/wemux-pw/node_modules/playwright-core/index.mjs \
PLAYWRIGHT_CHROMIUM_PATH=/usr/bin/chromium \
WEMUX_NEXT_TEST_DIST=/tmp/wemux-c01-next-canvas-dist \
node --import tsx apps/e2e/next-canvas-fork-browser.mjs
```

### 逐条验收证据

1. 画布内容只对获权成员可见，未获权访问被拒：仅加入 Team 但未获项目授权的 `outsider` 对画布图、单会话、血缘、任务会话列表与 Fork 五条读取路径全部被服务端拒绝，画布既不渲染节点也不泄露标题（`check: 未获权成员…`，截图 `canvas-outsider-{desktop,mobile}.png`）。画布不靠界面隐藏代替服务端过滤：图查询返回的节点集合本身只含可读会话。
2. 同 Task 下 Fork 固定 cursor，血缘可追溯：获权成员在画布上填入游标 1（持久化上限 2）创建分支，接口与存储校验同 Task、同项目，双向血缘都返回该分支且 `sourceEventCursor` 为 1；游标 3（未持久化）被拒 `cursor_not_durable`，同一 requestId 重放返回 `replayed: true` 且未新增会话（该项目未删除会话数保持 3）。血缘按人过滤：分支会话是 `owner-only`，部署者读不到它，血缘里也没有这条边（截图 `canvas-forked-{desktop,mobile}.png`）。
3. 撤权后四个出口停止提供并清理：撤掉会话授权后，单会话读取 404、血缘 404、任务列表过滤掉该会话、画布投影只剩成员自己拥有的分支会话且该边消失，界面如实显示 `无法读取血缘：Session not found`；撤掉项目授权后实时流收到服务端 `authorization` 信号并关闭，界面转为 `实时：权限已撤销，已停止订阅`，节点、边、血缘全部清空并显示 `已清除本地内容…已下载或截图带出设备的副本不在回收范围内`，同时画布图、任务列表、单会话与 Fork 四个出口返回 404/403（记录在 `revocations.json`）。撤权后重连实时出口由服务端重新鉴权并被拒（`实时：订阅失败（Project not found）`），刷新页面重新向服务端读取并显示 `项目不存在或当前账号无权访问`，都不从本地副本恢复任何内容（截图 `canvas-reloaded-{desktop,mobile}.png`）。
4. Fork 不修改原会话历史：Fork 前后来源会话行逐字段相等，来源持久化游标仍为 0，血缘是独立投影（服务端用例断言 + 浏览器验收断言）。
5. 断言与截图作为证据留存：e2e 两个视口各 11 项断言加 1 项跨视口断言，共 23 项 check 通过，12 张真实浏览器截图与 `result.json`/`revocations.json` 落在证据目录（原始证据按工作约定留在 `/var/tmp`，不入库）。

### 偏离与未决

- web-next 未引入 `@xyflow/react`：画布用确定性分列布局加 SVG 连线实现（`apps/web-next/src/lib/session-canvas-layout.ts` 与 `SessionCanvas.tsx`），由 TDD 契约锁定；布局模块不依赖任何图形库，后续如需换成 React Flow 只替换视口适配层。因此票据范围内的「拖动」未实现，设计文档 C5 的手动布局与 CAS 持久化（接口已存在且已授权）留给后续票据。
- `hiddenRelationCount` 服务端目前恒为 `null`，界面已按「权限不构成侧信道」处理该字段，但实际不会出现「另有 N 条关系因权限未显示」提示；如需真实计数需单独评估侧信道风险。
- 画布尚未发布 Presence（`PUT .../canvas/collaboration/presence` 已存在且已授权），本票只要求订阅与撤权语义；Presence 广播留给 03。
- 验收使用合成 Worker 能力与夹具会话，不执行真实 Agent 运行时；撤权只覆盖服务端出口与受控客户端缓存，已下载或截图带出设备的副本不在回收范围。
