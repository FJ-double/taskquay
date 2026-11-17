# 静态 Bearer Token（v1.1.0）

Taskquay 保留原 OAuth，新增可选的长期静态令牌，供只有 URL 和 Auth Token 输入框的 MCP 客户端使用。默认关闭；旧配置无需手工迁移。原 OAuth 所有者密码不是静态令牌，不可用它填手机的 Auth Token。

## 本机管理

以下命令使用当前安装的 `devspace`。源码/离线构建可将 `devspace` 替换为 `node bin/devspace.js`。Mac 和 Windows 均使用相同参数。命令作用于 `DEVSPACE_CONFIG_DIR` 指定的配置（未设置时为用户的 `.devspace`）；请核对目标环境。正式服务启用、重启和真实令牌签发需所有者授权。

```sh
devspace config set staticTokens.enabled true
devspace auth token create --name xiaomi-phone --allowed-tools open_workspace,read,workspace_context
devspace auth token list
devspace auth token revoke <token-id>
```

创建结果包含 `id`、名称、工具清单、时间和 `token`。明文只在本机创建输出中显示这一次；不要把输出发到聊天、日志、Git 或公开配置。请直接保存到密码管理器。丢失后撤销旧令牌并创建新令牌。`list` 只显示元数据；`revokedAt: null` 表示未撤销。每个客户端单独创建令牌。

创建不会自动打开服务端开关。更改 `staticTokens.enabled` 后需重启目标测试服务，生产重启另行确认。撤销无需重启：之后的每个 HTTP 请求都会读取持久化状态；已开始的调用不会被强制中断。静态令牌没有到期时间，不采用 OAuth 的 3600 秒 TTL。

`--allowed-tools` 为必填的精确工具名称清单，不支持 `*`，不隐式加入任何工具。权限同时限制 `tools/list` 和 `tools/call`，并与当前 `tools.mode` 和桥接开关取交集。默认示例仅授予工作区打开和读取；不会放开 `exec_command`、`bash`、`apply_patch`、进程控制、子 Agent 或桥接工具。授予 `windows_mcp` / `blender_mcp` 意味着允许该桥接工具原有契约内的操作，桥接自身的 `allowedTools` 仍生效。

## 手机与 MCP 请求

公网 URL 保持 `https://mac-tq.wuhu85.net/mcp`，不调整域名和隧道。服务器接受的标准请求头为 `Authorization: Bearer <token>`，MCP 消息仍使用原 Streamable HTTP 协议。

**超级小爱实机填写格式待验收。** 自动测试仅证明标准 HTTP Bearer 请求成功，不能证明手机输入框应填裸令牌还是完整 `Bearer ...`。在经授权的隔离/灰度端点，用手机保存连接、确认工具数大于 0，再执行一次只读操作。只有真实客户端完成后才能记录填写方式与 A10 通过。勿在任务书、截图或报告中暴露真实令牌。

需要检查时可在隔离环境开启 `logging.level: "debug"`。认证成功后的 `mcp_request` 事件标记 `authType: "static"` 和非秘密的 `tokenId`，不记录 Authorization 值。结合手机结果确认输入方式；不要记录完整请求头来排错。

## 401 / 403 定位

- 401：检查目标配置开关、是否已按该配置重启、令牌是否撤销、客户端是否发送了标准 Bearer 头。无凭据的 `GET /mcp` 返回 401 属于正常认证行为。
- 403 且提示 `Tool is not allowed for this token`：所请求工具未获该令牌授权。审计事件是 `static_token_tool_denied`。需要新权限时由所有者创建替代令牌并撤销旧令牌。
- 工具未列出：检查该令牌的清单、`tools.mode`、桥接/功能开关。令牌不会启用被服务器关闭的工具。
- 客户端协议问题：使用带 `Content-Type: application/json` 和 `Accept: application/json, text/event-stream` 的 `initialize`、`tools/list`、`tools/call` 消息定位，不以单独 GET 代替握手测试。

## 存储、升级与回滚

令牌存放于现有 `storage.stateDir` 下的 `static-tokens.sqlite`（以及 SQLite WAL/SHM 文件）。数据库只保存 SHA-256 哈希和元数据，目录/主文件沿用原状态库的 0700/0600 权限策略；Windows 沿用用户私有存储目录的访问边界。现有 `devspace.sqlite` 的迁移版本和 OAuth 表均不改变。

升级前保留原 1.0.8 构建与配置/状态备份。运行中的 SQLite 应使用 SQLite backup API；复制数据库文件时先正常停止目标服务，并包含 WAL，不能只热拷贝主文件。先在独立配置、状态目录及空闲本机端口验证 v1.1.0；生产切换需另行批准。OAuth 令牌无需重新签发。

回滚：正常停止目标新服务，恢复旧构建和升级前配置，然后按原方式启动。1.0.8 的严格配置 Schema 不认识 `staticTokens`，因此必须恢复旧配置或移除整个 `staticTokens` 段（仅设置 false 不够）。新增凭据库可保留，旧版本忽略它；OAuth 主库没有新增迁移，可继续读取，不需盲目覆盖其最新状态。若必须恢复备份，应明确这会回退备份之后的 OAuth/工作区变更。重新升级时已撤销令牌仍保持撤销，除非人为恢复旧凭据库备份。
