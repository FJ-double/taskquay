import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ensureDesktopProject } from "./codex-projects.js";
import { loadConfig } from "./config.js";
import { SqliteOAuthStore } from "./oauth-store.js";
import { createServer } from "./server.js";
import { StaticTokenStore } from "./static-token-store.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";

const registerProject: typeof ensureDesktopProject = async (roots) => ({
  protocol: "fixture", status: "persisted_registration", roots, createdDirectories: [], projectId: "fixture", uiStatus: "unverified",
});

for (const mode of ["codex", "claude"] as const) {
  test(`static HTTP MCP isolates permissions, persists and revokes (${mode})`, async (t) => {
    const logs: string[] = [];
    t.mock.method(console, "log", (line: unknown) => { logs.push(String(line)); });
    t.mock.method(console, "warn", (line: unknown) => { logs.push(String(line)); });
    const root = await mkdtemp(join(tmpdir(), "taskquay-static-http-"));
    // Keep review snapshots inside the fixture even when the host home is a Git repository.
    execFileSync("git", ["init", "--quiet", root], { windowsHide: true, stdio: "pipe" });
    await writeFile(join(root, ".gitignore"), "config/\nstate/\nworktrees/\n");
    const config = loadConfig(writeTestDevspaceConfig(join(root, "config"), {
      storage: { stateDir: join(root, "state") },
      workspaces: { allowedRoots: [root], worktreeRoot: join(root, "worktrees") },
      tools: { mode }, staticTokens: { enabled: true },
      ui: { enabled: false }, logging: { level: "debug" },
      subagents: { enabled: false, instructions: "on-demand", providers: [] },
    }));
    const manager = new StaticTokenStore(config.stateDir);
    const issued = manager.create({ name: "xiaomi-fixture", allowedTools: ["open_workspace", "read", "workspace_context"] });
    const other = manager.create({ name: "other-fixture", allowedTools: ["open_workspace"] });
    const oauthStore = new SqliteOAuthStore(config.stateDir);
    const oauthClient = oauthStore.registerClient({ redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"] }, config.oauth.allowedRedirectHosts);
    const oauthToken = "oauth-static-coexistence-fixture";
    oauthStore.saveAccessToken(createHash("sha256").update(oauthToken).digest("base64url"), {
      clientId: oauthClient.client_id, scopes: config.oauth.scopes,
      expiresAt: Math.floor(Date.now() / 1000) + 3600, resource: new URL("/mcp", config.publicBaseUrl).href,
    });
    oauthStore.close();
    let running = createServer(config, { registerProject });
    let listener = running.app.listen(0, "127.0.0.1");
    await once(listener, "listening");
    const stop = async () => {
      listener.closeAllConnections();
      await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
      await running.close();
    };
    t.after(async () => { await stop(); manager.close(); await rm(root, { recursive: true, force: true }); });
    const post = async (token: string | undefined, method: string, params: Record<string, unknown>, modern = false) => {
      const address = listener.address();
      assert(address && typeof address !== "string");
      const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json", Accept: "application/json, text/event-stream",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(modern ? { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": method,
            ...(typeof params.name === "string" ? { "Mcp-Name": params.name } : {}) } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: modern ? {
          ...params, _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": { name: "static-fixture", version: "1" },
          },
        } : params }),
        signal: AbortSignal.timeout(10000),
      });
      const text = await response.text();
      const data = text.startsWith("event:") ? text.split("\n").find((line) => line.startsWith("data: "))?.slice(6) : text;
      return { status: response.status, headers: response.headers, text, body: data ? JSON.parse(data) : {} };
    };
    for (const token of [undefined, "wrong-token", `${issued.token}wrong`]) {
      const response = await post(token, "tools/list", {});
      assert.equal(response.status, 401);
      assert.match(response.headers.get("WWW-Authenticate") ?? "", /Bearer.*resource_metadata=/);
    }
    const initialized = await post(issued.token, "initialize", {
      protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "xiaomi-fixture", version: "1" },
    });
    assert.equal(initialized.status, 200);
    assert.equal(initialized.body.result.serverInfo.name, "devspace");
    for (const modern of [false, true]) {
      const listed = await post(issued.token, "tools/list", {}, modern);
      assert.equal(listed.status, 200, `MCP tools/list status ${listed.status}: ${listed.text}`);
      assert.deepEqual(listed.body.result.tools.map((tool: { name: string }) => tool.name).sort(), issued.allowedTools.slice().sort());
      const otherList = await post(other.token, "tools/list", {}, modern);
      assert.deepEqual(otherList.body.result.tools.map((tool: { name: string }) => tool.name), ["open_workspace"]);
      const opened = await post(issued.token, "tools/call", { name: "open_workspace", arguments: { path: root } }, modern);
      assert.equal(opened.status, 200, `MCP tools/call status ${opened.status}: ${opened.text}`);
      assert.equal(opened.body.result.isError, undefined);
      const workspaceId = opened.body.result.structuredContent.workspace_id;
      assert.equal(typeof workspaceId, "string");
      await writeFile(join(root, "read-fixture.txt"), "read-only success\n");
      const read = await post(issued.token, "tools/call", { name: "read", arguments: { workspaceId, path: "read-fixture.txt" } }, modern);
      assert.equal(read.status, 200);
      assert.equal(read.body.result.isError, undefined);
      assert.match(JSON.stringify(read.body.result), /read-only success/);
      // Canonical and cached arguments, both modes, process/agent/bridge entry points.
      for (const name of ["exec_command", "bash", "apply_patch", "write", "edit", "write_stdin", "agent_task", "work_task", "windows_mcp", "blender_mcp"]) {
        const denied = await post(issued.token, "tools/call", { name, arguments: { workspaceId, command: "blocked", action: "call_tool", tool: "Snapshot" } }, modern);
        assert.equal(denied.status, 403);
        assert.match(denied.text, /not allowed/);
      }
      assert.equal(await readFile(join(root, "read-fixture.txt"), "utf8"), "read-only success\n");
    }
    const oauthList = await post(oauthToken, "tools/list", {});
    assert(oauthList.body.result.tools.length > issued.allowedTools.length);
    // Real server recreation, preserving only SQLite state.
    await stop();
    running = createServer(config, { registerProject });
    listener = running.app.listen(0, "127.0.0.1");
    await once(listener, "listening");
    assert.equal((await post(issued.token, "tools/list", {})).status, 200);
    assert.equal(manager.revoke(issued.id), true);
    assert.equal((await post(issued.token, "tools/list", {})).status, 401);
    assert.equal((await post(other.token, "tools/list", {})).status, 200);
    assert.equal((await post(oauthToken, "tools/list", {})).status, 200);
    const logged = logs.join("\n");
    assert.match(logged, /static_token_tool_denied/);
    for (const token of [issued.token, other.token, oauthToken]) assert(!logged.includes(token));
    // Disabling the feature must reject even an existing valid static credential.
    await stop();
    running = createServer({ ...config, staticTokens: { enabled: false } }, { registerProject });
    listener = running.app.listen(0, "127.0.0.1");
    await once(listener, "listening");
    assert.equal((await post(other.token, "tools/list", {})).status, 401);
    assert.equal((await post(oauthToken, "tools/list", {})).status, 200);
  });
}
