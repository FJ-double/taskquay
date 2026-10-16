import type Database from "better-sqlite3";
import {
  nativeRecoveryProbe, observeRecovery, readRecoverySnapshot,
  type RecoveryObservation, type RecoveryOsProbe,
} from "./windows-recovery-observer.js";

/** Bounded, paginated, read-only scan; never schedules or applies recoveries. */
export interface RecoveryScanOptions {
  /** At least 60 seconds. Heartbeat age decides WHEN to inspect, never WHEN to release. */
  minOwnerSilenceMs?: number;
  /** Maximum 100 rows examined per invocation. */
  limit?: number;
  /** Keyset cursor; only opaque managed execution IDs, not SQL fragments. */
  afterExecutionId?: string;
  /** Optional exact checkout directory filter, not a substring match. */
  checkoutRoot?: string;
  nowMs?: number;
}
export interface RecoveryScanEntry {
  executionId: string;
  ownerId: string;
  ownerGeneration: string;
  heartbeatAgeMs: number;
  status: "heartbeat_recent" | "candidate" | "active" | "quarantine" | "invalid_record";
  observation?: RecoveryObservation;
}
export interface RecoveryScanPage {
  scanned: number;
  entries: RecoveryScanEntry[];
  nextCursor?: string;
  truncated: boolean;
  mode: "observe_only";
}
const validId = /^ex_[a-f0-9]{32}$/;
export function scanManagedRecovery(sqlite: Database.Database,
  options: RecoveryScanOptions = {},
  probe: RecoveryOsProbe = nativeRecoveryProbe): RecoveryScanPage {
  const limit = options.limit ?? 25;
  const minOwnerSilenceMs = options.minOwnerSilenceMs ?? 120_000;
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
      !Number.isSafeInteger(minOwnerSilenceMs) || minOwnerSilenceMs < 60_000 ||
      !Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error("RECOVERY_SCAN_BOUNDS_INVALID");
  }
  if (options.afterExecutionId !== undefined && !validId.test(options.afterExecutionId)) {
    throw new Error("RECOVERY_SCAN_CURSOR_INVALID");
  }
  if (options.checkoutRoot !== undefined && !options.checkoutRoot.trim()) {
    throw new Error("RECOVERY_SCAN_ROOT_INVALID");
  }
  // Never hold a transaction or persistent OS handle during the per-row
  // native observations. The query is not a lock, nor a release permit.
  const rows = sqlite.prepare(`select e.id,e.owner_id,e.owner_generation,
      o.heartbeat_at_ms as heartbeat_at_ms
      from managed_executions e
      join execution_owners o on o.id=e.owner_id and o.generation=e.owner_generation
      join execution_claims c on c.execution_id=e.id and c.owner_id=e.owner_id
      where e.resource_state in ('held','cleanup_pending','quarantined')
        and e.id > ?
        and (? is null or e.checkout_root=?)
      group by e.id,e.owner_id,e.owner_generation,o.heartbeat_at_ms
      order by e.id asc limit ?`).all(
    options.afterExecutionId ?? "", options.checkoutRoot ?? null,
    options.checkoutRoot ?? null, limit + 1,
  ) as Array<{ id: string; owner_id: string; owner_generation: string;
    heartbeat_at_ms: number }>;
  const page = rows.slice(0, limit);
  const entries: RecoveryScanEntry[] = page.map((row) => {
    const heartbeatAgeMs = nowMs - row.heartbeat_at_ms;
    const base = {
      executionId: row.id, ownerId: row.owner_id,
      ownerGeneration: row.owner_generation, heartbeatAgeMs,
    };
    // A recent heartbeat is only a reason to defer costly OS inspection;
    // it is NOT enough to declare a persisted claim safe or complete.
    if (heartbeatAgeMs < minOwnerSilenceMs || heartbeatAgeMs < 0) {
      return { ...base, status: "heartbeat_recent" };
    }
    const snapshot = readRecoverySnapshot(sqlite, row.id);
    if (!snapshot) return { ...base, status: "invalid_record" };
    try {
      const observation = observeRecovery(snapshot, probe);
      return { ...base,
        status: observation.decision === "candidate" ? "candidate" :
          observation.decision === "active" ? "active" : "quarantine",
        observation };
    } catch {
      // A failed native query is never permission to release a claim.
      return { ...base, status: "quarantine" };
    }
  });
  return { scanned: entries.length, entries,
    nextCursor: rows.length > limit ? page.at(-1)?.id : undefined,
    truncated: rows.length > limit, mode: "observe_only" };
}
