# AGENTS.md

## 目标

在当前仓库从零复刻 deep-worker-main（HappyClaw），用 Pi SDK 替代 Claude Agent SDK。源码可重写，用户可观察行为必须与参考仓库一致。

## 常用命令

```bash
npm install          # 安装全部 workspace 依赖
npm run dev          # 启动后端（tsx 直跑）
npm run typecheck    # 全量类型检查（server/web/pi-runner/shared）
npm test -- --run    # 运行全部单元测试（一次）
npm run build        # 构建 server/web/pi-runner/shared
npm run format       # prettier 格式化
```

## 架构

- npm workspaces monorepo：`server`、`web`、`pi-runner`、`shared`。
- 后端：Hono + better-sqlite3 + Pino；执行引擎 Pi RPC（`pi --mode rpc`）。
- 前端：React + Vite + Tailwind + Zustand。
- 数据库迁移：`server/src/db/migration.ts`，用 `config_kv.schema_version` 跟踪版本，升级前自动备份，拒绝降级。
- 共享类型放 `shared`，三方跨包引用统一走 workspace 依赖。

## 完成条件（阶段门禁）

每个阶段结束必须全部通过并附实际输出：

```bash
npm run typecheck
npm test -- --run
npm run build
git diff --check
```

并对照阶段 Spec 逐条验收后汇报，等待人工确认再进入下一阶段。

## 提交说明约定

- Git 提交说明保留 Conventional Commit 前缀，冒号后的描述和提交正文统一使用中文。

## 禁止事项

- 不得修改参考仓库 `C:/Users/Administrator/Desktop/deep-worker-main/` 中的任何文件。
- 不允许关闭类型检查、跳过测试、删除断言或用注释绕过问题。
- 密钥、API Key、Token 不得写入普通日志。
- 不引入非必要依赖；确有必要时说明理由并随 commit 提交。
- 只修改当前阶段任务列出的文件；避免范围外改动。
- 不得用 `git reset --hard` / `git checkout --` 覆盖未提交的他人改动。
