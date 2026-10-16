import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import Database from "better-sqlite3";
import { migrateDatabase } from "./db/migrations.js";
import { ExecutionStateStore, type ExecutionOwnerIdentity } from "./execution-state-store.js";
import { scanManagedRecovery } from "./windows-recovery-scanner.js";
import type { RecoveryOsProbe } from "./windows-recovery-observer.js";

const boot = "win-ntboot-v1:abcdef01-2345-6789-abcd-1234567890ab:01db3abcdef01234";
const owner: ExecutionOwnerIdentity = {
  id: "scanner-owner", kind: "mcp", pid: 99112,
  processCreatedAt: "2026-10-14T00:00:00.000Z",
  bootId: boot, generation: "scanner-generation",
};
const hash = createHash("sha256").update("scan-fixture").digest("hex");
const job = "Local\\taskquay-job-4a56df09-e451-4dd5-a5c0-8c6b107d0013";
function fixture(count = 3) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrateDatabase(db);
  const store = new ExecutionStateStore(db);
  store.registerOwner(owner);
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const created = store.create({
      kind: "command", workspaceId: "ws", checkoutRoot: "C:/scan-target",
      owner, access: "write", resources: [],
      idempotencyScope: "scan-fixture", requestKey: String(i),
      requestHash: hash, initialPhase: "starting",
    }, (sqlite, executionId) => {
      sqlite.prepare(`insert into execution_claims
        (id,owner_id,owner_pid,kind,checkout_root,agent_id,resources,acquired_at,access_mode,execution_id)
        values (?,?,?,?,?,?,?,?,?,?)`).run(
        `claim-scanner-${i}`, owner.id, owner.pid, "command",
        "C:/scan-target", null, "[]", new Date().toISOString(), "write", executionId);
    }).execution;
    ids.push(created.id);
    if (i > 0) {
      const armed = store.arm({
        executionId: created.id, expectedGeneration: 1, expectedVersion: 0,
        pid: 99113 + i, createdAt: "2026-10-14T00:00:02.000Z", bootId: boot,
        jobIdentity: job.replace("0013", String(10 + i).padStart(4, "0")),
        evidence: "os-assigned",
      });
      store.transition({ executionId: created.id, expectedVersion: armed.state_version,
        expectedGeneration: 1, phase: "running" });
    }
  }
  return { db, ids };
}
const absent: RecoveryOsProbe = {
  boot: () => boot,
  process: () => "absent_or_reused",
  job: () => "absent",
};

test("scanner is read-only; stale heartbeat allows OS candidate observation, not release", () => {
  const { db } = fixture();
  try {
    const stamp = (db.prepare("select heartbeat_at_ms from execution_owners")
      .get() as {heartbeat_at_ms: number}).heartbeat_at_ms;
    db.pragma("query_only = ON");
    const scan = scanManagedRecovery(db, { nowMs: stamp + 120_001, limit: 10 }, absent);
    assert.equal(scan.mode, "observe_only");
    assert.equal(scan.scanned, 3);
    assert.equal(scan.entries.filter((e) => e.status === "candidate").length, 2);
    assert.equal(scan.entries.filter((e) => e.status === "quarantine").length, 1);
    assert.equal((db.prepare("select count(*) n from execution_claims").get() as {n:number}).n, 3);
    assert.equal((db.prepare("select count(*) n from execution_audit").get() as {n:number}).n, 7);
  } finally { db.close(); }
});

test("recent heartbeat defers native inspection; missing proof and stale TTL never auto-release", () => {
  const { db } = fixture(2);
  try {
    const stamp = (db.prepare("select heartbeat_at_ms from execution_owners")
      .get() as {heartbeat_at_ms: number}).heartbeat_at_ms;
    let probes = 0;
    const observed = scanManagedRecovery(db, { nowMs: stamp + 1000 }, {
      ...absent, boot: () => { probes++; return boot; },
    });
    assert.ok(observed.entries.every((e) => e.status === "heartbeat_recent"));
    assert.equal(probes, 0);
    const stale = scanManagedRecovery(db, { nowMs: stamp + 5_000_000 }, absent);
    assert.equal(stale.entries[0]?.status === "quarantine" ||
      stale.entries[1]?.status === "quarantine", true);
    assert.equal((db.prepare("select count(*) n from execution_claims").get() as {n:number}).n, 2);
  } finally { db.close(); }
});

test("bounded keyset pagination scans all rows once without modifying SQLite", () => {
  const { db, ids } = fixture(5);
  try {
    const stamp = (db.prepare("select heartbeat_at_ms from execution_owners")
      .get() as {heartbeat_at_ms: number}).heartbeat_at_ms;
    let afterExecutionId: string | undefined;
    const seen: string[] = [];
    for (let n = 0; n < 4; n++) {
      const page = scanManagedRecovery(db, { limit: 2, afterExecutionId,
        nowMs: stamp + 120_001 }, absent);
      seen.push(...page.entries.map((item) => item.executionId));
      if (!page.nextCursor) break;
      afterExecutionId = page.nextCursor;
    }
    assert.deepEqual([...seen].sort(), [...ids].sort());
    assert.equal(new Set(seen).size, 5);
    assert.equal((db.prepare("select count(*) n from managed_executions").get() as {n:number}).n, 5);
    assert.throws(() => scanManagedRecovery(db, { limit: 101 }), /BOUNDS/);
    assert.throws(() => scanManagedRecovery(db, { minOwnerSilenceMs: 500 }), /BOUNDS/);
    assert.throws(() => scanManagedRecovery(db, { afterExecutionId: "1;drop table" }), /CURSOR/);
    assert.equal(scanManagedRecovery(db, { checkoutRoot: "C:/different" }).scanned, 0);
  } finally { db.close(); }
});
