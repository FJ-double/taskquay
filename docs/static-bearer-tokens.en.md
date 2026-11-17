# Static Bearer tokens (v1.1.0)

Taskquay keeps OAuth and optionally accepts owner-issued, long-lived static credentials for MCP clients with URL/Auth Token fields. The feature defaults to off. Existing configurations and OAuth grants continue to work. The OAuth owner password is not a static credential.

## Local management

Run against the intended `DEVSPACE_CONFIG_DIR` (the user's `.devspace` by default). The same CLI works on macOS and Windows. For a source/offline build, replace `devspace` with `node bin/devspace.js`.

```sh
devspace config set staticTokens.enabled true
devspace auth token create --name xiaomi-phone --allowed-tools open_workspace,read,workspace_context
devspace auth token list
devspace auth token revoke <token-id>
```

Creation displays the plaintext `token` once in the local command output. Store it privately; never paste real credentials into chat, logs, commits or public configuration. Listing returns only IDs, names, exact tool grants and creation/revocation timestamps. Use a separate token per client. Lost credentials require a replacement and revocation of the old ID.

Creation does not enable the server feature. Restart the target test server after changing the switch; production activation, credential issuance and restarts require owner authorization. Revocation is checked on every subsequent HTTP request without a restart; it does not cancel an already running operation. Static tokens have no TTL and do not inherit OAuth's one-hour expiry.

`--allowed-tools` is mandatory. No wildcards or implicit grants are accepted. Both tool discovery and invocation enforce the exact list, intersected with the configured tool mode and enabled features. The example grants only workspace opening and reading. Shell, patching, process control, agents and bridge tools receive no automatic access. Granting a bridge's outer tool name grants its existing interface, still subject to the bridge's own `allowedTools` configuration.

## Phone setup and diagnosis

Keep the public MCP URL `https://mac-tq.wuhu85.net/mcp` and the existing tunnel. The server accepts standard `Authorization: Bearer <token>` requests over the existing Streamable HTTP transport.

**The Super Xiaoai Auth Token field format still requires a real phone test.** HTTP integration tests do not establish whether that UI wants a raw value or the full header value. On an owner-approved isolated/canary endpoint, save the connection, check for a nonzero tool count and complete one read-only call before recording the format and passing A10. Do not expose credentials in screenshots or reports.

In an isolated environment, debug logging adds `authType: "static"` and a nonsecret `tokenId` to authenticated `mcp_request` events, never the Authorization value. Use these events to confirm successful phone authentication without logging full headers.

- 401: check the target switch, restart, revoked state and Bearer header formatting. An unauthenticated `GET /mcp` returning 401 is expected.
- 403 with `Tool is not allowed for this token`: the tool is outside the exact grant. The audit event is `static_token_tool_denied`.
- Missing tool: check the grant, tool mode and feature/bridge configuration. A credential cannot enable a disabled server feature.
- Test MCP with `initialize`, `tools/list` and `tools/call`, using JSON Content-Type and Accept for both JSON and SSE; GET alone is not a handshake test.

## Upgrade and rollback

`storage.stateDir/static-tokens.sqlite` stores only SHA-256 hashes and metadata, protected by the same private-directory/file policy as existing state (0700/0600 on POSIX; the existing private user directory boundary on Windows). SQLite WAL/SHM files belong to the same state. The original `devspace.sqlite` schema and OAuth tables are unchanged.

Keep the previous 1.0.8 build and back up configuration/state before a production change. For live SQLite use its backup API; for file copies stop the target service first and account for WAL. Validate using a separate config, state and unused loopback port. Production switching requires separate approval. Existing OAuth clients do not need new grants.

To roll back, stop the new target service, restore the previous build and configuration, then start normally. The 1.0.8 strict schema does not recognize `staticTokens`: restore the old config or remove that entire section, rather than setting it false. The separate credential database can remain; the old build ignores it. The OAuth database has no new migration and remains readable, so avoid needlessly replacing current OAuth/workspace state with an older backup. Reinstalling v1.1.0 retains revocations unless an older credential backup is deliberately restored.
