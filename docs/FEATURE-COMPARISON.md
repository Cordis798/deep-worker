# 全量功能对照清单

状态含义：`通过` 表示当前仓库有实现和自动化测试；`降级` 表示遵循 Pi 能力边界；`外部验收` 表示代码链路已覆盖，但需要真实凭据、Docker 或第三方服务。

| 参考功能 | 状态 | 证据或阻塞原因 |
| --- | --- | --- |
| Web/PWA 工作台 | 通过 | React 路由、manifest、Service Worker、响应式布局已存在。 |
| 流式聊天、工具轨迹、Markdown | 通过 | Pi StreamEvent、WebSocket、Chat 页面和 Runner 测试。 |
| 图片/文件 | 通过 | Workspace Tools、文件页和对应测试。 |
| Agent Profile / Workspace / Runtime Session | 通过 | 领域表、CRUD、所有权和运行链路测试。 |
| 飞书、Telegram、QQ、钉钉、微信、Discord、WhatsApp | 外部验收 | 七类适配器和 Fake Transport 测试通过；真实账号连接需人工提供凭据。 |
| 定时任务与恢复 | 通过 | Cron/间隔/一次性、幂等运行、租约恢复和通知状态测试。 |
| Workspace Memory | 通过 | 版本号 CAS、搜索、权限隔离和路由测试。 |
| Skills | 通过 | 导入、hash 校验、隔离和能力解析测试。 |
| MCP | 降级 | 实现最小连接、工具列表和调用；Pi 不提供 Claude Code 等价 MCP 托管。 |
| Plugins | 降级 | 保留 catalog 与启用状态；不实现 Claude Code 不可变快照/COW。 |
| 多 Provider 与故障转移 | 通过 | Round Robin、Weighted、Failover、健康恢复和 Pi 映射测试。 |
| Host/Container 双执行模式 | 外部验收 | 权限、挂载、资源限制和 Fake Runner 已测试；真实 Docker 镜像需环境准备。 |
| 监控与备份恢复 | 通过 | 监控 API/页面、临时数据备份恢复和端口安全测试。 |
| 用量统计与每日/月度汇总 | 通过 | eventId 幂等账本、五类 Token、筛选和聚合测试。 |
| 计费、订阅、余额、兑换码、配额 | 通过 | 本地 SQLite 状态机、余额幂等、兑换码幂等和配额超限测试。 |
| 真实支付网关 | 非目标 | 阶段规格明确不接入支付网关。 |

## 最终 e2e 覆盖

自动化链路覆盖：Setup → 创建 Workspace/Runtime Session → Fake Pi 聊天 → usage 事件入账 → `/api/usage/stats`、明细、CSV → `/api/billing/my/summary`。定时任务、渠道 Fake 测试在既有独立测试中覆盖；真实 IM、Pi Provider、Docker 属于外部验收项。
