# macOS 1.1.1 shared-core handoff

Baseline branch: `baseline/v1.1.0-bearer`

BASELINE_SHA: `b681a9b89637f938493f411e9ba05d3ac0fecb73`

macOS development branch: `platform/macos-1.1.1`.

HP v22 supplied the portable document parser/cache/worker/job modules and the external tool contracts. The existing JavaScript document engine is retained as shared source, built with TypeScript's allowJs mode; tool registration and terminal integration use the existing MCP target. This avoids a separate macOS document implementation or authentication fork.

Changes useful to merge back into shared core:

- `native-document*.js`, four parser dependencies and `document_tool` registration.
- `terminal_sessions`, `system_processes`, and owned-session listing in ProcessSessionManager.
- A common registration predicate for optional platform/backend capabilities and static-token grants.
- Accurate POSIX shell invocation, optional PTY load fallback, and PTY process-group termination.
- Canonical workspace path reauthorization that still checks the final canonical boundary.
- Shutdown ownership for document workers/jobs and JS-inclusive source test fingerprints.

macOS-specific delivery stays in the arm64 packager, installer/user LaunchAgent and macOS documentation. Windows desktop availability remains restricted to win32. Existing OAuth, static-token storage/grants and the main SQLite migration history are unchanged.
