import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WindowsProviderTurnRunner, providerRunnerEnv } from "./provider-turn-runner.js";
import type { LocalAgentTurnControl } from "./local-agent-runtime.js";

const windows = process.platform === "win32" ? {} : { skip: "win32 process Job required" };
const fixture = fileURLToPath(new URL("./provider-turn-fixture-child.ts", import.meta.url));
const ex = () => `ex_${randomUUID().replaceAll("-", "")}`;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test("a real Job-hosted Provider callback waits for durable host ACK before request", windows, async () => {
  const dir = mkdtempSync(join(tmpdir(), "taskquay-provider-fixture-"));
  let commit!: () => void;
  const commitPromise = new Promise<void>((resolve) => { commit = resolve; });
  const events: string[] = [];
  try {
    const runner = await WindowsProviderTurnRunner.start({
      executionId: ex(), generation: 1, fixtureChildPath: fixture,
      provider: "codex", context: { agentId: "test", provider: "codex", workspaceRoot: dir },
      input: { workspaceRoot: dir, prompt: "hi" },
      persistArmed: (p) => {
        assert.match(p.jobIdentity, /taskquay-job-/);
        assert.ok(p.runnerPid > 0 && p.runnerCreatedAt);
      },
      callbacks: {
        onSessionId: async (id) => { events.push(`session:${id}`); await commitPromise; },
        onThreadInfo: () => { events.push("thread"); },
        onRequest: () => { events.push("request"); },
        onTurnStarted: () => { events.push("turn"); },
      },
    });
    await sleep(300);
    assert.deepEqual(events, ["session:fake-session-resume-42"],
      "Request must not advance ahead of durable session callback.");
    commit();
    const result = await runner.finished;
    assert.equal(result.ok, true);
    assert.equal(result.result?.providerSessionId, "fake-session-resume-42");
    assert.equal(result.result?.finalResponse, "FIXTURE:hi");
    assert.equal(result.proof.activeProcesses, 0);
    assert.deepEqual(events, ["session:fake-session-resume-42", "thread", "request", "turn"]);
    assert.deepEqual(await runner.cancel(), result.proof, "Terminal cancellation is idempotent.");
  } finally { commit?.(); await sleep(250); rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 }); }
});

test("failed Provider session persistence returns error and zero-member Job proof; no request dispatched", windows, async () => {
  const dir = mkdtempSync(join(tmpdir(), "taskquay-provider-failure-"));
  const events: string[] = [];
  try {
    const runner = await WindowsProviderTurnRunner.start({
      executionId: ex(), generation: 1, fixtureChildPath: fixture,
      provider: "claude", context: { agentId: "test", provider: "claude", workspaceRoot: dir },
      input: { workspaceRoot: dir, prompt: "must-not-dispatch" },
      persistArmed: () => {},
      callbacks: {
        onSessionId: () => { events.push("session"); throw new Error("DURABLE_STORE_FAILED"); },
        onRequest: () => { events.push("request"); },
      },
    });
    await assert.rejects(runner.finished, /PROVIDER_CALLBACK_PERSISTENCE_FAILED/);
    const drained = await runner.cancel();
    assert.equal(drained.activeProcesses, 0);
    assert.deepEqual(events, ["session"]);
  } finally { await sleep(250); rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 }); }
});

test("Provider callback after terminal result is quarantined and never persists a new session", windows, async () => {
  const dir = mkdtempSync(join(tmpdir(), "taskquay-provider-late-"));
  const sessions: string[] = [];
  try {
    const runner = await WindowsProviderTurnRunner.start({
      executionId: ex(), generation: 1, fixtureChildPath: fixture,
      provider: "codex", context: { agentId: "fixture", provider: "codex", workspaceRoot: dir },
      input: { workspaceRoot: dir, prompt: "late-callback" },
      persistArmed: () => {},
      callbacks: { onSessionId: (id) => { sessions.push(id); } },
    });
    await assert.rejects(runner.finished, /PROVIDER_CALLBACK_AFTER_RESULT/);
    assert.deepEqual(sessions, ["fake-session-resume-42"]);
    assert.equal((await runner.cancel()).activeProcesses, 0);
  } finally { await sleep(200); rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 }); }
});

test("Wrong-generation Provider callback is ignored and cannot change session identity", windows, async () => {
  const dir = mkdtempSync(join(tmpdir(), "taskquay-provider-generation-"));
  const sessions: string[] = [];
  try {
    const runner = await WindowsProviderTurnRunner.start({
      executionId: ex(), generation: 1, fixtureChildPath: fixture,
      provider: "codex", context: { agentId: "fixture", provider: "codex", workspaceRoot: dir },
      input: { workspaceRoot: dir, prompt: "wrong-generation" },
      persistArmed: () => {},
      callbacks: { onSessionId: (id) => { sessions.push(id); } },
    });
    const result = await runner.finished;
    assert.equal(result.proof.activeProcesses, 0);
    assert.equal(result.ok, true);
    assert.deepEqual(sessions, ["fake-session-resume-42"]);
  } finally { await sleep(200); rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 }); }
});

test("turn control steer/interrupt crosses the Job IPC channel and stops after terminal state", windows, async () => {
  const dir = mkdtempSync(join(tmpdir(), "taskquay-provider-control-"));
  let control!: LocalAgentTurnControl;
  let ready!: () => void;
  const controlReady = new Promise<void>((resolve) => { ready = resolve; });
  try {
    const runner = await WindowsProviderTurnRunner.start({
      executionId: ex(), generation: 1, fixtureChildPath: fixture,
      provider: "codex", context: { agentId: "test", provider: "codex", workspaceRoot: dir },
      input: { workspaceRoot: dir, prompt: "control" },
      persistArmed: () => {},
      callbacks: { onControlReady: (received) => { control = received; ready(); } },
    });
    await controlReady;
    assert.equal(control.isAlive(), true);
    assert.equal((await control.steer("change direction")).turnId, "turn-fixture-steered");
    await control.interrupt();
    const result = await runner.finished;
    assert.equal(result.ok, true);
    assert.equal(result.result?.finalResponse, "FIXTURE:interrupted");
    assert.equal(result.proof.activeProcesses, 0);
    assert.equal(control.isAlive(), false);
    await assert.rejects(control.steer("after terminal"), /PROVIDER_TURN_TERMINAL/);
  } finally { await sleep(250); rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 }); }
});

test("runner env drops NODE_OPTIONS preloads but keeps Provider credentials", () => {
  const env = providerRunnerEnv({ NODE_OPTIONS: "--require evil.cjs", node_options: "--inspect",
    OPENAI_API_KEY: "kept", Path: "C:\\bin" }, "ex_1", 3);
  assert.deepEqual(env, { OPENAI_API_KEY: "kept", Path: "C:\\bin",
    TASKQUAY_EXECUTION_ID: "ex_1", TASKQUAY_EXECUTION_GENERATION: "3" });
});

test("a real Job-hosted runner does not run a NODE_OPTIONS preload", windows, async () => {
  const dir = mkdtempSync(join(tmpdir(), "taskquay-provider-preload-"));
  const marker = join(dir, "preload-ran");
  const preload = join(dir, "preload.cjs");
  writeFileSync(preload, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");`);
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `--require "${preload}"`;
  try {
    const runner = await WindowsProviderTurnRunner.start({
      executionId: ex(), generation: 1, fixtureChildPath: fixture,
      provider: "codex", context: { agentId: "test", provider: "codex", workspaceRoot: dir },
      input: { workspaceRoot: dir, prompt: "preload" }, persistArmed: () => {}, callbacks: {},
    });
    assert.equal((await runner.finished).ok, true);
    assert.equal(existsSync(marker), false, "NODE_OPTIONS preload ran inside the Provider runner");
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous;
    await sleep(250); rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
  }
});

test("control send failure rejects the caller and leaves no pending control", windows, async () => {
  const dir = mkdtempSync(join(tmpdir(), "taskquay-provider-ipc-closed-"));
  let control!: LocalAgentTurnControl;
  let ready!: () => void;
  const controlReady = new Promise<void>((resolve) => { ready = resolve; });
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  try {
    const runner = await WindowsProviderTurnRunner.start({
      executionId: ex(), generation: 1, fixtureChildPath: fixture,
      provider: "codex", context: { agentId: "test", provider: "codex", workspaceRoot: dir },
      input: { workspaceRoot: dir, prompt: "control" },
      persistArmed: () => {},
      callbacks: { onControlReady: (received) => { control = received; ready(); } },
    });
    await controlReady;
    const internals = runner as unknown as { child: import("node:child_process").ChildProcess;
      controls: Map<string, unknown> };
    internals.child.disconnect();
    await assert.rejects(control.steer("ipc closed"), /PROVIDER_RUNNER_IPC_CLOSED/);
    assert.equal(internals.controls.size, 0);
    await assert.rejects(runner.finished);
    assert.equal((await runner.cancel()).activeProcesses, 0);
    await sleep(50);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await sleep(250); rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
  }
});

test("concurrent cancel calls share one Job drain", windows, async () => {
  const dir = mkdtempSync(join(tmpdir(), "taskquay-provider-cancel-race-"));
  let ready!: () => void;
  const controlReady = new Promise<void>((resolve) => { ready = resolve; });
  try {
    const runner = await WindowsProviderTurnRunner.start({
      executionId: ex(), generation: 1, fixtureChildPath: fixture,
      provider: "codex", context: { agentId: "test", provider: "codex", workspaceRoot: dir },
      input: { workspaceRoot: dir, prompt: "control" },
      persistArmed: () => {},
      callbacks: { onControlReady: () => { ready(); } },
    });
    await controlReady;
    const [first, second] = await Promise.all([runner.cancel(), runner.cancel()]);
    assert.equal(first.activeProcesses, 0);
    assert.deepEqual(second, first);
    await assert.rejects(runner.finished, /PROVIDER_TURN_CANCELLED/);
  } finally { await sleep(250); rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 }); }
});
