<div align="center">
  <img src="docs/assets/deep-worker-logo.svg" width="96" alt="Deep Worker 标志" />
  <h1>Deep Worker</h1>
  <p>基于 Pi RPC 的自托管、多用户 Agent 工作台</p>
  <p>把 Workspace、会话队列、流式执行、工具调用与可靠性状态收敛到一条可观测消息闭环。</p>
</div>

<p align="center">
  <img alt="Node.js 20+" src="https://img.shields.io/badge/Node.js-20%2B-111827?logo=node.js&logoColor=white" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white" />
  <img alt="Pi RPC" src="https://img.shields.io/badge/Runner-Pi%20RPC-4F46E5" />
  <img alt="SQLite" src="https://img.shields.io/badge/Storage-SQLite-0F766E" />
</p>

## 它解决什么问题

Deep Worker 面向需要自托管 Agent 工作台的团队：一个用户可以拥有多个 Workspace，每个 Workspace 维护独立的 Runtime Session；消息进入后经过持久化队列，由 Pi Runner 执行并把流式事件回传到 WebSocket，最终回复和 Outbox 状态都可恢复、可追踪。

它不是只把聊天页面接到模型 API 上，而是把执行边界、会话串行、失败重试、Provider 故障转移、用量账本和权限控制放在服务端统一管理。

## 四个核心设计

### 1. Agent-First 三层产品模型

Deep Worker 用 `Agent Profile → Workspace → Runtime Session` 把“Agent 是谁、数据放在哪里、一次对话如何运行”拆成三个可独立治理的层级：

```text
Agent Profile（可复用的身份与能力配置）
└── Workspace（文件、记忆、渠道挂载与执行模式的隔离边界）
    └── Runtime Session（会话上下文、队列和 Pi 进程复用边界）
```

- **Agent Profile** 属于用户，可被多个 Workspace 复用，保存 Prompt、版本和稳定身份指纹。
- **Workspace** 绑定所有者、独立目录、记忆、渠道挂载及 Host / Container 执行策略，承担数据与权限隔离。
- **Runtime Session** 从 Workspace 继承或单独绑定 Agent Profile；同一 Session 串行执行，不同 Session 并发运行。
- 四段 Prompt 与 `prompt_mode` 共同生成 `identity_hash`。Pi 会话复用时同时校验身份、能力和 Provider 指纹；任一指纹变化都会关闭旧进程并重建，会话管理器也提供空闲回收能力，避免配置变化后继续使用旧上下文。

这套模型让 Profile 位于顶层：身份与能力可以跨 Workspace 复用，而文件、记忆、渠道和执行权限仍被 Workspace 隔离，会话状态则被限制在最小的 Runtime Session 范围内。

### 2. 七渠道 IM 统一抽象与适配器

服务端通过统一的 `ChannelAdapter` / `ChannelTransport` 边界接入飞书、Telegram、QQ、钉钉、微信、Discord 和 WhatsApp，Agent 执行链路不直接依赖各渠道 SDK：

- 适配器统一连接、断开、重连、状态查询、入站订阅，以及文本、文件、图片、Reaction 和流式更新接口。
- 能力矩阵显式描述各渠道的群聊、私聊、原生话题、流式更新和媒体投递差异；不支持的能力在适配层直接拒绝。
- 统一渠道地址保留 Provider、账号、外部聊天和原生话题上下文，支持多账号隔离、私聊绑定 Session、群聊挂载 Workspace，并确保回复回到原始会话。
- 出站消息进入持久化投递队列并执行有界重试；入站消息使用稳定幂等键去重，降低断线重连和服务重启造成的重复处理。

当前仓库已实现七类适配器、路由编排与 Fake Transport 自动化测试；真实第三方 SDK Transport、账号登录和凭据联调属于外部集成验收，不把协议层完成夸大为生产账号已经连通。详细能力差异见 [IM_CHANNEL_SPEC.md](IM_CHANNEL_SPEC.md)。

### 3. Agent Profile 四段式 Prompt 与安全发布

Agent Profile 将配置拆成 `IDENTITY / SOUL / AGENTS / TOOLS` 四段，分别承载身份设定、行为倾向、Agent 协作约束和工具约束，并支持 `append` / `replace` 两种配置模式：

- 四段内容统一持久化、校验长度并纳入 `identity_hash`，每次修改或恢复都会生成新的 Prompt 版本，不覆盖历史。
- Agent Builder 支持多轮草稿、能力预览和“准备发布 → 后续确认”的两阶段流程。
- 准备发布时生成有时效的一次性确认短语，数据库只保存其哈希；只有 Profile 所有者能在后续用户操作中发布，定时任务、子代理、错误口令、过期口令和重复发布都会被拒绝。
- 当前 Runner 将 `IDENTITY` 作为系统 Prompt 注入 Pi；`SOUL / AGENTS / TOOLS` 及 `append / replace` 已进入配置、版本和一致性指纹，完整的四段运行时拼装仍按 Pi 能力边界增量实现。

这套流程把“编辑人设”和“让人设生效”分开：确认短语既验证用户看过待发布内容，也是一枚短时、单次使用的安全令牌。

### 4. 四工作区编译验证与共享协议单源

仓库采用 npm workspaces 管理 `shared`、`pi-runner`、`server` 和 `web` 四个 TypeScript 编译单元：

- `StreamEvent`、WebSocket 消息和跨包公共类型集中在 `@deep-worker/shared`，Runner、Server、Web 直接依赖同一份声明，不需要手工复制类型文件。
- 根目录脚本统一执行四个工作区的 `typecheck` 与 `build`；Vitest 同时发现四端测试，当前覆盖 **72 个测试文件、196 项用例**。
- `npm run typecheck`、`npm test -- --run`、`npm run build` 与 `git diff --check` 组成可本地复现的提交门禁，把协议漂移、类型错误和构建问题提前到提交前发现。
- Pi 原始事件只在 Runner 内解析，再映射为稳定 `StreamEvent` 投影；服务端持久化并通过 WebSocket 转发，前端不需要理解 Pi RPC 私有字段。

这里没有照搬不存在的 `make sync-types` 或 GitHub Actions：当前实现依靠 workspace 依赖完成共享类型单源，并由根目录门禁统一验证。

## 快速启动

需要 Node.js 20+。普通成员的 Workspace 默认使用 Docker Container Runner；Windows 需要先启用 WSL 2 和“虚拟机平台”，并启动 Docker Desktop。

```bash
npm install

# 构建普通成员执行 Pi RPC 所需的最小镜像
npm run container:build

# 无需 API Key 的本地演示：使用确定性的 Fake Pi Runner
DEEP_WORKER_RUNNER=fake npm run dev -w server

# 另开终端启动 Web
npm run dev -w web -- --host 127.0.0.1
```

PowerShell 可以这样设置演示模式：

```powershell
$env:DEEP_WORKER_RUNNER = "fake"
npm run dev -w server
```

打开 [http://127.0.0.1:5173/setup](http://127.0.0.1:5173/setup) 创建首个管理员。服务端默认使用真实 Pi Runner；生产环境不设置 `DEEP_WORKER_RUNNER=fake`，并确保 `pi --mode rpc` 可执行且 Provider 凭据已配置。若只启动后端，API 地址为 [http://127.0.0.1:3000](http://127.0.0.1:3000)。

Container Runner 会为每个会话生成独立的 Pi `models.json`，其中只保存 API Key 环境变量引用；真实密钥仍由服务端解密后注入进程。容器默认通过 Docker bridge 网络访问已配置的模型接口。若看到 Docker `code=125`，先运行 `docker desktop status` 和 `docker image inspect deep-worker-pi:latest` 检查引擎与镜像。

## 核心能力

| 领域       | 能力                                                                         |
| ---------- | ---------------------------------------------------------------------------- |
| 工作台     | 多用户、Agent Profile → Workspace → Runtime Session、文件与记忆              |
| Agent 执行 | Pi RPC 进程、流式事件、bash 最小工具集、会话串行与跨会话并发                 |
| 可靠性     | Inbox → Turn → Outbox 状态机、幂等键、指数退避重试、超时和重启恢复           |
| 模型接入   | Provider 加密凭据、会话粘性、Round Robin / Weighted / Failover 与健康恢复    |
| Agent 配置 | 四段式 Prompt、版本恢复、能力预览、一次性确认短语与身份指纹失效              |
| 渠道接入   | 七渠道统一适配器、能力矩阵、多账号隔离、Workspace / Session 挂载与入站去重   |
| 自动化     | Cron / 间隔 / 单次定时任务、租约恢复、幂等运行与结果通知                     |
| 能力治理   | Skills 导入与哈希、受治理 MCP 客户端与 Pi custom tool bridge、Plugins 目录、能力解析与注入 |
| 可观测性   | 队列、Runner、Container、Provider 脱敏监控；Token 用量、成本和 CSV 导出      |
| 安全边界   | ACL 权限矩阵、登录锁定、配置脱敏、数据库迁移备份与 Host / Container 执行模式 |

## 架构与消息闭环

![Deep Worker 架构与消息闭环](docs/assets/architecture.svg)

```text
用户消息 → API / WebSocket → Inbox
       → 按 session 串行的 Turn 队列
       → Pi Runner（prompt / bash / 流式事件）
       → StreamEvent → WebSocket
       → Outbox / 最终回复 / 用量账本
```

同一 Session 内的消息严格串行，不同 Session 可以并发；进程重启后，未完成 Turn 会从持久化状态恢复。Fake Runner 只用于开发和自动化测试，真实 Pi 行为以 [PI_RPC_BEHAVIOR.md](pi-runner/PI_RPC_BEHAVIOR.md) 为准。

## 从哪里开始看代码

```text
server/      Hono API、SQLite、队列、Provider、渠道与运维能力
pi-runner/   Pi RPC 客户端、Fake Runner、事件解析与工具边界
shared/      WebSocket、StreamEvent 与跨包协议
web/         React + Vite 工作台
docs/        API、ACL、功能对照、计费与运行规格
```

推荐阅读顺序：`server/src/app.ts` → `server/src/runtime-runner-service.ts` → `pi-runner/src/` → `shared/stream-event.ts` → `web/src/pages/ChatPage.tsx`。

## 验证

当前测试基线为 72 个测试文件、196 项用例；真实 Pi、Docker 与第三方 IM 账号仍按外部集成项单独验收。

```bash
npm run typecheck
npm test -- --run
npm run build
git diff --check
```

## 当前边界

- Pi RPC 当前以 bash 驱动的最小工具集为主；Read / Edit / Glob / Grep 结构化工具仍是增量方向，不宣称与 Claude Code 工具集等价。
- Fake Runner 不需要真实模型凭据；真实 Pi、IM 渠道和 Docker 属于需要外部凭据或运行环境的集成验收项。
- 用量与账单是本地 SQLite 账本，不接入真实支付网关。
- Provider 与渠道配置页提供最小可用闭环，渠道连接本身仍取决于对应适配器和外部凭据。

## 文档

- [API 与 WebSocket](docs/API.md)
- [ACL 权限矩阵](docs/ACL-MATRIX.md)
- [功能对照清单](docs/FEATURE-COMPARISON.md)
- [IM 渠道统一抽象规格](IM_CHANNEL_SPEC.md)
- [Agent 能力治理规格](CAPABILITY_GOVERNANCE_SPEC.md)
- [用量与计费规格](docs/USAGE_BILLING_SPEC.md)
- [容器、Provider 与运维规格](docs/CONTAINER_PROVIDER_OPERATIONS_SPEC.md)
- [Pi RPC 行为清单](pi-runner/PI_RPC_BEHAVIOR.md)
