# 01: Worker / Agent / Model / Skill / Preset / Provider 管理面

**What to build:** 管理员在一个管理面管理 Worker、Agent 能力、Model、Skill、Preset、Provider，四态（已配置、已认证、已分发、可执行）分离展示，版本与能力来自运行时真实探测。

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] 六类资源均可列出、查看与配置
- [ ] 四态分离展示，配置状态不冒充可执行状态
- [ ] 版本与能力来自真实探测，探测失败如实上报不可用
- [ ] 远程安装 Agent 不覆盖全局安装，失败给出明确原因
- [ ] 无权限用户不能修改管理面配置
- [ ] 断言与截图作为证据留存
