import type Database from "better-sqlite3";
import { ExecutionStateStore, type ExecutionOwnerIdentity } from "./execution-state-store.js";

/**
 * Tracks the current OS-owning daemon generation. The heartbeat is a
 * liveness hint, NEVER authority to release an execution or steal a claim.
 * A missing/mismatched owner prevents NEW work; existing Jobs are not killed.
 */
export class ManagedOwnerLease {
  private timer?: NodeJS.Timeout;
  private closed = false;
  private healthy = false;
  private lastSuccessMs = 0;
  private lastError: string | undefined;

  constructor(private readonly sqlite: Database.Database,
    readonly owner: ExecutionOwnerIdentity,
    readonly heartbeatIntervalMs = 30_000,
    readonly maxHeartbeatSilenceMs = 95_000,
    private readonly clock: () => number = Date.now) {
    if (!Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 50 ||
        !Number.isSafeInteger(maxHeartbeatSilenceMs) ||
        maxHeartbeatSilenceMs < 2 * heartbeatIntervalMs) {
      throw new Error("MANAGED_OWNER_LEASE_INTERVAL_INVALID");
    }
  }

  /** The owner must have been registered with its exact PID and generation. */
  start(): void {
    if (this.timer || this.closed) throw new Error("MANAGED_OWNER_LEASE_ALREADY_STARTED");
    this.beat();
    if (!this.healthy) throw new Error("MANAGED_OWNER_LEASE_START_UNVERIFIED");
    this.timer = setInterval(() => { this.beat(); }, this.heartbeatIntervalMs);
    this.timer.unref();
  }

  beat(): boolean {
    if (this.closed) return false;
    try {
      if (!new ExecutionStateStore(this.sqlite).heartbeat(this.owner)) {
        this.healthy = false;
        this.lastError = "MANAGED_OWNER_IDENTITY_MISMATCH";
        return false;
      }
      this.healthy = true;
      this.lastSuccessMs = this.clock();
      this.lastError = undefined;
      return true;
    } catch (error) {
      this.healthy = false;
      this.lastError = error instanceof Error ? error.message : "MANAGED_OWNER_HEARTBEAT_ERROR";
      return false;
    }
  }

  assertCanAdmit(): void {
    if (this.closed || !this.timer) throw new Error("MANAGED_OWNER_LEASE_NOT_RUNNING");
    if (!this.healthy || this.clock() - this.lastSuccessMs > this.maxHeartbeatSilenceMs) {
      // Allow a synchronous recheck. A stale heartbeat alone is not proof of
      // owner death, but we cannot safely admit new work without an ACK.
      if (!this.beat()) throw new Error("MANAGED_OWNER_LEASE_UNVERIFIED");
    }
  }

  snapshot(): { active: boolean; lastSuccessMs: number; lastError?: string } {
    return { active: !this.closed && this.healthy, lastSuccessMs: this.lastSuccessMs,
      lastError: this.lastError };
  }

  stop(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    // Intentional: status isn't changed to "dead" by stop(). There may be
    // children or late cleanup pending. Only native proof can release them.
  }
}
