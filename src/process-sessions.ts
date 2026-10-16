import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { executionContract, type ExecutionContract, resolveShellCommand, terminateProcessTree } from "./process-platform.js";
import { ExecutionCoordinator, type ExecutionClaim } from "./execution-coordinator.js";
import { WorkLedger } from "./work-ledger.js";
import { randomUUID, randomBytes, createHash, type Hash } from "node:crypto";
import { diagnosticError } from "./server-diagnostics.js";
import { WindowsCommandRunner, type JobExitEvidence } from "./execution-runner.js";
import { ExecutionStateStore, type ExecutionOwnerIdentity } from "./execution-state-store.js";
import { windowsProcessCreatedAt, WindowsJobObject } from "./windows-job-object.js";
import { windowsBootIdentity } from "./windows-boot-identity.js";
import { ManagedOwnerLease } from "./managed-owner-lease.js";

const DEFAULT_EXEC_YIELD_MS = 10_000;
const DEFAULT_INTERACTIVE_YIELD_MS = 250;
const DEFAULT_POLL_YIELD_MS = 5_000;
export const MAX_PROCESS_YIELD_MS = 12_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
const DEFAULT_BUFFER_CHARACTERS = 1_000_000;
const COMPLETED_SESSION_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

export interface StartCommandInput {
  requestKey?: string;
  workspaceId: string;
  command: string;
  cwd: string;
  workspaceRoot?: string;
  tty?: boolean;
  columns?: number;
  rows?: number;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
  resources?: string[];
  workRunId?: string;
}

export interface WriteStdinInput {
  workspaceId: string;
  sessionId: number;
  /** Mandatory for Job-managed sessions. The session ID alone can be reused on restart. */
  executionId?: string;
  chars?: string;
  columns?: number;
  rows?: number;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
}

export interface ProcessSnapshot {
  execution: ExecutionContract;
  phase: "running" | "root_exited_stdio_open" | "closed";
  rootExitedElapsedMs?: number;
  terminalReplay: boolean;
  outputScope: "since_previous_read";
  operationId?: string;
  workRunId?: string;
  sessionId?: number;
  executionId?: string;
  output: string;
  outputTruncated: boolean;
  running: boolean;
  exitCode?: number;
  signal?: string;
  wallTimeMs: number;
}

interface ManagedProcess {
  write(data: string): void;
  kill(signal?: NodeJS.Signals): void;
  resize?(columns: number, rows: number): void;
}

interface ProcessSession {
  execution: ExecutionContract;
  rootExitedAt?: number;
  finishedAt?: number;
  terminalReceipt?: ProcessSnapshot;
  id: number;
  executionId?: string;
  managedJob?: WindowsCommandRunner;
  /** Flushes partial multi-byte sequences held by per-stream decoders. */
  flushOutput?: () => void;
  /** Legacy win32 pipe path: owns the shell's descendants for terminate. */
  pipeJob?: WindowsJobObject;
  managedReleased?: boolean;
  workFinalized?: boolean;
  workspaceId: string;
  process?: ManagedProcess;
  startedAt: number;
  columns: number;
  rows: number;
  buffer: HeadTailBuffer;
  running: boolean;
  exitCode?: number;
  signal?: string;
  exitPromise: Promise<void>;
  resolveExit: () => void;
  cleanupTimer?: NodeJS.Timeout;
  executionClaim?: ExecutionClaim;
  workOperationId?: string;
  workRunId?: string;
  failure?: Record<string, unknown>;
  outputBytes: number;
  outputHash: Hash;
}

interface ProcessSessionManagerOptions {
  diagnostics?: (event: string, fields: Record<string, unknown>, level: "info" | "warn" | "error") => void;
  maxBufferCharacters?: number;
  completedSessionTtlMs?: number;
  maxCompletedSessions?: number;
  stateDir?: string;
  /** Staged rollout only: production remains on legacy path until release gate. */
  managedWindowsCommands?: boolean;
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Duration and output limits must be non-negative.");
  }
  return Math.min(Math.floor(value), maximum);
}

function terminalSize(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > 1_000) {
    throw new Error("Terminal dimensions must be integers between 1 and 1000.");
  }
  return value;
}

function processEnvironment(input?: {
  workspaceId?: string;
  workspaceRoot?: string;
}): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    NO_COLOR: "1",
    TERM: "dumb",
    PAGER: "cat",
    GIT_PAGER: "cat",
    GH_PAGER: "cat",
    CODEX_CI: "1",
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    ...(input?.workspaceId ? { DEVSPACE_WORKSPACE_ID: input.workspaceId } : {}),
    ...(input?.workspaceRoot ? { DEVSPACE_WORKSPACE_ROOT: input.workspaceRoot } : {}),
  };
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function sliceCodePoints(value: string, start: number, end?: number): string {
  return Array.from(value).slice(start, end).join("");
}

function takeHead(value: string, count: number): string {
  if (count <= 0) return "";
  return sliceCodePoints(value, 0, count);
}

function takeTail(value: string, count: number): string {
  if (count <= 0) return "";
  const characters = Array.from(value);
  return characters.slice(Math.max(0, characters.length - count)).join("");
}

function splitBudget(maxCharacters: number): { head: number; tail: number } {
  return {
    head: Math.ceil(maxCharacters / 2),
    tail: Math.floor(maxCharacters / 2),
  };
}

function formatHeadTail(head: string, tail: string, omittedCharacters: number): string {
  if (omittedCharacters <= 0) return head + tail;
  return `${head}\n... output truncated (${omittedCharacters} characters omitted) ...\n${tail}`;
}

export class HeadTailBuffer {
  private head = "";
  private tail = "";
  private totalCharacters = 0;

  constructor(private readonly maxCharacters: number) {
    if (!Number.isInteger(maxCharacters) || maxCharacters < 1) {
      throw new Error("Head/tail buffer limit must be a positive integer.");
    }
  }

  append(output: string): void {
    if (!output) return;

    const previousTotal = this.totalCharacters;
    this.totalCharacters += codePointLength(output);

    if (this.totalCharacters <= this.maxCharacters) {
      this.head += output;
      return;
    }

    const budget = splitBudget(this.maxCharacters);
    if (previousTotal <= this.maxCharacters) {
      const fullOutput = this.head + output;
      this.head = takeHead(fullOutput, budget.head);
      this.tail = takeTail(fullOutput, budget.tail);
      return;
    }

    this.tail = takeTail(this.tail + output, budget.tail);
  }

  hasOutput(): boolean {
    return this.totalCharacters > 0;
  }

  drain(maxCharacters: number): { output: string; truncated: boolean } {
    if (!Number.isInteger(maxCharacters) || maxCharacters < 1) {
      throw new Error("Output limit must be a positive integer.");
    }

    const omittedByBuffer = Math.max(
      0,
      this.totalCharacters - codePointLength(this.head) - codePointLength(this.tail),
    );
    const retained = formatHeadTail(this.head, this.tail, omittedByBuffer);
    const output = truncateOutput(retained, maxCharacters);
    const truncated = omittedByBuffer > 0 || output.truncated;

    this.head = "";
    this.tail = "";
    this.totalCharacters = 0;

    return { output: output.output, truncated };
  }
}

function truncateOutput(output: string, maxCharacters: number): { output: string; truncated: boolean } {
  const outputCharacters = codePointLength(output);
  if (outputCharacters <= maxCharacters) return { output, truncated: false };

  const marker = "\n... output truncated ...\n";
  const markerCharacters = codePointLength(marker);
  const available = Math.max(0, maxCharacters - markerCharacters);
  const budget = splitBudget(available);
  return {
    output: takeHead(output, budget.head) + marker + takeTail(output, budget.tail),
    truncated: true,
  };
}

export class ProcessSessionManager {
  private readonly workStateDir?: string;
  private readonly sessions = new Map<number, ProcessSession>();
  private readonly maxBufferCharacters: number;
  private readonly completedSessionTtlMs: number;
  private nextSessionId = 1;
  readonly executionCoordinator?: ExecutionCoordinator;
  private readonly managedOwner?: ExecutionOwnerIdentity;
  private readonly managedLease?: ManagedOwnerLease;
  private readonly claims = new Set<ExecutionClaim>();
  private shuttingDown = false;

  constructor(private readonly options: ProcessSessionManagerOptions = {}) {
    if (options.maxCompletedSessions !== undefined && (!Number.isInteger(options.maxCompletedSessions) || options.maxCompletedSessions < 1)) throw new Error("Terminal receipt cap must be a positive integer.");
    this.workStateDir = options.stateDir;
    this.maxBufferCharacters = options.maxBufferCharacters ?? DEFAULT_BUFFER_CHARACTERS;
    this.completedSessionTtlMs = options.completedSessionTtlMs ?? COMPLETED_SESSION_TTL_MS;
    if (options.stateDir) {
      this.executionCoordinator = new ExecutionCoordinator(options.stateDir);
      if (process.platform === "win32" && options.managedWindowsCommands === true) {
        const runtimeIdentity = randomUUID();
        this.managedOwner = {
          id: this.executionCoordinator.managedOwnerId,
          kind: "mcp", pid: process.pid,
          processCreatedAt: windowsProcessCreatedAt(process.pid),
          // Not an OS reboot proof. Stage 3 must replace this before
          // automatic post-restart recovery is permitted.
          bootId: windowsBootIdentity(),
          generation: runtimeIdentity,
        };
        this.executionCoordinator.registerManagedOwner(this.managedOwner);
        this.managedLease = new ManagedOwnerLease(
          this.executionCoordinator.sharedDatabaseHandle.sqlite, this.managedOwner);
        this.managedLease.start();
      }
    }
  }

  async mutate<T>(workspaceRoot: string, operation: () => Promise<T>): Promise<T> {
    if (this.shuttingDown) throw new Error("Execution manager is shutting down.");
    const claim = this.executionCoordinator?.acquire({ workspaceRoot, kind: "mutation" });
    if (claim) this.claims.add(claim);
    try { return await operation(); } finally { this.releaseClaim(claim); }
  }

  /** Direct host reads are free of provider work and share a source read claim. */
  async readWorkspace<T>(workspaceRoot: string, operation: () => Promise<T>): Promise<T> {
    if (this.shuttingDown) throw new Error("Execution manager is shutting down.");
    const claim = this.executionCoordinator?.acquire({ workspaceRoot, kind: "read", access: "read" });
    if (claim) this.claims.add(claim);
    try { return await operation(); } finally { this.releaseClaim(claim); }
  }

  private releaseClaim(claim?: ExecutionClaim): void {
    if (claim) { claim.release(); this.claims.delete(claim); }
    if (this.shuttingDown && this.claims.size === 0) this.executionCoordinator?.close();
  }

  async start(input: StartCommandInput): Promise<ProcessSnapshot> {
    if (this.shuttingDown) throw new Error("Execution manager is shutting down.");
    if (this.managedOwner && this.executionCoordinator) {
      this.managedLease?.assertCanAdmit();
      return this.startManaged(input);
    }
    if (input.requestKey) {
      if (!input.workRunId || !this.workStateDir) throw new Error("Command requestKey requires persistent workRunId.");
      const ledger = new WorkLedger(this.workStateDir);
      try {
        ledger.requireScope(input.workRunId, input.workspaceRoot ?? input.cwd, input.workspaceId);
        const prior = ledger.db.prepare("select id from console_operations where run_id=? and request_key=?").get(input.workRunId, `command:${input.requestKey}`) as { id: string } | undefined;
        if (prior) throw new Error(`RECORDED_OPERATION: ${prior.id}; recover through work_task get. Command was not replayed.`);
      } finally { ledger.close(); }
    }
    const yieldTimeMs = boundedInteger(input.yieldTimeMs, DEFAULT_EXEC_YIELD_MS, MAX_PROCESS_YIELD_MS);
    boundedInteger(input.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS, 100_000);
    const session = this.createSession(input);
    session.executionClaim = this.executionCoordinator?.acquire({ workspaceRoot: input.workspaceRoot ?? input.cwd,
      kind: "command", resources: input.resources });
    if (session.executionClaim) this.claims.add(session.executionClaim);
    this.sessions.set(session.id, session);

    try {
      if (input.workRunId && this.workStateDir) {
        const ledger = new WorkLedger(this.workStateDir);
        try {
          ledger.requireScope(input.workRunId, input.workspaceRoot ?? input.cwd, input.workspaceId);
          if (input.requestKey) {
            const prior = ledger.db.prepare("select id from console_operations where run_id=? and request_key=?").get(input.workRunId, `command:${input.requestKey}`) as { id: string } | undefined;
            if (prior) throw new Error(`RECORDED_OPERATION: ${prior.id}; recover through work_task get. Command was not replayed.`);
          }
          session.workOperationId = ledger.operation({ runId: input.workRunId, requestKey: `command:${input.requestKey ?? randomUUID()}`,
            kind: "command", label: "受管命令（不记录原始命令或凭据）", status: "running" });
        } finally { ledger.close(); }
      } else if (input.workRunId) throw new Error("Work accounting is unavailable; command was not started.");
      if (input.tty && process.platform !== "win32") await this.startPty(session, input);
      else this.startPipe(session, input);
    } catch (error) {
      session.failure = diagnosticError(error);
      this.record(session, "process_start_failed", session.failure, "error");
      this.endWorkOperation(session, false);
      this.sessions.delete(session.id);
      this.releaseClaim(session.executionClaim);
      throw error;
    }

    await this.waitForExit(session, yieldTimeMs);

    const snapshot = this.consume(session, input.maxOutputTokens);
    return snapshot;
  }

  /** Win32 managed command path. No user command starts until SQLite has
   * atomically admitted its claim, work receipt and execution identity, and
   * a suspended-by-protocol Runner has durably persisted Job membership.
   */
  private async startManaged(input: StartCommandInput): Promise<ProcessSnapshot> {
    const owner = this.managedOwner!;
    const coordinator = this.executionCoordinator!;
    if (input.requestKey && (!input.workRunId || !this.workStateDir)) {
      throw new Error("Command requestKey requires persistent workRunId.");
    }
    const yieldTimeMs = boundedInteger(input.yieldTimeMs, DEFAULT_EXEC_YIELD_MS, MAX_PROCESS_YIELD_MS);
    boundedInteger(input.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS, 100_000);
    const session = this.createSession(input);
    const semanticHash = createHash("sha256").update(JSON.stringify({
      workspaceId: input.workspaceId, command: input.command, cwd: input.cwd,
      workspaceRoot: input.workspaceRoot ?? input.cwd,
      tty: Boolean(input.tty), resources: [...new Set(input.resources ?? [])].sort(),
      workRunId: input.workRunId ?? null,
    })).digest("hex");

    // Network reconnect/retry must report the prior durable command identity
    // BEFORE attempting admission. Otherwise a still-running first attempt
    // looks like a generic occupied-checkout error, inviting the host to
    // retry a potentially non-idempotent command under a new request key.
    // This preflight is advisory; the transactional check below remains the
    // definitive defense when two clients race on the same requestKey.
    if (input.requestKey && input.workRunId && this.workStateDir) {
      const ledger = new WorkLedger(this.workStateDir, coordinator.sharedDatabaseHandle);
      ledger.requireScope(input.workRunId, input.workspaceRoot ?? input.cwd, input.workspaceId);
      const prior = ledger.db.prepare(`select id,request_hash,command_operation_id
        from managed_executions where idempotency_scope=? and request_key=?`)
        .get(`command:${input.workRunId}`, input.requestKey) as
        { id: string; request_hash: string; command_operation_id: string | null } | undefined;
      if (prior) {
        if (prior.request_hash !== semanticHash) {
          throw new Error("IDEMPOTENCY_CONFLICT: requestKey belongs to different command inputs; no command replayed.");
        }
        if (prior.command_operation_id) {
          throw new Error(`RECORDED_OPERATION: ${prior.command_operation_id}; recover through work_task get. Command was not replayed.`);
        }
        throw new Error(`RECORDED_EXECUTION: ${prior.id}; original command outcome requires reconciliation. Command was not replayed.`);
      }
      const oldOperation = ledger.db.prepare(`select id from console_operations
        where run_id=? and request_key=?`)
        .get(input.workRunId, `command:${input.requestKey}`) as {id:string} | undefined;
      if (oldOperation) {
        throw new Error(`RECORDED_OPERATION: ${oldOperation.id}; recover through work_task get. Command was not replayed.`);
      }
    }

    // The SQLite callback MUST stay synchronous. Admission rolls everything
    // back, including the claim, if the work run is closed or a request is
    // duplicated. Node/Windows process creation happens after commit.
    const admitted = coordinator.admitManaged({
      workspaceRoot: input.workspaceRoot ?? input.cwd,
      kind: "command", resources: input.resources,
    }, (sqlite, borrowedDatabase) => {
      const store = new ExecutionStateStore(sqlite);
      const ledger = input.workRunId && this.workStateDir
        ? new WorkLedger(this.workStateDir, borrowedDatabase) : undefined;
      if (input.workRunId && !ledger) throw new Error("Work accounting is unavailable; command was not started.");
      if (ledger && input.workRunId) {
        ledger.requireScope(input.workRunId, input.workspaceRoot ?? input.cwd, input.workspaceId);
        if (input.requestKey) {
          const prior = sqlite.prepare("select id from console_operations where run_id=? and request_key=?")
            .get(input.workRunId, `command:${input.requestKey}`) as { id: string } | undefined;
          if (prior) throw new Error(`RECORDED_OPERATION: ${prior.id}; recover through work_task get. Command was not replayed.`);
        }
      }
      const result = store.create({
        kind: "command", workspaceId: input.workspaceId,
        checkoutRoot: input.workspaceRoot ?? input.cwd,
        workRunId: input.workRunId, owner, access: "write",
        resources: [...(input.resources ?? [])],
        idempotencyScope: input.workRunId
          ? `command:${input.workRunId}` : `command:ephemeral:${owner.id}`,
        requestKey: input.requestKey,
        requestHash: semanticHash, initialPhase: "starting",
      }, () => {
        if (ledger && input.workRunId) {
          session.workOperationId = ledger.operation({
            runId: input.workRunId, requestKey: `command:${input.requestKey ?? randomUUID()}`,
            kind: "command", label: "受管命令（不记录原始命令或凭据）", status: "running",
          });
        }
      });
      if (!result.created) {
        throw new Error(`RECORDED_EXECUTION: ${result.execution.id}; previous command was not replayed.`);
      }
      // The command ledger operation is created by onCreate, inside the same
      // outer admission transaction. Persist its exact identity before GO:
      // without this link a crash recovery can free the native Job claim but
      // leave console_operations running forever (work_task cannot finish).
      // Never guess an operation from timestamps, command text or PID.
      if (input.workRunId) {
        if (!session.workOperationId) throw new Error("MANAGED_COMMAND_LEDGER_LINK_MISSING");
        const linked = sqlite.prepare(`update managed_executions
          set command_operation_id=?
          where id=? and kind='command' and work_run_id=? and command_operation_id is null`)
          .run(session.workOperationId, result.execution.id, input.workRunId);
        if (linked.changes !== 1) throw new Error("MANAGED_COMMAND_LEDGER_LINK_CONFLICT");
      }
      return { executionId: result.execution.id, value: result.execution.id };
    });
    session.executionClaim = admitted.claim;
    session.executionId = admitted.value;
    session.workRunId = input.workRunId;
    this.claims.add(admitted.claim);
    this.sessions.set(session.id, session);
    // One decoder per stream: a multi-byte UTF-8 sequence may be split across
    // pipe chunks. Flushed by flushManagedOutput() before the session ends.
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    session.flushOutput = () => {
      this.append(session, stdoutDecoder.end());
      this.append(session, stderrDecoder.end());
    };
    try {
      const runner = await WindowsCommandRunner.start({
        executionId: session.executionId, generation: 1,
        command: input.command, cwd: input.cwd,
        environment: processEnvironment({ workspaceId: input.workspaceId, workspaceRoot: input.workspaceRoot }),
        persistArmed: (proof) => coordinator.withManagedState((sqlite) => {
          const store = new ExecutionStateStore(sqlite);
          const armed = store.arm({
            executionId: proof.executionId, expectedVersion: 0, expectedGeneration: proof.generation,
            pid: proof.runnerPid, createdAt: proof.runnerCreatedAt,
            bootId: owner.bootId, jobIdentity: proof.jobIdentity,
            evidence: JSON.stringify({ kind: "os_job_membership", count: proof.memberCount,
              jobIdentity: proof.jobIdentity, createdAt: proof.runnerCreatedAt }),
          });
          store.transition({
            executionId: proof.executionId, expectedVersion: armed.state_version,
            expectedGeneration: proof.generation, phase: "running",
          });
        }),
        onStdout: (data) => this.append(session, stdoutDecoder.write(data)),
        onStderr: (data) => this.append(session, stderrDecoder.write(data)),
      });
      session.managedJob = runner;
      session.process = {
        write: (data) => runner.sendInput(data),
        kill: () => { void runner.cancel(0).catch((error) =>
          this.record(session, "managed_cancel_failed", diagnosticError(error), "error")); },
      };
      this.record(session, "process_started", { childPid: runner.runnerPid, executionId: session.executionId });
      void runner.finished.then((proof) => this.completeManagedSession(session, proof),
        (error: unknown) => this.failManagedSession(session, error));
    } catch (error) {
      this.record(session, "managed_start_failed", diagnosticError(error), "error");
      // Even if no GO was intended, keep the claim quarantined when Job
      // identity/cleanup is unproven. Stage 3 recovery must inspect it.
      try {
        coordinator.withManagedState((sqlite) => {
          const store = new ExecutionStateStore(sqlite);
          const row = store.get(session.executionId!);
          if (row && row.phase !== "terminal") store.transition({
            executionId: row.id, expectedVersion: row.state_version,
            expectedGeneration: row.generation, phase: "terminal", outcome: "unknown",
            resourceState: "quarantined", recoveryReason: "managed_runner_start_failed",
          });
        });
      } catch (stateError) {
        this.record(session, "managed_quarantine_failed", diagnosticError(stateError), "error");
      }
      this.sessions.delete(session.id);
      throw error;
    }
    await this.waitForExit(session, yieldTimeMs);
    return this.consume(session, input.maxOutputTokens);
  }

  private completeManagedSession(session: ProcessSession, proof: JobExitEvidence): void {
    if (!session.executionId || !this.executionCoordinator || !session.managedJob || !session.running) return;
    try {
      const successful = proof.stopReason === "root_exit" && proof.rootExitCode === 0;
      const outcome = proof.stopReason === "cancelled" ? "cancelled"
        : successful ? "completed" : "failed";
      const status = successful ? "completed" : "failed";
      this.executionCoordinator.completeManaged(session.executionId, (sqlite, borrowedDatabase) => {
        const store = new ExecutionStateStore(sqlite);
        let row = store.get(session.executionId!);
        if (!row || row.job_identity !== proof.jobIdentity ||
          row.runner_pid !== proof.runnerPid || row.generation !== proof.generation ||
          row.phase !== "running" || proof.activeProcesses !== 0) {
          throw new Error("MANAGED_RELEASE_IDENTITY_MISMATCH: Job identity or empty proof is invalid.");
        }
        row = store.transition({
          executionId: row.id, expectedVersion: row.state_version,
          expectedGeneration: row.generation, phase: "terminal",
          outcome, resourceState: "cleanup_pending",
        });
        row = store.transition({
          executionId: row.id, expectedVersion: row.state_version,
          expectedGeneration: row.generation, resourceState: "released",
          exitEvidence: { kind: "job_empty_verified", verifiedAt: proof.verifiedAt,
            verifier: "WindowsCommandRunner", detail: JSON.stringify(proof) },
        });
        if (session.workOperationId && this.workStateDir) {
          const ledger = new WorkLedger(this.workStateDir, borrowedDatabase);
          ledger.endOperation(session.workOperationId, status, [{
            label: "Windows Job tree verified empty before command resource release",
            reference: JSON.stringify({ executionId: row.id, jobIdentity: proof.jobIdentity,
              runnerPid: proof.runnerPid, exitCode: proof.rootExitCode ?? null,
              stopReason: proof.stopReason, verifiedAt: proof.verifiedAt }),
            outcome: successful ? "passed" : "failed",
          }]);
        }
      });
      session.managedReleased = true;
      session.workFinalized = true;
      this.finish(session, proof.rootExitCode, proof.rootSignal);
    } catch (error) {
      this.failManagedSession(session, error);
    }
  }

  private failManagedSession(session: ProcessSession, error: unknown): void {
    if (!session.running) return;
    session.failure = diagnosticError(error);
    this.record(session, "managed_cleanup_unverified", session.failure, "error");
    this.append(session, "Windows Job cleanup or database receipt is unverified; claim retained for recovery.\n");
    // Do not mark the work ledger completed or release the claim.
    session.workFinalized = true;
    this.finish(session, undefined, "SIGTERM");
  }

  async write(input: WriteStdinInput): Promise<ProcessSnapshot> {
    const session = this.getOwnedSession(input.workspaceId, input.sessionId);
    if (session.executionId && input.executionId !== session.executionId) {
      throw new Error("EXECUTION_ID_MISMATCH: provide the execution_id returned by exec_command; session_id alone is not sufficient.");
    }
    const chars = input.chars ?? "";
    const interactionRequested =
      chars.length > 0 || input.columns !== undefined || input.rows !== undefined;
    if (!session.running && interactionRequested) throw new Error("Process is terminal; only empty polls can replay its receipt.");

    if (input.columns !== undefined || input.rows !== undefined) {
      session.columns = terminalSize(input.columns, session.columns);
      session.rows = terminalSize(input.rows, session.rows);
      if (!session.process?.resize) {
        throw new Error(`Process session ${session.id} is not a PTY and cannot be resized.`);
      }
      session.process.resize(session.columns, session.rows);
    }

    const interruptRequested = chars.includes("\u0003") && session.running;
    if (interruptRequested) {
      session.process?.kill("SIGINT");
    }
    const writableChars = chars.replaceAll("\u0003", "");
    if (writableChars && session.running) session.process?.write(writableChars);

    if ((interactionRequested || !session.buffer.hasOutput()) && session.running) {
      const fallback = interactionRequested ? DEFAULT_INTERACTIVE_YIELD_MS : DEFAULT_POLL_YIELD_MS;
      const yieldTimeMs = boundedInteger(input.yieldTimeMs, fallback, MAX_PROCESS_YIELD_MS);
      await this.waitForExit(session, yieldTimeMs);
    }

    const snapshot = this.consume(session, input.maxOutputTokens);
    return snapshot;
  }

  terminate(workspaceId: string, sessionId: number): void {
    const session = this.getOwnedSession(workspaceId, sessionId);
    if (session.running) session.process?.kill("SIGTERM");
  }

  shutdown(): void {
    this.shuttingDown = true;
    this.managedLease?.stop();
    for (const session of this.sessions.values()) {
      if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
      if (session.running) session.process?.kill("SIGTERM");
    }
    this.sessions.clear();
    if (this.claims.size === 0) this.executionCoordinator?.close();
  }

  private async waitForExit(session: ProcessSession, yieldTimeMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        session.exitPromise,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, yieldTimeMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private createSession(input: StartCommandInput): ProcessSession {
    let resolveExit = (): void => undefined;
    const exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });

    return {
      execution: executionContract(input.tty),
      // Managed sessions use unpredictable safe integers so stale IDs after a
      // daemon restart cannot readily target an unrelated live command.
      id: this.managedOwner ? randomBytes(6).readUIntBE(0, 6) : this.nextSessionId++,
      workspaceId: input.workspaceId,
      workRunId: input.workRunId,
      outputBytes: 0,
      outputHash: createHash("sha256"),
      startedAt: Date.now(),
      columns: terminalSize(input.columns, DEFAULT_COLUMNS),
      rows: terminalSize(input.rows, DEFAULT_ROWS),
      buffer: new HeadTailBuffer(this.maxBufferCharacters),
      running: true,
      exitPromise,
      resolveExit,
    };
  }

  private startPipe(session: ProcessSession, input: StartCommandInput): void {
    const shell = resolveShellCommand(input.command);
    const detached = process.platform !== "win32";
    const child = spawn(input.command, {
      cwd: input.cwd,
      env: processEnvironment({
        workspaceId: input.workspaceId,
        workspaceRoot: input.workspaceRoot,
      }),
      stdio: "pipe",
      windowsHide: true,
      detached,
      shell: shell.executable,
    });
    if (process.platform === "win32" && child.pid) session.pipeJob = this.attachPipeJob(session, child.pid);

    session.process = {
      write: (data) => child.stdin.write(data),
      kill: (signal = "SIGTERM") => this.killPipe(session, child, signal, detached),
    };
    child.once("spawn", () => this.record(session, "process_started", { childPid: child.pid }));
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data: string) => this.append(session, data));
    child.stderr.on("data", (data: string) => this.append(session, data));
    child.on("error", (error) => {
      session.failure = diagnosticError(error);
      this.record(session, "process_error", session.failure, "error");
      this.append(session, `${error.message}\n`);
    });
    child.on("close", (code, signal) => {
      // Deliberate: once all stdio is closed the session is terminal and its
      // claim is released, so the Job handle is closed here. KILL_ON_JOB_CLOSE
      // then ends any member that detached from our pipes (e.g. a GUI or
      // `start` target); the managed path is stricter and kills on root exit.
      this.closePipeJob(session);
      this.finish(session, code ?? undefined, signal ?? undefined);
    });
    child.once("exit", () => { session.rootExitedAt = Date.now(); });
  }

  /** Assigned right after spawn returns. A descendant the shell creates
   * before assignment escapes the Job; that small race is accepted. */
  private attachPipeJob(session: ProcessSession, pid: number): WindowsJobObject | undefined {
    let job: WindowsJobObject | undefined;
    try {
      job = new WindowsJobObject();
      job.assignVerified(pid);
      return job;
    } catch (error) {
      // Fail closed if assignment succeeded but verification did not.
      try { job?.close(); } catch {}
      this.record(session, "process_job_unavailable", { childPid: pid, ...diagnosticError(error) }, "warn");
      return undefined;
    }
  }

  private closePipeJob(session: ProcessSession): void {
    const job = session.pipeJob;
    if (!job) return;
    session.pipeJob = undefined;
    try {
      const remaining = job.activeProcesses();
      if (remaining > 0) this.record(session, "process_job_closed_with_members", { remaining }, "warn");
    } catch {}
    try { job.close(); }
    catch (error) { this.record(session, "process_job_close_failed", diagnosticError(error), "error"); }
  }

  private killPipe(
    session: ProcessSession,
    child: Parameters<typeof terminateProcessTree>[0],
    signal: NodeJS.Signals,
    detached: boolean,
  ): void {
    if (session.pipeJob) {
      // Kills the whole Job, including descendants started after assignment
      // and those orphaned after the root shell exited.
      try { session.pipeJob.terminate(1); return; }
      catch (error) { this.record(session, "process_job_terminate_failed", diagnosticError(error), "error"); }
    }
    if (process.platform === "win32" && session.rootExitedAt !== undefined) {
      // The root PID may already be reused; never taskkill it. Without a Job,
      // orphaned descendants cannot be located safely.
      this.record(session, "process_terminate_skipped", {
        reason: "root_exited_without_job", rootExitedElapsedMs: Date.now() - session.rootExitedAt,
      }, "warn");
      return;
    }
    terminateProcessTree(child, signal, detached);
  }

  private async startPty(session: ProcessSession, input: StartCommandInput): Promise<void> {
    let nodePty: typeof import("node-pty");
    try {
      nodePty = await import("node-pty");
    } catch {
      throw new Error("PTY support requires the optional node-pty dependency.");
    }

    const shell = resolveShellCommand(input.command);
    let pty: import("node-pty").IPty;
    try {
      pty = nodePty.spawn(shell.executable, shell.args, {
        cwd: input.cwd,
        env: processEnvironment({
          workspaceId: input.workspaceId,
          workspaceRoot: input.workspaceRoot,
        }),
        name: "xterm-256color",
        cols: session.columns,
        rows: session.rows,
      });
    } catch (error) {
      throw error;
    }

    session.process = {
      write: (data) => pty.write(data),
      kill: (signal) => pty.kill(signal),
      resize: (columns, rows) => pty.resize(columns, rows),
    };
    this.record(session, "process_started", { childPid: pty.pid });
    pty.onData((data) => this.append(session, data));
    pty.onExit(({ exitCode, signal }) => {
      this.finish(session, exitCode, signal === 0 ? undefined : String(signal));
    });
  }

  private finish(session: ProcessSession, exitCode?: number, signal?: string): void {
    if (!session.running) return;
    // Managed runner exposes no stdio-end hook; its Job-empty proof is the
    // last point before the receipt, so emit any trailing partial sequence.
    session.flushOutput?.();
    session.running = false;
    session.finishedAt = Date.now();
    session.exitCode = exitCode;
    session.signal = signal;
    const success = exitCode === 0 && !signal && !session.failure;
    this.record(session, "process_finished", { exitCode, signal, outputBytes: session.outputBytes, ...session.failure }, success ? "info" : "warn");
    if (!session.workFinalized) this.endWorkOperation(session, success);
    if (session.executionId) {
      // The SQLite proof-gated transaction already deleted a verified claim.
      // On failed cleanup, preserve the active claim for Stage 3 recovery.
      if (session.managedReleased && session.executionClaim) {
        this.claims.delete(session.executionClaim);
        if (this.shuttingDown && this.claims.size === 0) this.executionCoordinator?.close();
      }
    } else {
      this.releaseClaim(session.executionClaim);
    }
    session.resolveExit();
    session.cleanupTimer = setTimeout(
      () => this.sessions.delete(session.id),
      this.completedSessionTtlMs,
    );
    session.cleanupTimer.unref();
    const completed = [...this.sessions.values()].filter((item) => !item.running)
      .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
    while (completed.length > (this.options.maxCompletedSessions ?? 64)) this.removeSession(completed.shift()!.id);
  }

  private endWorkOperation(session: ProcessSession, success: boolean): void {
    if (!session.workOperationId || !this.workStateDir) return;
    let ledger: WorkLedger | undefined;
    try {
      ledger = new WorkLedger(this.workStateDir);
      ledger.endOperation(session.workOperationId, success ? "completed" : "failed", [{
        label: success ? "Managed process exited successfully (not deployment acceptance)" : "Managed process failed; inspect state before retrying",
        reference: JSON.stringify({ version: 1, boundary: "process", sessionId: session.id, pid: process.pid,
          exitCode: session.exitCode ?? null, signal: session.signal ?? null, elapsedMs: Date.now() - session.startedAt,
          outputBytes: session.outputBytes, outputSha256: session.outputHash.copy().digest("hex"),
          logReference: { event: "process_finished", operationId: session.workOperationId, sessionId: session.id, pid: process.pid },
          outputRecovery: "metadata_only", hostAcknowledgment: "unknown", ...session.failure, retry: "reconcile_before_replay" }),
        outcome: success ? "passed" : "failed",
      }]);
    } catch (error) {
      this.record(session, "process_accounting_failed", diagnosticError(error), "error");
      this.append(session, "Work accounting could not be finalized; reconcile the work run before marking it complete.\n");
    } finally {
      try { ledger?.close(); }
      catch (error) { this.record(session, "process_accounting_failed", diagnosticError(error), "error"); }
    }
  }

  private record(session: ProcessSession, event: string, fields: Record<string, unknown> = {}, level: "info" | "warn" | "error" = "info"): void {
    try {
      this.options.diagnostics?.(event, { workspaceId: session.workspaceId, workRunId: session.workRunId,
        operationId: session.workOperationId, sessionId: session.id, elapsedMs: Date.now() - session.startedAt, ...fields }, level);
    } catch {}
  }

  private append(session: ProcessSession, output: string): void {
    session.outputBytes += Buffer.byteLength(output);
    session.outputHash.update(output);
    session.buffer.append(output);
  }

  private consume(session: ProcessSession, maxOutputTokens?: number): ProcessSnapshot {
    if (session.terminalReceipt) return { ...session.terminalReceipt, execution: { ...session.execution }, terminalReplay: true };
    const limit = boundedInteger(maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS, 100_000);
    const maxCharacters = Math.max(256, limit * 4);
    const buffered = session.buffer.drain(maxCharacters);
    this.record(session, "process_output_consumed", { running: session.running,
      returnedOutputBytes: Buffer.byteLength(buffered.output), outputTruncated: buffered.truncated });

    const snapshot: ProcessSnapshot = {
      execution: { ...session.execution },
      phase: !session.running ? "closed" : session.rootExitedAt === undefined ? "running" : "root_exited_stdio_open",
      rootExitedElapsedMs: session.running && session.rootExitedAt !== undefined ? Date.now() - session.rootExitedAt : undefined,
      terminalReplay: false,
      outputScope: "since_previous_read",
      operationId: session.workOperationId,
      workRunId: session.workRunId,
      sessionId: session.id,
      executionId: session.executionId,
      output: buffered.output,
      outputTruncated: buffered.truncated,
      running: session.running,
      exitCode: session.exitCode,
      signal: session.signal,
      wallTimeMs: (session.finishedAt ?? Date.now()) - session.startedAt,
    };
    if (!session.running) session.terminalReceipt = { ...snapshot, execution: { ...snapshot.execution } };
    return snapshot;
  }

  private getOwnedSession(workspaceId: string, sessionId: number): ProcessSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown process session: ${sessionId}`);
    if (session.workspaceId !== workspaceId) {
      throw new Error(`Process session ${sessionId} does not belong to workspace ${workspaceId}.`);
    }
    return session;
  }

  private removeSession(sessionId: number): void {
    const session = this.sessions.get(sessionId);
    if (session?.cleanupTimer) clearTimeout(session.cleanupTimer);
    this.sessions.delete(sessionId);
  }
}
