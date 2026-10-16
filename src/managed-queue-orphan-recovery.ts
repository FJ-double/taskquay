import type Database from "better-sqlite3";
import {
  nativeRecoveryProbe, type ProcessProbe, type RecoveryOsProbe,
} from "./windows-recovery-observer.js";

/**
 * An orphan *waiting ticket* is not an orphan Job. The ticket's survival
 * proves the exact atomic tryAdmit transaction never committed. It is safe
 * to mark its still-queued Agent as stopped ONLY after the exact owner
 * identity is proven exited; do not re-enqueue or automatically replay.
 *
 * An absent ticket, missing owner generation, active claim, or running Turn
 * must always be quarantined: that could be a promoted/paid Provider Turn.
 */
export interface ManagedQueueSnapshot {
  id: string; sequence: number; owner_id: string; owner_pid: number;
  owner_generation: string | null; agent_id: string | null;
  checkout_root: string; kind: string; expires_at_ms: number | null;
  owner_status: string | null; owner_pid_native: number | null;
  owner_created_at: string | null; owner_boot_id: string | null;
  agent_status: string | null; agent_root: string | null;
  agent_control_state: string | null;
  claimant_count: number; running_turn_count: number; managed_active_count: number;
  agent_waiter_count: number;
}
export interface QueueOrphanDecision {
  ticketId: string;
  status: "candidate" | "active" | "quarantine";
  reason: string;
  ownerProbe?: ProcessProbe;
  nativeBoot?: string;
  observedAt: string;
}
export interface QueueOrphanApplyResult {
  status: "not_found" | "candidate" | "active" | "quarantine" | "stopped";
  decision?: QueueOrphanDecision;
}
const bootFormat = /^win-ntboot-v1:([a-f0-9-]{36}):([0-9a-f]{16})$/;

export function readManagedQueueSnapshot(db: Database.Database,
  ticketId: string): ManagedQueueSnapshot | undefined {
  return db.prepare(`select w.id,w.sequence,w.owner_id,w.owner_pid,
     w.owner_generation,w.agent_id,w.checkout_root,w.kind,w.expires_at_ms,
     o.status owner_status,o.pid owner_pid_native,
     o.process_created_at owner_created_at,o.boot_id owner_boot_id,
     a.status agent_status,a.workspace_root agent_root,a.control_state agent_control_state,
     (select count(*) from execution_claims c where c.agent_id=w.agent_id) claimant_count,
     (select count(*) from local_agent_turns t where t.agent_id=w.agent_id
       and t.status='running') running_turn_count,
     (select count(*) from managed_executions m join console_executions ce
       on ce.id=m.agent_execution_id where ce.agent_id=w.agent_id
       and m.resource_state != 'released') managed_active_count,
     (select count(*) from execution_waiters x where x.agent_id=w.agent_id) agent_waiter_count
     from execution_waiters w
     left join execution_owners o on o.id=w.owner_id and o.generation=w.owner_generation
     left join local_agent_sessions a on a.id=w.agent_id
     where w.id=? and w.owner_generation is not null`).get(ticketId) as
    ManagedQueueSnapshot | undefined;
}

export function observeManagedQueueOrphan(snapshot: ManagedQueueSnapshot,
  probe: RecoveryOsProbe = nativeRecoveryProbe): QueueOrphanDecision {
  const base = {
    ticketId: snapshot.id, observedAt: new Date().toISOString(),
  };
  const result = (status: QueueOrphanDecision["status"], reason: string,
    more: Partial<QueueOrphanDecision> = {}): QueueOrphanDecision =>
    ({ ...base, status, reason, ...more });
  if (!snapshot.owner_generation || !snapshot.agent_id ||
      snapshot.kind !== "agent" || snapshot.owner_pid !== snapshot.owner_pid_native ||
      !snapshot.owner_created_at || !snapshot.owner_boot_id ||
      !bootFormat.test(snapshot.owner_boot_id) ||
      snapshot.agent_status !== "queued" ||
      snapshot.agent_root === null || snapshot.agent_root === undefined ||
      snapshot.agent_root.toLowerCase().replaceAll("\\", "/") !==
        snapshot.checkout_root.toLowerCase().replaceAll("\\", "/") ||
      snapshot.agent_waiter_count !== 1 || snapshot.claimant_count !== 0 ||
      snapshot.running_turn_count !== 0 || snapshot.managed_active_count !== 0 ||
      ["desktop_owned", "reconcile_required"].includes(snapshot.agent_control_state ?? "")) {
    return result("quarantine", "QUEUE_IDENTITY_OR_DISPATCH_UNVERIFIABLE");
  }
  let currentBoot: string;
  try { currentBoot = probe.boot(); }
  catch { return result("quarantine", "BOOT_PROBE_UNAVAILABLE"); }
  if (!bootFormat.test(currentBoot)) return result("quarantine", "BOOT_PROBE_INVALID");
  if (currentBoot !== snapshot.owner_boot_id) {
    // Do not trust a before/after reboot identity until verified on an
    // explicitly approved isolated machine. Old tickets stay quarantined.
    return result("quarantine", "PRIOR_BOOT_NOT_FIELD_VERIFIED", { nativeBoot: currentBoot });
  }
  const ownerProbe = probe.process(snapshot.owner_pid, snapshot.owner_created_at);
  if (ownerProbe === "same") return result("active", "EXACT_OWNER_STILL_RUNNING",
    { nativeBoot: currentBoot, ownerProbe });
  if (ownerProbe === "unknown") return result("quarantine", "OWNER_IDENTITY_UNAVAILABLE",
    { nativeBoot: currentBoot, ownerProbe });
  return result("candidate", "EXACT_OWNER_EXITED_TICKET_NOT_PROMOTED",
    { nativeBoot: currentBoot, ownerProbe });
}

/** Read-only by default. Explicit apply validates the SAME ticket, owner
 * generation, Agent and all dependent rows inside an IMMEDIATE transaction.
 * No provider launch, no legacy waiter mutation and no Claim release.
 */
export function inspectManagedQueueOrphan(db: Database.Database, ticketId: string,
  options: { apply?: boolean } = {},
  probe: RecoveryOsProbe = nativeRecoveryProbe): QueueOrphanApplyResult {
  if (options.apply && probe !== nativeRecoveryProbe && !process.env.NODE_TEST_CONTEXT) {
    throw new Error("QUEUE_SYNTHETIC_NATIVE_PROBE_FORBIDDEN");
  }
  const first = readManagedQueueSnapshot(db, ticketId);
  if (!first) return { status: "not_found" };
  const decision = observeManagedQueueOrphan(first, probe);
  if (decision.status !== "candidate") return { status: decision.status, decision };
  if (!options.apply) return { status: "candidate", decision };

  db.transaction(() => {
    const current = readManagedQueueSnapshot(db, ticketId);
    if (!current || Object.keys(first).some((key) =>
      first[key as keyof ManagedQueueSnapshot] !== current[key as keyof ManagedQueueSnapshot])) {
      throw new Error("QUEUE_ORPHAN_CAS_CHANGED");
    }
    if (decision.ownerProbe !== "absent_or_reused" ||
        decision.nativeBoot !== first.owner_boot_id) {
      throw new Error("QUEUE_ORPHAN_KERNEL_PROOF_MISSING");
    }
    const updated = db.prepare(`update local_agent_sessions
      set status='stopped',error='Owner exited before queued Provider Turn started.',
        error_code='AGENT_QUEUE_OWNER_EXITED',error_retryable='true',
        updated_at=?
      where id=? and status='queued'`).run(decision.observedAt, first.agent_id);
    if (updated.changes !== 1) throw new Error("QUEUE_ORPHAN_AGENT_CHANGED");
    const deleted = db.prepare(`delete from execution_waiters
      where id=? and owner_id=? and owner_generation=? and agent_id=?`)
      .run(first.id, first.owner_id, first.owner_generation, first.agent_id);
    if (deleted.changes !== 1) throw new Error("QUEUE_ORPHAN_WAITING_IDENTITY_LOST");
    db.prepare(`insert into managed_queue_recovery_audit
      (ticket_id,owner_id,owner_generation,agent_id,disposition,evidence,created_at)
      values (?,?,?,?,?,?,?)`).run(
      first.id, first.owner_id, first.owner_generation, first.agent_id,
      "stopped_without_dispatch", JSON.stringify({
        nativeBoot: decision.nativeBoot, ownerPid: first.owner_pid,
        processCreatedAt: first.owner_created_at, ownerProbe: decision.ownerProbe,
        reason: decision.reason, expiresAtMs: first.expires_at_ms,
      }), decision.observedAt);
  }).immediate();
  return { status: "stopped", decision };
}

/** Bounded read-only discovery. A missing ticket is never a recovery
 * candidate: promotion may already have committed. */
export function scanManagedQueueOrphans(db: Database.Database,
  options: { limit?: number; afterSequence?: number } = {},
  probe: RecoveryOsProbe = nativeRecoveryProbe) {
  const limit = options.limit ?? 25;
  const cursor = options.afterSequence ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
      !Number.isSafeInteger(cursor) || cursor < 0) {
    throw new Error("QUEUE_SCAN_BOUND_INVALID");
  }
  const rows = db.prepare(`select id,sequence from execution_waiters
    where sequence>? and owner_generation is not null
    order by sequence asc limit ?`).all(cursor, limit + 1) as
    Array<{ id: string; sequence: number }>;
  return {
    mode: "observe_only" as const,
    entries: rows.slice(0, limit).map((item) => {
      const snapshot = readManagedQueueSnapshot(db, item.id);
      return snapshot ? observeManagedQueueOrphan(snapshot, probe) :
        { ticketId: item.id, status: "quarantine" as const,
          reason: "QUEUE_RECORD_VANISHED", observedAt: new Date().toISOString() };
    }),
    nextSequence: rows.length > limit ? rows[limit - 1]?.sequence : undefined,
  };
}
