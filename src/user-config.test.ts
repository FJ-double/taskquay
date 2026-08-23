import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDevspaceFiles } from "./user-config.js";

const configDir = mkdtempSync(join(tmpdir(), "devspace-user-config-test-"));
const env = { DEVSPACE_CONFIG_DIR: configDir };

try {
  writeFileSync(join(configDir, "config.json"), JSON.stringify({
    port: 8787,
    subagents: {
      enabled: true,
      providers: [{ id: "codex", enabled: true }],
    },
  }));
  writeFileSync(join(configDir, "auth.json"), JSON.stringify({
    ownerToken: "test-owner-token",
  }));

  assert.deepEqual(loadDevspaceFiles(env).config, {
    port: 8787,
    subagents: {
      enabled: true,
      providers: [{ id: "codex", enabled: true }],
    },
  });
  assert.equal(loadDevspaceFiles(env).auth.ownerToken, "test-owner-token");

  writeFileSync(join(configDir, "config.json"), JSON.stringify({ port: "8787" }));
  assert.throws(() => loadDevspaceFiles(env), /expected number/i);

  writeFileSync(join(configDir, "config.json"), JSON.stringify({ unknownSetting: true }));
  assert.throws(() => loadDevspaceFiles(env), /unrecognized key/i);

  writeFileSync(join(configDir, "config.json"), "{");
  assert.throws(() => loadDevspaceFiles(env), /Unable to read .*config\.json/);
} finally {
  rmSync(configDir, { recursive: true, force: true });
}
