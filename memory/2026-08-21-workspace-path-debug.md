# 工作区路径错误排查记录

## 现象

发送聊天消息后，Pi Agent 返回“工作区路径不存在”。

## 根因

工作区创建时，`folder` 默认使用 `jid`。Web 工作区的 JID 形如 `web:<UUID>`，其中冒号在 Windows 目录名中非法。运行链路此前把 `workspace.folder` 直接传给 Pi Runner；容器运行器在挂载前校验该路径，因此在模型调用前就失败了。

实测当前 Windows 环境：对 `web:<UUID>` 执行 `fs.mkdir(..., { recursive: true })` 返回 `ENOENT`，解析后的路径仍包含非法冒号。

## 修复

- 在 `server/src/workspaces.ts` 统一定义 `workspaceRoot(jid)`，将 JID 映射到 `data/workspaces/<安全化 JID>`。
- 文件管理、终端、Pi Agent 和脚本任务共用同一物理工作区根目录。
- Runtime Runner 执行前确保该目录存在，兼容已有数据库中保存的旧 `folder` 值，不需要改写用户数据。
- 增加回归测试，验证数据库中的非法 `folder` 不会再成为 Windows cwd，并确认运行前目录已创建。

## 验证

- 受影响测试：3 个文件、15 个测试通过。
- 全量测试：72 个文件、194 个测试通过。
- `npm run typecheck` 通过。
- `npm run build` 通过。
- `git diff --check` 通过。
