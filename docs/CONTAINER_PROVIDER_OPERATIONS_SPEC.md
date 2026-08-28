# 容器、Provider 与运维规格

## 目标

在现有 Pi Runner 和工作区模型之上，提供可选择的 Container/Host 执行引擎、多 Provider 故障转移、运行监控、备份恢复和安全边界。执行模式和 Provider 选择必须由服务端决定，不能由普通成员通过请求参数绕过权限。

## 用户故事

- 管理员可以把工作区设为 Host 或 Container；普通成员创建的工作区默认使用 Container，不能把工作区降级到 Host。
- Container Runner 以非 root 身份启动 Pi Agent SDK Worker，通过中性 JSON IPC 控制；使用显式镜像、超时、资源限制和挂载清单，挂载路径不在 allowlist 内时拒绝启动。
- 同一 Runtime Session 优先保持 Provider 粘性；Provider 连续失败后从健康候选中按策略选择替代项，恢复间隔到期后自动恢复。
- Provider 凭据只以加密密文落盘，映射到 Pi 时才生成进程环境，不进入普通日志和监控响应。
- 管理员可以查看队列、Runner、Container、Provider 和遗留租约状态，并可执行安全的 Runner 恢复操作。
- 备份包含 SQLite 一致性快照和受管数据目录；恢复前校验归档路径、manifest、SQLite 完整性，失败时不破坏现有数据。

## 核心流程

1. 创建或修改工作区时校验当前用户；Host 仅允许 active admin，成员请求 Host 返回 403。
2. 运行回合根据工作区的有效执行模式选择 Host Pi Runner 或 Container Runner；历史上不安全的 Host 记录对非管理员按 Container 解释。
3. Container Runner 生成固定 Docker 参数：非 root、只读根文件系统、受限临时目录、内存/CPU/PID 限制、工作区与会话目录挂载。
4. ProviderPool 按 session 粘性、round-robin/weighted/failover 选择 Provider；失败上报更新健康状态，恢复时间到达后重新纳入候选。
5. Monitor API 只返回聚合运行状态和脱敏 Provider 信息；恢复动作先停止/释放遗留 Runner，再改变持久化租约。
6. 备份先生成数据库快照和 manifest，再打包；恢复先在临时目录验证，全部通过后原子替换受管目录。

## 异常流程

- Docker 不可用、镜像不存在、挂载不安全、资源参数非法时 Container Runner 失败，不能静默回退到 Host。
- Host 用户在运行过程中被降权或禁用时，新的 Host 回合立即拒绝；正在执行的租约由恢复流程终止。
- Provider 全部不健康时返回确定性失败；不把失败 Provider 继续用于新会话，恢复间隔到期后自动探测。
- 备份归档包含绝对路径、`..`、符号链接、特殊文件或损坏数据库时拒绝恢复，保留原数据。

## 可验证验收

- Container 参数、非 root、只读/读写挂载、容量限制、超时和 allowlist 有确定性测试。
- Host/Container 权限和历史 Host 记录迁移有测试，普通成员不能降级为 Host。
- Provider 三种策略、粘性、故障转移、健康恢复和 Pi 配置映射有确定性测试。
- 监控接口覆盖队列、Runner、Container、Provider 状态，敏感字段不出现在响应。
- 临时数据目录上的备份/恢复集成测试覆盖成功、损坏归档和恢复前校验失败。
- `npm run typecheck`、`npm test -- --run`、`npm run build`、`git diff --check` 全部通过。

## 非目标

- 不实现计费、新 IM 渠道或 Agent Builder。
- 不在本阶段构建完整生产镜像；Container Runner 提供可审计的 Docker 启动协议和 Fake Docker 测试，真实镜像由部署环境提供。
- 不把 Provider 凭据、Token 或完整命令行环境写入日志、监控响应或普通错误信息。
