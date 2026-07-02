import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { LocalAgentStore } from "./local-agent-store.js";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

for (const flag of ["-v", "--version"]) {
  const output = execFileSync("node", ["--import", "tsx", "src/cli.ts", flag], {
    encoding: "utf8",
    env: { ...process.env, DEVSPACE_CONFIG_DIR: "/tmp/devspace-cli-version-test" },
  }).trim();

  assert.equal(output, packageJson.version);
}

const root = mkdtempSync(join(tmpdir(), "devspace-cli-agents-test-"));
try {
  const configDir = join(root, ".devspace");
  const stateDir = join(root, ".state");
  const projectRoot = join(root, "project");
  const harnessPath = join(root, "harness.cjs");
  const promptPath = join(root, "prompt.txt");
  mkdirSync(join(configDir, "agents"), { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(
    harnessPath,
    "process.stdin.on('data', data => process.stdout.write('cli:' + data.toString().includes('Task:')));\n",
  );
  writeFileSync(promptPath, "check this");
  writeFileSync(
    join(configDir, "agents", "reviewer.md"),
    [
      "---",
      "name: reviewer",
      "description: Read-only reviewer.",
      "provider: codex",
      "model: gpt-5.4",
      "---",
      "",
      "Review only.",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(configDir, "agents", "legacy.md"),
    [
      "---",
      "name: legacy",
      "description: Legacy CLI agent.",
      "provider: legacy",
      "backend: cli",
      `command: "${process.execPath} ${harnessPath}"`,
      "---",
      "",
      "Legacy body.",
      "",
    ].join("\n"),
  );

  const output = execFileSync("node", ["--import", "tsx", "src/cli.ts", "agents", "ls"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      DEVSPACE_CONFIG_DIR: configDir,
      DEVSPACE_ALLOWED_ROOTS: projectRoot,
      DEVSPACE_STATE_DIR: stateDir,
      DEVSPACE_WORKSPACE_ROOT: projectRoot,
      DEVSPACE_LOCAL_AGENTS: "1",
      DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    },
  });

  assert.match(output, /profile reviewer codex gpt-5\.4 - Read-only reviewer\./);

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_ALLOWED_ROOTS: projectRoot,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_LOCAL_AGENTS: "1",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  });
  const store = new LocalAgentStore(join(config.stateDir, "local-agents.json"));
  const record = store.create({
    workspaceRoot: projectRoot,
    profileName: "legacy",
    provider: "legacy",
    backend: "cli",
  });
  execFileSync(
    "node",
    [
      "--import",
      "tsx",
      "src/cli.ts",
      "agents",
      "__worker",
      record.id,
      "--prompt-file",
      promptPath,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        DEVSPACE_CONFIG_DIR: configDir,
        DEVSPACE_ALLOWED_ROOTS: projectRoot,
        DEVSPACE_STATE_DIR: stateDir,
        DEVSPACE_LOCAL_AGENTS: "1",
        DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
      },
    },
  );
  assert.equal(store.get(record.id)?.status, "idle");
  assert.equal(store.get(record.id)?.latestResponse, "cli:true");
} finally {
  rmSync(root, { recursive: true, force: true });
}
