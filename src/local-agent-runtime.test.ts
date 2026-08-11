import assert from "node:assert/strict";
import { LocalAgentRuntimePool } from "./local-agent-runtime-pool.js";
import type {
  LocalAgentDriver,
  LocalAgentRunInput,
  LocalAgentRunResult,
  LocalAgentRuntime,
  LocalAgentRuntimeContext,
} from "./local-agent-runtime.js";

const context: LocalAgentRuntimeContext = {
  agentId: "agt_test",
  provider: "codex",
  workspace: "/tmp/project",
};
const input: LocalAgentRunInput = { prompt: "inspect", workspace: "/tmp/project" };

class FakeRuntime implements LocalAgentRuntime {
  readonly provider = "codex" as const;
  alive = true;
  closeCount = 0;
  runCount = 0;
  private readonly pending: Array<() => void> = [];

  releaseWait(): void {
    for (const resolve of this.pending.splice(0)) resolve();
  }

  async run(runInput: LocalAgentRunInput): Promise<LocalAgentRunResult> {
    this.runCount += 1;
    if (runInput.prompt === "wait") await new Promise<void>((resolve) => this.pending.push(resolve));
    return {
      provider: this.provider,
      providerSessionId: "thread_1",
      finalResponse: `done:${runInput.prompt}`,
      items: [],
    };
  }

  releaseSession(): Promise<void> {
    return Promise.resolve();
  }

  isAlive(): boolean {
    return this.alive;
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    this.alive = false;
    this.releaseWait();
  }
}

const runtime = new FakeRuntime();
let createCount = 0;
const driver: LocalAgentDriver = {
  provider: "codex",
  idleTimeoutMs: Number.POSITIVE_INFINITY,
  runtimeKey: () => "shared",
  createRuntime: async () => {
    createCount += 1;
    await Promise.resolve();
    return runtime;
  },
};

const pool = new LocalAgentRuntimePool();
const [first, second] = await Promise.all([
  pool.run(driver, context, input),
  pool.run(driver, { ...context, agentId: "agt_other" }, { ...input, prompt: "second" }),
]);
assert.equal(createCount, 1, "runtime creation is single-flight per runtime key");
assert.equal(first.finalResponse, "done:inspect");
assert.equal(second.finalResponse, "done:second");
assert.equal(runtime.runCount, 2);

const running = pool.run(driver, context, { ...input, prompt: "wait" });
await new Promise<void>((resolve) => setImmediate(resolve));
await pool.evictIdle(Date.now() + 10_000_000);
assert.equal(runtime.closeCount, 0, "active runtimes are not evicted");
runtime.releaseWait();
await running;

await pool.close();
await pool.close();
assert.equal(runtime.closeCount, 1, "runtime close is idempotent");
assert.equal(pool.size, 0);
