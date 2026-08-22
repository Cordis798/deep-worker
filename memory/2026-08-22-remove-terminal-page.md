# 移除终端页面记录

## 决策

终端页面不是 Pi Agent 核心闭环的一部分，只提供宿主机命令执行入口；当前项目的核心能力
是 Workspace、Runtime Session、Pi RPC Runner、Provider、文件和 Agent 聊天。因此移除
终端页面，减少维护成本和宿主机命令执行风险。

## 变更

- 删除前端终端页面、状态管理、WebSocket API 和终端测试。
- 删除后端 `TerminalManager`、终端 REST/WebSocket 路由及相关测试。
- 移除 `node-pty` 依赖。
- 删除侧边栏终端入口。
- 保留旧 `/terminal` 地址并重定向到 `/chat`，避免历史书签进入空白页。
- 保留 Workspace 文件 API。

## 验证

- 全量类型检查通过。
- 全量测试：72 个文件、196 项通过。
- 全量构建通过。
- `git diff --check` 通过。
- 浏览器访问 `/terminal` 已跳转到 `/chat`。

## 状态

DONE
