# Pi Agent SDK、R16 与 R28 实现规格

## 目标

1. 以直接 Pi Agent SDK Session 替换 `pi --mode rpc`，保留现有可靠性、Provider、计费和跨端事件契约。
2. 将现有能力目录扩展为可执行、可审计的岗位—角色—能力包治理闭环。
3. 新增能力感知 Agent Router，完成路由决策、子任务调度、执行追踪和结果汇总。
4. 补齐 Router 所需的 Workspace `owner/editor/viewer` 最小资源 ACL。

## 用户故事

- Workspace owner 可以邀请 editor/viewer，并保持系统管理员与租户资源范围分离。
- editor 可以在共享 Session 中对话、读写资源、发起编排和复制历史到个人 Workspace。
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
  prompt(input: RuntimeInput): Promise<void>;
  steer(input: RuntimeInput): Promise<void>;
  followUp(input: RuntimeInput): Promise<void>;
  abort(): Promise<void>;
  compact(instructions?: string): Promise<void>;
  subscribe(listener: RuntimeEventListener): () => void;
  dispose(): Promise<void> | void;
}
```

SDK Adapter 使用 `createAgentSession`、`ModelRuntime`、`SessionManager`、`SettingsManager` 和 `DefaultResourceLoader`。Host 与 Container 只负责提供目录、凭据、Provider 和资源边界，不再各自实现 Pi 协议。

旧 Session 迁移规则：

1. 检测现有 Pi JSONL 并尝试 `SessionManager.open`。
2. 打开成功则保持上下文连续。
3. 打开失败则记录 `context_status=reset_required`，保留 Web/IM 历史并创建新 SDK context。
4. 失败原因只记录错误类型和脱敏摘要，不记录消息正文或凭据。

## Workspace ACL

资源角色与系统 `admin/member` 独立：

| 行为 | owner | editor | viewer |
| --- | --- | --- | --- |
| 查看 Workspace、历史和编排轨迹 | 允许 | 允许 | 允许 |
| 发送消息、触发 Router | 允许 | 允许 | 拒绝 |
| 写文件、Memory 和可写配置 | 允许 | 允许 | 拒绝 |
| 复制共享 Session | 允许 | 允许 | 拒绝 |
| 管理成员、岗位、Router Policy、Agent 池 | 允许 | 拒绝 | 拒绝 |
| 修改 AgentProfile | 仅 Profile 所有者 | 仅 Profile 所有者 | 拒绝 |

系统管理员没有 Workspace 资源旁路。不可见资源统一返回 404；已知但动作不允许时返回 403。

复制 Session 只复制可见历史快照，目标必须是调用者拥有的 Workspace；新会话使用目标 Workspace 的 AgentProfile、Provider、能力和 SDK context。

## R16 能力治理

### 能力模型

```ts
type CapabilityKind = 'builtin_tool' | 'skill' | 'mcp_tool' | 'pi_extension_tool';
type CapabilityRisk = 'read' | 'write' | 'external' | 'destructive';
type CapabilityDecision = 'allow' | 'deny';
```

系统维护能力定义、来源、版本/hash、风险和可用状态。未分类能力一律按 `destructive` 处理。

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
- MCP Server 每个允许的 Tool 转换为受控 customTool，handler 仍通过现有凭据和授权层。
- Pi 内置工具只传入 manifest 中允许的工具名。
- manifest hash、Agent identity hash 或 Provider fingerprint 变化时关闭暖 Session 并重建。

Pi Extension 导入使用临时目录、路径穿越/软链接检查、内容 hash、不可变版本目录和显式审批。Legacy Plugin Catalog 不自动获得执行权。

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

硬限制：最多 4 阶段、12 个任务、并发 4；依赖只能指向更早阶段，禁止循环和动态加点。

### 候选选择

服务端按以下顺序处理：

1. 从 Workspace Agent 池读取 active Profile。
2. 使用实际发起成员重新计算每个 Profile 的 EffectiveManifest。
3. 过滤 ACL、能力、Provider、计费或状态不满足的候选。
4. 按岗位精确匹配、路由优先级降序、当前负载升序、Profile ID 升序稳定选择。
5. 没有候选时拒绝该任务并记录逐候选排除原因。

### 执行

- 每个子任务创建隔离临时 Runtime Session，并记录 parent run/task。
- 只注入任务说明、明确依赖结果、当前 Workspace 上下文和不可变能力 manifest。
- 上游 Agent 输出以 `untrusted_worker_output` 包裹，不能覆盖系统指令。
- read 任务可并行；write/external/destructive 任务获取 Workspace 副作用租约后串行。
- 每个任务单次最长 10 分钟，整次编排最长 30 分钟。
- 可重试错误由原 Agent 重试一次，再切换一个合格候选一次。
- Provider 可能已接受副作用但回执丢失时标记 `uncertain`，冻结等待人工裁决。
- 失败任务的依赖节点标记 blocked；独立节点继续。
- 首版运行中不自动生成新 Plan Version。

### 审批与聚合

全部能力为 read 时自动执行。存在 write/external/destructive 时生成绑定 user、workspace、plan version 和 plan hash 的一次性审批，10 分钟过期。

聚合由发起 Agent 完成。输入包含每个任务的 AgentProfile、状态、来源、结果摘要、产物引用和失败原因；最终响应必须显式指出部分失败，不伪装成完整成功。

### 状态

Run 状态：

```text
planning → awaiting_approval → queued → running
        → completed | partial | failed | cancelled | uncertain
```

Task 状态：

```text
pending → queued → running
        → completed | retry_wait | failed | blocked | cancelled | uncertain
```

取消操作终止活跃 SDK Session、取消未开始任务，但不承诺回滚已经发生的外部副作用。服务重启后从 SQLite 状态和租约恢复，不依赖内存计划。

## 数据迁移

- v13：SDK context 与临时子 Session 字段。
- v14：Workspace members，现有 `owner_user_id` 回填为 owner。
- v15：能力定义、风险、能力包版本、岗位、runtime policy、Pi Extension 版本。
- v16：Workspace Agent 池、Router Policy、Run、Plan Version、Task、Dependency、Event、Approval、Side-effect Lease。

现有 Workspace 的 Router 默认 off；新 Workspace 默认 auto。现有 AgentProfile 获得兼容当前行为的 legacy runtime policy。数据库升级继续执行自动备份和拒绝降级。

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
- `/api/workspaces/:jid/orchestrations/:runId/approve|reject|cancel|replan`
- `/api/workspaces/:jid/orchestrations/:runId/events`

`StreamEvent` 增加 orchestrationRunId、orchestrationTaskId、parentTaskId、agentProfileId、planVersion，以及 plan/task/approval/result 四类编排事件。

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

