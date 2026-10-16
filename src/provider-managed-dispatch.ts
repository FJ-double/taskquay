import { createHash, randomUUID } from "node:crypto";
import { ExecutionCoordinator, type ExecutionClaim, type ExecutionClaimInput, type ManagedAdmissionTicket } from "./execution-coordinator.js";
import type Database from "better-sqlite3";
import type { DatabaseHandle } from "./db/client.js";
import { ExecutionStateStore, type ExecutionOwnerIdentity } from "./execution-state-store.js";
import { windowsProcessCreatedAt } from "./windows-job-object.js";
import { windowsBootIdentity } from "./windows-boot-identity.js";
import { ManagedOwnerLease } from "./managed-owner-lease.js";
import {
  WindowsProviderTurnRunner, type IsolatedProviderStart,
  type IsolatedProviderResult, type ProviderTurnJobProof,
} from "./provider-turn-runner.js";
import type { LocalAgentRunCallbacks, LocalAgentRunInput, LocalAgentRuntimeContext } from "./local-agent-runtime.js";
import type { SubagentsConfig } from "./local-agent-config.js";
import { WorkLedger } from "./work-ledger.js";

export type ProviderTurnStarter = (input: IsolatedProviderStart) =>
  Promise<{ finished: Promise<IsolatedProviderResult>;
    cancel?: () => Promise<unknown> }>;

export interface ProviderManagedTurn {
  claim: ExecutionClaim;
  managedExecutionId: string;
  agentExecutionId: string;
  workRunId: string;
  workspaceId: string;
  context: LocalAgentRuntimeContext;
  input: LocalAgentRunInput;
  callbacks: LocalAgentRunCallbacks;
  resources: string[];
  subagents: SubagentsConfig;
}
export interface ProviderManagedCompletion {
  executionId: string;
  completion: IsolatedProviderResult;
}

export interface AtomicProviderAdmission {
  claim: ExecutionClaim;
  executionId: string;
  agentExecutionId: string;
  workRunId: string;
}
export interface AtomicProviderAdmissionInput {
  requirement: ExecutionClaimInput;
  agentId: string;
  provider: string;
  workspaceId: string;
  workRunId?: string;
  workItemId?: string;
  requestKey?: string;
  model?: string;
  effort?: string;
  prompt: string;
  providerSessionId?: string | null;
}

/**
 * Agent Claim + WorkLedger execution + managed_executions are committed
 * in ONE SQLite transaction, before any Provider process starts.
 * LocalAgentStore turn state still lives on a separate SQLite connection;
 * cross-store atomicity and managed queue leasing are later phases.
 *
 * Never release an adopted claim through the old release() callback before
 * the OS proof and ledger outcome are committed together.
 */
export class ManagedProviderDispatcher {
  readonly owner: ExecutionOwnerIdentity;
  readonly lease: ManagedOwnerLease;
  private readonly starter: ProviderTurnStarter;
  private readonly inFlight = new Set<{ finished: Promise<IsolatedProviderResult>;
    cancel?: () => Promise<unknown> }>();

  constructor(private readonly coordinator: ExecutionCoordinator,
    private readonly stateDir: string,
    starter: ProviderTurnStarter = (input) => WindowsProviderTurnRunner.start(input)) {
    if (process.platform !== "win32") throw new Error("MANAGED_PROVIDER_UNSUPPORTED_PLATFORM");
    const generation = randomUUID();
    this.owner = {
      id: coordinator.managedOwnerId,
      kind: "agentd",
      pid: process.pid,
      processCreatedAt: windowsProcessCreatedAt(process.pid),
      // NT kernel boot GUID + raw BootTime. This only fences generations:
      // recovery still requires separate exact Job-empty process proof.
      bootId: windowsBootIdentity(),
      generation,
    };
    coordinator.registerManagedOwner(this.owner);
    this.lease = new ManagedOwnerLease(coordinator.sharedDatabaseHandle.sqlite, this.owner);
    this.lease.start();
    this.starter = starter;
  }

  admit(input: AtomicProviderAdmissionInput, beforeCommit?: () => void): AtomicProviderAdmission {
    this.lease.assertCanAdmit();
    const admitted = this.coordinator.admitManaged(input.requirement, (sqlite, database) =>
      this.persistAdmittedTurn(input, sqlite, database, beforeCommit));
    return { claim: admitted.claim, ...admitted.value };
  }

  /** Queueing creates no Provider turn, managed execution, or claim. */
  enqueue(input: AtomicProviderAdmissionInput, waitMs: number): {
    id: string;
    tryAdmit: (beforeCommit?: () => void) => AtomicProviderAdmission | undefined;
    cancel: () => void;
  } {
    this.lease.assertCanAdmit();
    const ticket: ManagedAdmissionTicket = this.coordinator.enqueueManaged(input.requirement, waitMs);
    return {
      id: ticket.id,
      tryAdmit: (beforeCommit) => {
        this.lease.assertCanAdmit();
        const accepted = ticket.tryAdmit((sqlite, database) =>
          this.persistAdmittedTurn(input, sqlite, database, beforeCommit));
        return accepted ? { claim: accepted.claim, ...accepted.value } : undefined;
      },
      cancel: () => ticket.cancel(),
    };
  }

  private persistAdmittedTurn(input: AtomicProviderAdmissionInput,
    sqlite: Database.Database, database: DatabaseHandle, beforeCommit?: () => void): {
      executionId: string;
      value: { executionId: string; agentExecutionId: string; workRunId: string };
    } {
      const ledger = new WorkLedger(this.stateDir, database);
      ledger.assertAgentUsable(input.agentId);
      const previous = ledger.latestExecution(input.agentId);
      const priorRun = previous ? ledger.run(previous.run_id) : undefined;
      const reusable = !input.workRunId && priorRun?.status === "running" &&
        JSON.parse(priorRun.origin).entryPoint === "devspace_cli" ? priorRun.id : undefined;
      const work = input.workRunId || reusable
        ? ledger.requireScope(input.workRunId ?? reusable!, input.requirement.workspaceRoot, input.workspaceId)
        : ledger.begin({
          root: input.requirement.workspaceRoot, workspaceId: input.workspaceId,
          workItemId: input.workItemId ?? `agent-${input.agentId}`,
          runKey: `cli-${randomUUID()}`,
          title: `DevSpace · ${input.workItemId ?? input.agentId}`.slice(0, 160),
          origin: { entryPoint: "devspace_cli", evidence: "server_entry" },
        });
      const requestHash = createHash("sha256").update(JSON.stringify({
        agentId: input.agentId, workRunId: work.id, provider: input.provider,
        session: input.providerSessionId ?? null,
        model: input.model ?? null, effort: input.effort ?? null,
        prompt: input.prompt, access: input.requirement.access ?? "write",
        resources: [...new Set(input.requirement.resources ?? [])].sort(),
      })).digest("hex");
      const agentExecutionId = ledger.beginExecution({
        runId: work.id, agentId: input.agentId, provider: input.provider,
        model: input.model, effort: input.effort,
      });
      const store = new ExecutionStateStore(sqlite);
      const created = store.create({
        kind: "agent", workspaceId: input.workspaceId,
        checkoutRoot: input.requirement.workspaceRoot,
        agentExecutionId, workRunId: work.id,
        owner: this.owner, access: input.requirement.access ?? "write",
        resources: [...(input.requirement.resources ?? [])],
        idempotencyScope: `isolated-provider:${work.id}:${input.agentId}`,
        requestKey: input.requestKey,
        requestHash, initialPhase: "starting",
      });
      if (!created.created) throw new Error(
        `PROVIDER_EXECUTION_ALREADY_RECORDED: ${created.execution.id}; do not replay the model request.`);
      // LocalAgentStore is on the same borrowed SQLite connection in managed
      // mode. A failed beginTurn aborts ALL three admission tables and the
      // local agent turn together, before there can be a child process.
      beforeCommit?.();
      return {
        executionId: created.execution.id,
        value: { executionId: created.execution.id, agentExecutionId, workRunId: work.id },
      };
  }

  /** When the manager and LocalAgentStore borrow the coordinator's SQLite
   * connection, even nested LocalAgentStore savepoints commit atomically with
   * the managed claim, ledger and Job proof.
   */
  withTurnTransaction<T>(work: () => T): T {
    return this.coordinator.withManagedState(() => work());
  }

  /** Only valid before any Worker dispatch. Caller guarantees run() has not
   * been called; proof of no dispatch is checked against persisted state. */
  abandonUndispatched(admission: AtomicProviderAdmission, reason: string): void {
    this.coordinator.completeManaged(admission.executionId, (sqlite, database) => {
      const store = new ExecutionStateStore(sqlite);
      const current = store.get(admission.executionId);
      if (!current || current.phase !== "starting" || current.armed_evidence ||
          current.runner_pid !== null) throw new Error("PROVIDER_DISPATCH_MAY_HAVE_STARTED");
      let row = store.transition({
        executionId: admission.executionId, expectedGeneration: current.generation,
        expectedVersion: current.state_version, phase: "terminal", outcome: "failed",
        resourceState: "cleanup_pending", recoveryReason: reason,
      });
      row = store.transition({
        executionId: admission.executionId, expectedGeneration: row.generation,
        expectedVersion: row.state_version, resourceState: "released",
        exitEvidence: { kind: "never_dispatched_verified", verifiedAt: new Date().toISOString(),
          verifier: "ManagedProviderDispatcher.abandonUndispatched", detail: reason },
      });
      const ledger = new WorkLedger(this.stateDir, database);
      ledger.providerNotRequested(admission.agentExecutionId);
      ledger.endExecution(admission.agentExecutionId, "failed");
    });
  }

  async run(turn: ProviderManagedTurn): Promise<ProviderManagedCompletion> {
    const { claim, context, input, agentExecutionId } = turn;
    const execution = this.coordinator.withManagedState((sqlite) => {
      const existing = sqlite.prepare(
        "select owner_id,kind,execution_id,checkout_root from execution_claims where id=?",
      ).get(claim.id) as
        { owner_id: string; kind: string; execution_id: string | null; checkout_root: string } | undefined;
      if (!existing || existing.owner_id !== this.owner.id ||
          existing.kind !== "agent" || existing.execution_id !== turn.managedExecutionId) {
        throw new Error("PROVIDER_CLAIM_NOT_ATOMICALLY_ADMITTED");
      }
      const recorded = sqlite.prepare(
        "select id,run_id,agent_id,status from console_executions where id=?",
      ).get(agentExecutionId) as
        { id: string; run_id: string; agent_id: string; status: string } | undefined;
      if (!recorded || recorded.run_id !== turn.workRunId ||
          recorded.agent_id !== context.agentId || recorded.status === "completed") {
        throw new Error("PROVIDER_LEDGER_TURN_IDENTITY_MISMATCH");
      }
      const managed = new ExecutionStateStore(sqlite).get(turn.managedExecutionId);
      if (!managed || managed.phase !== "starting" || managed.owner_id !== this.owner.id ||
          managed.agent_execution_id !== agentExecutionId || managed.work_run_id !== turn.workRunId ||
          managed.workspace_id !== turn.workspaceId || managed.runner_pid !== null) {
        throw new Error("PROVIDER_MANAGED_ADMISSION_IDENTITY_MISMATCH");
      }
      return managed;
    });
    const runner = await this.starter({
      executionId: execution.id, generation: execution.generation,
      provider: context.provider, context, input,
      subagents: turn.subagents, callbacks: turn.callbacks,
      persistArmed: (proof) => this.coordinator.withManagedState((sqlite) => {
        const store = new ExecutionStateStore(sqlite);
        const armed = store.arm({
          executionId: execution.id,
          expectedGeneration: execution.generation,
          expectedVersion: execution.state_version,
          pid: proof.runnerPid,
          createdAt: proof.runnerCreatedAt,
          bootId: this.owner.bootId,
          jobIdentity: proof.jobIdentity,
          evidence: JSON.stringify({ kind: "os_job_membership",
            memberCount: 1, createdAt: proof.runnerCreatedAt, job: proof.jobIdentity }),
        });
        store.transition({
          executionId: execution.id, expectedGeneration: execution.generation,
          expectedVersion: armed.state_version, phase: "running",
        });
      }),
    });
    this.inFlight.add(runner);
    let completion: IsolatedProviderResult;
    try {
      completion = await runner.finished;
    } finally {
      this.inFlight.delete(runner);
    }
    if (!completion.proof || completion.proof.activeProcesses !== 0 ||
        completion.proof.executionId !== execution.id ||
        completion.proof.generation !== execution.generation) {
      throw new Error("PROVIDER_JOB_PROOF_UNVERIFIED");
    }
    return { executionId: execution.id, completion };
  }

  /** Close only runners created and tracked by this owner. Never kill processes
   * by name or PID; cancellation is Job-scoped and any unknown proof remains
   * quarantined for recovery.
   */
  async stopAll(): Promise<void> {
    this.lease.stop();
    await Promise.allSettled([...this.inFlight].map((runner) => runner.cancel?.()));
  }

  /** Called AFTER LocalAgentStore has durably recorded the finished turn. */
  finalize(outcome: ProviderManagedCompletion, status: "completed" | "failed" | "cancelled",
    persistTurn?: () => void): void {
    const { executionId, completion } = outcome;
    const proof: ProviderTurnJobProof = completion.proof;
    this.coordinator.completeManaged(executionId, (sqlite, database) => {
      // Do not release the claim until the AgentStore terminal turn state
      // and WorkLedger work receipt have committed together.
      persistTurn?.();
      const store = new ExecutionStateStore(sqlite);
      let row = store.get(executionId);
      if (!row || row.phase !== "running" || row.job_identity !== proof.jobIdentity ||
          row.runner_pid !== proof.runnerPid || row.generation !== proof.generation ||
          row.owner_id !== this.owner.id || row.resource_state !== "held" ||
          proof.activeProcesses !== 0) {
        throw new Error("PROVIDER_MANAGED_RELEASE_UNVERIFIED");
      }
      row = store.transition({
        executionId, expectedGeneration: row.generation, expectedVersion: row.state_version,
        phase: "terminal", outcome: status, resourceState: "cleanup_pending",
      });
      store.transition({
        executionId, expectedGeneration: row.generation, expectedVersion: row.state_version,
        resourceState: "released", exitEvidence: {
          kind: "job_empty_verified", verifiedAt: proof.verifiedAt,
          verifier: "WindowsProviderTurnRunner", detail: JSON.stringify(proof),
        },
      });
      const ledger = new WorkLedger(this.stateDir, database);
      const agentId = sqlite.prepare("select agent_execution_id from managed_executions where id=?")
        .get(executionId) as { agent_execution_id: string };
      ledger.endExecution(agentId.agent_execution_id, status);
    });
  }
}
