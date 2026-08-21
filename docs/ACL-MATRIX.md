# ACL 权限矩阵

| 能力 | 未登录 | 普通成员 | 管理员 | 额外权限 |
| --- | --- | --- | --- | --- |
| 健康检查、初始化状态、登录注册 | 允许 | 允许 | 允许 | 无 |
| 自己的 Agent、Workspace、Session、文件、终端、任务、Memory | 拒绝 | 允许 | 允许 | 资源所有权 |
| 自己的渠道账号、能力清单、Provider | 拒绝 | 允许 | 允许 | 资源所有权 |
| 自己的用量和账务 | 拒绝 | 允许 | 允许 | 资源所有权 |
| 按用户筛选用量、查看用户账务 | 拒绝 | 拒绝 | 允许 | 管理员角色 |
| 套餐、订阅、余额、兑换码和计费设置管理 | 拒绝 | 拒绝 | 允许 | `manage_billing` |
| 监控、恢复、挂载 allowlist | 拒绝 | 拒绝 | 允许 | `manage_system_config` |
| 用户、角色、状态、邀请 | 拒绝 | 按授权拒绝 | 允许 | `manage_users` / `manage_invites` |
| 审计日志 | 拒绝 | 按授权拒绝 | 允许 | `view_audit_log` |
| Host 执行模式 | 拒绝 | 拒绝 | 仅活动管理员 | 管理员角色与状态 |

所有资源路由都会再次检查 `owner_user_id`；不能通过修改 URL、Workspace JID、Session ID 或查询参数绕过所有权边界。普通成员不能把 Workspace 从 Container 降级为 Host。
