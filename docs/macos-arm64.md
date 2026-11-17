# Taskquay 1.1.1 macOS arm64 candidate

This candidate runs natively on Apple Silicon. It bundles Node, compiled core/UI, production dependencies and Darwin native modules. It provides no Intel installer. Existing OAuth and optional static Bearer credentials remain supported.

## Install or upgrade

Extract `taskquay-macos-arm64-1.1.1.tar.gz`, open Terminal in the extracted folder, then run as your logged-in user:

```sh
./install.command install
./install.command status
```

Use the same command from a newer extracted candidate to upgrade. The installer retains the previous release and launchd definition. It uses a user LaunchAgent (`net.taskquay.macos`), never a root/system daemon. Do not use sudo. Existing configuration, allowed roots, OAuth credentials and static-token grants are retained. A first installation prompts for the existing Taskquay local setup when configuration is missing.

If another Taskquay service already uses the configured port, choose a separate configuration/port for candidate testing. The installer does not stop services on other labels. Example:

```sh
./install.command install --config-dir /absolute/path/to/candidate-config --label net.taskquay.macos.candidate --install-root /absolute/path/to/candidate-install
```

The selected configuration must contain the desired host, unused port, state directory and allowed roots. Keep candidate state separate from an existing running instance. Reuse those three options with `status`, `stop`, `start` or `rollback` for that installation.

```sh
./install.command stop
./install.command start
./install.command rollback
```

Rollback restores the prior launchd definition/release, keeping configuration and state. A first installation has no prior version; use `stop` instead. Configuration/SQLite backups remain the owner's responsibility before changing a production instance. The static token database is independent of the OAuth schema.

## Check the running build

`GET /healthz` reports `version`, `build_sha`, `platform` and `arch`. `app/build-info.json` records the baseline and source commit. The bundled CLI `runtime/bin/node app/dist/cli.js doctor` also shows build SHA, the actual selected command shell and native dependency status.

On macOS, commands default to `/bin/zsh`; an explicitly selected supported POSIX `SHELL` is preserved. `exec_command` parameters keep their existing contract. TTY requests use the optional node-pty module; if it cannot be loaded, the request starts once using pipe and reports the actual transport. Session termination follows POSIX process groups.

## Tools and permissions

Core MCP tool names stay unchanged. Added shared tools are `document_tool`, `terminal_sessions` and `system_processes`. The same registration flow applies platform/backend availability and static-token permissions. No new tool is automatically granted to an existing static token.

- `document_tool` carries the HP v22 XLSX/DOCX/PDF inspect/search/edit contract, including bounded worker execution, durable operation results, explicit write keys, backups and source-hash checks. It supports cell edits, DOCX text-run replacement and appending a blank PDF page. Document paths remain within approved workspace boundaries. It does not control Office GUI applications.
- `terminal_sessions` lists or terminates only Taskquay-created sessions owned by the selected workspace.
- `system_processes` returns process names/PIDs, without full command arguments.
- `blender_mcp` requires explicit configuration and a reachable backend. Windows desktop automation is not advertised on macOS.
- `download_artifact` retains its existing opt-in switch and Darwin destination implementation.

This is a local candidate package, not a notarized application or a public npm release. Dependency license/NOTICE files and Node's license are retained in the payload.

## 中文说明

本版本仅提供 Apple Silicon 的 `taskquay-macos-arm64` 候选包，继续使用原 MCP 协议、OAuth、可选固定 Token 和工作区边界。新增文档、受管终端及进程列表三个共享工具；现有受限 Token 的工具清单不会扩大。

安装/升级使用 `./install.command install`，需要时用 `--config-dir`、`--label` 和 `--install-root` 指定隔离实例。用户级 launchd 负责后台运行；不用 sudo。`status` 查看构建，`stop/start` 控制选定实例，`rollback` 恢复上一个已记录的运行版本。首次安装没有旧版本可回滚。

## 本地 Agent 接入

初始化时检测已安装的 Claude Code、Codex、OpenCode 和 Pi CLI，并把选中的本地命令路径写入配置；缺失的 CLI 不会因 Taskquay 内置 SDK 而被标记为可用。

Claude Agent SDK 调用已安装的 `claude`，OpenCode SDK 启动已安装的 `opencode serve`。Pi 保留 SDK 会话和 Taskquay 的工作区沙箱，并使用本地 Pi 的 `~/.pi/agent` 认证、模型和会话数据；本机必须已安装 `pi` 命令，但 Pi 会话仍由 SDK 在 Taskquay 进程内运行。
