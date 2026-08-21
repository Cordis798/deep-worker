# API 概览

所有 JSON 写接口使用 `Content-Type: application/json`。除公开接口外，使用 HttpOnly 会话 Cookie；资源查询始终按当前用户所有权隔离。

## 公开接口

- `GET /healthz`：服务健康状态。
- `GET /api/auth/status`：是否已完成初始化。
- `POST /api/auth/setup`：创建首个管理员。
- `POST /api/auth/login`、`POST /api/auth/register`：登录和注册。

## 工作台

- `/api/auth/*`：当前用户、退出、密码和会话管理。
- `/api/agent-profiles/*`：Agent Profile、Prompt 版本和恢复。
- `/api/workspaces/*`：Workspace、Runtime Session 和归属校验。
- `/api/workspaces/:jid/runtime-sessions/:sessionId/messages`：提交 Agent 消息并返回持久化流事件。
- `/api/workspaces/:jid/runtime-sessions/:sessionId/turns/:turnId/events`：WebSocket 流式事件。
- `/api/workspaces/:jid/files/*`、`/api/workspaces/:jid/terminal/*`：文件和终端。
- `/api/tasks/*`：定时任务、运行历史、停止和恢复。
- `/api/workspaces/:jid/memory/*`：Memory 增删改查、版本冲突和搜索。
- `/api/channel-accounts/*`、`/api/capabilities/*`：渠道账号、Skills、MCP 降级客户端和 Plugins catalog。

## Provider 与运维

- `/api/providers`：Provider 配置、加密凭据和负载策略。
- `GET /api/monitor/status`：队列、Runner、Container、Provider 脱敏状态。
- `POST /api/monitor/recover`：恢复遗留 Runner/任务租约。
- `GET/PUT /api/monitor/mount-allowlist`：管理员读取或更新容器额外挂载白名单。

## 用量

- `GET /api/usage/stats`：汇总、按日期/模型分解和 Agent/Workspace/模型归因。
- `GET /api/usage/records`：分页用量明细。
- `GET /api/usage/models`：当前筛选范围内的模型。
- `GET /api/usage/export.csv`：带日期、Agent、Workspace、模型筛选的 CSV 导出，最多 10,000 条。

查询参数支持 `from`、`to`、`days`、`userId`（管理员）、`workspaceJid`、`agentId`、`model` 和 `source`。

## 计费

- `GET /api/billing/status`、`GET /api/billing/plans`：计费开关、最低余额和可用套餐。
- `GET /api/billing/my/summary`：当前套餐、余额、配额、每日用量和交易。
- `GET /api/billing/my/quota`、`GET /api/billing/my/access`：配额和执行访问判断。
- `GET /api/billing/my/transactions`、`GET /api/billing/my/daily`：账务与每日汇总。
- `POST /api/billing/my/redeem`：兑换余额、套餐或试用码。
- `/api/billing/admin/*`：套餐、用户订阅、余额调整、兑换码、审计和计费设置；需要 `manage_billing`。

## 错误约定

- 未登录：`401`。
- 无资源归属或资源不存在：`404`，不泄露其他用户资源。
- 无权限：`403`。
- 参数校验或业务状态错误：`400`；幂等冲突由具体接口返回 `409`。
