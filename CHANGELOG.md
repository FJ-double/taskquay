# Changelog

## 1.1.1-windows.3 — 2026-11-26

- 默认使用 Windows Job 跟踪命令。真实子任务仍在执行时保留占用，任务结束后最多等待 3 秒排空残留输出。
- 增加启动与定期恢复检查，以及 MCP 的 recover_tasks 和控制台「诊断并恢复」入口。经系统证据核实的孤儿命令会释放占用，并同步结算关联操作和工作运行。
- Recover verified orphaned Windows command claims without replaying commands. Legacy claims without sufficient process evidence remain held for diagnosis.

## 1.1.0 — Unreleased

- Add optional owner-issued static Bearer credentials alongside existing OAuth; disabled by default.
- Add `devspace auth token create/list/revoke` with explicit exact tool grants, one-time local secret display and independently revocable persistent hashes.
- Enforce grants on MCP tool discovery and calls across tool modes, cached arguments and bridge entry points.
- Preserve the OAuth database schema and document macOS/Windows setup, client verification and rollback.
- 新增可选固定令牌；默认关闭，保留 OAuth。提供本机创建/元数据清单/即时撤销、工具级隔离及中英文升级与回滚说明。超级小爱实机与正式上线验收单独记录。
