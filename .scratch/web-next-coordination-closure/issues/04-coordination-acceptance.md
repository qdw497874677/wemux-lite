# 04: Web 协调聊天与功能验收

Status: ready-for-agent
Blocked by: [03 协调创建/发送](03-gate-standard-reprobe.md)的真实 API 与 Worker 对话链路；UI 组件及受控测试可并行准备。

**Spec:** [Team 协调聊天贯通](../spec.md)
**合并来源:** `43966aa` 原 05 为隔离门的人工风险接受与开门票。按用户新决定，隔离与书面风险接受不再是功能门，本票改为 Web 与实际功能验收；历史用户签收与 FAIL 证据不回写。
**What to build:** `/next/` Team 页面呈现可选获权 Worker/Agent/Workspace 的协调入口，首次发送创建对话，恢复与重开同 Task 下的 Session，查看流式结果、审批及失败态。只有 API/Worker/UI 全链路可用才展示 enabled；保留 Team/资源授权，不增加协调专属文件/终端/网络限制。

## 实现计划

1. 复用现有会话/审批组件与账号 API，团队页打开只读，无副作用；首次发送与上传根据真实后端能力创建。上传分开验收：Server 收到有界文件并原子绑定 Task/Session 的元数据，及选定 Worker 上的 Agent 能实际读取文件；仅完成前者时不得显示为已交付的 Agent 附件，不伪装首次上传已完整可用。呈现会话历史、重试、刷新、审批及模型切换。
2. 服务端 availability 显示实际功能状态；入口不再以旧隔离门为前置，不得只把 403 改成 501。先完成后端与运行时的正反例，再开放 Web 可用态。
3. 同候选跑 Server/Worker/Web-next 相关测试，真实浏览器桌面/手机验收 Team 成员与非成员、首次发送/刷新/重开/结果、断线/重连、普通 Project 会话无回归。逐条核对 NEXT-05，不以局部安全加固测试替代功能验收。

## 测试与验收

- [ ] Web Team 入口可用：页面打开不创建 Task；首次发送自动创建/复用，显示消息及 Agent 结果
- [ ] 首次上传有界文件创建 Task/Session 与私有附件引用，同一意图幂等、冲突拒绝、撤权失效；没有虚构首条消息，失败不留下可见孤儿
- [ ] 附件经授权投递到选定 Worker 后由 Agent 实际读取原字节；离线、重试、重启与撤权时明确区分待投递/已投递/失败。只有 Server 收件不算完成上传能力，也不提前开启 Web 上传控件
- [ ] 获权 Worker/Agent/Workspace 选择、刷新恢复、重开新 Session、模型切换、停止/审批/失败重试按实际能力验证
- [ ] 非成员、跨 Team/Project/Worker 或他人 Session 无法探测和写入；普通 Task/独立宿主权限不回归
- [x] 至少一个真实有效的 Runtime 完成协调对话：用户允许的 Pi CLI 1.0.4 + `zai-coding-cn::glm-5.3-flash` 首发与文件创建、同 Session 工具读回按 Turn 边界验证通过一次，第二 Turn 历史失败已诊断为模型侧（见 `docs/acceptance/web-next-team-coordination-browser-partial.md`）；另付费验证模型切换 flash → `glm-5.3` 端到端通过一次（同文档新增章节）；Test Agent 用于可重复集成，不代替有效 Runtime 验收
- [ ] 桌面与手机真实浏览器 E2E 和 Server/Worker/Web-next 同候选验证记录退出码；上传若尚未交付不宣称支持
- [ ] UI/文档不声称“隔离”或“只能讨论不能改文件”；不在旧静态 FAIL 或 501 假开门状态下宣布完成
- [ ] 功能逐项通过后才签收 NEXT-05；未通过的缺口保持在票据中，脱敏摘要入库

本票不要求书面残余风险接受。用户进一步授权使用现有 Pi `5.3-flash` 完成真实验收；不因此取得其它付费服务、数据清理或对外投递授权。未来隔离能力单独设计，不混作协调聊天完成条件。
