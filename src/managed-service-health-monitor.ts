import type { ExecutionCoordinator } from "./execution-coordinator.js";
import type { ManagedServiceHandle } from "./managed-service-supervisor.js";

export type ServiceHealthOutcome = "healthy" | "unhealthy" | "probe_error";
export type ServiceHealthEvent = {
  sequence: number; service_id: string; owner_id: string;
  owner_generation: string; outcome: ServiceHealthOutcome;
  note: string; sampled_at: string;
};

/**
 * One service / one exact supervisor Owner generation.
 * A negative check records evidence but NEVER kills, releases a port,
 * changes resource_state or replays a service/model request.
 */
export class ManagedServiceHealthMonitor {
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<ServiceHealthEvent | undefined>;
  private closed = false;
  constructor(private readonly coordinator: ExecutionCoordinator,
    private readonly handle: Pick<ManagedServiceHandle, "serviceId" | "checkHealth">,
    private readonly intervalMs = 3_000) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 50 || intervalMs > 3_600_000) {
      throw new Error("SERVICE_HEALTH_INTERVAL_INVALID");
    }
  }

  async sample(): Promise<ServiceHealthEvent | undefined> {
    if (this.closed) throw new Error("SERVICE_HEALTH_MONITOR_CLOSED");
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.observeAndCommit();
    try { return await this.inFlight; }
    finally { this.inFlight = undefined; }
  }

  private async observeAndCommit(): Promise<ServiceHealthEvent | undefined> {
    const serviceId = this.handle.serviceId;
    const before = this.coordinator.sharedDatabaseHandle.sqlite.prepare(
      "select service_id, owner_id, owner_generation, execution_id, state from managed_service_reservations where service_id=?",
    ).get(serviceId) as {
      service_id: string; owner_id: string; owner_generation: string;
      execution_id: string; state: string;
    } | undefined;
    if (!before || before.state !== "running" ||
        before.owner_id !== this.coordinator.managedOwnerId) return undefined;
    let outcome: ServiceHealthOutcome;
    let note: string;
    try {
      const healthy = await this.handle.checkHealth();
      outcome = healthy ? "healthy" : "unhealthy";
      note = healthy ? "native_job_and_http_identity_verified" : "health_identity_not_verified";
    } catch {
      outcome = "probe_error";
      note = "health_probe_failed_without_native_exit_proof";
    }
    return this.coordinator.withManagedState((db) => {
      const owner = db.prepare(
        "select generation, status from execution_owners where id=?",
      ).get(before.owner_id) as { generation: string; status: string } | undefined;
      const current = db.prepare(
        "select service_id, owner_id, owner_generation, execution_id, state from managed_service_reservations where service_id=?",
      ).get(serviceId) as typeof before | undefined;
      if (!current || current.state !== "running" ||
          current.owner_id !== before.owner_id ||
          current.owner_generation !== before.owner_generation ||
          current.execution_id !== before.execution_id ||
          owner?.generation !== before.owner_generation || owner.status !== "active") {
        // The service was stopped/promoted/reowned during a slow health request.
        // Never append stale status against the wrong Owner generation.
        return undefined;
      }
      const sampledAt = new Date().toISOString();
      const inserted = db.prepare(`insert into managed_service_health_journal
        (service_id,owner_id,owner_generation,outcome,note,sampled_at)
        values (?,?,?,?,?,?)`).run(
        serviceId, before.owner_id, before.owner_generation,
        outcome, note, sampledAt);
      return {
        sequence: Number(inserted.lastInsertRowid), service_id: serviceId,
        owner_id: before.owner_id, owner_generation: before.owner_generation,
        outcome, note, sampled_at: sampledAt,
      };
    });
  }

  start(): void {
    if (this.closed || this.timer) throw new Error("SERVICE_HEALTH_MONITOR_ALREADY_STARTED");
    this.timer = setInterval(() => {
      void this.sample().catch(() => {
        // A failed database write is not evidence of a dead service.
        // Preserve all reservation/claim rows; the caller may inspect logs.
      });
    }, this.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight?.catch(() => undefined);
  }
}

/** Read-only, bounded ordered audit view. No hidden automatic recovery. */
export function readServiceHealthJournal(coordinator: ExecutionCoordinator, serviceId: string,
  options: { afterSequence?: number; limit?: number } = {}): ServiceHealthEvent[] {
  const cursor = options.afterSequence ?? 0, limit = options.limit ?? 25;
  if (!Number.isSafeInteger(cursor) || cursor < 0 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("SERVICE_HEALTH_READ_BOUND_INVALID");
  }
  return coordinator.sharedDatabaseHandle.sqlite.prepare(`
    select sequence,service_id,owner_id,owner_generation,outcome,note,sampled_at
    from managed_service_health_journal where service_id=? and sequence>?
    order by sequence limit ?`).all(serviceId, cursor, limit) as ServiceHealthEvent[];
}

/** Persisted audit rows drive alert state. Never treat consecutive failed
 * HTTP checks as authority to kill a process or unlock a reservation.
 * The alert can be safely recomputed after a supervisor process restart.
 */
export function readServiceHealthAlert(coordinator: ExecutionCoordinator, serviceId: string,
  threshold=3): {active:boolean; consecutiveFailures:number; lastSequence:number|null} {
  if (!Number.isSafeInteger(threshold) || threshold<1 || threshold>20) {
    throw new Error("SERVICE_HEALTH_ALERT_THRESHOLD_INVALID");
  }
  const rows=coordinator.sharedDatabaseHandle.sqlite.prepare(
    "select sequence,outcome from managed_service_health_journal where service_id=? order by sequence desc limit ?",
  ).all(serviceId,threshold) as {sequence:number;outcome:ServiceHealthOutcome}[];
  let consecutiveFailures=0;
  for (const row of rows) {
    if (row.outcome==="healthy") break;
    consecutiveFailures++;
  }
  return {active:consecutiveFailures>=threshold,consecutiveFailures,
    lastSequence:rows[0]?.sequence ?? null};
}
