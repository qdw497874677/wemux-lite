# 本机实例收敛验收

当前单一访问入口为 `http://192.168.3.22:8010/`，不再用临时预览 8012。此为当前开发主机的部署记录，不是通用生产安装器。

- 固定入口：`wemux-instance start|stop|restart|status`，实现见 `scripts/local-instance.mjs`。配置由 `WEMUX_INSTANCE_HOME` 指定，当前为 `/opt/data/wemux-lite/instance.json`（0600，不入 Git）。Server 和 Worker 使用同一个冻结的 release 与 Node 路径，避免仓库重建改变正在运行的版本。全局 `wemux-lite-worker` 命令也已指向该 release，而非旧 npm 包。
- Server 数据从原 local-8010 迁到 `/opt/data/wemux-lite/server/`；Worker 保留 `/opt/data/.wemux-lite`，身份、凭据、工作区和会话不搬动、不重新注册。停服后使用 SQLite `VACUUM INTO` 备份 Server、传输库、Worker 数据及其传输库到 `/opt/data/wemux-lite/backups/pre-consolidation/`。
- 三个历史 `/tmp` 实例目录仅留作历史备份，放置 `ARCHIVED-DO-NOT-START.txt`；预览 8012 停止。未删除历史数据。Server capability secret 固定存于受限部署配置。
- 新账号通过注册、出件箱验证、登录 API 创建。原账号未改密码。按操作者意图声明新账号为实例管理员，并通过本地运维事务显式添加原 Team member 与原 Worker use grant，写审计事件，不改变原 Worker owner。原私有 Project/Session 不因此自动共享。凭据只放本机受限文件，不写本文。
- 启动入口校验 pid + `/proc` start time，停止仅 SIGTERM，不强杀；启动后等原 Worker 在 Server 库显示 online，不能仅凭进程存在报成功。它是当前 Linux 主机的手动生命周期入口，**不提供开机自启或进程崩溃自动恢复**；没有伪装成 systemd 服务。

修复：`status` 和 `tailscale` 用 `SqliteWorkerStore({readOnly:true})` 打开，跳过 mkdir/chmod、schema 迁移、journal mode 设置和本机身份初始化。只读检查旧 schema 不再升级数据库。`apps/worker/test/cli-readonly.test.ts` 对真实 CLI 调用前后的数据库摘要与文件权限做断言，修复前失败、修复后通过。

验证：typecheck、完整 build、npm test 通过（Node 871 / 863 pass / 8 skipped，packages 10 pass，Web 293 pass），日志 `/tmp/consolidation-full-test.log`；真实 Chromium 登录新账号并从 `/cluster` 确认原 `local-worker` online；统一入口 restart 后重复通过。截图 `/tmp/wemux-consolidated-cluster.png`。临时邮箱使用本地出件箱，并不具备互联网收信能力；生产部署需配置真实邮件投递和 HTTPS。
