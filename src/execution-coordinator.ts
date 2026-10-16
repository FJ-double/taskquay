import { randomUUID } from "node:crypto";
import { realpathSync, existsSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import type Database from "better-sqlite3";
import { ExecutionStateStore, type ExecutionOwnerIdentity } from "./execution-state-store.js";
import { canonicalPathIdentity } from "./roots.js";

export type SourceAccess = "read" | "write";

export interface ExecutionClaimInput {
  workspaceRoot: string;
  kind: "agent" | "command" | "mutation" | "read";
  /** Only the trusted adapter/host reader assigns read, never inferred from a prompt. */
  access?: SourceAccess;
  agentId?: string;
  threadKey?: string;
  resources?: readonly string[];
  maxConcurrentAgents?: number;
  maxConcurrentReaders?: number;
}

interface ClaimRow {
  id: string; owner_id: string; owner_pid: number;
  kind: ExecutionClaimInput["kind"];
  checkout_root: string; agent_id: string | null; thread_key: string | null;
  access_mode: SourceAccess; resources: string; acquired_at?: string;
}
interface WaiterRow extends ClaimRow { sequence: number; expires_at_ms: number }

export interface ExecutionClaim {
  readonly id: string;
  bindThread(threadKey: string): void;
  release(): void;
}
export interface ExecutionTicket {
  readonly id: string;
  tryAcquire(): ExecutionClaim | undefined;
  cancel(): void;
}
/** Experimental managed FIFO ticket. Persisting a ticket never starts a
 * Provider and never writes a WorkLedger execution. At admission, the
 * callback, claim, managed execution and ticket removal commit together.
 */
export interface ManagedAdmissionTicket {
  readonly id: string;
  tryAdmit<T>(admitted: (sqlite: Database.Database, handle: DatabaseHandle,
    claimId: string) => { executionId: string; value: T }): { claim: ExecutionClaim; value: T } | undefined;
  cancel(): void;
}

export class ExecutionConflictError extends Error {
  readonly code = "EXECUTION_CONFLICT";
  constructor(readonly claimId: string, readonly agentId: string | undefined, reason: string) {
    super(`${reason}. Wait or observe the owner; reuse its session only for related work. Claim: ${claimId}.`);
    this.name = "ExecutionConflictError";
  }
}

/** Aliases and subdirectories identify one real checkout; linked worktrees remain distinct. */
export function canonicalExecutionRoot(path: string): string {
  const real = realpathSync(resolve(path));
  let cursor = real;
  for (;;) {
    if (existsSync(resolve(cursor, ".git"))) return canonicalPathIdentity(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) return canonicalPathIdentity(real);
    cursor = parent;
  }
}
function contains(parent: string, child: string): boolean {
  const rest = relative(parent, child);
  return rest === "" || (!isAbsolute(rest) && rest !== ".." && !rest.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}
export function overlaps(a: string, b: string): boolean { return contains(a, b) || contains(b, a); }
function resourceOverlap(a: ClaimRow, b: ClaimRow): boolean {
  const resources = JSON.parse(a.resources) as string[];
  return (JSON.parse(b.resources) as string[]).some((key) => resources.includes(key));
}
function exclusiveConflict(a: ClaimRow, b: ClaimRow): boolean {
  return Boolean((a.agent_id && a.agent_id === b.agent_id) ||
    (a.thread_key && a.thread_key === b.thread_key) || resourceOverlap(a, b) ||
    (overlaps(a.checkout_root, b.checkout_root) && (a.access_mode !== "read" || b.access_mode !== "read")));
}

/** Cooperative cross-process admission, not an OS sandbox. Active claims are never stolen. */
export class ExecutionCoordinator {
  private readonly database: DatabaseHandle;
  private readonly ownerId = randomUUID();
  private closed = false;

  constructor(stateDir: string) { this.database = openDatabase(stateDir); }
  /** Exact owned handle used by the explicitly opted-in AgentStore/ledger. */
  get sharedDatabaseHandle(): DatabaseHandle { return this.database; }
  get managedOwnerId(): string { return this.ownerId; }
  registerManagedOwner(owner: ExecutionOwnerIdentity): void {
    if (owner.id !== this.ownerId) throw new Error("Managed owner must match claim owner identity.");
    new ExecutionStateStore(this.database.sqlite).registerOwner(owner);
  }
  withManagedState<T>(update: (sqlite: Database.Database, handle: DatabaseHandle) => T): T {
    return this.database.sqlite.transaction(() => update(this.database.sqlite, this.database)).immediate();
  }

  /** Atomic managed admission: claim, execution identity and optional WorkLedger
   * operation must use THIS connection. The callback must not launch a process.
   * Legacy acquire/release remains untouched until its callers are migrated.
   */
  admitManaged<T>(input: ExecutionClaimInput, admitted: (
    sqlite: Database.Database, database: DatabaseHandle, claimId: string,
  ) => { executionId: string; value: T }): { claim: ExecutionClaim; value: T } {
    const candidate = this.row(input);
    return this.database.sqlite.transaction(() => {
      const blocker = this.blocker(candidate, input);
      if (blocker) throw new ExecutionConflictError(blocker.id, blocker.agent_id ?? undefined,
        "Source, thread, resource or concurrency limit is occupied");
      const prior = this.managedCapacityFairnessBlocker(candidate, input);
      if (prior) throw new ExecutionConflictError(prior.id, prior.agent_id ?? undefined,
        "Earlier runnable managed Agent is waiting for a global execution slot");
      const claim = this.insert(candidate);
      const { executionId, value } = admitted(this.database.sqlite, this.database, claim.id);
      if (!/^ex_[a-f0-9]{32}$/.test(executionId)) throw new Error("Invalid managed execution identity.");
      this.database.sqlite.prepare("update execution_claims set execution_id=? where id=?")
        .run(executionId, claim.id);
      return { claim, value };
    }).immediate();
  }

  /**
   * Work-conserving FIFO for up to four independently scoped Agent jobs.
   * Older runnable tickets reserve free global slots before younger tickets.
   * Older tickets blocked on a busy checkout do not idle an unrelated slot,
   * but an older conflicting writer always blocks younger readers/writers.
   *
    * LocalAgentManager's opted-in managed path consumes these tickets;
    * legacy queue paths remain separate.
   */
  enqueueManaged(input: ExecutionClaimInput, waitMs: number): ManagedAdmissionTicket {
    if (input.kind !== "agent") throw new Error("MANAGED_FIFO_AGENTS_ONLY");
    const candidate = this.row({ ...input, maxConcurrentAgents: input.maxConcurrentAgents ?? 4 });
    if (!Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > 900_000) {
      throw new Error("MANAGED_FIFO_TIMEOUT_INVALID");
    }
    const normalized = { ...input, maxConcurrentAgents: input.maxConcurrentAgents ?? 4 };
    const expiry = Date.now() + waitMs;
    this.database.sqlite.transaction(() => {
      // Managed tickets are not swept by TTL; their owner/Agent status must
      // be reconciled in one transaction after exact kernel identity checks.
      this.database.sqlite.prepare(
        "delete from execution_waiters where expires_at_ms <= ? and owner_generation is null",
      ).run(Date.now());
      const owner = this.database.sqlite.prepare(
        "select generation,status from execution_owners where id=?",
      ).get(this.ownerId) as { generation: string; status: string } | undefined;
      if (!owner || owner.status !== "active") {
        throw new Error("MANAGED_FIFO_OWNER_NOT_ACTIVE");
      }
      const active = (this.database.sqlite.prepare("select count(*) n from execution_waiters")
        .get() as { n: number }).n;
      if (active >= 64) throw new ExecutionConflictError("queue", undefined,
        "Managed FIFO capacity reached; no provider invoked");
      this.database.sqlite.prepare(`insert into execution_waiters
        (id,owner_id,owner_pid,kind,checkout_root,agent_id,thread_key,access_mode,resources,expires_at_ms,owner_generation)
        values (?,?,?,?,?,?,?,?,?,?,?)`).run(
        candidate.id, this.ownerId, process.pid, "agent", candidate.checkout_root,
        candidate.agent_id, candidate.thread_key, candidate.access_mode, candidate.resources, expiry, owner.generation);
    }).immediate();
    return {
      id: candidate.id,
      tryAdmit: <T>(admitted: (sqlite: Database.Database, handle: DatabaseHandle,
        claimId: string) => { executionId: string; value: T }) =>
        this.database.sqlite.transaction(() => {
          if (this.closed) throw new Error("MANAGED_FIFO_COORDINATOR_CLOSED");
          const ticket = this.database.sqlite.prepare(
            "select w.* from execution_waiters w join execution_owners o on o.id=w.owner_id and o.generation=w.owner_generation where w.id=? and w.owner_id=? and o.status='active'",
          ).get(candidate.id, this.ownerId) as WaiterRow | undefined;
          if (!ticket || ticket.expires_at_ms === null ||
              ticket.expires_at_ms <= Date.now()) {
            throw new Error("MANAGED_FIFO_TICKET_EXPIRED_OR_CANCELLED");
          }
          if (ticket.kind !== "agent" || ticket.checkout_root !== candidate.checkout_root ||
              ticket.agent_id !== candidate.agent_id ||
              ticket.thread_key !== candidate.thread_key ||
              ticket.access_mode !== candidate.access_mode ||
              ticket.resources !== candidate.resources) {
            throw new Error("MANAGED_FIFO_TICKET_IDENTITY_CHANGED");
          }
          if (this.blocker(candidate, normalized, ticket.sequence) ||
              this.managedCapacityFairnessBlocker(candidate, normalized, ticket.sequence)) return undefined;
          const inserted = this.insert(candidate);
          const { executionId, value } = admitted(this.database.sqlite, this.database, inserted.id);
          if (!/^ex_[a-f0-9]{32}$/.test(executionId)) throw new Error("MANAGED_FIFO_EXECUTION_ID_INVALID");
          const updated = this.database.sqlite.prepare(
            "update execution_claims set execution_id=? where id=? and owner_id=?",
          ).run(executionId, inserted.id, this.ownerId);
          if (updated.changes !== 1) throw new Error("MANAGED_FIFO_CLAIM_LINK_FAILED");
          const removed = this.database.sqlite.prepare(
            "delete from execution_waiters where id=? and owner_id=?",
          ).run(candidate.id, this.ownerId);
          if (removed.changes !== 1) throw new Error("MANAGED_FIFO_TICKET_LOST");
          return { claim: inserted, value };
        }).immediate(),
      cancel: () => {
        if (!this.closed) this.database.sqlite.prepare(
          "delete from execution_waiters where id=? and owner_id=?",
        ).run(candidate.id, this.ownerId);
      },
    };
  }

  private managedCapacityFairnessBlocker(candidate: ClaimRow, input: ExecutionClaimInput,
    sequence = Number.MAX_SAFE_INTEGER): ClaimRow | undefined {
    if (candidate.kind !== "agent") return undefined;
    const agents = this.database.sqlite.prepare(
      "select * from execution_claims where kind='agent'",
    ).all() as ClaimRow[];
    const slots = (input.maxConcurrentAgents ?? 4) - agents.length;
    if (slots <= 0) return agents[0];
    const earlier = this.database.sqlite.prepare(`select * from execution_waiters
      where kind='agent' and sequence < ? and expires_at_ms > ?
      order by sequence`).all(sequence, Date.now()) as WaiterRow[];
    const runnable: ClaimRow[] = [];
    for (const waiting of earlier) {
      if (agents.some((active) => exclusiveConflict(waiting, active)) ||
          runnable.some((reserved) => exclusiveConflict(waiting, reserved))) continue;
      if (waiting.access_mode === "read") {
        const readers = [...agents, ...runnable].filter((active) =>
          active.access_mode === "read" && overlaps(active.checkout_root, waiting.checkout_root));
        if (readers.length >= (input.maxConcurrentReaders ?? 2)) continue;
      }
      runnable.push(waiting);
      if (runnable.length >= slots) return waiting;
    }
    return undefined;
  }

  /** Proof-gated claim release. Nothing is released if finalization fails;
   * both state and deletion commit together on the admission connection.
   */
  completeManaged<T>(executionId: string, complete: (
    sqlite: Database.Database, database: DatabaseHandle,
  ) => T): T {
    return this.database.sqlite.transaction(() => {
      const value = complete(this.database.sqlite, this.database);
      const row = this.database.sqlite.prepare(
        "select resource_state from managed_executions where id=?",
      ).get(executionId) as { resource_state: string } | undefined;
      if (!row || row.resource_state !== "released") {
        throw new Error("MANAGED_RELEASE_UNVERIFIED: Job evidence is not committed.");
      }
      this.database.sqlite.prepare("delete from execution_claims where execution_id=?").run(executionId);
      return value;
    }).immediate();
  }

  private row(input: ExecutionClaimInput): ClaimRow {
    if (this.closed) throw new Error("Execution coordinator is closed.");
    const resources = [...new Set(input.resources ?? [])].sort();
    if (resources.length > 16 || resources.some((key) => !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(key))) {
      throw new Error("Use at most 16 explicit, bounded resource keys.");
    }
    for (const value of [input.maxConcurrentAgents ?? 2, input.maxConcurrentReaders ?? 2]) {
      if (!Number.isInteger(value) || value < 1 || value > 16) throw new Error("Concurrency must be between 1 and 16.");
    }
    if (input.access !== undefined && input.access !== "read" && input.access !== "write") throw new Error("Invalid source access.");
    return { id: `claim_${randomUUID().replaceAll("-", "")}`, owner_id: this.ownerId, owner_pid: process.pid,
      kind: input.kind, checkout_root: canonicalExecutionRoot(input.workspaceRoot), agent_id: input.agentId ?? null,
      thread_key: input.threadKey ?? null, access_mode: input.access ?? "write", resources: JSON.stringify(resources) };
  }

  private blocker(candidate: ClaimRow, input: ExecutionClaimInput, sequence = Number.MAX_SAFE_INTEGER): ClaimRow | undefined {
    // Expired WAITERS never started work. Active claims have no timeout-steal path.
    this.database.sqlite.prepare(
      "delete from execution_waiters where expires_at_ms <= ? and owner_generation is null",
    ).run(Date.now());
    const active = this.database.sqlite.prepare("select * from execution_claims").all() as ClaimRow[];
    const conflict = active.find((row) => exclusiveConflict(candidate, row));
    if (conflict) return conflict;
    const prior = this.database.sqlite.prepare(`select * from execution_waiters
      where sequence < ? and (expires_at_ms is null or expires_at_ms > ?)
      order by sequence`).all(sequence, Date.now()) as WaiterRow[];
    // An earlier writer blocks later readers; neither reader-to-writer upgrades nor reader barging.
    const waiting = prior.find((row) => exclusiveConflict(candidate, row));
    if (waiting) return waiting;
    if (candidate.kind === "agent") {
      const agents = active.filter((row) => row.kind === "agent");
      if (agents.length >= (input.maxConcurrentAgents ?? 2)) return agents[0];
      const readers = agents.filter((row) => row.access_mode === "read" && overlaps(row.checkout_root, candidate.checkout_root));
      if (candidate.access_mode === "read" && readers.length >= (input.maxConcurrentReaders ?? 2)) return readers[0];
    }
    return undefined;
  }

  private insert(row: ClaimRow): ExecutionClaim {
    this.database.sqlite.prepare(`insert into execution_claims
      (id, owner_id, owner_pid, kind, checkout_root, agent_id, resources, acquired_at, access_mode, thread_key)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.id, row.owner_id, row.owner_pid, row.kind, row.checkout_root, row.agent_id, row.resources,
        new Date().toISOString(), row.access_mode, row.thread_key);
    let released = false;
    return {
      id: row.id,
      bindThread: (threadKey) => {
        if (released || this.closed) throw new Error("Execution claim is no longer active.");
        this.database.sqlite.transaction(() => {
          const other = this.database.sqlite.prepare("select * from execution_claims where thread_key = ? and id != ?")
            .get(threadKey, row.id) as ClaimRow | undefined;
          if (other) throw new ExecutionConflictError(other.id, other.agent_id ?? undefined, "Provider thread already active");
          this.database.sqlite.prepare("update execution_claims set thread_key = ? where id = ? and owner_id = ?")
            .run(threadKey, row.id, this.ownerId);
        }).immediate();
      },
      release: () => {
        if (released || this.closed) return;
        this.database.sqlite.prepare("delete from execution_claims where id = ? and owner_id = ?").run(row.id, this.ownerId);
        released = true;
      },
    };
  }

  acquire(input: ExecutionClaimInput): ExecutionClaim {
    const candidate = this.row(input);
    return this.database.sqlite.transaction(() => {
      const blocker = this.blocker(candidate, input);
      if (blocker) throw new ExecutionConflictError(blocker.id, blocker.agent_id ?? undefined, "Source, thread, resource or concurrency limit is occupied");
      return this.insert(candidate);
    }).immediate();
  }

  enqueue(input: ExecutionClaimInput, waitMs: number): ExecutionTicket {
    const candidate = this.row(input);
    if (!Number.isInteger(waitMs) || waitMs < 1 || waitMs > 900_000) throw new Error("Queue timeout must be 1–900000 ms.");
    this.database.sqlite.transaction(() => {
      // Managed (v19) waiting tickets are bound to a durable Owner generation.
      // A legacy admission MUST NOT sweep them solely because TTL expired.
      this.database.sqlite.prepare(
        "delete from execution_waiters where expires_at_ms <= ? and owner_generation is null",
      ).run(Date.now());
      const count = (this.database.sqlite.prepare("select count(*) as n from execution_waiters").get() as { n: number }).n;
      if (count >= 64) throw new ExecutionConflictError("queue", undefined, "Local queue capacity reached; no provider invoked");
      this.database.sqlite.prepare(`insert into execution_waiters
        (id, owner_id, owner_pid, kind, checkout_root, agent_id, thread_key, access_mode, resources, expires_at_ms)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(candidate.id, this.ownerId, process.pid, candidate.kind, candidate.checkout_root, candidate.agent_id,
          candidate.thread_key, candidate.access_mode, candidate.resources, Date.now() + waitMs);
    }).immediate();
    return {
      id: candidate.id,
      tryAcquire: () => this.database.sqlite.transaction(() => {
        const ticket = this.database.sqlite.prepare("select * from execution_waiters where id = ? and owner_id = ?")
          .get(candidate.id, this.ownerId) as WaiterRow | undefined;
        if (!ticket || ticket.expires_at_ms <= Date.now()) throw new Error("Execution wait expired or was cancelled; no provider invoked.");
        if (this.blocker(candidate, input, ticket.sequence)) return undefined;
        this.database.sqlite.prepare("delete from execution_waiters where id = ? and owner_id = ?").run(candidate.id, this.ownerId);
        return this.insert(candidate);
      }).immediate(),
      cancel: () => {
        if (!this.closed) this.database.sqlite.prepare("delete from execution_waiters where id = ? and owner_id = ?").run(candidate.id, this.ownerId);
      },
    };
  }

  async run<T>(input: ExecutionClaimInput, action: () => Promise<T>): Promise<T> {
    const claim = this.acquire(input);
    try { return await action(); } finally { claim.release(); }
  }

  inspect(workspaceRoot: string) {
    const root = canonicalExecutionRoot(workspaceRoot);
    const active = this.database.sqlite.prepare("select * from execution_claims").all() as ClaimRow[];
    const waiting = this.database.sqlite.prepare("select * from execution_waiters where expires_at_ms > ? order by sequence").all(Date.now()) as WaiterRow[];
    return [...active.map((row) => ({ ...row, state: "active" })), ...waiting.map((row) => ({ ...row, state: "queued" }))]
      .filter((row) => overlaps(row.checkout_root, root))
      .map((row) => ({ id: row.id, kind: row.kind, access: row.access_mode, state: row.state,
        agentId: row.agent_id ?? undefined, ownerPid: row.owner_pid, resources: JSON.parse(row.resources) as string[],
        acquiredAt: row.acquired_at,
        recovery: "Active claims require reconciliation after an interrupted owner; never replay or steal them by timeout." }));
  }

  /** Read-only queue evidence. Do not expose another workspace's agent, path or resource names. */
  waitingState(workspaceRoot: string, agentId: string) {
    const root = canonicalExecutionRoot(workspaceRoot);
    const ticket = this.database.sqlite.prepare("select * from execution_waiters where agent_id=? and checkout_root=? order by sequence limit 1")
      .get(agentId, root) as WaiterRow | undefined;
    if (!ticket) return undefined;
    const active = this.database.sqlite.prepare("select * from execution_claims").all() as ClaimRow[];
    const prior = this.database.sqlite.prepare("select * from execution_waiters where sequence < ? and expires_at_ms > ? order by sequence")
      .all(ticket.sequence, Date.now()) as WaiterRow[];
    const blockers = [...active, ...prior].filter((row) => exclusiveConflict(ticket, row));
    return { state: ticket.expires_at_ms <= Date.now() ? "expired_pending_settlement" : "queued",
      expiresAt: new Date(ticket.expires_at_ms).toISOString(),
      reason: blockers.length ? "claim_or_prior_waiter" : "admission_limit_or_pending_dispatch",
      owners: blockers.slice(0, 8).map((row) => ({ claimId: row.id, kind: row.kind, access: row.access_mode,
        scope: overlaps(row.checkout_root, root) ? "checkout" : "shared_resource", state: "sequence" in row ? "queued" : "active" })),
      ownersTruncated: blockers.length > 8,
      guidance: "Wait for admission or cancel this owned queued task. Active claims are never stolen; writes are never replayed automatically." };
  }

  close(): void {
    if (this.closed) return;
    // A waiting intent can safely disappear; an active child may still be running.
    this.database.sqlite.prepare("delete from execution_waiters where owner_id = ?").run(this.ownerId);
    this.closed = true;
    this.database.close();
  }
}
