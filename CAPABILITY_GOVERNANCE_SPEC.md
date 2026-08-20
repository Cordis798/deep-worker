# 能力治理规格

## 目标

为 Agent 提供可审计、可复现且可注入 Pi Runner 的能力目录，覆盖 Skills、最小 MCP 客户端、Plugins 目录、能力解析、Agent Builder 和能力预览。

## 用户故事

- 用户可以从 Git、HTTPS 或 ZIP 导入 Skill。导入内容进入用户隔离目录，并保存来源、版本、内容 hash、依赖和启用状态。
- 系统可以列出内置 Skill，并在加载前检查清单和内容 hash。
- 用户可以登记一个最小 MCP Server，完成连接、工具列表和工具调用；凭据只保存密文，服务启动时可以健康检查。
- 用户可以查看 Plugins 目录及启用状态。Plugins 不产生不可变快照，也不执行 Claude Code 的物化语义。
- Agent 运行前，系统按系统、用户、项目的固定优先级解析有效能力，输出精确清单和 hash。同名 Skill 由高优先级来源覆盖。
- 用户可以多轮编辑 Agent 草稿、预览能力并保存。创建或更新前必须由用户在后续操作中输入一次性确认口令；未确认、口令错误或重复使用都不能发布。
- 用户可以查看已有 Prompt 版本并恢复指定版本。恢复动作生成新的版本记录，不覆盖历史。
- 能力预览展示选中、覆盖、禁用和缺失依赖；动态裁剪只允许从明确的候选集合中减少注入内容，不改变解析优先级。
- Pi Runner 接收有效 Skills、MCP 和 Plugins 的清单，把 Skills 映射到隔离目录，把 MCP 和 Plugins 映射到受控 settings/extension 配置；能力 hash 变化会使会话失效并重新建立。

## 数据与边界

### Skill

每个 Skill 必须是隔离目录中的一个子目录，根目录包含 `SKILL.md`。清单至少需要合法的 `name` 和 `description`；名称只能使用字母、数字、短横线和下划线。导入压缩包或仓库时禁止绝对路径、父目录跳转和越界软链接。内容 hash 覆盖清单和所有有效文件，文件名排序后计算。

来源优先级从低到高为：系统内置、用户、项目。相同名称只保留最高层的启用项；禁用项不参与覆盖。显式选择不存在、被禁用或依赖缺失的 Skill 时返回可区分的错误。

### MCP

最小客户端提供 `connect`、`listTools`、`callTool` 和 `healthCheck`。传输抽象至少支持可测试的内存实现；stdio/HTTP 适配只传递 JSON-RPC 消息，不承诺完整托管、采样、提示词或资源能力。命令、URL 和凭据不得进入普通日志。

### Plugins

只保存 catalog 条目、版本、来源、描述和启用状态。Plugins 可以进入预览和 Pi 配置清单，但不执行快照、COW、不可变物化或多层 Claude 优先级。

### 生效解析

解析结果必须包含版本号、精确 Skills/MCP/Plugins 列表、覆盖关系、排除原因和稳定 hash。hash 输入必须排序且不能包含密钥明文。任何进入 Pi Runner 的能力选择都必须来自解析结果，不能由调用方绕过 resolver 直接拼接。

### Agent Builder

草稿状态依次为编辑、待确认、已发布或已取消。准备发布时生成随机的一次性口令，并只保存其 hash、有效期和准备操作标识。发布必须由拥有者执行、来源必须是用户操作、口令必须来自后续操作且精确匹配；定时任务、子代理或同一准备操作不能发布。成功发布后立即消费口令。

## 核心流程

1. 导入器接收来源，下载或解包到临时目录，校验路径与 `SKILL.md`，计算 hash，原子移动到隔离目录并写入记录。
2. 启动时读取内置目录、用户记录、项目目录和 MCP/Plugins 记录，验证可用性后交给 resolver。
3. resolver 根据优先级、启用状态、显式选择和依赖关系生成 manifest；预览和运行器只消费该 manifest。
4. Builder 保存聊天和草稿，预览返回 manifest；准备发布生成口令，后续用户确认后才调用已有 Agent Profile 创建/更新及 Prompt 版本逻辑。
5. Runner 将 manifest 转换为 Pi session 的 skills 目录、MCP settings 和 Plugins extension 列表，并使用 manifest hash 参与会话复用判断。

## 异常流程与验收

- Git/HTTPS/ZIP 下载失败、压缩包越界、缺少或非法 `SKILL.md`、hash 不匹配必须失败且不留下半成品。
- 显式选择禁用 Skill、缺失 Skill 或缺失依赖必须返回稳定错误码。
- MCP 连接失败、工具列表响应异常和工具调用错误都必须可观测但不泄露凭据。
- Resolver 测试覆盖来源优先级、同名覆盖、禁用和稳定 hash。
- MCP 测试覆盖连接、列工具、调用完整链路。
- Builder 测试覆盖未确认不发布、错误口令、重复口令、非用户来源和成功发布。
- Prompt 历史测试覆盖恢复生成新版本。
- Pi 注入测试覆盖 Skill 路径、MCP 配置、Plugins 状态和能力 hash。

## 非目标

不实现计费、容器镜像管理、渠道新能力、完整 Claude Code MCP 托管、结构化文件工具的完整语义，以及 Claude Plugins 的不可变快照、COW 物化和六层优先级。
