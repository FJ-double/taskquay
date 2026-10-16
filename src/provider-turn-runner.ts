import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { LocalAgentRunCallbacks, LocalAgentRunInput, LocalAgentRuntimeContext, LocalAgentTurnControl } from "./local-agent-runtime.js";
import type { LocalAgentProvider } from "./local-agent-profiles.js";
import { ProviderCallbackFence, type ProviderIpcEnvelope } from "./provider-turn-ipc.js";
import { WindowsJobObject } from "./windows-job-object.js";
import type { SubagentsConfig } from "./local-agent-config.js";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Providers need the user's credentials, so the environment is inherited,
 * but nothing may execute code in the runner before it is assigned to its
 * Job (compare execution-runner bootstrapEnv): NODE_OPTIONS can carry
 * --require/--import preloads or --inspect. */
export function providerRunnerEnv(
  source: NodeJS.ProcessEnv, executionId: string, generation: number,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    // Windows environment names are case-insensitive.
    if (key.toUpperCase() !== "NODE_OPTIONS") env[key] = value;
  }
  env.TASKQUAY_EXECUTION_ID = executionId;
  env.TASKQUAY_EXECUTION_GENERATION = String(generation);
  return env;
}
export interface ProviderTurnJobProof {
  executionId: string; generation: number; jobIdentity: string;
  runnerPid: number; runnerCreatedAt: string; verifiedAt: string;
  activeProcesses: 0;
}
export interface IsolatedProviderStart {
  executionId: string;
  generation: number;
  provider: LocalAgentProvider;
  context: LocalAgentRuntimeContext;
  input: LocalAgentRunInput;
  /** Trusted adapter environment. Never logged, and never sent before GO. */
  providerEnv?: Record<string, string>;
  subagents?: SubagentsConfig;
  callbacks: LocalAgentRunCallbacks;
  persistArmed: (proof: Omit<ProviderTurnJobProof, "verifiedAt" | "activeProcesses">) => Promise<void> | void;
  /** Fixture only; production callers must use bundled provider-turn-child. */
  fixtureChildPath?: string;
}
export type IsolatedProviderResult = {
  ok: boolean;
  result?: { provider: LocalAgentProvider; providerSessionId: string | null; finalResponse: string; items: unknown[] };
  error?: { code: string; message: string; retryable?: boolean };
  proof: ProviderTurnJobProof;
};

/** Per-provider-turn Windows Job and IPC host. A thread ID survives in the
 * work ledger; the runtime process deliberately does not survive a turn.
 * This is NOT automatically enabled in LocalAgentRuntimePool.
 */
export class WindowsProviderTurnRunner {
  private sequence = 0;
  private incomingSequence = 0;
  private readonly controls = new Map<string, {
    resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout;
  }>();
  private readonly callbacksInFlight = new Set<Promise<unknown>>();
  private finalizing = false;
  private closed = false;
  private completedProof?: ProviderTurnJobProof;
  private draining?: Promise<ProviderTurnJobProof>;
  private protocolViolation?: Error;
  readonly finished: Promise<IsolatedProviderResult>;
  private resolveFinished!: (result: IsolatedProviderResult) => void;
  private rejectFinished!: (error: Error) => void;
  private constructor(
    private readonly child: ChildProcess,
    private readonly job: WindowsJobObject,
    private readonly proof: Omit<ProviderTurnJobProof, "verifiedAt" | "activeProcesses">,
    private readonly fence: ProviderCallbackFence,
  ) {
    this.finished = new Promise<IsolatedProviderResult>((resolve, reject) => {
      this.resolveFinished = resolve; this.rejectFinished = reject;
    });
    void this.finished.catch(() => undefined);
    child.on("message", (raw) => this.onMessage(raw as ProviderIpcEnvelope));
    child.once("exit", () => {
      if (!this.finalizing) void this.finishWithoutReceipt(new Error("PROVIDER_RUNNER_EXIT_WITHOUT_RESULT"));
    });
    child.once("error", () => {
      if (!this.finalizing) void this.finishWithoutReceipt(new Error("PROVIDER_RUNNER_PROCESS_ERROR"));
    });
  }
  static async start(input: IsolatedProviderStart): Promise<WindowsProviderTurnRunner> {
    if (process.platform !== "win32" || !/^ex_[a-f0-9]{32}$/.test(input.executionId) ||
        !Number.isSafeInteger(input.generation) || input.generation < 1 ||
        input.context.provider !== input.provider) throw new Error("ISOLATED_PROVIDER_INVALID_IDENTITY");
    const modulePath = input.fixtureChildPath ?? fileURLToPath(new URL(
      import.meta.url.endsWith(".ts") ? "./provider-turn-child.ts" : "./provider-turn-child.js", import.meta.url,
    ));
    const job = new WindowsJobObject();
    let child: ChildProcess;
    try {
      child = fork(modulePath, [], {
        cwd: input.context.workspaceRoot,
        env: providerRunnerEnv(process.env, input.executionId, input.generation),
        execArgv: modulePath.endsWith(".ts") ? ["--import", import.meta.resolve("tsx")] : [],
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
    } catch (error) { job.close(); throw error; }
    // Never log stdout/stderr from Provider tools; only capture bounded
    // bootstrap diagnostics if it dies BEFORE any Provider SDK can run.
    let diagnostic = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      diagnostic = (diagnostic + chunk.toString("utf8")).slice(-1_000);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => { cleanup(); reject(new Error("PROVIDER_RUNNER_READY_TIMEOUT")); }, 8_000);
        function cleanup() {
          clearTimeout(timeout);
          child.off("message", ready);
          child.off("exit", dead);
          child.off("error", failure);
        }
        function ready(raw: unknown) {
          const msg = raw as Partial<ProviderIpcEnvelope>;
          if (msg?.type !== "READY" || msg.executionId !== input.executionId ||
              msg.generation !== input.generation || msg.sequence !== 1) return;
          cleanup(); resolve();
        }
        function dead() { cleanup(); reject(new Error(`PROVIDER_RUNNER_PRE_ARM_EXIT: ${diagnostic}`)); }
        function failure(e: Error) { cleanup(); reject(e); }
        child.on("message", ready); child.once("exit", dead); child.once("error", failure);
      });
      if (!child.pid) throw new Error("PROVIDER_RUNNER_PID_MISSING");
      const runnerCreatedAt = job.assignVerified(child.pid);
      if (job.activeProcesses() !== 1) throw new Error("PROVIDER_RUNNER_JOB_NOT_EXCLUSIVE");
      const proof = { executionId: input.executionId, generation: input.generation,
        jobIdentity: job.name, runnerPid: child.pid, runnerCreatedAt };
      await input.persistArmed(proof);
      // The armed record MUST commit before GO.
      let runner!: WindowsProviderTurnRunner;
      const fence = new ProviderCallbackFence(input.executionId, input.generation, input.callbacks,
        (message) => runner.send(message.type, { ...message, sequence: undefined,
          requestId: message.requestId, ok: message.ok, error: message.error }),
        (threadId, turnId): LocalAgentTurnControl => ({
          providerThreadId: threadId, providerTurnId: turnId,
          isAlive: () => !runner.closed && !runner.finalizing,
          steer: async (prompt) => {
            const result = await runner.control("steer", prompt);
            return result as { turnId: string };
          },
          interrupt: async () => { await runner.control("interrupt"); },
        }));
      runner = new WindowsProviderTurnRunner(child, job, proof, fence);
      runner.incomingSequence = 1;
      runner.send("GO", { payload: { provider: input.provider, context: input.context,
        input: input.input, providerEnv: input.providerEnv, subagents: input.subagents } });
      return runner;
    } catch (error) {
      try { job.terminate(); } catch {}
      try { job.close(); } catch {}
      child.kill();
      throw error;
    }
  }
  private send(type: string, extra: Record<string, unknown> = {}) {
    if (!this.child.connected) throw new Error("PROVIDER_RUNNER_IPC_CLOSED");
    const { sequence: _ignored, ...rest } = extra;
    this.child.send({ type, executionId: this.proof.executionId,
      generation: this.proof.generation, sequence: ++this.sequence, ...rest });
  }
  private async control(command: "steer" | "interrupt", prompt?: string): Promise<unknown> {
    if (this.closed || this.finalizing) throw new Error("PROVIDER_TURN_TERMINAL");
    if (this.controls.size >= 16) throw new Error("PROVIDER_CONTROL_QUEUE_FULL");
    const requestId = `ctrl_${randomUUID()}`;
    const result = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.controls.delete(requestId);
        reject(new Error("PROVIDER_CONTROL_ACK_TIMEOUT"));
      }, 30_000);
      this.controls.set(requestId, { resolve, reject, timeout });
    });
    try {
      this.send("CONTROL", { requestId, command, prompt });
    } catch (error) {
      // The caller gets the send error; never leave an orphaned pending
      // promise that would later reject unhandled.
      const pending = this.controls.get(requestId);
      if (pending) clearTimeout(pending.timeout);
      this.controls.delete(requestId);
      throw error;
    }
    return result;
  }
  private onMessage(msg: ProviderIpcEnvelope) {
    if (!msg || msg.executionId !== this.proof.executionId ||
        msg.generation !== this.proof.generation ||
        !Number.isSafeInteger(msg.sequence) || msg.sequence <= this.incomingSequence) return;
    this.incomingSequence = msg.sequence;
    if (msg.type === "CALLBACK" && (this.finalizing || this.closed)) {
      // A Provider is forbidden to persist more identity/work events after
      // its final result. Never dispatch these callbacks into AgentStore.
      this.protocolViolation ??= new Error("PROVIDER_CALLBACK_AFTER_RESULT");
      if (this.child.connected && typeof msg.requestId === "string") {
        try { this.send("CALLBACK_ACK", { requestId: msg.requestId,
          ok: false, error: "PROVIDER_CALLBACK_AFTER_RESULT" }); } catch {}
      }
      return;
    }
    if (msg.type === "CALLBACK") {
      const work = this.fence.receive(msg);
      this.callbacksInFlight.add(work);
      void work.then(() => this.callbacksInFlight.delete(work), () => this.callbacksInFlight.delete(work));
    } else if (msg.type === "CONTROL_RESULT" && typeof msg.requestId === "string") {
      const pending = this.controls.get(msg.requestId);
      if (!pending) return;
      this.controls.delete(msg.requestId);
      clearTimeout(pending.timeout);
      if (msg.ok === true) pending.resolve(msg.result);
      else pending.reject(new Error(typeof msg.error === "string" ? msg.error : "Provider turn control failed."));
    } else if (msg.type === "PROVIDER_RESULT" && !this.finalizing) {
      this.finalizing = true;
      void this.complete(msg);
    }
  }
  private jobEmpty(): Promise<ProviderTurnJobProof> {
    // Concurrent cancel()/complete()/exit share one drain; a second drain
    // would observe the closed Job (WINDOWS_JOB_CLOSED). A failed drain is
    // not cached so a later caller may retry while the handle stays open.
    if (this.completedProof) return Promise.resolve(this.completedProof);
    this.draining ??= this.drainJob().finally(() => { this.draining = undefined; });
    return this.draining;
  }
  private async drainJob(): Promise<ProviderTurnJobProof> {
    // Root exit and stdio close are NOT proof of descendant exit.
    await delay(100);
    if (this.job.activeProcesses() > 0) this.job.terminate();
    for (let i = 0; i < 125; i++) {
      if (this.job.activeProcesses() === 0) {
        const proof = { ...this.proof, verifiedAt: new Date().toISOString(), activeProcesses: 0 as const };
        this.completedProof = proof;
        this.job.close(); this.closed = true;
        return proof;
      }
      await delay(40);
    }
    throw new Error("PROVIDER_JOB_NOT_EMPTY: cannot release resource claim.");
  }
  private async complete(msg: ProviderIpcEnvelope) {
    try {
      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          Promise.all([...this.callbacksInFlight]),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(
              new Error("PROVIDER_HOST_CALLBACK_TIMEOUT: quarantine execution.")), 32_000);
          }),
        ]);
      } finally {
        // Never keep the parent process alive after a confirmed Job drain.
        if (timeout) clearTimeout(timeout);
      }
      const proof = await this.jobEmpty();
      this.fence.close();
      const violation = this.protocolViolation ?? this.fence.failure;
      if (violation) throw violation;
      for (const pending of this.controls.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("Provider turn ended."));
      }
      this.controls.clear();
      const ok = msg.ok === true;
      const result = msg.result as IsolatedProviderResult["result"];
      const error = msg.error as IsolatedProviderResult["error"];
      this.resolveFinished({ ok, result: ok ? result : undefined, error: ok ? undefined : error, proof });
    } catch (error) {
      // An unresolved parent callback must not hold the Win32 process tree
      // forever. The provider receipt remains *unverified* to its caller.
      this.fence.close();
      try { await this.jobEmpty(); } catch {}
      this.rejectFinished(error instanceof Error ? error : new Error(String(error)));
    }
  }
  private async finishWithoutReceipt(error: Error) {
    this.finalizing = true;
    this.fence.close();
    try { await this.jobEmpty(); }
    catch (proofError) { this.rejectFinished(proofError instanceof Error ? proofError : error); return; }
    this.rejectFinished(error);
  }
  async cancel(): Promise<ProviderTurnJobProof> {
    // A repeated cancel after a terminal receipt never reopens a Job or
    // mutates the already-persisted outcome.
    if (this.completedProof) return this.completedProof;
    if (!this.finalizing) this.finalizing = true;
    this.fence.close();
    const proof = await this.jobEmpty();
    for (const pending of this.controls.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Provider turn cancelled."));
    }
    this.controls.clear();
    this.rejectFinished(new Error("PROVIDER_TURN_CANCELLED"));
    return proof;
  }
}
