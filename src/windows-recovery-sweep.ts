import type Database from "better-sqlite3";
import { nativeRecoveryProbe, type RecoveryOsProbe } from "./windows-recovery-observer.js";
import { scanManagedRecovery } from "./windows-recovery-scanner.js";
import { inspectManagedRecovery } from "./windows-recovery-transaction.js";

/** One bounded recovery iteration. No TTL-based deletion and no PID killing.
 * Only a linked managed command/agent with fresh native proof can release its
 * Claim; managed services and all legacy/unlinked claims remain untouched.
 * A cursor lets the daemon progress beyond permanently quarantined rows.
 */
export interface RecoverySweepOptions {
  limit?: number;
  afterExecutionId?: string;
  minOwnerSilenceMs?: number;
}
export interface RecoverySweepOutcome {
  executionId: string;
  status: "released" | "not_ready" | "quarantined" | "failed";
  reason?: string;
}
export interface RecoverySweepResult {
  scanned: number;
  released: number;
  entries: RecoverySweepOutcome[];
  nextCursor?: string;
}

export function sweepManagedRecovery(sqlite: Database.Database,
  options: RecoverySweepOptions = {}, probe: RecoveryOsProbe = nativeRecoveryProbe): RecoverySweepResult {
  const silence = options.minOwnerSilenceMs ?? 95_000;
  const page = scanManagedRecovery(sqlite, {
    limit: options.limit ?? 25, afterExecutionId: options.afterExecutionId,
    minOwnerSilenceMs: silence,
  }, probe);
  const entries: RecoverySweepOutcome[] = [];
  for (const entry of page.entries) {
    if (entry.status !== "candidate" || !entry.observation) {
      entries.push({ executionId: entry.executionId, status: "not_ready",
        reason: entry.status });
      continue;
    }
    // Reboot proof has not passed the separate field rollout gate. Keep
    // unattended recovery limited to same-boot, exact absent owner/runner/Job.
    if (entry.observation.evidenceKind !== "job_empty_verified") {
      entries.push({ executionId: entry.executionId, status: "quarantined",
        reason: "RECOVERY_PRIOR_BOOT_REQUIRES_FIELD_VALIDATION" });
      continue;
    }
    // Service reservations have a separate recovery protocol (ports, health
    // journals, and explicit reconciliation), never auto-release them here.
    const record = sqlite.prepare("select kind from managed_executions where id=?")
      .get(entry.executionId) as { kind: string } | undefined;
    if (!record || !["command", "agent"].includes(record.kind)) {
      entries.push({ executionId: entry.executionId, status: "quarantined",
        reason: "RECOVERY_SERVICE_OR_RECORD_UNSUPPORTED" });
      continue;
    }
    try {
      const applied = inspectManagedRecovery(sqlite, entry.executionId, {
        apply: true, expectedVersion: entry.observation.version,
        requireOwnerSilenceMs: silence,
      }, probe);
      entries.push({ executionId: entry.executionId,
        status: applied.status === "released" ? "released" : "not_ready",
        reason: applied.status });
    } catch (error) {
      // An ambiguous ledger, CAS conflict, reused PID, or database error
      // must never be converted into a successful release.
      entries.push({ executionId: entry.executionId, status: "failed",
        reason: error instanceof Error ? error.message : "RECOVERY_UNEXPECTED_ERROR" });
    }
  }
  return { scanned: page.scanned,
    released: entries.filter((entry) => entry.status === "released").length,
    entries, nextCursor: page.nextCursor };
}
