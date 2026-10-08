# 01: 计划 revision 与批准记录

**What to build:** 协调 Task 的计划可以保存为不可变 revision，并针对具体 revision 记录批准（批准人、时间）。修订产生新 revision 后旧批准自动失效；成员能看到每个 revision 的批准状态。Web 协调界面可完成保存与批准。

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] 计划保存产生递增、不可变 revision，含创建者与时间
- [ ] 批准绑定具体 revision 与批准人；新 revision 不继承旧批准
- [ ] 界面可查看 revision 列表与批准状态，并可批准当前 revision
- [ ] 重复请求幂等（同 requestId 不产生重复 revision 或批准）
- [ ] 无权限成员不能批准或查看他人无权访问的协调 Task
- [ ] 断言与截图作为证据留存
