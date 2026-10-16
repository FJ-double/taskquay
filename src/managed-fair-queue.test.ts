import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ExecutionCoordinator, type ExecutionClaimInput,
  type ManagedAdmissionTicket } from "./execution-coordinator.js";
import { ExecutionStateStore, type ExecutionOwnerIdentity } from "./execution-state-store.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
type Admitted = { id: string; executionId: string; coord: ExecutionCoordinator };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "taskquay-managed-fifo-"));
  const stateDir = join(dir, "state");
  const roots = Array.from({ length: 10 }, (_, i) => join(dir, `checkout-${i}`));
  roots.forEach((root) => mkdirSync(root, { recursive: true }));
  const a = new ExecutionCoordinator(stateDir), b = new ExecutionCoordinator(stateDir);
  const owners = new Map([[a, "a"], [b, "b"]].map(([coord, suffix]) => {
    const owner: ExecutionOwnerIdentity = { id: (coord as ExecutionCoordinator).managedOwnerId,
      kind: "agentd", pid: process.pid,
      processCreatedAt: "2026-10-14T00:00:00.000Z", bootId: "fixture-boot",
      generation: `fixture-generation-${suffix}` };
    (coord as ExecutionCoordinator).registerManagedOwner(owner);
    return [coord as ExecutionCoordinator, owner] as const;
  }));
  const input = (n: number, extra: Partial<ExecutionClaimInput> = {}): ExecutionClaimInput => ({
    workspaceRoot: roots[n], kind: "agent", agentId: `agent-${n}`,
    access: "write", maxConcurrentAgents: 4, resources: [], ...extra,
  });
  let serial = 0;
  const attach = (coord: ExecutionCoordinator, input: ExecutionClaimInput) =>
    (sqlite: Parameters<Parameters<ExecutionCoordinator["admitManaged"]>[1]>[0],
      _handle: unknown, _claimId: string) => {
      const owner = owners.get(coord)!;
      const value = new ExecutionStateStore(sqlite).create({
        kind: "agent", workspaceId: "fixture-workspace",
        checkoutRoot: input.workspaceRoot, owner, access: input.access ?? "write",
        resources: [...(input.resources ?? [])],
        idempotencyScope: "fifo-staging",
        requestKey: `ticket-${++serial}-${randomUUID()}`,
        requestHash: sha(JSON.stringify(input)), initialPhase: "starting",
      });
      assert.equal(value.created, true);
      return { executionId: value.execution.id, value: value.execution.id };
    };
  const immediate = (coord: ExecutionCoordinator, input: ExecutionClaimInput): Admitted => {
    const result = coord.admitManaged(input, attach(coord, input));
    return { id: result.claim.id, executionId: result.value, coord };
  };
  const waiting = (coord: ExecutionCoordinator, input: ExecutionClaimInput, waitMs = 120_000) => {
    const ticket: ManagedAdmissionTicket = coord.enqueueManaged(input, waitMs);
    return { ticket, tryAdmit: () => {
      const result = ticket.tryAdmit(attach(coord, input));
      return result ? { id: result.claim.id, executionId: result.value, coord } : undefined;
    } };
  };
  const finish = (entry: Admitted) => {
    entry.coord.completeManaged(entry.executionId, (sqlite) => {
      const store = new ExecutionStateStore(sqlite);
      let row = store.get(entry.executionId)!;
      row = store.transition({ executionId: row.id, expectedGeneration: row.generation,
        expectedVersion: row.state_version, phase: "terminal", outcome: "failed",
        resourceState: "cleanup_pending" });
      store.transition({ executionId: row.id, expectedGeneration: row.generation,
        expectedVersion: row.state_version, resourceState: "released",
        exitEvidence: { kind: "never_dispatched_verified", verifiedAt: new Date().toISOString(),
          verifier: "managed-fifo-test", detail: "fixture never spawns workers" } });
    });
  };
  const count = (table: string) => (a.sharedDatabaseHandle.sqlite.prepare(
    `select count(*) n from ${table}`).get() as { n: number }).n;
  const cleanup = () => {
    a.close(); b.close();
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
  };
  return { a, b, input, roots, immediate, waiting, finish, count, cleanup };
}

test("four different checkouts run together across independent owners; fifth waits for released slot", () => {
  const f = fixture();
  try {
    const running = Array.from({ length: 4 }, (_, i) =>
      f.immediate(i % 2 ? f.b : f.a, f.input(i)));
    assert.equal(f.count("execution_claims"), 4);
    const fifth = f.waiting(f.a, f.input(4));
    assert.equal(fifth.tryAdmit(), undefined);
    assert.equal(f.count("execution_waiters"), 1);
    assert.equal(f.count("managed_executions"), 4);
    f.finish(running[0]);
    assert.equal(f.count("execution_claims"), 3);
    const admitted = fifth.tryAdmit();
    assert.ok(admitted, "fifth may enter after a proven release");
    assert.equal(f.count("execution_claims"), 4);
    assert.equal(f.count("execution_waiters"), 0);
    assert.throws(() => fifth.tryAdmit(), /EXPIRED_OR_CANCELLED/,
      "ticket cannot replay an already dispatched inference");
    running.slice(1).forEach(f.finish);
    f.finish(admitted!);
    assert.equal(f.count("execution_claims"), 0);
  } finally { f.cleanup(); }
});

test("first runnable queued Agent reserves the global slot even if a younger ticket is tried first", () => {
  const f = fixture();
  try {
    const active = [0,1,2,3].map((i) => f.immediate(f.a, f.input(i)));
    const older = f.waiting(f.a, f.input(4));
    const newer = f.waiting(f.b, f.input(5));
    f.finish(active[0]);
    assert.equal(newer.tryAdmit(), undefined, "younger cannot barge into older's one free slot");
    const first = older.tryAdmit();
    assert.ok(first);
    assert.equal(newer.tryAdmit(), undefined);
    f.finish(active[1]);
    const second = newer.tryAdmit();
    assert.ok(second);
    [...active.slice(2), first!, second!].forEach(f.finish);
    assert.equal(f.count("execution_claims"), 0);
  } finally { f.cleanup(); }
});

test("busy checkout does not stall an unrelated runnable queue entry", () => {
  const f = fixture();
  try {
    const busy = f.immediate(f.a, f.input(0));
    const blocked = f.waiting(f.a, f.input(0, { agentId: "new-agent-on-busy-checkout" }));
    const independent = f.waiting(f.b, f.input(1));
    assert.equal(blocked.tryAdmit(), undefined);
    const admitted = independent.tryAdmit();
    assert.ok(admitted, "work-conserving FIFO allows unrelated job to use a free slot");
    assert.equal(blocked.tryAdmit(), undefined);
    f.finish(busy);
    const afterwards = blocked.tryAdmit();
    assert.ok(afterwards);
    [admitted!, afterwards!].forEach(f.finish);
  } finally { f.cleanup(); }
});

test("queued writer prevents later same-checkout writer, even across owner connections", () => {
  const f = fixture();
  try {
    const initial = f.immediate(f.a, f.input(0));
    const first = f.waiting(f.a, f.input(0, { agentId: "writer-1" }));
    const second = f.waiting(f.b, f.input(0, { agentId: "writer-2" }));
    f.finish(initial);
    assert.equal(second.tryAdmit(), undefined);
    const promoted = first.tryAdmit();
    assert.ok(promoted);
    assert.equal(second.tryAdmit(), undefined);
    f.finish(promoted!);
    const next = second.tryAdmit();
    assert.ok(next);
    f.finish(next!);
  } finally { f.cleanup(); }
});

test("failed admitted callback atomically retains FIFO ticket and does not create a claim", () => {
  const f = fixture();
  try {
    const input = f.input(0);
    const ticket = f.a.enqueueManaged(input, 120_000);
    assert.throws(() => ticket.tryAdmit(() => { throw new Error("INJECTED_LEDGER_FAILURE"); }),
      /INJECTED_LEDGER_FAILURE/);
    assert.equal(f.count("execution_claims"), 0);
    assert.equal(f.count("managed_executions"), 0);
    assert.equal(f.count("execution_waiters"), 1);
    ticket.cancel();
    assert.equal(f.count("execution_waiters"), 0);
    assert.equal(f.count("execution_claims"), 0);
  } finally { f.cleanup(); }
});

test("direct managed admissions cannot bypass queued runnable Agent when capacity is tight", () => {
  const f = fixture();
  try {
    const active = [0,1,2,3].map((i) => f.immediate(f.a, f.input(i)));
    const queued = f.waiting(f.b, f.input(4));
    f.finish(active[0]);
    assert.throws(() => f.immediate(f.a, f.input(5)), /Earlier runnable managed Agent/);
    const admitted = queued.tryAdmit();
    assert.ok(admitted);
    [...active.slice(1), admitted!].forEach(f.finish);
  } finally { f.cleanup(); }
});

test("24 FIFO tickets eventually enter in their original order as one global slot recycles", () => {
  const f = fixture();
  try {
    const initial = [0,1,2,3].map((i) => f.immediate(f.a, f.input(i)));
    const waiting = Array.from({ length: 24 }, (_, i) => f.waiting(i % 2 ? f.b : f.a,
      f.input(4 + (i % 6), { agentId: `fifo-agent-${i}`,
        resources: [`fifo-global-resource-${i}`] })));
    assert.equal(f.count("execution_waiters"), 24);
    for (let i = 0; i < waiting.length; i++) {
      if (i === 0) f.finish(initial[0]);
      const next = waiting[i].tryAdmit();
      assert.ok(next, `FIFO ticket ${i} should be admitted without starvation`);
      if (i + 1 < waiting.length) {
        assert.equal(waiting[i + 1].tryAdmit(), undefined,
          "Later ticket must not overtake current occupant of the sole free slot");
      }
      f.finish(next!);
    }
    initial.slice(1).forEach(f.finish);
    assert.equal(f.count("execution_claims"), 0);
    assert.equal(f.count("execution_waiters"), 0);
  } finally { f.cleanup(); }
});

test("an explicit resource key serializes unrelated checkouts", () => {
  const f = fixture();
  try {
    const shared = "shared-device-control";
    const first = f.immediate(f.a, f.input(0, { resources: [shared] }));
    const second = f.waiting(f.b, f.input(1, { resources: [shared] }));
    assert.equal(second.tryAdmit(), undefined, "Shared resource must serialize independent roots");
    f.finish(first);
    const admitted = second.tryAdmit();
    assert.ok(admitted);
    f.finish(admitted!);
  } finally { f.cleanup(); }
});

test("cancelled and expired FIFO intents never create a claim or Provider execution", async () => {
  const f = fixture();
  try {
    const one = f.a.enqueueManaged(f.input(0), 1000);
    one.cancel();
    assert.throws(() => one.tryAdmit(() => { throw new Error("SHOULD_NOT_RUN"); }),
      /EXPIRED_OR_CANCELLED/);
    const two = f.b.enqueueManaged(f.input(1), 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.throws(() => two.tryAdmit(() => { throw new Error("SHOULD_NOT_RUN"); }),
      /EXPIRED_OR_CANCELLED/);
    assert.equal(f.count("execution_claims"), 0);
    assert.equal(f.count("managed_executions"), 0);
  } finally { f.cleanup(); }
});

test("legacy enqueue and acquire never TTL-delete an expired v19 managed waiter", async () => {
  const f = fixture();
  try {
    const managed = f.a.enqueueManaged(f.input(0), 1);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const oldWaiter = f.b.enqueue({ ...f.input(1), kind: "read", agentId: "old-queue" }, 1000);
    assert.equal(f.count("execution_waiters"), 2,
      "Legacy enqueue must not delete the expired managed ticket before native recovery");
    const read = f.b.acquire({ ...f.input(2), kind: "read", agentId: "reader" });
    try {
      assert.equal(f.count("execution_waiters"), 2,
        "Legacy acquire also must not bypass OS-proof-gated managed queue recovery");
      assert.throws(() => managed.tryAdmit(() => { throw new Error("NEVER_DISPATCH"); }),
        /EXPIRED_OR_CANCELLED/);
    } finally { read.release(); oldWaiter.cancel(); managed.cancel(); }
  } finally { f.cleanup(); }
});

test("24 repeated fair FIFO rounds keep four agents or fewer active and leave no orphan claims", () => {
  for (let round = 0; round < 24; round++) {
    const f = fixture();
    try {
      const active = [0,1,2,3].map((i) =>
        f.immediate(i % 2 ? f.b : f.a, f.input(i)));
      const pending = Array.from({ length: 16 }, (_, i) =>
        f.waiting(i % 2 ? f.b : f.a, f.input(4 + (i % 6), {
          agentId: `stress-${round}-${i}`,
          resources: [`stress:${round}:${i}`],
        })));
      for (let n = 0; n < pending.length; n++) {
        if (n === 0) f.finish(active.shift()!);
        const admitted = pending[n].tryAdmit();
        assert.ok(admitted, `FIFO ${round}:${n} starved`);
        assert.ok(f.count("execution_claims") <= 4);
        if (n + 1 < pending.length) {
          assert.equal(pending[n + 1].tryAdmit(), undefined,
            "Younger ticket cannot overtake when only one slot remains");
        }
        f.finish(admitted!);
      }
      active.forEach(f.finish);
      assert.equal(f.count("execution_claims"), 0);
      assert.equal(f.count("execution_waiters"), 0);
      assert.equal(f.count("managed_executions"), 20);
    } finally { f.cleanup(); }
  }
});
