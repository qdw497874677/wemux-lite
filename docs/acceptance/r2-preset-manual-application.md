# R2 节点资源预设：手工应用切片

## 本次已实现

- 实例管理员发布不可变的 Preset 版本，CAS 校验 `expectedRevision`；当前只支持 Skill 和固定官方 Agent runtime，`autoApply` 必须关闭。Preset 只是模板，应用后由独立 ResourceBinding 和 ResourceSet 承担期望态。
- 管理员在集群节点页选择目标 Worker，查看版本、大小及安装脚本/重启/凭证提示，确认后手工应用；服务端使用 `requestId`、fingerprint、`expectedSetRevision` 在一个 SQLite 事务内创建全部 binding、应用记录及一个 ResourceSet revision，提交后通知 Worker。重复请求幂等，不同参数或过期 CAS 返回冲突。应用记录按 binding 展示 reconcile 进度。
- 通过浏览器管理入口、HTTP、SQLite 事务和真实 Server + 两个 Worker 的验证；真实 Worker 将通过 Preset 分配的 Skill 安装并上报 ready。

## 可重复验收

1. `npm run build:packages && npm run typecheck && npm run build --workspace @wemux/server && npm run build --workspace @wemux/web`
2. `npm test`（本次复跑：server 等测试 822 pass、web 9 pass、worker 280 pass，0 fail；见脚本输出）
3. `node apps/e2e/resource-preset-browser.mjs`：运行生产集群页面浏览器交互，检查发布版本、确认对话框、应用及进度；HTTP 由脚本桩提供，不替代真实 Worker 测试。
4. `node --import tsx --test apps/e2e/resource-reconcile.test.ts`：真实 Server + 两 Worker，验证断线追赶、官方 Pi 包安装/重启探测，以及 Preset CAS、幂等和 Worker 收敛。需能访问 npm registry，耗时与网络有关。

原始的脱敏真实进程证据保留在忽略提交的 `.scratch/r1-stage4/resource-reconcile-e2e.txt` 和 `worker-resource-tree.txt`；浏览器证据由 `resource-preset-browser.mjs` 写入其指定的本地目录。上述验证不等于全新裸机安装验收，也没有证明真实模型完成 Turn。

## 尚未完成

R2 最终验收仍需在干净 Linux 环境下：独立安装 Worker、注册、从集群 Web 应用 Preset、重启并配置模型凭证、创建真实 Session，验证固定 Skill 被实际注入且模型完成无副作用 Turn。自动应用、多节点批量、provider/connector Preset、失败重试引导和节点总体 ready 聚合尚未实现；不将本切片宣称为完整空服务器闭环。
