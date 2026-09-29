# R2 真实 Pi Session 复跑记录（局部验收）

## 已验证

在本机 Linux、真实 Server + Worker 进程、真实 Pi CLI、已配置且有权限的 `my-codex::gpt-6-sol` 模型下执行：

```bash
WEMUX_REAL_AGENT_E2E=1 WEMUX_REAL_PI_MODEL='my-codex::gpt-6-sol' \
  node --import tsx --test apps/e2e/real-pi.test.ts
```

2026-09-29 复跑结果：`1 pass, 0 fail`（约 43 秒）。该脚本使用临时数据库、本地 Git 仓库和临时 Worker home，完成 Worker 注册、Workspace 就绪、Pi 能力/模型检测、创建 Session、第一轮真实模型回复、Worker 停止及重启、原 Session 第二轮回复，并确认 Journal 同步。发送的仅为两个无副作用的定值回复请求。脚本现显式给创建 Session 的请求指定 `requestId`，且只把真正的 Worker 错误日志视为失败（正常的连接/本机管理员提示不会误报）。测试自动删除临时目录，不保存登录凭据、Cookie、模型密钥或原始事件。

## 失败探针与范围

`qwen-token-plan-cn::glm-5` 虽出现在 Pi 的可检测模型列表，实际提供方返回 `403 AccessDenied.Unpurchased`；“被列出”不等于“已开通”。改用经独立 `pi --print --no-tools` 探针可执行的 `my-codex::gpt-6-sol` 后，两轮请求成功。真实模型验收依赖操作者在本机提供可用的 Pi 凭证，测试默认跳过，不能在 CI 没有密钥时伪称通过。

**未验证**：此脚本使用源码 Worker 和本机已配置的 Pi，不经过干净 Linux 的独立 Worker 安装、Server Web 的 Preset 应用、托管 Pi 安装及固定 Skill 的实际注入。资源收敛、runtime 重启和 Preset 应用由 `apps/e2e/resource-reconcile.test.ts` 独立验证，尚无一条串联全部步骤的端到端证据。安装器当前还是全局 npm 安装 + 前台进程，缺少 immutable manifest、包校验、managed install、用户级服务和健康回滚；故 R2 裸机闭环仍未验收。
