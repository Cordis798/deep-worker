# Web 工作台核心规格

## 目标

在现有认证、领域模型和 Pi Runner API 之上，提供可用的 React Web/PWA 工作台。页面不追求参考仓库的像素级样式，但路由、权限守卫、数据操作、聊天事件流和移动端核心操作必须可验证。

## 路由与权限

- 未初始化系统访问受保护路由时进入 `/setup`。
- 已初始化但未登录访问受保护路由时进入 `/login`，登录后回到原路径。
- 已登录访问 `/login`、`/register`、`/setup` 时进入 `/chat`。
- 公开路由：`/login`、`/register`、`/setup`。
- 受保护路由：`/chat/:workspaceId?`、`/agent-profiles`、`/settings`、`/monitor`、`/users`、`/files`、`/terminal`。
- `/groups` 重定向到 `/chat`，未知路径重定向到 `/chat`。
- `/monitor` 仅允许拥有系统配置权限的用户访问；`/users` 仅允许拥有用户、邀请码或审计权限的用户访问。

## 核心流程

1. Setup/登录/注册完成后，加载当前用户、Agent Profile、Workspace 和 Runtime Session。
2. 工作台侧栏允许创建、切换 Workspace 和 Session，并显示当前绑定信息。
3. 聊天页通过 REST 创建 Turn，通过 Runner WebSocket 接收 `text_delta`、思考、工具轨迹和终态事件；支持 Markdown 文本、图片链接、发送、停止和失败重试提示。
4. 文件面板按当前 Workspace 浏览目录，支持创建目录、上传、下载、文本读取、编辑保存和图片预览。
5. 终端面板创建会话、发送命令、接收输出、调整窗口大小和关闭会话；无真实 PTY 能力时返回明确的降级状态。
6. Agent Profile 页面支持创建、编辑、删除、Prompt 版本列表和恢复。
7. 设置、监控和用户页面展示当前后端已提供的数据；不伪造未实现的计费、渠道和能力治理功能。

## 异常与状态

- 所有异步页面必须有加载、空数据、失败和权限不足状态。
- API 401 统一清理本地会话并跳转登录；403 展示权限提示，不泄露资源存在性。
- WebSocket 断开自动重连；当前 Turn 通过 REST 查询恢复事件。
- 页面刷新后从 URL 和 API 恢复当前 Workspace/Session，不依赖内存状态。
- 移动端侧栏可折叠，聊天输入区固定在可视区域底部，主要按钮不重叠。

## 自动化验收

- Store 测试覆盖认证状态、Workspace/Session 切换和聊天流事件聚合。
- 组件测试覆盖登录守卫、聊天发送/停止、文件目录操作和 Agent 编辑。
- WebSocket Fake 服务覆盖正常流式回复、工具轨迹和终态事件。
- `npm run typecheck`、`npm test -- --run`、`npm run build`、`git diff --check` 全部通过。

## 非目标

- 不实现 IM 渠道、能力导入、任务调度和计费。
- 不引入完整 Markdown/PTY/终端仿真生态；仅提供当前工作台需要的最小能力。
- 不修改参考仓库。
