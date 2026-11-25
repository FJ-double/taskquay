import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * Child bootstrap: the only permitted operation before GO is IPC handshake.
 * The command and its environment arrive only AFTER the owner has assigned
 * this process to its own Windows Job and durably recorded the armed state.
 * Control messages never use stdout or stderr.
 */
type Envelope = {
  executionId: string;
  generation: number;
  sequence: number;
};
type ControlMessage = Envelope & (
  { type: "GO"; executable: string; args: string[]; cwd: string; environment: Record<string, string> } |
  { type: "INPUT"; data: string } |
  { type: "DRAIN"; drainMs: number } |
  { type: "STOP" }
);

const executionId = process.env.TASKQUAY_EXECUTION_ID ?? "";
const generation = Number(process.env.TASKQUAY_EXECUTION_GENERATION);
if (!/^ex_[a-f0-9]{32}$/.test(executionId) || !Number.isSafeInteger(generation) || generation < 1 ||
    !process.send) {
  process.exitCode = 127;
} else {
  let sequence = 0;
  let lastControlSequence = 0;
  let started = false;
  let processRoot: ChildProcessWithoutNullStreams | undefined;
  let rootExited = false;
  let rootClosed = false;
  let drainTimer: NodeJS.Timeout | undefined;

  const send = (type: string, extra: Record<string, unknown> = {}) => {
    process.send?.({ type, executionId, generation, sequence: ++sequence, ...extra });
  };
  const signalError = (error: unknown) => {
    send("RUNNER_ERROR", { message: error instanceof Error ? error.message : String(error) });
  };
  const finishDrain = (timedOut: boolean) => {
    if (!drainTimer) return;
    clearTimeout(drainTimer);
    drainTimer = undefined;
    if (timedOut) {
      processRoot?.stdout.destroy();
      processRoot?.stderr.destroy();
      send("DRAIN_TIMEOUT");
    }
    if (process.connected) process.disconnect?.();
  };

  process.on("disconnect", () => {
    if (!started) process.exit(127);
    // Job KILL_ON_JOB_CLOSE is owned by the parent; do not spawn a new process.
  });
  process.on("message", (payload: unknown) => {
    if (payload === null || typeof payload !== "object") return;
    const m = payload as Partial<ControlMessage>;
    if (m.executionId !== executionId || m.generation !== generation ||
        typeof m.sequence !== "number" || !Number.isSafeInteger(m.sequence) ||
        m.sequence <= lastControlSequence) return;
    lastControlSequence = m.sequence;
    if (m.type === "GO") {
      if (started || typeof m.executable !== "string" || !Array.isArray(m.args) || typeof m.cwd !== "string" ||
          !m.environment || typeof m.environment !== "object") {
        signalError("Invalid or repeated GO");
        return;
      }
      started = true;
      try {
        processRoot = spawn(m.executable, m.args, {
          cwd: m.cwd,
          env: m.environment,
          stdio: "pipe",
          windowsHide: true,
          windowsVerbatimArguments: /(?:^|[\\/])cmd(?:\.exe)?$/i.test(m.executable),
          shell: false,
          detached: false,
        });
        processRoot.stdout.pipe(process.stdout, { end: false });
        processRoot.stderr.pipe(process.stderr, { end: false });
        processRoot.on("spawn", () => send("ROOT_STARTED", { pid: processRoot?.pid }));
        processRoot.once("exit", (code, signal) => {
          rootExited = true;
          send("ROOT_EXIT", { code, signal });
        });
        processRoot.once("close", () => {
          rootClosed = true;
          finishDrain(false);
        });
        processRoot.on("error", signalError);
      } catch (error) {
        signalError(error);
      }
      return;
    }
    if (!started) return;
    if (m.type === "INPUT" && typeof m.data === "string") {
      processRoot?.stdin.write(m.data);
    } else if (m.type === "DRAIN" && rootExited && !drainTimer) {
      const drainMs = typeof m.drainMs === "number" ? Math.max(0, Math.min(m.drainMs, 3_000)) : 3_000;
      drainTimer = setTimeout(() => finishDrain(true), drainMs);
      if (rootClosed) finishDrain(false);
    } else if (m.type === "STOP") {
      processRoot?.kill("SIGTERM");
    }
  });
  send("READY");
}
