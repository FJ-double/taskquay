import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadConfig } from "./config.js";
import { StaticTokenStore } from "./static-token-store.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";

test("local token CLI creates once, lists metadata, revokes and opts in without migrating old config", () => {
  const root = mkdtempSync(join(tmpdir(), "taskquay-token-cli-"));
  try {
    const configDir = join(root, "config");
    const env = { ...process.env, ...writeTestDevspaceConfig(configDir, {
      storage: { stateDir: join(root, "state") }, workspaces: { allowedRoots: [root] },
    }) };
    // An actual pre-feature config, with no staticTokens section.
    writeFileSync(join(configDir, "config.jsonc"), JSON.stringify({
      configVersion: 1, storage: { stateDir: join(root, "state") }, workspaces: { allowedRoots: [root] },
    }));
    assert.equal(loadConfig(env).staticTokens?.enabled, false);
    const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
    const run = (...args: string[]) => execFileSync(process.execPath, ["--import", "tsx", cli, ...args], { env, encoding: "utf8" });
    const invalid = spawnSync(process.execPath, ["--import", "tsx", cli, "auth", "token", "create", "--name", "fixture"], { env, encoding: "utf8" });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /Usage:/);
    const created = JSON.parse(run("auth", "token", "create", "--name", "cli-fixture", "--allowed-tools", "open_workspace,read")) as { id: string; token: string };
    assert.equal(typeof created.token, "string");
    const list = run("auth", "token", "list");
    assert(!list.includes(created.token));
    assert(!list.includes("token_hash"));
    assert.equal(JSON.parse(list)[0].id, created.id);
    assert.equal(loadConfig(env).staticTokens?.enabled, false);
    run("config", "set", "staticTokens.enabled", "true");
    assert.equal(loadConfig(env).staticTokens?.enabled, true);
    assert.match(run("auth", "token", "revoke", created.id), /revoked/);
    const store = new StaticTokenStore(join(root, "state"));
    try { assert.equal(store.verify(created.token), undefined); } finally { store.close(); }
    assert.equal(typeof JSON.parse(run("auth", "token", "list"))[0].revokedAt, "string");
    run("config", "set", "staticTokens.enabled", "false");
    assert.equal(loadConfig(env).staticTokens?.enabled, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
