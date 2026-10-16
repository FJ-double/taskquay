import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { WindowsProviderTurnRunner } from "./provider-turn-runner.js";

const onlyWindows = process.platform === "win32" ? {} : { skip: "Windows Job capability required" };
const fixture = fileURLToPath(new URL("./provider-adapter-probe-child.ts", import.meta.url));
for (const provider of ["codex", "claude", "opencode", "pi"] as const) {
  test(`real ${provider} SDK / app-server metadata probe runs inside Windows Job with zero model calls`,
    onlyWindows, async (t) => {
      const dir = mkdtempSync(join(tmpdir(), `taskquay-adapter-probe-${provider}-`));
      try {
        if (provider === "codex" && !existsSync(join(process.env.APPDATA ?? "", "npm", "codex.cmd"))) {
          t.skip("Codex CLI not installed"); return;
        }
        const runner = await WindowsProviderTurnRunner.start({
          executionId: `ex_${randomUUID().replaceAll("-", "")}`, generation: 1,
          provider, fixtureChildPath: fixture,
          providerEnv: provider === "codex"
            ? { CODEX_COMMAND: join(process.env.APPDATA ?? "", "npm", "codex.cmd") }
            : undefined,
          context: { provider, agentId: `test-${provider}`, workspaceRoot: dir },
          input: { workspaceRoot: dir, prompt: "METADATA_ONLY_NO_INFERENCE" },
          callbacks: {
            onRequest: () => { throw new Error("PAID_MODEL_CALL_NOT_ALLOWED"); },
            onTurnStarted: () => { throw new Error("PROVIDER_TURN_NOT_ALLOWED"); },
          },
          persistArmed: (proof) => {
            assert.match(proof.jobIdentity, /^Local\\taskquay-job-/);
            assert.ok(proof.runnerCreatedAt && proof.runnerPid);
          },
        });
        const response = await runner.finished;
        assert.equal(response.ok, true, JSON.stringify(response.error));
        assert.equal(response.result?.finalResponse, "NO_INFERENCE_PROBE");
        assert.equal(response.proof.activeProcesses, 0);
        const details = response.result?.items?.[0] as Record<string, unknown> | undefined;
        assert.equal(details?.modelRequests, 0);
        assert.equal(details?.sdkImported, true, JSON.stringify(details));
        if (provider === "codex") assert.equal(details?.metadataHandshake, "initialize/initialized");
        if (provider === "opencode") {
          assert.equal(typeof details?.cliAvailable, "boolean");
          // An SDK import is NEVER proof that an OpenCode service can run.
          assert.equal(details?.metadataHandshake, "not_attempted");
        }
      } finally {
        await new Promise((resolve) => setTimeout(resolve, 250));
        await rm(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
      }
    });
}
