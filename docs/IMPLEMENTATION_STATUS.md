# Deep Worker 当前实现状态

本文档记录当前 `master` 分支对 SDK 运行时、工作区权限、能力治理和 Agent Router 的可验证实现，作为后续迭代的基线。

## 已完成

| 领域 | 当前行为 | 验证位置 |
| --- | --- | --- |
| SDK 运行时 | Host 与 Container 均通过同一 Pi Agent SDK Adapter 创建 Session；生产路径不启动 `pi --mode rpc` | `pi-runner/src/pi-sdk-runtime.ts`、`server/src/container-runner.ts` |
| Context 恢复 | 安全枚举 JSONL、成功恢复或记录脱敏的 reset 状态，失败后创建新上下文 | `pi-runner/src/pi-session-discovery.ts` |
| Workspace ACL | `workspace_admin`、`member`、`viewer` 三层权限；会话、历史、复制和写入动作分别校验 | `server/src/workspace-acl.ts`、`server/src/routes/workspaces.ts` |
| 岗位治理 | 工作区管理员可调整成员岗位和能力包；最后一名管理员不能被降权或撤销 | `server/src/workspace-acl.ts` |
| 能力解析 | Skill 优先级、依赖、冲突、岗位 allow/deny、稳定 hash 与解析审计已落库；运行时可恢复受治理 MCP 连接配置，并按任务能力裁剪 MCP/Plugin 交集 | `server/src/capabilities/capability-resolver.ts`、`server/src/capabilities/capability-governance.ts` |
| Skill 注入 | 有效 Skill 会复制到隔离 Session 目录，再通过 SDK Resource Loader 加载 | `pi-runner/src/capability-injection.ts` |
| MCP 工具桥接 | Pi Agent SDK 会话启动时发现受治理 MCP 工具，注册稳定名称的 custom tools；路由任务按服务端 `allowed_tools` 白名单暴露并在调用时复核，调用支持取消、结果截断和生命周期关闭；只读回合再按 MCP 工具只读/破坏性标记过滤 | `pi-runner/src/mcp-tool-bridge.ts`、`pi-runner/src/capability-injection.ts`、`server/src/routes/capabilities.ts` |
| Agent Router | 根据任务意图、岗位标签和能力选择 Agent，并先按成员岗位能力包裁剪候选；持久化 Plan/Task/Event；有依赖任务按顺序执行，纯只读任务可按显式并行意图分批调度并汇总结果；高风险计划必须通过一次性审批，支持拒绝、过期和取消；派发前复核计划能力 hash、Agent 绑定、AgentProfile 内容指纹和创建者身份 | `server/src/agent-router/`、`server/src/capabilities/capability-governance.ts` |
| 并发安全 | Plan 与 Task 使用 SQLite 租约；重复 dispatch 返回冲突，旧 worker 不能覆盖新租约结果 | `server/src/agent-router/store.ts` |
| Web/IM | Web 可创建、审批、取消和调度计划；IM 支持 `/route`、`/single`、`/approve`、`/reject`、`/cancel`，两者进入同一执行链 | `web/src/pages/ChatPage.tsx`、`server/src/im/` |

## 安全边界

- Pi 内置工具当前保持显式 allowlist，默认只开放 `bash`；能力治理不会把未知工具隐式升级为可执行权限。
- 自定义 Pi Extension/Plugin 不在 Host 中自动执行。它们会被解析、审计并在 capability manifest 中记录，但 SDK Session 使用 `noExtensions`，直到具备独立沙箱、路径校验和审批链路。
- MCP 凭据继续只保存在加密配置中；公开解析结果不返回凭据，运行时仅在内存中恢复连接配置。工具必须先通过岗位能力包解析，再由 Pi SDK custom tool bridge 注册，不会因为“已启用”而绕过治理。
- MCP 工具名称带有服务端前缀以避免冲突；调用结果限制大小，连接在 Session 释放时关闭，取消信号不会承诺回滚外部副作用。
- Router 子任务只接收任务说明和已完成的前置结果；计划、任务和事件均写入 SQLite，可在进程重启后依据租约恢复。
- 路由任务使用 MCP 时必须配置服务端工具白名单；工具发现和实际调用均按精确名称复核，未列入白名单的工具不会注入 SDK。
- 取消会原子释放计划/任务租约并取消未开始任务；活跃 SDK 会收到 AbortSignal，租约续期失败也会中止旧 Worker 回合；已发生的外部副作用不承诺回滚。
- 每个 Router 子任务带有 10 分钟运行上限；成员降权或撤销对话权限时，运行中的回合会被中止且不自动重试。
- 旧 Worker 在租约失效或异常退出时，只能按自身 fencing 清理仍归属自己的运行中任务和计划；若新 Worker 已接管，旧 Worker 的收口写入会被拒绝。
- Router 计划会绑定创建时的 AgentProfile 内容指纹，并在派发前重算审批 hash；身份提示内容或计划路由发生变化时，已审批计划必须重新规划，避免继续执行旧配置。

## 后续演进顺序

1. 为经过审批的 Extension 增加不可变版本、内容 hash 和最小沙箱挂载。
2. 在 Router 上补充预算、uncertain 状态和更细粒度的只读并行策略；保持现有单 Agent 链路兼容。

