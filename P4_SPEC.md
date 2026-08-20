# P4 阶段 Spec：Pi Runner 核心闭环

## 目标

完成“消息进入 → 会话队列 → Pi Agent 执行 → StreamEvent → 最终回复”的最小可恢复闭环。Pi RPC 是唯一运行时协议来源；本阶段不把 Claude Code 的工具或事件语义带入 Pi。

## 用户故事

- 用户向一个 Runtime Session 发送消息，能收到流式文本、工具轨迹和最终回复。
- 同一 Runtime Session 的消息严格按提交顺序执行；不同 Session 可以并发。
- Pi 进程超时或暂时失败时，系统按有界指数退避重试；超过上限后落失败状态。
- 服务重启后，未完成的 Inbox/Turn/Outbox 不会静默丢失，可以继续恢复或明确失败。
- 测试不需要真实模型 API Key；Fake Pi Runner 能模拟正常、超时、失败和并发场景。

## 核心流程

1. API 校验 Runtime Session 所有权和 active 状态。
2. 写入 Inbox，再创建一条幂等 Turn 和 pending Outbox。
3. SessionQueue 对同一 session 串行取 Turn；不同 session 不共享锁。
4. PiRpcClient 发送 `prompt`，把 JSONL 事件映射成 shared `StreamEvent`。
5. 文本增量写入 Outbox，`agent_settled` 后提取最终回复并完成 Turn/Inbox。
6. 超时、进程退出或可重试失败进入 retry_wait；重启扫描过期 lease 并恢复。

## 异常流程

- 无效 JSONL 只生成协议错误，不使客户端失去后续帧解析能力。
- `prompt` 被 RPC 拒绝立即失败；prompt 接受后的失败由事件/进程状态决定。
- 超时先发送 `abort`，等待有限宽限期；无响应则杀掉子进程并让 SessionManager 失效。
- 队列满时拒绝新消息，不覆盖已持久化消息。
- Outbox 投递失败不回滚已完成 Turn；保留 pending 记录供恢复。

## 可验证验收

- `PI_RPC_BEHAVIOR.md` 区分官方协议证据、本机实测和未验证项。
- Fake Runner 覆盖正常回复、bash 工具事件、超时、失败重试、同 session 串行、跨 session 并发和重启恢复。
- `npm run typecheck`、`npm test -- --run`、`npm run build`、`git diff --check` 全部通过。

## 非目标

- 不实现 IM 渠道、Web 页面、Container 模式或任务调度。
- 不实现 Read/Edit/Glob/Grep 的完整语义；本阶段仅限制为 bash 最小工具集并保留未来 registerTool 扩展边界。
- 不宣称 Pi 的内置工具、扩展 UI 或事件与 Claude Code 等价。
