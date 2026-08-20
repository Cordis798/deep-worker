# Pi RPC 行为清单

更新时间：2026-08-20

## 证据状态

本机使用临时 npm 执行方式实测：

```text
npx --yes @mariozechner/pi-coding-agent@0.73.1 --offline --mode rpc --no-session --tools bash
```

没有把 Pi 包加入本项目依赖。真实探测使用了交互式 stdin，避免进程在管道 EOF 时提前结束。

已实测：进程启动、`get_state`、直接 `bash`、错误 `set_model`、无 API Key 时的 `prompt` 拒绝。由于本机没有 Provider API Key，无法生成真实模型的 assistant/tool streaming event；事件字段以下以 Pi 官方 RPC 源码作为等价证据，并明确标注为“官方源码证据”。

官方证据：

- RPC 类型：`https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/modes/rpc/rpc-types.ts`
- RPC 客户端：`https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/modes/rpc/rpc-client.ts`
- 严格 JSONL reader：`https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/modes/rpc/jsonl.ts`
- RPC 文档：`https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md`

## 启动与 JSONL 边界

启动形式为：

```text
pi --mode rpc [options]
```

本机确认 `--offline`、`--no-session` 和 `--tools bash` 均可接受。协议是 stdin/stdout 上的严格 JSONL：只以 LF（`\n`）分帧，输入可接受 CRLF 并去掉行尾 `\r`；不能按 Unicode 行分隔符切帧。stdout 同时承载 response 和异步 agent event；stderr 不属于协议流。

## 真实探测记录

### `get_state`

发送：

```json
{"id":"state-2","type":"get_state"}
```

收到成功 response，核心字段如下（未知模型和 no-session 的 `sessionFile` 省略）：

```json
{
  "id": "state-2",
  "type": "response",
  "command": "get_state",
  "success": true,
  "data": {
    "model": {"id":"unknown","provider":"unknown","api":"unknown"},
    "thinkingLevel": "off",
    "isStreaming": false,
    "isCompacting": false,
    "steeringMode": "one-at-a-time",
    "followUpMode": "one-at-a-time",
    "sessionId": "<uuid-like id>",
    "autoCompactionEnabled": true,
    "messageCount": 1,
    "pendingMessageCount": 0
  }
}
```

同一进程连续查询得到同一 session；直接 bash 后 `messageCount` 从 0 变为 1，说明直接 bash 会写入当前 session message state。

### 直接 `bash`

发送：

```json
{"id":"bash-2","type":"bash","command":"echo rpc-probe"}
```

收到：

```json
{
  "id":"bash-2",
  "type":"response",
  "command":"bash",
  "success":true,
  "data":{
    "output":"rpc-probe\n",
    "exitCode":0,
    "cancelled":false,
    "truncated":false
  }
}
```

### `set_model` 失败

发送不存在的模型：

```json
{"id":"model-2","type":"set_model","provider":"anthropic","modelId":"missing-model-for-probe"}
```

收到：

```json
{"id":"model-2","type":"response","command":"set_model","success":false,"error":"Model not found: anthropic/missing-model-for-probe"}
```

### `prompt` 无 API Key

发送：

```json
{"id":"prompt-2","type":"prompt","message":"Reply exactly RPC_PROBE_OK"}
```

收到 `success:false`，错误为 `No API key found for the selected model...`。因此本项目不能把“prompt response 成功”误认为模型已经完成；成功 prompt 只代表接受/排队，完成边界使用 `agent_settled`。

## 已确认的命令

| 命令 | 输入关键字段 | response 行为 |
| --- | --- | --- |
| `prompt` | `id?`, `message`, `images?`, streaming 时可用 `streamingBehavior: steer\|followUp` | 返回 `type=response`, `command=prompt`, `success`；success 只代表已接受/排队 |
| `abort` | 无必需字段 | 返回成功 response；当前 agent 操作被中止 |
| `bash` | `id?`, `command` | 返回 `data.output`, `exitCode`, `cancelled`, `truncated?`, `fullOutputPath?` |
| `abort_bash` | 无必需字段 | 中止当前直接 bash |
| `get_state` | 无 | 返回 model、thinkingLevel、isStreaming、isCompacting、sessionFile、sessionId、messageCount、pendingMessageCount 等 |
| `set_model` | `provider`, `modelId` | 成功时返回完整 Model；失败时 `success=false,error` |
| `get_messages` | 无 | 返回当前 `AgentMessage[]` |
| `get_last_assistant_text` | 无 | 返回 `{ text: string|null }` |

官方源码还列出了 `steer`、`follow_up`、`new_session`、模型/思考级别切换、compaction、session/tree 查询、commands 和 extension UI 等命令；P4 客户端只封装上表和明确需要的 `abort`，其余留待后续能力治理。

## 事件流字段（官方源码证据，真实模型事件待 API Key 验证）

官方列出的事件包括：`agent_start`、`agent_end`、`agent_settled`、`turn_start`、`turn_end`、`message_start`、`message_update`、`message_end`、`bash_execution_update`、`tool_execution_start`、`tool_execution_update`、`tool_execution_end`、`queue_update`、compaction/retry 事件及 `extension_error`。

关键字段如下：

- `message_update.assistantMessageEvent.type`：`text_start`、`text_delta`、`text_end`、`thinking_start`、`thinking_delta`、`thinking_end`、`toolcall_start`、`toolcall_delta`、`toolcall_end`。
- 文本增量使用 `assistantMessageEvent.delta`；`contentIndex` 用于区分内容块；`message_end.message` 是最终消息权威快照。
- `toolcall_start` 至少包含 `id` 和 `toolName`；`toolcall_delta` 使用 `delta` 累积参数；`toolcall_end.toolCall` 包含完整调用。
- `tool_execution_start` 包含 `toolCallId`、`toolName`、`args`；update 使用 `partialResult`；end 包含 `result` 和 `isError`。
- `bash_execution_update` 包含 `id` 和输出 `delta`；最终 bash response 的 `data` 是权威结果。
- `message_update.usage` 是最新的累计 provider usage，可能在完成前为零。

## 工具调用协议与边界

官方当前源码列出的内置工具为 `read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`。这证明 Pi 具备自己的工具集，但不证明它与 Claude Code 工具语义一致。

P4 启动 RPC 时只允许 `--tools bash`，因此本阶段的最小工具集是 bash 执行与文本回传。未来结构化工具应通过 Pi `registerTool()` 扩展点注册；RPC 协议没有把 `registerTool` 描述成一组可直接发送的命令，所以本阶段只保留本地骨架，不伪造工具调用协议。

直接 RPC `bash` 的输出会进入当前会话状态，并在下一次 prompt 时作为上下文；它不是结构化文件编辑 API。

## 会话复用与恢复

- 同一进程内连续 `prompt` 会复用同一个 Pi session/context；本次探测用 `get_state` 确认同一进程 sessionId 稳定。
- `--no-session` 会关闭持久化，本次探测只为避免写入用户 session；生产 Runner 不使用它。
- `--session-dir` 提供独立的 session 存储目录；`get_state` 返回当前 `sessionFile` 和 `sessionId`（需在持久化 session 配置下实测）。
- 每个 Runtime Session 使用独立进程、工作目录和 session 存储目录；恢复时优先使用记录的 session 文件，避免多个 session 混用。

## 映射决策

| Pi 事件 | shared StreamEvent |
| --- | --- |
| `message_update` + `text_delta` | `text_delta`，取 `delta` |
| `message_update` + `thinking_delta` | `thinking_delta`，取 `delta` |
| `message_update` + `toolcall_start` | `tool_use_start` |
| `message_update` + `toolcall_end` | `tool_use_end` |
| `tool_execution_start` | `tool_use_start` |
| `tool_execution_update` | `tool_progress` |
| `tool_execution_end` | `tool_result` |
| `bash_execution_update` | `tool_progress`，toolName=`bash` |
| `message_update` + usage | `usage` |
| 未识别事件 | `raw_sdk_event`，保留脱敏后的 rawEvent |

事件映射只承诺 Pi 证据覆盖的字段；`sessionId`、`turnId`、`queryRunId` 等关联字段由 Runner 本地补充并标记为 synthetic，不伪装成 Pi 字段。
