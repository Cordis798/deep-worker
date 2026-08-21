# Pi Container `code=125` 排查记录

## 现象

普通成员在 Container Workspace 发送消息后，回合重试三次并失败：`Pi RPC process exited (code=125, signal=null)`。

## 根因

1. Docker Desktop 引擎未启动；后端日志确认 Windows 未启用 WSL 2 与“虚拟机平台”。
2. Runner 把 Pi 参数插在 `docker run` 之前，实际命令近似 `docker --mode rpc ... run`，参数顺序错误。
3. 容器固定使用 `--network none`，无法访问 DeepSeek 远程 API。
4. 仓库没有 `deep-worker-pi:latest` 的构建文件，容器内也没有根据页面 Provider 配置生成 Pi `models.json`。
5. 旧错误只包含退出码，Docker stderr 未进入脱敏后的诊断信息。

## 修复

- 为 Pi RPC 客户端增加包装命令前缀参数，生成 `docker run ... IMAGE pi --mode rpc ...`。
- 容器改用 Docker bridge 网络，同时保留非 root、只读根文件系统和资源限制。
- 根据 Provider 配置为每个会话生成独立 `models.json`，文件只引用密钥环境变量。
- 增加固定版本的最小 Pi 镜像与构建命令。
- 将脱敏、限长后的进程 stderr 附加到退出错误，方便区分 Docker daemon、镜像和参数问题。

## 外部环境结论

DeepSeek `/models` 返回 HTTP 200，配置的 `deepseek-v4-flash-vision-exp` 存在，API Key 有效。Windows 只读审计确认 BIOS 虚拟化和 `Microsoft-Windows-Subsystem-Linux` 已启用，但 `VirtualMachinePlatform` 处于 Disabled，系统尚未加载 Hypervisor。启用该组件并重启后，才能构建镜像和完成真实容器调用验收。

隔离 Host Pi 会话已使用数据库中的同一 Provider 完成真实请求，模型回复 `OK`，共收到 53 个 RPC 事件；生成的 `models.json` 使用环境变量引用且不包含真实 API Key。
