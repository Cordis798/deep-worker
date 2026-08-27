# Miniclaw 技术差异审计

## 目的

本文记录 `C:/Users/Administrator/Desktop/miniclaw-main/` 与 Deep Worker 的可验证差异，作为 Pi Agent SDK 迁移、R16 能力治理扩展和 R28 Agent Router 的事实基线。参考仓库只读；迁移复用行为和边界，不复制源码或目录结构。

## 必须迁移的运行时差异

| 领域 | Deep Worker 当前实现 | Miniclaw 已有实现 | 本项目决策 |
| --- | --- | --- | --- |
| Agent 运行时 | `PiRpcClient` 启动 `pi --mode rpc`，通过 JSONL 收发命令和事件 | 直接依赖 `@earendil-works/pi-coding-agent@0.84.2`，用 `createAgentSession` 创建会话 | 建立运行时适配层后切换为直接 SDK，验证完成后删除 RPC 生产路径 |
| 会话生命周期 | 每个 Runtime Session 维护一个 RPC 子进程 | `SessionManager` 打开或创建 Pi JSONL，会话对象原生支持 prompt/steer/follow-up/abort/compact | 保留现有 SessionQueue 和可靠性账本，替换会话内核 |
| 事件 | 解析 RPC 私有事件后投影为 `StreamEvent` | 订阅 `AgentSessionEvent`，映射文本、思考、工具、压缩、队列和结束事件 | 保持 `StreamEvent` 为跨端稳定契约，不向 Web 泄漏 SDK 私有字段 |
| 工具 | 生产链路明确启用 `bash`，结构化工具和 ToolRegistry 仍是骨架 | ResourceLoader 加载 read/bash/edit/write/find/grep/ls、customTools 和 Extensions | 用有效能力清单精确启用工具；未知工具默认高风险 |
| Skills | 目录、导入、hash 和预览已存在 | `DefaultResourceLoader` 直接加载 Skill 路径 | 将现有解析结果接入正常聊天和 SDK Session |
| MCP | 自建最小客户端和数据库记录已存在 | 现有业务 handler 被适配成 Pi custom tools | 保留自建客户端与授权层，将允许的 MCP Tool 注册为 customTools |
| Plugins | 仅 Catalog 元数据和启用状态 | 有不可变 Catalog/Runtime 快照设计，但 Pi 生产入口闭环仍需验证 | 明确改为受审批的 Pi Extension 包，不宣称兼容 Claude Plugins |
| Host/Container | Host 和 Container 各自管理 RPC Client | 两种模式启动同一个编译 Runner | 收敛为同一个 SDK Runner 和同一输出协议 |

## Miniclaw 已有而当前实现较弱的能力

1. 直接 SDK Session、原生 steer/follow-up/compact 和事件订阅。
2. ResourceLoader 驱动的 Skills、Extensions 与精确工具加载。
3. AgentProfile `runtime_policy` 和有效能力预览的运行时连接。
4. 子 Agent 生命周期事件及 workflow 状态投影。
5. 更完整的 Pi 原生文件和搜索工具集合。
6. Plugin 内容寻址、快照和物化思路。

这些能力只作为实现参考。Miniclaw 的 `pi-subagents` 仍由模型侧 Agent 工具触发，应用层没有按 AgentProfile、能力和 ACL 选择 worker 的 Router，也没有完整的平台级 result/steer RPC。因此不能把它直接包装成 R28。

## 两个项目都不具备的目标能力

### R16 扩展

- 岗位、角色、能力包三层治理。
- 研发、运维、销售模板与 Workspace 自定义版本。
- AgentProfile、岗位能力包和成员权限的三方能力交集。
- read/write/external/destructive 风险分级及未知能力从严。
- 能力包发布、冲突、覆盖、deny 和运行清单审计。

### R28 Agent Router

- LLM 提议、服务端硬裁决的结构化路由计划。
- Workspace AgentProfile 候选池和确定性评分。
- 分层并行任务图、隔离子 Session、执行追踪和最终汇总。
- 风险审批、Workspace 副作用租约、失败切换和重启恢复。
- Web 与 IM 的统一编排入口和可视轨迹。

### Workspace 协作边界

- Workspace `owner/editor/viewer` 成员关系。
- editor 可对话与写资源、viewer 只读历史。
- 共享会话复制到个人 Workspace 后继续对话。
- 系统管理员能力与租户资源范围分离。

## 必须保留的 Deep Worker 设计

- `shared`、`pi-runner`、`server`、`web` npm workspaces，不改成 Miniclaw 的目录布局。
- `@deep-worker/shared` 作为跨端类型单一真源。
- Inbox → Turn → Outbox 持久化可靠性链路和 SessionQueue。
- Provider Pool、用量账本、计费闸门、Host/Container 策略和七渠道适配器。
- Fake Runner 和无真实凭据的自动化测试能力。
- 当前更高或兼容的框架版本，不为表面统一而降级。

## 禁止误写

- IM 渠道路由、定时任务路由和 SessionQueue 都不是 Agent Router。
- `AGENTS` Prompt 段是声明性规则，不是可执行编排引擎。
- `pi-subagents` 是可选执行扩展，不是 R28 的授权和调度控制面。
- Pi Extensions 不等于 Claude Plugins。
- 参考项目没有 Workspace viewer 或岗位能力包，相关能力必须作为本项目新增实现。

