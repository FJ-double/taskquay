import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { relative, isAbsolute, sep } from "node:path";
import type Database from "better-sqlite3";
import { ExecutionCoordinator, canonicalExecutionRoot } from "./execution-coordinator.js";
import { ExecutionStateStore, type ExecutionOwnerIdentity } from "./execution-state-store.js";
import { nativeRecoveryProbe, type RecoveryOsProbe } from "./windows-recovery-observer.js";

/** Stage 5 opt-in admission primitive, NOT a running service supervisor.
 * Service storage/ports use a separate namespace from ephemeral Agent slots.
 * Actual service launches must use their own independent Windows Job and
 * persist a native Job proof before any service is marked running.
 */
export interface ServiceReservationInput {
  serviceKey: string;
  workspaceRoot: string;
  stateRoot: string;
  workspaceId: string;
  bindHost: "127.0.0.1" | "0.0.0.0" | "::1";
  port: number;
  owner: ExecutionOwnerIdentity;
}
export interface ServiceReservationRow {
  service_id: string; service_key: string; owner_id: string;
  owner_generation: string; execution_id: string;
  checkout_root: string; state_root: string; bind_host: string;
  port: number; state: "reserved" | "running" | "stopping" | "released" | "quarantined";
  created_at: string; updated_at: string;
}
function within(parent: string, child: string): boolean {
  const diff = relative(parent, child);
  return diff === "" || (!isAbsolute(diff) && diff !== ".." && !diff.startsWith(".." + sep));
}
const nativeJobName = /^Local\\taskquay-job-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export class ManagedServiceReservations {
  constructor(private readonly coord: ExecutionCoordinator) {}
  private get db(): Database.Database { return this.coord.sharedDatabaseHandle.sqlite; }

  /** Reservation and never-dispatched Execution identity are atomic. No
   * process launch, listener bind, port probe or Provider inference here.
   */
  reserve(input: ServiceReservationInput): ServiceReservationRow {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/.test(input.serviceKey) ||
        !input.workspaceId.trim()) throw new Error("MANAGED_SERVICE_INVALID_IDENTITY");
    if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535 ||
        !["127.0.0.1", "0.0.0.0", "::1"].includes(input.bindHost)) {
      throw new Error("MANAGED_SERVICE_INVALID_BIND");
    }
    if (input.owner.id !== this.coord.managedOwnerId) {
      throw new Error("MANAGED_SERVICE_OWNER_NOT_CURRENT");
    }
    const checkoutRoot = canonicalExecutionRoot(input.workspaceRoot);
    const stateRoot = realpathSync(input.stateRoot).toLowerCase();
    if (within(checkoutRoot.toLowerCase(), stateRoot) ||
        within(stateRoot, checkoutRoot.toLowerCase())) {
      throw new Error("MANAGED_SERVICE_STATE_AND_CHECKOUT_MUST_BE_DISJOINT");
    }
    const semantic = {
      serviceKey: input.serviceKey, workspaceId: input.workspaceId,
      checkoutRoot, stateRoot, bindHost: input.bindHost, port: input.port,
    };
    const requestHash = createHash("sha256").update(JSON.stringify(semantic)).digest("hex");
    return this.coord.withManagedState((db) => {
      const created = new ExecutionStateStore(db).create({
        kind: "service", workspaceId: input.workspaceId,
        checkoutRoot, owner: input.owner, access: "watch",
        resources: [`service:port:${input.port}`],
        initialPhase: "starting",
        idempotencyScope: "managed-service:" + input.serviceKey,
        requestKey: randomUUID(), requestHash,
      }, (sqlite, executionId) => {
        const now = new Date().toISOString();
        sqlite.prepare(`insert into managed_service_reservations
          (service_id,service_key,owner_id,owner_generation,execution_id,
          checkout_root,state_root,bind_host,port,state,created_at,updated_at)
          values (?,?,?,?,?,?,?,?,?,'reserved',?,?)`).run(
          `svc_${randomUUID().replaceAll("-", "")}`, input.serviceKey,
          input.owner.id, input.owner.generation, executionId, checkoutRoot,
          stateRoot, input.bindHost, input.port, now, now);
      });
      if (!created.created) throw new Error("MANAGED_SERVICE_REPLAY_FORBIDDEN");
      const reservation = db.prepare("select * from managed_service_reservations where execution_id=?")
        .get(created.execution.id) as ServiceReservationRow | undefined;
      if (!reservation) throw new Error("MANAGED_SERVICE_RESERVATION_LOST");
      return reservation;
    });
  }

  inspect(serviceId: string): ServiceReservationRow | undefined {
    return this.db.prepare("select * from managed_service_reservations where service_id=?")
      .get(serviceId) as ServiceReservationRow | undefined;
  }

  /** Requires an actual OS-backed armed Job with a live matched runner.
   * The OS query happens before the SQLite write; the same fields are
   * rechecked inside IMMEDIATE transaction to reject state changes.
   */
  confirmRunning(serviceId: string, probe: RecoveryOsProbe = nativeRecoveryProbe): void {
    if (probe !== nativeRecoveryProbe && !process.env.NODE_TEST_CONTEXT) {
      throw new Error("MANAGED_SERVICE_SYNTHETIC_PROBE_FORBIDDEN");
    }
    const row = this.inspect(serviceId);
    if (!row || row.state !== "reserved") throw new Error("MANAGED_SERVICE_NOT_RESERVED");
    const before = this.db.prepare(`select m.kind,m.phase,m.resource_state,m.state_version,
      m.runner_pid,m.runner_created_at,m.runner_boot_id,m.job_identity,m.armed_evidence,
      o.pid owner_pid,o.process_created_at owner_created_at,o.boot_id owner_boot
      from managed_executions m join execution_owners o on o.id=m.owner_id
      where m.id=? and m.owner_id=? and m.owner_generation=o.generation`)
      .get(row.execution_id, row.owner_id) as Record<string, unknown> | undefined;
    if (!before || before.kind !== "service" || before.phase !== "running" ||
        before.resource_state !== "held" || !before.armed_evidence ||
        typeof before.job_identity !== "string" || !nativeJobName.test(before.job_identity) ||
        typeof before.runner_pid !== "number" ||
        typeof before.runner_created_at !== "string" ||
        typeof before.owner_pid !== "number" || typeof before.owner_created_at !== "string" ||
        before.runner_boot_id !== before.owner_boot || before.owner_boot !== probe.boot() ||
        probe.process(before.runner_pid, before.runner_created_at) !== "same" ||
        probe.process(before.owner_pid, before.owner_created_at) !== "same" ||
        probe.job(before.job_identity) !== "exists_active") {
      throw new Error("MANAGED_SERVICE_LIVE_JOB_NOT_VERIFIED");
    }
    this.coord.withManagedState((sqlite) => {
      const latest = sqlite.prepare(`select m.kind,m.phase,m.resource_state,m.state_version,
        m.runner_pid,m.runner_created_at,m.runner_boot_id,m.job_identity,m.armed_evidence,
        o.pid owner_pid,o.process_created_at owner_created_at,o.boot_id owner_boot
        from managed_executions m join execution_owners o on o.id=m.owner_id
        where m.id=? and m.owner_id=? and m.owner_generation=o.generation`)
        .get(row.execution_id, row.owner_id) as Record<string, unknown> | undefined;
      if (!latest || Object.keys(before).some((key) => before[key] !== latest[key])) {
        throw new Error("MANAGED_SERVICE_RUNNING_CAS_CONFLICT");
      }
      const changed = sqlite.prepare(`update managed_service_reservations
        set state='running',updated_at=? where service_id=? and state='reserved'
        and owner_id=? and owner_generation=? and execution_id=?`)
        .run(new Date().toISOString(), row.service_id, row.owner_id, row.owner_generation,
          row.execution_id);
      if (changed.changes !== 1) throw new Error("MANAGED_SERVICE_RESERVATION_RACE");
    });
  }

  /** This never stops/kills a process. Only close a service reservation
   * whose matching native Job is gone AND execution evidence was committed.
   * No implicit TTL-based port or state-root reclaim.
   */
  finalizeExited(serviceId: string, probe: RecoveryOsProbe = nativeRecoveryProbe): void {
    if (probe !== nativeRecoveryProbe && !process.env.NODE_TEST_CONTEXT) {
      throw new Error("MANAGED_SERVICE_SYNTHETIC_PROBE_FORBIDDEN");
    }
    const row = this.inspect(serviceId);
    // An armed service that failed its first health check never reached
    // "running"; it may still be released ONLY after the same exact
    // terminal, native-empty Job proof. Never infer exit from reserved.
    if (!row || !["reserved", "running", "stopping", "quarantined"].includes(row.state)) {
      throw new Error("MANAGED_SERVICE_NOT_FINALIZABLE");
    }
    const before = this.db.prepare(`select m.kind,m.phase,m.resource_state,m.outcome,m.state_version,
      m.runner_pid,m.runner_created_at,m.job_identity,m.runner_boot_id,m.exit_evidence,
      o.boot_id owner_boot
      from managed_executions m join execution_owners o on o.id=m.owner_id
      where m.id=? and m.owner_id=? and m.owner_generation=o.generation`)
      .get(row.execution_id, row.owner_id) as Record<string, unknown> | undefined;
    const evidence = before?.exit_evidence
      ? JSON.parse(String(before.exit_evidence)) as { kind?: string } : null;
    if (!before || before.kind !== "service" || before.phase !== "terminal" ||
        before.resource_state !== "released" ||
        !["job_empty_verified"].includes(evidence?.kind ?? "") ||
        before.owner_boot !== probe.boot() || before.runner_boot_id !== before.owner_boot ||
        typeof before.job_identity !== "string" || !nativeJobName.test(before.job_identity) ||
        typeof before.runner_pid !== "number" ||
        typeof before.runner_created_at !== "string" ||
        probe.job(before.job_identity) !== "absent" ||
        probe.process(before.runner_pid, before.runner_created_at) !== "absent_or_reused") {
      throw new Error("MANAGED_SERVICE_RELEASE_PROOF_UNVERIFIED");
    }
    this.coord.withManagedState((sqlite) => {
      const now = sqlite.prepare(`select m.phase,m.resource_state,m.state_version,
        m.exit_evidence,m.runner_pid,m.job_identity
        from managed_executions m where m.id=?`).get(row.execution_id) as
        Record<string, unknown> | undefined;
      if (!now || now.phase !== before.phase || now.resource_state !== before.resource_state ||
          now.state_version !== before.state_version || now.exit_evidence !== before.exit_evidence ||
          now.runner_pid !== before.runner_pid || now.job_identity !== before.job_identity) {
        throw new Error("MANAGED_SERVICE_FINALIZE_CAS_CHANGED");
      }
      const updated = sqlite.prepare(`update managed_service_reservations
        set state='released',updated_at=?
        where service_id=? and execution_id=? and owner_id=? and owner_generation=? and state=?`)
        .run(new Date().toISOString(), row.service_id, row.execution_id,
          row.owner_id, row.owner_generation, row.state);
      if (updated.changes !== 1) throw new Error("MANAGED_SERVICE_FINALIZE_CAS_CHANGED");
    });
  }
}
