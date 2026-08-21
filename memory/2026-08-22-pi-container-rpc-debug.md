# Pi 容器 RPC 退出排障记录

## 症状

Container Workspace 发送消息后，Pi Agent 先报错：

```text
Pi RPC process exited (code=125, signal=null)
```

修复 Docker 启动问题后，真实聊天进一步暴露：

```text
Pi RPC process exited (code=0, signal=null)
```

## 根因

`code=125` 来自 Docker 启动层，包含以下问题：

1. Docker Desktop 与 WSL 2 最初未处于可用状态。
2. Pi 参数被放在 `docker run` 前，Docker CLI 参数顺序错误。
3. 容器使用 `--network none`，无法访问 DeepSeek。
4. 仓库缺少可构建的 Pi 镜像，容器中也缺少 Provider `models.json`。
5. Docker Hub 域名一度被错误解析，基础镜像无法拉取。

`code=0` 来自 RPC 输入通道：服务端执行 `docker run` 时没有传入
`--interactive`，Docker 未保持容器 stdin 打开。Pi RPC 收到 EOF 后正常退出，
因此退出码为 0，但服务端尚未完成请求。

RPC 恢复后又发现两个独立问题：Provider 环境变量此前只存在于 Docker CLI
进程，没有通过 `docker run --env` 注入容器；前端还把 `turn_start`、`turn_end`
等中间状态误判为终态，导致 WebSocket 在正文到达前关闭。

## 修复

- 修正包装命令顺序，生成 `docker run ... IMAGE pi --mode rpc ...`。
- 使用 bridge 网络并保留非 root、只读根文件系统和资源限制。
- 为每个会话生成独立 Pi Provider 配置，API Key 只通过环境变量传递。
- 增加固定版本 Pi Dockerfile、镜像构建命令和脱敏 stderr 诊断。
- 为 `docker run` 增加 `--interactive`，保持 JSONL stdin 生命周期。
- 仅把 Provider 环境变量名传给 `docker run --env`，由 Docker CLI 环境提供真实
  值，避免密钥出现在命令参数中，并同步注入 `PI_CODING_AGENT_DIR`。
- 前端仅在 `agent settled` 或 `agent failed` 时结束流，不再被 turn 中间状态截断。
- 在容器参数测试中固定 `run --rm --interactive --init` 的顺序。

## 证据

- `deep-worker-pi:latest` 已成功构建。
- 直接 Pi 版本与 RPC 探测容器均能创建、启动并退出，不再返回 125。
- 首次真实聊天稳定复现 `code=0`，与缺少 interactive stdin 的行为一致。
- 修复后使用生产同构 Docker 参数完成真实容器集成探测：Pi RPC `get_state`
  返回有效 sessionId，直接 bash 返回 `PI_RPC_STDIN_OK` 且退出码为 0；进程在
  请求期间保持存活，证明 stdin EOF 问题已消除。
- 真实 DeepSeek 容器请求完成，持久化结果为 `PI_CONTAINER_OK`，前端聊天页面也
  已实际显示 `PI_CONTAINER_OK`。
- 聚焦回归测试覆盖 Docker 环境变量注入和前端中间状态流转。
- 全量类型检查通过。
- 全量测试：72 个文件、197 项通过。
- 全量构建通过。
- `git diff --check` 通过。

## 回归测试

- `server/src/container-runner.test.ts`：断言 Docker 参数包含并按顺序传入
  `run --rm --interactive --init`，且只传密钥变量名、不暴露密钥值。
- `pi-runner/src/rpc-client.test.ts`：覆盖包装命令顺序和 stderr 脱敏。
- `web/src/stores/chat.test.ts`：覆盖 `turn_start`、`turn_end` 不提前关闭聊天流。

## 状态

已完成。真实容器、真实 DeepSeek 模型和前端显示链路均通过。
