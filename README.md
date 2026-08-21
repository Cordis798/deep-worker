# Deep Worker

Deep Worker 是一个基于 Pi RPC 的自托管多用户 Agent 工作台，包含 Web/PWA、Workspace、Runtime Session、定时任务、记忆、文件、终端、渠道适配、Provider、容器隔离、用量与本地计费。

## 快速开始

```bash
npm install
npm run dev
```

打开 `http://localhost:3000/setup` 创建首个管理员。默认使用 Fake Pi Runner 的测试链路；真实 Pi RPC 由服务端配置的 `pi --mode rpc` 进程提供，真实 Provider 凭据只通过环境变量或加密配置注入。

## 常用命令

```bash
npm run typecheck
npm test -- --run
npm run build
git diff --check
```

## 功能入口

- `/chat`：Workspace、Runtime Session、流式聊天和工具轨迹。
- `/agent-profiles`：Agent Profile 与 Prompt 版本。
- `/files`、`/terminal`、`/tasks`、`/memory`：文件、终端、定时任务和 Workspace Memory。
- `/usage`：Token 分类、筛选、明细和 CSV 导出。
- `/billing`：套餐、余额、配额、兑换码和交易记录。
- `/monitor`：队列、Runner、Container、Provider 和恢复状态。

## 运行时边界

Pi RPC 的稳定能力以 `pi-runner/PI_RPC_BEHAVIOR.md` 为准。本项目使用 Pi 的 prompt、abort、bash、get_state、set_model 等能力；结构化 Read/Edit/Glob/Grep 工具不宣称与 Claude Code 等价，当前最小工具集以 bash 为主。MCP 和 Plugins 采用项目规格中定义的降级实现。

## 计费说明

计费是本地账本，不接入真实支付网关。用量事件以 `eventId` 幂等写入，按输入、输出、缓存读取、缓存写入、推理五类 Token 统计；套餐、余额、兑换码和日/周/月配额均由 SQLite 事务保证一致性。详细规格见 [docs/USAGE_BILLING_SPEC.md](docs/USAGE_BILLING_SPEC.md)，全量对照见 [docs/FEATURE-COMPARISON.md](docs/FEATURE-COMPARISON.md)。

## 文档

- [API](docs/API.md)
- [ACL 权限矩阵](docs/ACL-MATRIX.md)
- [功能对照清单](docs/FEATURE-COMPARISON.md)
- [用量与计费规格](docs/USAGE_BILLING_SPEC.md)
- [容器、Provider 与运维规格](docs/CONTAINER_PROVIDER_OPERATIONS_SPEC.md)
