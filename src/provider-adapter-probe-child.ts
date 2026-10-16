/**
 * Test-only Provider metadata bootstrap. No Provider runtime.run(), no
 * prompt submission, no thread/start or turn/start RPC, and no auth reads.
 * Runs INSIDE the test's Windows Job, after its durable GO.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { ProviderIpcEnvelope } from "./provider-turn-ipc.js";

const executionId = process.env.TASKQUAY_EXECUTION_ID ?? "";
const generation = Number(process.env.TASKQUAY_EXECUTION_GENERATION);
let sequence = 0;
let started = false;
const send = (message: Record<string, unknown>) => process.send?.({
  executionId, generation, sequence: ++sequence, ...message,
});
const safeVersion = (executable: string) => {
  const result = spawnSync(executable, ["--version"], {
    timeout: 8_000, encoding: "utf8", windowsHide: true,
    shell: process.platform === "win32" && /\.cmd$/i.test(executable),
  });
  return result.status === 0 ? (result.stdout || "").trim().slice(0, 160) : null;
};
async function probe(payload: {
  provider?: string;
  input?: { prompt?: string };
  context?: { workspaceRoot?: string };
  providerEnv?: Record<string, string>;
}) {
  const provider = payload.provider;
  if (!["codex", "claude", "opencode", "pi"].includes(provider ?? "") ||
      payload.input?.prompt !== "METADATA_ONLY_NO_INFERENCE") {
    throw new Error("PROBE_DISPATCH_IDENTITY_MISMATCH");
  }
  const runtimeDir = payload.context?.workspaceRoot;
  if (typeof runtimeDir !== "string" || !existsSync(runtimeDir)) throw new Error("PROBE_WORKSPACE_MISSING");
  let details: Record<string, unknown> = { provider, modelRequests: 0, sdkImported: false };
  if (provider === "codex") {
    const { CodexAppServerRuntime, resolveCodexCommand } = await import("./local-agent-codex.js");
    const command = resolveCodexCommand({ ...process.env, ...payload.providerEnv });
    if (!command) throw new Error("CODEX_CLI_MISSING");
    const codexHome = join(runtimeDir, "isolated-codex-home");
    mkdirSync(codexHome, { recursive: true });
    // Only the constructor's app-server process is created here. It is a
    // descendant of this already-Job-assigned fixture process.
    const runtime = new CodexAppServerRuntime({
      command: command.executable, version: command.version,
      env: { ...process.env, CODEX_HOME: codexHome },
    });
    try {
      await Promise.race([
        runtime.initialize(),
        new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("CODEX_INITIALIZE_TIMEOUT")), 12_000);
          timer.unref();
        }),
      ]);
      details = { provider, modelRequests: 0, sdkImported: true,
        metadataHandshake: "initialize/initialized", commandVersion: command.version ?? "unknown" };
    } finally {
      await runtime.close();
    }
  } else if (provider === "claude") {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    const cmd = join(process.env.APPDATA ?? "", "npm", "claude.cmd");
    details = { provider, modelRequests: 0, sdkImported: typeof sdk.query === "function",
      cliVersion: existsSync(cmd) ? safeVersion(cmd) : null, metadataHandshake: "not_attempted" };
  } else if (provider === "opencode") {
    const sdk = await import("@opencode-ai/sdk");
    const cli = spawnSync("where.exe", ["opencode"], { timeout: 3_000, windowsHide: true, encoding: "utf8" });
    details = { provider, modelRequests: 0, sdkImported: typeof sdk.createOpencodeClient === "function",
      cliAvailable: cli.status === 0, metadataHandshake: "not_attempted" };
  } else {
    const sdk = await import("@earendil-works/pi-coding-agent");
    details = { provider, modelRequests: 0,
      sdkImported: typeof sdk.createAgentSession === "function",
      metadataHandshake: "not_attempted" };
  }
  send({ type: "PROVIDER_RESULT", ok: true, result: {
    provider, providerSessionId: null, finalResponse: "NO_INFERENCE_PROBE",
    items: [details],
  } });
}
process.on("message", (raw: unknown) => {
  const message = raw as ProviderIpcEnvelope;
  if (message.executionId !== executionId || message.generation !== generation ||
      message.type !== "GO" || started) return;
  started = true;
  void probe(message.payload as Parameters<typeof probe>[0]).catch((error: unknown) => {
    const original = error instanceof Error && error.cause instanceof Error
      ? error.cause.message.slice(0, 400) : "";
    send({ type: "PROVIDER_RESULT", ok: false, error: {
      code: "PROVIDER_METADATA_PROBE_FAILED",
      message: (error instanceof Error ? error.message : String(error)) +
        (original ? `; cause=${original}` : ""),
    } });
  }).finally(() => process.disconnect?.());
});
process.on("disconnect", () => process.exit(0));
send({ type: "READY" });
