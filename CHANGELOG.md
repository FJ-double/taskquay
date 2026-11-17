# Changelog

## 1.1.1 — macOS arm64 candidate

- Share HP v22 document processing, owned terminal sessions and process listing.
- Intersect platform/backend availability and static-token grants in tool registration.
- Default macOS command execution to zsh, preserve explicit POSIX shells, and report pipe when optional PTY loading is unavailable.
- Accept canonical workspace paths on macOS without widening root containment.
- Add a bundled arm64 runtime, user LaunchAgent installer/upgrade/rollback and source/build metadata.

## 1.1.0 — Unreleased

- Add optional owner-issued static Bearer credentials alongside existing OAuth; disabled by default.
- Add `devspace auth token create/list/revoke` with explicit exact tool grants, one-time local secret display and independently revocable persistent hashes.
- Enforce grants on MCP tool discovery and calls across tool modes, cached arguments and bridge entry points.
- Preserve the OAuth database schema and document macOS/Windows setup, client verification and rollback.
- 新增可选固定令牌；默认关闭，保留 OAuth。提供本机创建/元数据清单/即时撤销、工具级隔离及中英文升级与回滚说明。超级小爱实机与正式上线验收单独记录。
