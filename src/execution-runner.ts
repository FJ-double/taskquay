import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WindowsJobObject } from "./windows-job-object.js";

type RunnerSignal = {
  type: string;
  executionId: string;
  generation: number;
  sequence: number;
  code?: number | null;
  signal?: string | null;
  message?: string;
};

export interface RunnerArmedIdentity {
  executionId: string;
  generation: number;
  runnerPid: number;
  runnerCreatedAt: string;
  jobIdentity: string;
  memberCount: number;
  armedAt: string;
}

export interface WindowsCommandInput {
  /** Identity must have been created in the state store before calling. */
  executionId: string;
  generation: number;
  command: string;
  cwd: string;
  environment: Record<string, string>;
  /** Called BEFORE GO. The caller must durably persist armed evidence here. */
  persistArmed: (proof: RunnerArmedIdentity) => Promise<void> | void;
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (chunk: Buffer) => void;
  graceMs?: number;
}

export interface JobExitEvidence {
  executionId: string;
  generation: number;
  jobIdentity: string;
  verifiedAt: string;
  activeProcesses: 0;
  runnerPid: number;
  rootExitCode?: number;
  rootSignal?: string;
  stopReason: "root_exit" | "cancelled" | "runner_lost";
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function awaitZero(job: WindowsJobObject, deadlineMs: number): Promise<void> {
  const until = Date.now() + deadlineMs;
  do {
    if (job.activeProcesses() === 0) return;
    await delay(40);
  } while (Date.now() <= until);
  throw new Error("WINDOWS_JOB_CLEANUP_PENDING: membership did not reach zero within verification window.");
}

function bootstrapEnv(input: WindowsCommandInput): NodeJS.ProcessEnv {
  // Do not inherit NODE_OPTIONS, auto-instrumentation or arbitrary model tools.
  return {
    Path: process.env.Path ?? process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    USERPROFILE: process.env.USERPROFILE,
    TASKQUAY_EXECUTION_ID: input.executionId,
    TASKQUAY_EXECUTION_GENERATION: String(input.generation),
  };
}

/**
 * One Windows Job per execution, with a dedicated IPC bootstrap process.
 * No application command/provider is loaded before persistence confirms
 * assignment to the Job. All other platform implementations remain unchanged.
 */
export class WindowsCommandRunner {
  private readonly job: WindowsJobObject;
  private readonly child: ChildProcess;
  private readonly identity: RunnerArmedIdentity;
  private sequence = 0;
  private incoming = 0;
  private settled?: Promise<JobExitEvidence>;
  private resolveFinished!: (value: JobExitEvidence) => void;
  private rejectFinished!: (reason: Error) => void;
  readonly finished: Promise<JobExitEvidence>;
  private readonly graceMs: number;
  private jobClosed = false;

  private constructor(input: WindowsCommandInput, child: ChildProcess, job: WindowsJobObject, identity: RunnerArmedIdentity) {
    this.job = job;
    this.child = child;
    this.identity = identity;
    this.graceMs = input.graceMs ?? 200;
    this.finished = new Promise<JobExitEvidence>((resolve, reject) => {
      this.resolveFinished = resolve;
      this.rejectFinished = reject;
    });
    // Errors become the completion receipt even when caller only observes start.
    void this.finished.catch(() => undefined);
    child.stdout?.on("data", (chunk: Buffer) => input.onStdout?.(chunk));
    child.stderr?.on("data", (chunk: Buffer) => input.onStderr?.(chunk));
    child.on("message", (value: unknown) => {
      const m = value as Partial<RunnerSignal>;
      if (m?.executionId !== input.executionId || m.generation !== input.generation ||
          !Number.isSafeInteger(m.sequence) || (m.sequence ?? 0) <= this.incoming) return;
      this.incoming = m.sequence!;
      if (m.type === "ROOT_EXIT") {
        void this.settle("root_exit", m.code ?? undefined, m.signal ?? undefined);
      } else if (m.type === "RUNNER_ERROR") {
        void this.settle("runner_lost");
      }
    });
    child.once("exit", () => { void this.settle("runner_lost"); });
    child.once("error", () => { void this.settle("runner_lost"); });
  }

  static async start(input: WindowsCommandInput): Promise<WindowsCommandRunner> {
    if (process.platform !== "win32") throw new Error("WINDOWS_JOB_UNSUPPORTED");
    if (!/^ex_[a-f0-9]{32}$/.test(input.executionId) ||
        !Number.isSafeInteger(input.generation) || input.generation <= 0) {
      throw new Error("INVALID_EXECUTION_IDENTITY");
    }
    const modulePath = fileURLToPath(new URL(
      import.meta.url.endsWith(".ts") ? "./execution-runner-child.ts" : "./execution-runner-child.js",
      import.meta.url,
    ));
    const job = new WindowsJobObject();
    let child: ChildProcess;
    try {
      child = fork(modulePath, [], {
        cwd: input.cwd,
        env: bootstrapEnv(input),
        // The fork's cwd is the user's project, which may not contain tsx.
        // Resolve the development loader relative to this installation.
        execArgv: modulePath.endsWith(".ts")
          ? ["--import", import.meta.resolve("tsx")]
          : [],
        stdio: ["pipe", "pipe", "pipe", "ipc"],
      });
    } catch (error) {
      job.close();
      throw error;
    }
    // Before GO the only stderr is from the bootstrap/Node loader.
    let bootstrapError = "";
    child.stderr?.on("data", (data: Buffer) => {
      bootstrapError = (bootstrapError + data.toString("utf8")).slice(-1_500);
    });
    try {
      const ready = await new Promise<RunnerSignal>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("RUNNER_READY_TIMEOUT")), 8_000);
        function tidy() {
          clearTimeout(timer);
          child.off("message", onMessage);
          child.off("error", onError);
          child.off("exit", onExit);
        }
        function onMessage(raw: unknown) {
          const m = raw as Partial<RunnerSignal>;
          if (m?.type !== "READY" || m.executionId !== input.executionId ||
              m.generation !== input.generation || m.sequence !== 1) return;
          tidy();
          resolve(m as RunnerSignal);
        }
        function onError(error: Error) { tidy(); reject(error); }
        function onExit(code: number | null) {
          tidy(); reject(new Error(`RUNNER_EXIT_BEFORE_ARM: code=${code}; bootstrap=${bootstrapError}`));
        }
        child.on("message", onMessage);
        child.once("error", onError);
        child.once("exit", onExit);
      });
      if (ready.sequence !== 1 || !child.pid) throw new Error("RUNNER_NOT_READY");
      const runnerCreatedAt = job.assignVerified(child.pid);
      const memberCount = job.activeProcesses();
      if (memberCount !== 1) throw new Error(`JOB_ASSIGNMENT_UNEXPECTED_MEMBERS: ${memberCount}`);
      const identity: RunnerArmedIdentity = {
        executionId: input.executionId,
        generation: input.generation,
        runnerPid: child.pid,
        runnerCreatedAt,
        jobIdentity: job.name,
        memberCount,
        armedAt: new Date().toISOString(),
      };
      // Failure to durably arm aborts execution. GO has not been sent.
      await input.persistArmed(identity);
      const runner = new WindowsCommandRunner(input, child, job, identity);
      runner.send("GO", { command: input.command, cwd: input.cwd, environment: input.environment });
      return runner;
    } catch (error) {
      try { job.terminate(); await awaitZero(job, 5_000); }
      catch { /* Preserve original cause; fail-closed Job handle closing still kills members. */ }
      try { job.close(); } catch {}
      if (!child.killed) child.kill(); // Bootstrap only: no business command could have received GO.
      throw error;
    }
  }

  get runnerPid() { return this.identity.runnerPid; }
  get jobIdentity() { return this.identity.jobIdentity; }
  get activeProcesses(): number { return this.jobClosed ? 0 : this.job.activeProcesses(); }

  sendInput(data: string): void {
    if (!this.settled) this.send("INPUT", { data });
  }

  private send(type: string, extra: Record<string, unknown> = {}) {
    if (!this.child.connected) throw new Error("RUNNER_IPC_DISCONNECTED");
    this.child.send({ type, executionId: this.identity.executionId,
      generation: this.identity.generation, sequence: ++this.sequence, ...extra });
  }

  async cancel(graceMs = 10_000): Promise<JobExitEvidence> {
    if (this.settled) return this.settled;
    try { this.send("STOP"); } catch {}
    // Allow a provider/command to stop normally before escalation.
    await Promise.race([this.finished.catch(() => undefined), delay(graceMs)]);
    if (this.settled) return this.settled;
    return this.settle("cancelled");
  }

  private settle(reason: JobExitEvidence["stopReason"], code?: number, signal?: string): Promise<JobExitEvidence> {
    if (this.settled) return this.settled;
    this.settled = (async () => {
      if (reason === "root_exit") await delay(this.graceMs);
      // Do not treat root exit, IPC close or stdio close as Job-empty proof.
      if (this.job.activeProcesses() !== 0) this.job.terminate();
      await awaitZero(this.job, 5_000);
      const proof: JobExitEvidence = {
        executionId: this.identity.executionId,
        generation: this.identity.generation,
        jobIdentity: this.identity.jobIdentity,
        verifiedAt: new Date().toISOString(),
        activeProcesses: 0,
        runnerPid: this.identity.runnerPid,
        stopReason: reason,
        ...(code === undefined ? {} : { rootExitCode: code }),
        ...(signal === undefined ? {} : { rootSignal: signal }),
      };
      this.job.close();
      this.jobClosed = true;
      return proof;
    })();
    this.settled.then(this.resolveFinished, this.rejectFinished);
    return this.settled;
  }
}
