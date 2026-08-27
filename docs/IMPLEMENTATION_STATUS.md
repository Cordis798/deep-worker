# Deep Worker 当前实现状态

本文档记录当前 `master` 分支对 SDK 运行时、工作区权限、能力治理和 Agent Router 的可验证实现，作为后续迭代的基线。

## 已完成

| 领域 | 当前行为 | 验证位置 |
| --- | --- | --- |
| SDK 运行时 | Host 与 Container 均通过同一 Pi Agent SDK Adapter 创建 Session；生产路径不启动 `pi --mode rpc` | `pi-runner/src/pi-sdk-runtime.ts`、`server/src/container-runner.ts` |
| Context 恢复 | 安全枚举 JSONL、成功恢复或记录脱敏的 reset 状态，失败后创建新上下文 | `pi-runner/src/pi-session-discovery.ts` |
| Workspace ACL | `workspace_admin`、`member`、`viewer` 三层权限；会话、历史、复制和写入动作分别校验 | `server/src/workspace-acl.ts`、`server/src/routes/workspaces.ts` |
| 岗位治理 | 工作区管理员可调整成员岗位和能力包；最后一名管理员不能被降权或撤销 | `server/src/workspace-acl.ts` |
| 能力解析 | Skill 优先级、依赖、冲突、岗位 allow/deny、稳定 hash 与解析审计已落库 | `server/src/capabilities/capability-resolver.ts` |
| Skill 注入 | 有效 Skill 会复制到隔离 Session 目录，再通过 SDK Resource Loader 加载 | `pi-runner/src/capability-injection.ts` |
| Agent Router | 根据任务意图、岗位标签和能力选择 Agent，持久化 Plan/Task/Event，按依赖顺序执行并汇总结果；高风险计划必须通过一次性审批，支持拒绝、过期和取消 | `server/src/agent-router/` |
| 并发安全 | Plan 与 Task 使用 SQLite 租约；重复 dispatch 返回冲突，旧 worker 不能覆盖新租约结果 | `server/src/agent-router/store.ts` |
| Web/IM | Web 可创建、审批、取消和调度计划；IM 支持 `/route`、`/single`、`/approve`、`/reject`、`/cancel`，两者进入同一执行链 | `web/src/pages/ChatPage.tsx`、`server/src/im/` |

## 安全边界

- Pi 内置工具当前保持显式 allowlist，默认只开放 `bash`；能力治理不会把未知工具隐式升级为可执行权限。
- 自定义 Pi Extension/Plugin 不在 Host 中自动执行。它们会被解析、审计并在 capability manifest 中记录，但 SDK Session 使用 `noExtensions`，直到具备独立沙箱、路径校验和审批链路。
- MCP 凭据继续只保存在加密配置中；当前解析结果提供名称、传输方式和健康状态，未把凭据写入 manifest、日志或事件，也不会因为“已启用”而自动获得模型工具权限。
- Router 子任务只接收任务说明和已完成的前置结果；计划、任务和事件均写入 SQLite，可在进程重启后依据租约恢复。
- 取消会原子释放计划/任务租约并取消未开始任务；活跃 SDK 会收到 AbortSignal，已发生的外部副作用不承诺回滚。

## 后续演进顺序

1. 为 MCP 工具增加容器侧受控 custom tool bridge（超时、取消、输出脱敏和逐次授权）。
2. 为经过审批的 Extension 增加不可变版本、内容 hash 和最小沙箱挂载。
3. 在 Router 上补充预算、并行只读任务和 uncertain 状态；保持现有单 Agent 链路兼容。

