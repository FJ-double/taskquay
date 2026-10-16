import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export type ExecutionPhase = "queued" | "starting" | "running" | "stopping" | "terminal";
export type ExecutionOutcome = "pending" | "completed" | "failed" | "cancelled" | "interrupted" | "unknown";
export type ExecutionResourceState = "unclaimed" | "held" | "cleanup_pending" | "released" | "quarantined";

type ExecutionKind = "agent" | "command" | "service";
type ExecutionAccess = "read" | "write" | "watch" | "exclusive";

export interface ExecutionOwnerIdentity {
  id: string;
  kind: "mcp" | "agentd";
  pid: number;
  processCreatedAt: string;
  bootId: string;
  generation: string;
}

export interface ExecutionStateRow {
  id: string;
  kind: ExecutionKind;
  owner_id: string;
  owner_generation: string;
  generation: number;
  phase: ExecutionPhase;
  outcome: ExecutionOutcome;
  resource_state: ExecutionResourceState;
  state_version: number;
  request_hash: string;
  request_key: string | null;
  idempotency_scope: string;
  runner_pid: number | null;
  job_identity: string | null;
  armed_evidence: string | null;
  exit_evidence: string | null;
  [column: string]: unknown;
}

export interface CreateExecutionInput {
  kind: ExecutionKind;
  workspaceId: string;
  checkoutRoot: string;
  workRunId?: string;
  agentExecutionId?: string;
  commandOperationId?: string;
  owner: ExecutionOwnerIdentity;
  access: ExecutionAccess;
  resources: string[];
  idempotencyScope: string;
  requestKey?: string;
  /** SHA-256 of canonical semantic arguments, excluding wait/output budgets. */
  requestHash: string;
  initialPhase: "queued" | "starting";
}

export interface StateUpdate {
  executionId: string;
  expectedVersion: number;
  expectedGeneration: number;
  phase?: ExecutionPhase;
  outcome?: ExecutionOutcome;
  resourceState?: ExecutionResourceState;
  stopReason?: string;
  recoveryReason?: string;
  cancellationRequestedAt?: string;
  /** OS verification must occur OUTSIDE SQLite transaction (phase 3). */
  exitEvidence?: {
    kind: "job_empty_verified" | "never_dispatched_verified" | "prior_boot_verified";
    verifiedAt: string;
    verifier: string;
    detail: string;
  };
}

const phases: Record<ExecutionPhase, readonly ExecutionPhase[]> = {
  queued: ["starting", "terminal"],
  starting: ["running", "stopping", "terminal"],
  running: ["stopping", "terminal"],
  stopping: ["terminal"],
  terminal: ["terminal"],
};

function required(value: string, label: string): string {
  if (!value.trim()) throw new Error(`${label} must not be blank.`);
  return value;
}

/** Single-connection state primitives; the caller retains database ownership.
 *
 * Existing execution_claims and execution_waiters remain legacy until a later
 * phase integrates the Job runner. Never infer that a legacy PID has exited.
 * Use withWorkUnit to modify work ledger, claim/waiter and execution in ONE
 * SQLite transaction. Do not open a second Store in that callback.
 */
export class ExecutionStateStore {
  constructor(readonly sqlite: Database.Database) {}

  withWorkUnit<T>(action: (sqlite: Database.Database) => T): T {
    return this.sqlite.transaction(() => {
      const result = action(this.sqlite);
      if (result && typeof (result as { then?: unknown }).then === "function") {
        throw new Error("A database work unit must be synchronous; run OS and Provider operations after commit.");
      }
      return result;
    }).immediate();
  }

  registerOwner(owner: ExecutionOwnerIdentity): void {
    required(owner.id, "owner id");
    required(owner.processCreatedAt, "owner process creation time");
    required(owner.bootId, "boot identity");
    required(owner.generation, "owner generation");
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error("Owner PID must be positive.");
    this.withWorkUnit((sqlite) => {
      const prior = sqlite.prepare("select * from execution_owners where id=?").get(owner.id) as
        (Record<string, unknown> | undefined);
      if (prior) {
        if (prior.kind !== owner.kind || prior.pid !== owner.pid ||
            prior.process_created_at !== owner.processCreatedAt ||
            prior.boot_id !== owner.bootId || prior.generation !== owner.generation) {
          throw new Error("Owner ID reused with different process identity.");
        }
        return;
      }
      sqlite.prepare(`insert into execution_owners
        (id,kind,pid,process_created_at,boot_id,generation,heartbeat_at_ms,status,registered_at)
        values (?,?,?,?,?,?,?,'active',?)`)
        .run(owner.id, owner.kind, owner.pid, owner.processCreatedAt, owner.bootId,
          owner.generation, Date.now(), new Date().toISOString());
    });
  }

  heartbeat(owner: ExecutionOwnerIdentity): boolean {
    return this.sqlite.prepare(`update execution_owners set heartbeat_at_ms=?,status='active'
      where id=? and pid=? and process_created_at=? and boot_id=? and generation=? and status!='dead'`)
      .run(Date.now(), owner.id, owner.pid, owner.processCreatedAt, owner.bootId, owner.generation).changes === 1;
  }

  get(executionId: string): ExecutionStateRow | undefined {
    return this.sqlite.prepare("select * from managed_executions where id=?").get(executionId) as ExecutionStateRow | undefined;
  }

  /** onCreate can write the associated ledger operation AND the claim/waiter.
   * A duplicate request never invokes onCreate and never starts a new worker.
   */
  create(
    input: CreateExecutionInput,
    onCreate?: (sqlite: Database.Database, executionId: string) => void,
  ): { created: boolean; execution: ExecutionStateRow } {
    required(input.workspaceId, "workspace id");
    required(input.checkoutRoot, "checkout root");
    required(input.idempotencyScope, "idempotency scope");
    if (!/^[a-f0-9]{64}$/i.test(input.requestHash)) throw new Error("Expected SHA-256 semantic request hash.");
    if (input.requestKey !== undefined) required(input.requestKey, "request key");
    if (input.resources.length > 16 || input.resources.some((resource) => !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(resource))) {
      throw new Error("Invalid execution resource keys.");
    }
    return this.withWorkUnit((sqlite) => {
      if (input.requestKey !== undefined) {
        const previous = sqlite.prepare(`select * from managed_executions
          where idempotency_scope=? and request_key=?`)
          .get(input.idempotencyScope, input.requestKey) as ExecutionStateRow | undefined;
        if (previous) {
          if (previous.request_hash !== input.requestHash) throw new Error("IDEMPOTENCY_CONFLICT: request parameters differ.");
          return { created: false, execution: previous };
        }
      }
      const owner = sqlite.prepare("select * from execution_owners where id=?").get(input.owner.id) as
        ({ status: string; pid: number; process_created_at: string; boot_id: string; generation: string } | undefined);
      if (!owner || owner.status !== "active" || owner.pid !== input.owner.pid ||
          owner.process_created_at !== input.owner.processCreatedAt ||
          owner.boot_id !== input.owner.bootId || owner.generation !== input.owner.generation) {
        throw new Error("Execution owner has no matching active process identity.");
      }
      const executionId = `ex_${randomUUID().replaceAll("-", "")}`;
      const now = new Date().toISOString();
      sqlite.prepare(`insert into managed_executions
        (id,kind,workspace_id,checkout_root,work_run_id,agent_execution_id,command_operation_id,
         owner_id,owner_generation,access_mode,resources,phase,outcome,resource_state,
         idempotency_scope,request_key,request_hash,created_at,updated_at)
        values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(executionId, input.kind, input.workspaceId, input.checkoutRoot,
          input.workRunId ?? null, input.agentExecutionId ?? null, input.commandOperationId ?? null,
          input.owner.id, input.owner.generation, input.access,
          JSON.stringify([...new Set(input.resources)].sort()), input.initialPhase,
          "pending", input.initialPhase === "queued" ? "unclaimed" : "held",
          input.idempotencyScope, input.requestKey ?? null, input.requestHash, now, now);
      onCreate?.(sqlite, executionId);
      this.audit(sqlite, executionId, 1, "registered", null,
        { phase: input.initialPhase, resourceState: input.initialPhase === "queued" ? "unclaimed" : "held" });
      return { created: true, execution: this.get(executionId)! };
    });
  }

  /** CAS on both generation and state version; stale callbacks cannot revive terminal work. */
  transition(input: StateUpdate): ExecutionStateRow {
    return this.withWorkUnit((sqlite) => {
      const before = this.get(input.executionId);
      if (!before || before.generation !== input.expectedGeneration || before.state_version !== input.expectedVersion) {
        throw new Error("EXECUTION_VERSION_CONFLICT: observe execution again before updating.");
      }
      const phase = input.phase ?? before.phase;
      const outcome = input.outcome ?? before.outcome;
      const resource = input.resourceState ?? before.resource_state;
      if (!phases[before.phase].includes(phase)) throw new Error("Invalid execution phase transition.");
      if (before.phase === "terminal" && phase !== "terminal") throw new Error("Terminal execution cannot restart.");
      if (before.outcome !== "pending" && outcome !== before.outcome) throw new Error("Persisted outcome is immutable.");
      if ((phase === "terminal") !== (outcome !== "pending")) {
        throw new Error("Terminal phase must have an outcome; nonterminal phase must be pending.");
      }
      if (resource === "released" && before.resource_state !== "released" && !input.exitEvidence) {
        throw new Error("RESOURCE_PROOF_REQUIRED: release needs verified exit evidence.");
      }
      if (input.exitEvidence && (!input.exitEvidence.verifiedAt.trim() ||
          !input.exitEvidence.verifier.trim() || !input.exitEvidence.detail.trim())) {
        throw new Error("Exit evidence must identify the verifier, time and observation.");
      }
      if (before.resource_state === "released" && resource !== "released") {
        throw new Error("Released resources cannot be reclaimed by a stale execution.");
      }
      const now = new Date().toISOString();
      const nextEvidence = input.exitEvidence ? JSON.stringify(input.exitEvidence) : before.exit_evidence;
      const updated = sqlite.prepare(`update managed_executions
        set phase=?,outcome=?,resource_state=?,stop_reason=coalesce(?,stop_reason),
        recovery_reason=coalesce(?,recovery_reason),
        cancellation_requested_at=coalesce(?,cancellation_requested_at),
        exit_evidence=?,state_version=state_version+1,updated_at=?
        where id=? and generation=? and state_version=?`)
        .run(phase, outcome, resource, input.stopReason ?? null, input.recoveryReason ?? null,
          input.cancellationRequestedAt ?? null, nextEvidence, now,
          input.executionId, input.expectedGeneration, input.expectedVersion);
      if (updated.changes !== 1) throw new Error("EXECUTION_VERSION_CONFLICT.");
      this.audit(sqlite, input.executionId, before.generation, "transition",
        { phase: before.phase, outcome: before.outcome, resource: before.resource_state, version: before.state_version },
        { phase, outcome, resource, version: before.state_version + 1, exitEvidence: input.exitEvidence ?? null });
      return this.get(input.executionId)!;
    });
  }

  /** Persist proof of membership BEFORE signalling GO to a paused Runner. */
  arm(input: {
    executionId: string; expectedVersion: number; expectedGeneration: number;
    pid: number; createdAt: string; bootId: string; jobIdentity: string; evidence: string;
  }): ExecutionStateRow {
    if (!Number.isSafeInteger(input.pid) || input.pid <= 0 ||
        !input.createdAt.trim() || !input.bootId.trim() ||
        !input.jobIdentity.trim() || !input.evidence.trim()) throw new Error("Incomplete Job arming identity.");
    return this.withWorkUnit((sqlite) => {
      const row = this.get(input.executionId);
      if (!row || row.state_version !== input.expectedVersion ||
          row.generation !== input.expectedGeneration || row.phase !== "starting" || row.armed_evidence) {
        throw new Error("EXECUTION_VERSION_CONFLICT: cannot arm a stale or non-starting execution.");
      }
      const result = sqlite.prepare(`update managed_executions
        set runner_pid=?,runner_created_at=?,runner_boot_id=?,job_identity=?,
            armed_evidence=?,armed_at=?,state_version=state_version+1,updated_at=?
        where id=? and generation=? and state_version=? and phase='starting' and armed_evidence is null`)
        .run(input.pid, input.createdAt, input.bootId, input.jobIdentity, input.evidence,
          new Date().toISOString(), new Date().toISOString(),
          input.executionId, input.expectedGeneration, input.expectedVersion);
      if (result.changes !== 1) throw new Error("EXECUTION_VERSION_CONFLICT.");
      this.audit(sqlite, input.executionId, row.generation, "armed", { version: row.state_version },
        { version: row.state_version + 1, jobIdentity: input.jobIdentity });
      return this.get(input.executionId)!;
    });
  }

  private audit(sqlite: Database.Database, executionId: string, generation: number,
    action: string, previous: unknown, next: unknown): void {
    sqlite.prepare(`insert into execution_audit
      (execution_id,generation,action,previous_state,next_state,created_at)
      values (?,?,?,?,?,?)`)
      .run(executionId, generation, action, previous === null ? null : JSON.stringify(previous),
        JSON.stringify(next), new Date().toISOString());
  }
}
