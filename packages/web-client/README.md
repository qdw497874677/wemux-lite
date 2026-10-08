# 公共浏览器客户端边界（Ticket 01A）

此包不依赖 `apps/web`、React、路由或 Query 缓存。运行时无新增第三方库；宿主、账号、项目与本地身份投影由 `@wemux/web-contract/browser-host` 类型导入提供。先运行根 `npm run build:packages`，再构建消费方。

## 第一条链路的公开合同

- `discoverHost(signal?)` / `parseHostBootstrap(value)` / `hostContractVersion`：同源 `/api/host`，只接受版本 1、`cluster | local-worker` 及字符串能力清单；拒绝 HTML SPA 回退。发现不决定路由、不登录。
- `createClusterClient(config = anonymousSession(), onUnauthorized?, options?)`：`authOptions`、`login`、`currentAccount`、`projects`、`logout`、`dispose`。项目列表保持服务端权限过滤，不补造数据。
- `AccountSession`、`anonymousSession`、`isSignedIn`、`toAccountSession`：仅集群身份投影。登录令牌只在 HttpOnly Cookie，CSRF 只在内存，不持久化。
- `createLocalIdentityClient(fetcher?, onUnauthorized?)`：`status`、`login`、`logout`、`dispose`；使用 `/api/local/*` 和 Worker 的 `x-wemux-csrf`，不接受集群 AccountSession。`LocalStatus` 中的集群注册信息不是 Web 用户登录身份。
- `ApiError.status` / `ApiError.kind` / `classifyClientError`：区分 unauthorized、forbidden、not-found、network、server、contract、cancelled、unexpected。普通渲染异常为 unexpected，不当成无效链接。
- `randomId`、`copyText`、`selectElementText`：支持 HTTP IP 访问；没有安全剪贴板或写入被拒绝时返回 false，调用方必须选择文本并提示 Ctrl+C / 长按复制。不得以 execCommand 谎报成功。

底层 `createClusterTransport`、`clusterAccountOperations`、`createLocalTransport`、`localIdentityOperations` 是旧客户端的兼容组合接缝；新入口优先使用上述窄客户端，不导入旧页面或旧 API 文件。集群 transport 接受相对于宿主 origin 的 `/api/*`，排除本地 API、其他 origin 与重定向；本地 transport 限定 `/api/local/*`。`options.origin` 只用于显式目标宿主/测试注入，不从不可信返回地址构造；浏览器入口默认使用当前 origin，与 `/next/` 路由基路径无关。

## 身份生命周期

1. 先发现宿主。cluster 用匿名客户端调用 `currentAccount` 恢复 Cookie 身份或调用 `login`；local-worker 只调用本地身份客户端。
2. cluster 登录/恢复后将返回值投影为 AccountSession，销毁匿名客户端，再以该投影创建登录客户端，保证 `teamId` 作用域正确。账号或团队改变时销毁旧客户端并取消、清空 UI 缓存。客户端不隐式更改路由或 Query 缓存。
3. 集群 401 回调一次，取消同身份在途 HTTP 和旧 SSE 作用域，后续调用拒绝。403 GET 是无权限，不触发身份失效；403 写操作最多通过 `/api/auth/me` 刷新 CSRF 并重试一次，不改变原请求内容。刷新返回 401 时同样使身份失效。
4. local-worker 保留旧工作台复用 API 对象的语义：受保护请求 401 取消旧请求；显式重新 login 开启新请求代次，旧响应不能进入新身份。status/login 的 401 保留为未登录/登录错误，允许再次登录；dispose 后不可恢复。
5. logout 后 UI 仍应销毁客户端、清理缓存。新客户端无自动 SSE/Journal 订阅，不宣称会话层已完整共享。

## 旧入口兼容与待迁移登记

| 逻辑 | 本步处理 | 后续边界 |
| --- | --- | --- |
| 宿主发现、账号/项目投影、Cookie/CSRF HTTP | 迁出；旧 bootstrap/client/dto 保持导出兼容 | 新入口直接消费本包 |
| HTTP UUID、复制与手动选择 | 迁出；旧 random/utils 重导出 | 由两入口提示复制降级 |
| 集群请求身份失效、取消 | 与旧 SSE 共用同一取消 signal；新增迟到 JSON 防护 | UI 清缓存仍由宿主负责 |
| 本地身份 HTTP | 迁出；旧 LocalSessionApi 组合复用 | 本地 Task 与完整工作台仍在后续票 |
| 旧 App 路由/登录状态 | 仅账号投影改用公共函数，未搬 UI | 新入口独立实现 |
| Journal 投影、分页/新鲜度、SSE重连 | 不迁出；`apps/web/src/api/journal.ts`、旧 client 的 watch/watchProject、`hosts/session-journal.ts` 保留 | Ticket 04/13 审计并迁移，不可从新目录反向导入 |
| Session 幂等提交、launchScope/device-scope、文件/终端及资源 API | 业务代码保留旧目录，仅复用共享请求底层 | 各业务票完成行为迁移 |
| AuthForm 的旧 `toAccountSession` 导出 | 旧组件兼容导出仍存在；App 已消费公共投影 | 页面替换时删除，不搬旧组件 |

## 验证边界

`npm test --workspace @wemux/web-client` 从包的公开构建导出验证双宿主、401/403、CSRF、取消、目标隔离、错误分类和 HTTP 降级。旧 Web 测试保留登录/API/身份、host routes、local Session/Journal 以及安全扫描；扫描覆盖本包，源码契约仅辅助行为测试。

这不是部署或真实浏览器验收证据。旧根入口的真实登录、刷新恢复、历史会话稳定加载，以及同实例 `/next/` 桌面/移动端验收仍由 Ticket 01 集成环节执行；本步未启动预览实例、未改部署、未操作业务数据库或模型。
