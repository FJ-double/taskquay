# Taskquay Windows x64

版本 `1.1.1-windows.2`，基于带 Bearer Token 的 Taskquay 1.1.0（基线提交 `b681a9b`），支持 Windows 10/11 x64。

## 安装

解压 `releases/taskquay-windows-x64.zip`，在 PowerShell 中运行：

```powershell
.\install-windows.ps1
```

默认安装路径：`%LOCALAPPDATA%\Taskquay\windows-1.1.1`。安装器不覆盖已有目录；`-Destination` 指定独立目录，`-ConfigDirectory` 指定用户现有配置目录，`-AutoStart` 创建当前用户开机启动快捷方式，`-Start` 启动服务。

首次使用：

```cmd
taskquay.cmd init
taskquay.cmd doctor
taskquay.cmd serve
```

默认 MCP：`http://127.0.0.1:7676/mcp`。支持 OAuth 和 Bearer Token；Token 的可见工具范围与能力发现结果取交集。

## 复用本机 Agent

仅打包 Taskquay 与 Node.js 运行依赖，不内置 Agent CLI 或 Agent SDK。

```cmd
taskquay.cmd agents discover
taskquay.cmd agents select claude
```

- **Codex**：使用本机 `codex mcp-server` 的 `codex` / `codex-reply` 工具执行 `agent_task`，并记录线程身份及权限模式。
- **Claude Code**：`agent_task` 使用本机 `claude.exe --print --restricted`。只读任务限制为 Read/Glob/Grep；允许修改文件的任务开放 Edit/Write，但不默认开放 shell 或网络工具。需要 Claude CLI 自身已经登录。
- **Claude MCP 桥接**：`agent_mcp` 仅提供受工作区边界和 Bearer 授权约束的 `Read` 操作，和完整 `agent_task` 相互独立。

启用 Agent 前确保 CLI 已安装且已登录。模型调用是否可用以真实 `agent_task` 的执行结果为准，而非仅凭命令可发现。

## Windows 工具

- 默认命令使用 PowerShell 7（可运行时）或 CMD；Windows Job 管理路径必须使用真实的可执行文件，若 PowerShell 只有 WindowsApps 启动别名，则回退 CMD，确保子进程处于同一个 Windows Job 中。
- 当前终端为 `pipe_fallback`，支持命令、会话输出、输入和取消，但**不提供原生 ConPTY 的完整交互语义**。受管 Job 执行路径通过环境变量 `TASKQUAY_EXPERIMENTAL_MANAGED_WINDOWS_COMMANDS=1` 显式启用，默认保持原有行为。
- `terminal_sessions` 只管理 Taskquay 自己创建的会话；`system_processes` 只读列出进程 PID 与名称。
- `document_tool` 支持 XLSX、DOCX、PDF 检查、搜索和限定修改。写入生成备份，使用幂等 `request_key`。
- `windows_mcp`、`blender_mcp` 仅在配置启用且后端实际可连接时展示。

## 构建与测试

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test:windows:regression
pnpm build
pnpm package:windows
pnpm test:windows
```

安装包、SHA-256 与构建清单位于 `releases/`。发版前应验证解压后运行、权限、文档读写、真实已登录 Agent、Windows Job 进程清理和启动项行为。原有 HP 生产服务不因候选包构建而自动升级。

版权与依赖许可证：见 `LICENSE`、`NOTICE` 和 `THIRD_PARTY_NOTICES.md`。
