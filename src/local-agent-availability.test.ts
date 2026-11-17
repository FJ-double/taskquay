import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLocalAgentProviderAvailabilitySnapshot } from "./local-agent-availability.js";

const snapshot = getLocalAgentProviderAvailabilitySnapshot({
  ...process.env,
  CODEX_COMMAND: "/definitely/missing/devspace-codex",
});
assert.deepEqual(snapshot.find((provider) => provider.name === "codex"), {
  name: "codex",
  available: false,
  reason: "/definitely/missing/devspace-codex executable not found",
});
assert.equal(
  getLocalAgentProviderAvailabilitySnapshot({ ...process.env, CODEX_COMMAND: "" })
    .find((provider) => provider.name === "codex")?.available,
  false,
);

{
  const directory = mkdtempSync(join(tmpdir(), "devspace-provider-command-"));
  const executable = join(directory, "codex-wrapper");
  try {
    assert.equal(
      getLocalAgentProviderAvailabilitySnapshot({
        ...process.env,
        CODEX_COMMAND: directory,
      }).find((provider) => provider.name === "codex")?.available,
      false,
    );
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o700);
    const availability = getLocalAgentProviderAvailabilitySnapshot(
      {
        ...process.env,
        CODEX_COMMAND: "/definitely/missing/devspace-codex",
        OPENAI_API_KEY: "must-not-appear",
      },
      {
        enabled: true,
        instructions: "on-demand",
        providers: [{
          id: "codex",
          enabled: true,
          command: executable,
          env: { OPENAI_API_KEY: "configured-secret", EMPTY_VALUE: "" },
        }],
      },
    ).find((provider) => provider.name === "codex");
    assert.deepEqual(availability, {
      name: "codex",
      available: true,
      note: "available",
    });
    assert.doesNotMatch(JSON.stringify(availability), /configured-secret|must-not-appear/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

{
  const unavailableClaude = getLocalAgentProviderAvailabilitySnapshot({
    PATH: "",
    CLAUDE_COMMAND: "/definitely/missing/claude",
  }).find((provider) => provider.name === "claude");
  assert.deepEqual(unavailableClaude, {
    name: "claude",
    available: false,
    reason: "/definitely/missing/claude executable not found",
  });
  const installedClaude = getLocalAgentProviderAvailabilitySnapshot({
    PATH: "",
    CLAUDE_COMMAND: process.execPath,
  }).find((provider) => provider.name === "claude");
  assert.deepEqual(installedClaude, { name: "claude", available: true });
}

for (const [provider, variable] of [["opencode", "OPENCODE_COMMAND"], ["pi", "PI_COMMAND"]] as const) {
  const missing = getLocalAgentProviderAvailabilitySnapshot({
    PATH: "", [variable]: "/definitely/missing/local-agent",
  }).find((entry) => entry.name === provider);
  assert.deepEqual(missing, { name: provider, available: false,
    reason: "/definitely/missing/local-agent executable not found" });
  const installed = getLocalAgentProviderAvailabilitySnapshot({
    PATH: "", [variable]: process.execPath,
  }).find((entry) => entry.name === provider);
  assert.deepEqual(installed, { name: provider, available: true });
}
