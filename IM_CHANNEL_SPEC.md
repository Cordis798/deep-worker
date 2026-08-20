# 统一 IM 渠道规格

## 目标

为七种渠道提供统一的连接、入站、回复、文件、图片、Reaction 和断线恢复接口；消息通过稳定的渠道地址进入现有 Workspace/Runtime Session 与 Pi Runner 链路。

## 支持渠道

| Provider | 私聊地址示例 | 群聊地址示例 | 原生话题 | 流式更新 |
| --- | --- | --- | --- | --- |
| Telegram | `telegram:1001` | `telegram:-1001` | 支持论坛话题映射 | 否 |
| Discord | `discord:dm:1001` | `discord:1001` | 否 | 支持 |
| WhatsApp | `whatsapp:1001@s.whatsapp.net` | `whatsapp:1001@g.us` | 否 | 否 |
| 飞书 | `feishu:oc_private` | `feishu:oc_group` | 支持话题隔离 | 支持 |
| QQ | `qq:c2c:1001` | `qq:group:1001` | 否 | 支持 |
| 钉钉 | `dingtalk:c2c:1001` | `dingtalk:conversation:1001` | 否 | 支持 |
| 微信 | `wechat:1001` | 暂不提供 | 否 | 否 |

真实 SDK 不在自动化测试中启动。每个 provider 通过可替换 Transport 接收 SDK 事件；Fake Transport 覆盖消息进入、投递和断线重连。

## 路由语义

- 群聊只能挂载 Workspace。
- 私聊只能挂载 Runtime Session；没有既有挂载时，使用账号默认 Workspace 创建 Session。
- 支持原生话题的群聊，使用 `#thread:<context>#root:<message>` 地址和 `im_context_bindings` 做独立 Session 隔离。
- 渠道地址包含账号片段时，账号身份参与唯一键；同一外部聊天在不同账号下互不串线。
- 回复沿用入站消息的完整地址和账号身份，重启后不根据当前默认账号漂移。

## 统一适配器

适配器必须提供：

- `connect`、`disconnect`、`reconnect`、状态查询；
- 入站消息订阅，携带账号、外部聊天、私聊/群聊、发送者和原生线程上下文；
- 文本、文件、图片、Reaction 投递；
- 能力声明和失败信息。

Transport 负责 provider SDK 细节，适配器负责地址规范化和能力边界。微信与 WhatsApp 的登录状态保留 `qr_required`/`connecting` 状态，不在测试中模拟真实扫码。

## 命令

文本消息在进入 Agent 前解析以下命令：

- `/list`：列出当前用户可用 Workspace；
- `/status`：返回连接、挂载和当前路由状态；
- `/where`：返回当前聊天对应的 Workspace/Session；
- `/bind <workspace>`：群聊绑定 Workspace；
- `/unbind`：解除当前聊天挂载；
- `/new [名称]`：在当前 Workspace 创建 Runtime Session，并在私聊中绑定；
- `/clear`：清空当前 Session 的 Agent 上下文；
- `/help`：返回命令说明。

命令失败只回复当前聊天，不进入 Agent；权限和所有权由服务端数据库判断。

## 可靠性

- 出站投递采用有界指数退避，默认最多 3 次；
- 每次投递保存 provider、账号、目标地址和入站消息关联，重启恢复时不重新解析默认账号；
- 连接断开后自动重连，重复连接必须串行，旧连接不能清理新连接；
- 凭据只存 AES-256-GCM 密文，API 响应只返回是否存在凭据，不返回明文。

## 验收

- 七个 provider 各有 Fake Transport 测试，覆盖入站、文本投递、断线重连；
- 挂载测试覆盖群聊、私聊、原生话题和多账号隔离；
- 命令测试覆盖成功和失败路径；
- 全量 `typecheck`、`test`、`build`、`git diff --check` 通过。

## 非目标

不实现真实 IM 账号登录验收、Skills/MCP/Plugins、计费和 Container 模式；不引入没有测试价值的真实 SDK 依赖。
