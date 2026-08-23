import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadDevspaceFiles,
  setDevspaceConfigValue,
} from "./user-config.js";

withConfigDir((configDir, env) => {
  writeFileSync(join(configDir, "config.json"), JSON.stringify({
    host: "0.0.0.0",
    port: 8787,
    allowedRoots: ["/work"],
    publicBaseUrl: "https://devspace.example.com",
    artifactsEnabled: true,
    subagents: true,
  }));
  writeFileSync(join(configDir, "auth.json"), JSON.stringify({
    ownerToken: "test-owner-token",
  }));

  const files = loadDevspaceFiles(env);
  assert.equal(files.migratedLegacyConfig, true);
  assert.equal(files.config.server.host, "0.0.0.0");
  assert.equal(files.config.server.port, 8787);
  assert.deepEqual(files.config.workspaces.allowedRoots, ["/work"]);
  assert.equal(files.config.artifacts.enabled, true);
  assert.equal(files.config.subagents.enabled, true);
  assert.equal(files.config.tools.mode, "codex");
  assert.equal(files.config.ui.enabled, true);
  assert.equal(files.auth.ownerToken, "test-owner-token");
  assert.equal(existsSync(join(configDir, "config.json")), false);
  assert.equal(existsSync(join(configDir, "config.jsonc")), true);
  assert.equal(existsSync(join(configDir, "config.json.v1.0.bak")), true);

  const nextLoad = loadDevspaceFiles(env);
  assert.equal(nextLoad.migratedLegacyConfig, false);
});

withConfigDir((configDir, env) => {
  writeFileSync(join(configDir, "config.jsonc"), `{
    // This comment must survive config updates.
    "configVersion": 1,
    "server": {
      "port": 8787,
    },
  }\n`);

  const files = loadDevspaceFiles(env);
  assert.equal(files.config.server.port, 8787);
  assert.equal(files.config.tools.mode, "codex");

  setDevspaceConfigValue(["server", "publicBaseUrl"], "https://new.example.com", env);
  const updated = readFileSync(join(configDir, "config.jsonc"), "utf8");
  assert.match(updated, /This comment must survive config updates/);
  assert.equal(loadDevspaceFiles(env).config.server.publicBaseUrl, "https://new.example.com");
});

withConfigDir((configDir, env) => {
  writeFileSync(join(configDir, "config.jsonc"), JSON.stringify({ configVersion: 1 }));
  writeFileSync(join(configDir, "config.json"), "{");
  assert.equal(loadDevspaceFiles(env).config.server.port, 7676);
  assert.equal(existsSync(join(configDir, "config.json")), true);
});

withConfigDir((configDir, env) => {
  writeFileSync(join(configDir, "config.jsonc"), "{");
  writeFileSync(join(configDir, "config.json"), JSON.stringify({ port: 8787 }));
  assert.throws(() => loadDevspaceFiles(env), /Unable to read .*config\.jsonc/);
  assert.equal(existsSync(join(configDir, "config.json")), true);
});

withConfigDir((configDir, env) => {
  writeFileSync(join(configDir, "config.json"), JSON.stringify({ unknownSetting: true }));
  assert.throws(
    () => loadDevspaceFiles(env),
    /Unsupported legacy configuration keys: unknownSetting/,
  );
  assert.equal(existsSync(join(configDir, "config.json")), true);
  assert.equal(existsSync(join(configDir, "config.jsonc")), false);
  assert.equal(existsSync(join(configDir, "config.json.v1.0.bak")), false);
});

console.log("user config tests passed");

function withConfigDir(
  test: (configDir: string, env: NodeJS.ProcessEnv) => void,
): void {
  const configDir = mkdtempSync(join(tmpdir(), "devspace-user-config-test-"));
  const env = { DEVSPACE_CONFIG_DIR: configDir };
  try {
    test(configDir, env);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
}
