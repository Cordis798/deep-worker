# Pi Agent SDK、R16 与 R28 实现规格

## 目标

1. 以直接 Pi Agent SDK Session 替换 `pi --mode rpc`，保留现有可靠性、Provider、计费和跨端事件契约。
2. 将现有能力目录扩展为可执行、可审计的岗位—角色—能力包治理闭环。
3. 新增能力感知 Agent Router，完成路由决策、子任务调度、执行追踪和结果汇总。
4. 补齐 Router 所需的 Workspace `owner/editor/viewer` 最小资源 ACL。

## 用户故事

- Workspace admin 可以邀请 member/viewer，并保持系统管理员与租户资源范围分离。
- member 可以在共享 Session 中对话、发起编排和复制历史到个人 Workspace，但不能修改 Workspace 资源配置。
- viewer 只能查看 Workspace、会话历史和编排轨迹。
- 系统管理员可以发布全局能力模板，Workspace owner 可以发布本 Workspace 的版本化岗位能力包。
- 同一个 AgentProfile 被不同岗位成员使用时，只获得三方交集后的能力。
- 简单消息继续由当前 Agent 处理；复杂消息由专用 Router Profile 提议多阶段计划。
- 只读任务可以并行，高风险任务在用户确认后串行执行，最终仍由发起 Agent 回复。

## 运行时契约

`pi-runner` 提供运行时无关接口：

```ts
export interface AgentRuntime {
  createSession(options: RuntimeSessionOptions): Promise<RuntimeSession>;
  close(): Promise<void>;
}

export interface RuntimeSession {
  readonly sessionId: string;
  readonly isStreaming: boolean;
  prompt(input: RuntimeInput): Promise<RuntimeResult>;
  steer(input: RuntimeInput): Promise<RuntimeResult>;
  followUp(input: RuntimeInput): Promise<RuntimeResult>;
  abort(): Promise<void>;
  compact(instructions?: string): Promise<void>;
  subscribe(listener: RuntimeEventListener): () => void;
  dispose(): Promise<void> | void;
}
```

SDK Adapter 使用 `createAgentSession`、`ModelRuntime`、`SessionManager`、`SettingsManager` 和 `DefaultResourceLoader`。调用方必须先订阅再 prompt；每个 turn 只接受首个 terminal result 并只结算一次 usage，timeout/abort 后到达的迟发结果不得再次结算。

Host 直接加载该 Adapter；Container 镜像打包同一 Adapter 和中性 Worker 入口，由 Host 通过长度分帧 JSON IPC 控制。IPC 只是进程边界协议，不暴露 Pi RPC 语义；SDK 与工具仍在容器内执行，Host 不代替容器执行工具。

旧 Session 迁移规则：

1. 在该应用 Session 的隔离 sessionDir 枚举 JSONL，读取并校验元数据；唯一合法文件或最新且无歧义的文件才允许 `SessionManager.open`。
2. 打开成功则保持上下文连续。
3. 打开失败则记录 `context_status=reset_required`，保留 Web/IM 历史并创建新 SDK context。
4. 歧义或失败时递增 `context_generation` 并记录 `context_status=reset_required`；失败原因只记录错误类型和脱敏摘要，不记录消息正文或凭据。

## Workspace ACL

资源角色与系统 `admin/member` 独立，分别为 `workspace_admin/member/viewer`：

| 行为 | workspace_admin | member | viewer |
| --- | --- | --- | --- |
| 查看 Workspace、历史和编排轨迹 | 允许 | 允许 | 允许 |
| 发送消息、触发 Router | 允许 | 允许 | 拒绝 |
| 由已授权 Agent 执行文件/Memory 副作用 | 允许 | 允许 | 拒绝 |
| 复制共享 Session | 允许 | 允许 | 拒绝 |
| 管理成员、岗位、Router Policy、Agent 池 | 允许 | 拒绝 | 拒绝 |
| 修改 AgentProfile 和能力配置 | 允许 | 拒绝 | 拒绝 |

系统管理员没有 Workspace 资源旁路。不可见资源统一返回 404；已知但动作不允许时返回 403。

共享执行链路明确拆分四类主体：`actor_user_id` 是当前调用者；`workspace_id` 是资源租户；`credential_principal_id` 指向 Workspace 管理员绑定的 Provider/MCP 凭据；`billing_principal_id` 指向 Workspace 预算账户。Runner Inbox、Turn、Usage、Memory、Channel Mount 与审计事件均保存 actor 和 workspace，不能继续用 `owner_user_id` 同时表达四种语义。

成员具有 `active/revoked` 生命周期；不得移除最后一名 workspace_admin，所有权转移必须在同一事务完成。撤权后立即使 WebSocket、未使用审批和未开始任务失效，运行中任务在下一次工具闸门检查时终止。个人 Workspace 是仅有一个 workspace_admin 且未邀请成员的普通 Workspace，不建立第二套权限模型。

复制 Session 只复制用户/助手文本和当前仍获授权的产物引用；不复制系统 Prompt、原始 Tool Result、凭据、Memory 或 SDK JSONL。目标必须是调用者管理的 Workspace；记录 `source_session_id` 与 `source_snapshot_hash`，新会话按目标 Workspace 的 AgentProfile、Provider 和能力创建全新 SDK context。

## R16 能力治理

### 能力模型

```ts
type CapabilityKind = 'builtin_tool' | 'skill' | 'mcp_tool' | 'pi_extension_tool';
type CapabilityRisk = 'read' | 'write' | 'external' | 'destructive';
type CapabilityDecision = 'allow' | 'deny';
```

系统维护能力定义、来源、版本/hash、风险和可用状态。未分类或未知能力一律 `unavailable/deny`，必须经管理员分类和发布后才能使用。

岗位能力包是不可变发布版本。内置研发、运维、销售模板只引用能力分类；发布时解析成精确能力 ID、版本和 hash，保证后续可复现。

有效能力计算：

```text
(AgentProfile allow ∩ 成员岗位包 allow ∩ Workspace 资源权限允许范围)
− (系统 deny ∪ AgentProfile deny ∪ 岗位包 deny)
```

多岗位成员的岗位 allow 先取并集，所有 deny 取并集。Resolver 输出 selected、denied、conflicts、unavailable、riskSummary、sourceChain 和稳定 manifest hash。

### 运行时注入

- Skills 作为 `DefaultResourceLoader.additionalSkillPaths`。
- Pi Extensions 作为经过审批的 `additionalExtensionPaths`。
- MCP Server 每个允许的 Tool 转换为受控 customTool；发现结果固化 schema/hash，连接可复用且可关闭，每次调用支持取消、超时和输出脱敏，并在容器内时由容器侧执行。现有加密配置只负责凭据存储，不能替代逐次授权。
- Pi 内置工具只传入 manifest 中允许的工具名。
- 每个 Task 固化 capability、action 和 resource scope；创建 Session 前与每次 tool call 前都重新校验成员状态、ACL、manifest、风险和审批。实际参数越出批准范围时 fail-closed 并写审计事件。
- manifest hash、Agent identity hash 或 Provider fingerprint 变化时关闭暖 Session 并重建。

Pi Extension 导入使用临时目录、路径穿越/软链接检查、内容 hash、不可变版本目录和显式审批。Host 模式只加载系统受信 allowlist；Workspace 自定义 Extension 强制进入最小挂载、最小环境和受控网络的 Container 沙箱。Legacy Plugin Catalog 不自动获得执行权。

## R28 Agent Router

### 触发

- Web 消息携带 `routingMode: auto | single | multi`。
- `single` 直接进入现有单 Agent 链路。
- `multi` 强制规划。
- `auto` 由 Router Profile 输出 `single` 或 `multi`。
- IM 提供 `/route <message>`、`/single <message>` 和审批命令。
- 定时任务首版继续单 Agent。

### 计划

Router Profile 是 Workspace 绑定的受管 Profile，只获得输出结构化计划所需的只读上下文，不加载业务工具。计划不能携带 Agent ID，只能声明任务、依赖、必需能力和偏好岗位。

AgentProfile 通过 `workspace_agent_bindings` 加入 Agent 池；每次发布生成不可变 Profile Version 和 identity hash。Run 固定绑定版本，后续编辑不影响运行中的计划。

硬限制：最多 4 阶段、12 个任务、并发 4；依赖只能指向更早阶段，禁止循环和动态加点。

### 候选选择

服务端按以下顺序处理：

1. 从 Workspace Agent 池读取 active Profile。
2. 使用实际发起成员重新计算每个 Profile 的 EffectiveManifest。
3. 过滤 ACL、能力、Provider、计费或状态不满足的候选。
4. 按岗位精确匹配、路由优先级降序、当前负载升序、Profile ID 升序稳定选择。
5. 没有候选时拒绝该任务并记录逐候选排除原因。

### 执行

- 每个子任务创建隔离临时 Runtime Session，并记录 parent run/task；单次 runner attempt 禁用内部多次重试，重试和候选切换只由 Scheduler 决定，幂等键绑定 run/task/planVersion/attempt。
- 只注入任务说明、明确依赖结果、当前 Workspace 上下文和不可变能力 manifest。
- 上游 Agent 输出以 `untrusted_worker_output` 包裹，不能覆盖系统指令。
- read 任务可并行；write/external/destructive 任务获取 Workspace 副作用租约后串行。
- 每个任务单次最长 10 分钟，整次编排最长 30 分钟。
- 可重试错误由原 Agent 重试一次，再切换一个合格候选一次。
- Provider 可能已接受副作用但回执丢失时标记 `uncertain`，冻结等待人工裁决。
- 副作用租约使用原子 claim、owner、expires_at、heartbeat 与单调 fencing token；每次副作用前比较 token，过期 worker 不得继续写入。
- 失败任务的依赖节点标记 blocked；独立节点继续。
- 首版运行中不自动生成新 Plan Version。

### 审批与聚合

全部能力为 read 时自动执行。存在 write/external/destructive 时生成绑定 user、workspace、plan version 和 plan hash 的一次性审批，10 分钟过期。

Worker 使用 Workspace 管理员显式绑定的 Provider 凭据和 Workspace 预算，不读取调用者私人密钥。Plan 保存预估成本，Run/Task 设置预算上限并通过账本原子预留、结算和释放；超预算不得启动或重试。

聚合由发起 Agent 完成。输入包含每个任务的 AgentProfile、状态、来源、结果摘要、产物引用和失败原因；最终响应必须显式指出部分失败，不伪装成完整成功。

### 状态

Run 状态：

```text
planning → awaiting_approval → queued → running
        → completed | partial | failed | cancelled | uncertain | validation_failed
```

Task 状态：

```text
pending → queued → running
        → completed | retry_wait | failed | blocked | cancelled | uncertain
```

Approval 状态为 `pending → approved | rejected | expired`；`retry_wait` 只能回到 queued。auto 模式缺少有效 Router Profile、Provider 或预算时 fail-safe 回退 single，并记录原因。

取消操作终止活跃 SDK Session、取消未开始任务，但不承诺回滚已经发生的外部副作用。`uncertain` 只能由 workspace_admin 执行 resume、mark_succeeded 或 mark_failed，并完整审计。服务重启后从 SQLite 状态和租约恢复，不依赖内存计划。Run/Task 状态更新使用 `expected_state + version` CAS；状态迁移、Event 与 Outbox 在同一事务提交。

## 数据迁移

- v13：SDK context 状态、generation 与恢复标识；不提前加入 Router 子 Session 字段。
- v14：Workspace members 与执行主体字段，现有 `owner_user_id` 回填为 workspace_admin，并迁移 Inbox、Turn、Usage、Memory、Channel 的 actor/workspace 语义。
- v15：能力定义、风险、能力包版本、岗位、runtime policy、Pi Extension 版本。
- v16：Workspace Agent 池、Router Policy、Run、Plan Version、Task、Dependency、Event、Approval、Side-effect Lease。

所有 Workspace 的 Router 默认 off/single，由 workspace_admin 显式开启 auto。现有 AgentProfile 获得兼容当前行为的 legacy runtime policy。数据库升级继续执行自动备份和拒绝降级。

## API 与事件

新增 API：

- `/api/workspaces/:jid/members`
- `/api/workspaces/:jid/runtime-sessions/:sessionId/fork`
- `/api/capabilities/definitions`
- `/api/capability-packages`
- `/api/capabilities/extensions`
- `/api/workspaces/:jid/job-roles`
- `/api/agent-profiles/:id/runtime-policy`
- `/api/workspaces/:jid/effective-capabilities`
- `/api/workspaces/:jid/router-policy`
- `/api/workspaces/:jid/runtime-sessions/:sessionId/orchestrations`
- `/api/workspaces/:jid/orchestrations/:runId`
- `/api/workspaces/:jid/orchestrations/:runId/approve`
- `/api/workspaces/:jid/orchestrations/:runId/reject`
- `/api/workspaces/:jid/orchestrations/:runId/cancel`
- `/api/workspaces/:jid/orchestrations/:runId/replan`
- `/api/workspaces/:jid/orchestrations/:runId/events`

`StreamEvent` 增加 orchestrationRunId、orchestrationTaskId、parentTaskId、agentProfileId、planVersion，以及 plan/task/approval/result 四类编排事件。

`replan` 仅允许 awaiting_approval/failed 状态，生成新 Plan Version 并使旧审批失效；“运行中不自动改图”不禁止管理员显式 replan。

## 异常与安全要求

- 模型建议永远不能替代 ACL、能力、风险、计费和容量检查。
- Planner 生成未知能力、越界依赖、超限任务或 Agent ID 时计划校验失败。
- MCP 凭据、Provider Key、审批明文和 Extension 私密配置不得进入日志、manifest 或事件。
- 未审批/内容 hash 变化的 Extension fail-closed。
- 不允许 viewer 通过 WebSocket、IM 命令或 ID 猜测绕过只读限制。
- 编排幂等键不得跨 user、workspace、session 或 plan version 重放。

## 验收条件

1. 生产源码不再启动 `pi --mode rpc`，Host/Container 均使用同一 SDK Adapter。
2. 正常聊天与 Router 都消费同一个 EffectiveManifest。
3. owner/editor/viewer 权限矩阵、admin 无旁路和 Session fork 有自动化测试。
4. R16 的优先级、deny、风险、hash、Extension 审批和暖 Session 失效有测试。
5. R28 覆盖单/多路由、确定性选人、审批、并行读、串行写、重试切换、uncertain、取消、重启恢复和部分结果聚合。
6. Web 与 Fake IM Transport 完成同一编排闭环。
7. `npm run typecheck`、`npm test -- --run`、`npm run build`、`git diff --check` 全部通过。

## 非目标

- 不改成 Miniclaw 的目录结构，不引入 Electron。
- 不实现 Claude Plugin 兼容层。
- 不用 `pi-subagents` 替代应用层 Router。
- 不实现任意 DAG、图形化计划编辑和运行中自动改图。
- 不允许并行写同一 Workspace。
- 不让无人值守定时任务执行需要人工审批的编排。
