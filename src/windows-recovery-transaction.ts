import type Database from "better-sqlite3";
import { ExecutionStateStore } from "./execution-state-store.js";
import {
  nativeRecoveryProbe, observeRecovery, readRecoverySnapshot,
  type RecoveryObservation, type RecoveryOsProbe,
} from "./windows-recovery-observer.js";

export interface RecoveryApplyResult {
  status: "candidate" | "quarantined" | "active" | "released" | "not_found";
  observation?: RecoveryObservation;
}

/** NOT called by daemon startup or production. Explicitly apply only after
 * a fresh, exact native OS observation. A caller cannot provide a prebuilt
 * success receipt. Default is read-only (apply=false).
 *
 * The OS observation runs BEFORE the SQLite write transaction, so a native
 * query never holds a database lock. CAS rechecks all owner/runner/version
 * identity and the single claim before release.
 */
export function inspectManagedRecovery(
  sqlite: Database.Database, executionId: string,
  options: {
    apply?: boolean; expectedVersion?: number;
    /** Mandatory for unattended recovery: stale heartbeat is only a scan trigger. */
    requireOwnerSilenceMs?: number;
  } = {},
  probe: RecoveryOsProbe = nativeRecoveryProbe,
): RecoveryApplyResult {
  const before = readRecoverySnapshot(sqlite, executionId);
  if (!before) return { status: "not_found" };
  if (options.requireOwnerSilenceMs !== undefined &&
      (!Number.isSafeInteger(options.requireOwnerSilenceMs) ||
       options.requireOwnerSilenceMs < 60_000)) {
    throw new Error("RECOVERY_OWNER_SILENCE_INVALID");
  }
  const ownerBefore = options.requireOwnerSilenceMs === undefined ? undefined :
    sqlite.prepare(`select heartbeat_at_ms,status from execution_owners
      where id=? and generation=?`).get(before.owner_id,before.owner_generation) as
      {heartbeat_at_ms:number;status:string}|undefined;
  const nowMs = Date.now();
  if (ownerBefore && (!Number.isSafeInteger(ownerBefore.heartbeat_at_ms) ||
      nowMs < ownerBefore.heartbeat_at_ms ||
      nowMs - ownerBefore.heartbeat_at_ms < options.requireOwnerSilenceMs!)) {
    return { status: "active" };
  }
  if (options.requireOwnerSilenceMs !== undefined && !ownerBefore) {
    return { status: "quarantined" };
  }
  const observation = observeRecovery(before, probe);
  if (options.apply && probe !== nativeRecoveryProbe && !process.env.NODE_TEST_CONTEXT) {
    throw new Error("RECOVERY_SYNTHETIC_OS_PROBE_FORBIDDEN_OUTSIDE_TESTS");
  }
  if (observation.decision !== "candidate") {
    return { status: observation.decision === "active" ? "active" : "quarantined", observation };
  }
  if (!options.apply) return { status: "candidate", observation };
  if (options.expectedVersion !== undefined && options.expectedVersion !== before.state_version) {
    throw new Error("RECOVERY_VERSION_CONFLICT");
  }
  if (!observation.evidenceKind || !observation.bootId) throw new Error("RECOVERY_OS_EVIDENCE_MISSING");
  const verifySnapshot = () => {
    const current = readRecoverySnapshot(sqlite, executionId);
    if (!current || Object.keys(before).some((key) =>
      current[key as keyof typeof current] !== before[key as keyof typeof before])) {
      throw new Error("RECOVERY_CAS_SNAPSHOT_CHANGED");
    }
    const count = sqlite.prepare("select count(*) n from execution_claims where execution_id=?")
      .get(executionId) as { n: number };
    if (count.n !== 1) throw new Error("RECOVERY_CLAIM_AMBIGUOUS");
  };
  sqlite.transaction(() => {
    if (ownerBefore) {
      const ownerNow = sqlite.prepare(`select heartbeat_at_ms,status from execution_owners
        where id=? and generation=?`).get(before.owner_id,before.owner_generation) as
        typeof ownerBefore | undefined;
      if (!ownerNow || ownerNow.heartbeat_at_ms !== ownerBefore.heartbeat_at_ms ||
          ownerNow.status !== ownerBefore.status ||
          Date.now() - ownerNow.heartbeat_at_ms < options.requireOwnerSilenceMs!) {
        // Even a native candidate cannot release a Claim if its owner
        // resumed heartbeats while the kernel probes were underway.
        throw new Error("RECOVERY_OWNER_HEARTBEAT_CHANGED");
      }
    }
    verifySnapshot();
    const store = new ExecutionStateStore(sqlite);
    const current = store.get(executionId);
    if (!current || current.resource_state === "released") {
      throw new Error("RECOVERY_EXECUTION_ALREADY_RELEASED");
    }
    let row = current;
    if (row.phase !== "terminal") {
      row = store.transition({
        executionId, expectedGeneration: row.generation, expectedVersion: row.state_version,
        phase: "terminal", outcome: "interrupted",
        resourceState: "cleanup_pending",
        recoveryReason: "owner_died_with_unverified_provider_outcome",
      });
    } else if (row.resource_state !== "cleanup_pending") {
      row = store.transition({
        executionId, expectedGeneration: row.generation, expectedVersion: row.state_version,
        resourceState: "cleanup_pending",
        recoveryReason: "owner_died_after_provider_terminal",
      });
    }
    row = store.transition({
      executionId, expectedGeneration: row.generation, expectedVersion: row.state_version,
      resourceState: "released",
      exitEvidence: {
        kind: observation.evidenceKind!,
        verifiedAt: observation.observedAt,
        verifier: "WindowsRecoveryObserver/NT-kernel",
        detail: JSON.stringify({
          decision: observation.decision, reason: observation.reason,
          bootId: observation.bootId, ownerProbe: observation.ownerProbe,
          runnerProbe: observation.runnerProbe, jobProbe: observation.jobProbe,
          ownerId: before.owner_id, ownerGeneration: before.owner_generation,
          ownerPid: before.owner_pid, runnerPid: before.runner_pid,
          jobIdentity: before.job_identity,
        }),
      },
    });
    if (row.resource_state !== "released") throw new Error("RECOVERY_RESOURCE_RELEASE_NOT_COMMITTED");
    // A recovered agent must not silently become a new writable continuation
    // with an unknown prior Provider result. Preserve the Provider session ID
    // for later explicit reconciliation rather than replaying inference.
    const reference = sqlite.prepare(`select agent_execution_id,command_operation_id,work_run_id,kind
      from managed_executions where id=?`)
      .get(executionId) as {
        agent_execution_id: string | null; command_operation_id: string | null;
        work_run_id: string | null; kind: string;
      };
    if (reference.kind === "command" && reference.work_run_id) {
      // This is a *failed/interrupted* command, not a successful result and
      // not permission to replay a non-idempotent side effect. All ledger
      // checks and writes must participate in the proof-gated release tx.
      // An older unlinked command is ambiguous; quarantine it instead of
      // guessing which live console operation to finish.
      if (!reference.command_operation_id) {
        throw new Error("RECOVERY_COMMAND_OPERATION_LINK_MISSING");
      }
      const operation = sqlite.prepare(`select run_id,kind,status
        from console_operations where id=?`).get(reference.command_operation_id) as
        { run_id: string; kind: string; status: string } | undefined;
      const workRun = sqlite.prepare(`select status from console_work_runs where id=?`)
        .get(reference.work_run_id) as {status:string} | undefined;
      if (!operation || operation.run_id !== reference.work_run_id ||
          operation.kind !== "command" || !["running","queued","starting"].includes(operation.status) ||
          workRun?.status !== "running") {
        throw new Error("RECOVERY_COMMAND_OPERATION_IDENTITY_CONFLICT");
      }
      const evidence = [{
        label: "Verified command owner lost; execution result requires reconciliation",
        reference: JSON.stringify({
          executionId, kind: "command", outcome: "interrupted",
          recoveryReason: observation.reason, verifiedAt: observation.observedAt,
          replay: "forbidden_without_explicit_reconciliation",
        }),
        outcome: "failed" as const,
      }];
      const ended = sqlite.prepare(`update console_operations set status='failed',
        evidence=?, finished_at=? where id=? and run_id=? and status in ('running','queued','starting')`)
        .run(JSON.stringify(evidence), observation.observedAt,
          reference.command_operation_id, reference.work_run_id);
      if (ended.changes !== 1) throw new Error("RECOVERY_COMMAND_OPERATION_CAS_CONFLICT");
      const touched = sqlite.prepare(`update console_work_runs set revision=revision+1
        where id=? and status='running'`).run(reference.work_run_id);
      if (touched.changes !== 1) throw new Error("RECOVERY_COMMAND_WORK_RUN_CAS_CONFLICT");
    }
    if (reference.kind === "agent" && reference.agent_execution_id) {
      const receipt = sqlite.prepare("select agent_id,status from console_executions where id=?")
        .get(reference.agent_execution_id) as { agent_id: string; status: string } | undefined;
      if (!receipt) throw new Error("RECOVERY_AGENT_LEDGER_MISSING");
      if (!["completed", "failed", "cancelled"].includes(receipt.status)) {
        sqlite.prepare(`update console_executions
          set status='reconciliation_required',finished_at=coalesce(finished_at,?)
          where id=?`).run(new Date().toISOString(), reference.agent_execution_id);
      }
      sqlite.prepare(`update local_agent_sessions
        set control_state='reconcile_required',
            error_code='OWNER_LOST_REQUIRE_RECONCILIATION',
            control_revision=control_revision+1,updated_at=?
        where id=?`).run(new Date().toISOString(), receipt.agent_id);
    }
    const deleted = sqlite.prepare("delete from execution_claims where id=? and execution_id=? and owner_id=?")
      .run(before.claim_id, executionId, before.owner_id);
    if (deleted.changes !== 1) throw new Error("RECOVERY_CLAIM_RELEASE_CONFLICT");
    sqlite.prepare("update execution_owners set status='dead' where id=? and generation=?")
      .run(before.owner_id, before.owner_generation);
  }).immediate();
  return { status: "released", observation };
}
