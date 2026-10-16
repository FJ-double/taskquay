import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import Database from "better-sqlite3";
import { migrateDatabase } from "./db/migrations.js";
import { ExecutionStateStore, type ExecutionOwnerIdentity } from "./execution-state-store.js";
import { sweepManagedRecovery } from "./windows-recovery-sweep.js";
import type { RecoveryOsProbe } from "./windows-recovery-observer.js";

const boot = "win-ntboot-v1:abcdef01-2345-6789-abcd-1234567890ab:01db3abcdef01234";
const oldBoot = "win-ntboot-v1:abcdef02-2345-6789-abcd-1234567890ab:01db3abcdef01100";
const hash = createHash("sha256").update("automatic-recovery-disposable").digest("hex");
const absent: RecoveryOsProbe = {
  boot: () => boot,
  process: () => "absent_or_reused",
  job: () => "absent",
};
function fixture(kind: "command" | "agent" | "service" = "command",
  arm = true, ownerBoot = boot) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrateDatabase(db);
  const owner: ExecutionOwnerIdentity = {
    id: randomUUID(), kind: "mcp", pid: 99001,
    processCreatedAt: "2026-10-14T00:00:00.000Z",
    bootId: ownerBoot, generation: randomUUID(),
  };
  const store = new ExecutionStateStore(db);
  store.registerOwner(owner);
  const row = store.create({
    kind, owner, workspaceId: "isolated", checkoutRoot: "C:/disposable",
    access: "write", resources: [], idempotencyScope: "recovery-sweep-test",
    requestHash: hash, initialPhase: "starting",
  }, (sqlite, executionId) => {
    sqlite.prepare(`insert into execution_claims
      (id,owner_id,owner_pid,kind,checkout_root,agent_id,resources,acquired_at,access_mode,execution_id)
      values (?,?,?,?,?,?,?,?,?,?)`).run(
      "claim_" + randomUUID().replaceAll("-", ""), owner.id, owner.pid,
      kind === "agent" ? "agent" : "command", "C:/disposable",
      null, "[]", new Date().toISOString(), "write", executionId);
  }).execution;
  if (arm) {
    const armed = store.arm({
      executionId: row.id, expectedVersion: 0, expectedGeneration: 1,
      pid: 99002, createdAt: "2026-10-14T00:00:02.000Z",
      bootId: ownerBoot,
      jobIdentity: "Local\\taskquay-job-4a56df09-e451-4dd5-a5c0-8c6b107d0013",
      evidence: "native-test-membership",
    });
    store.transition({ executionId: row.id, expectedVersion: armed.state_version,
      expectedGeneration: 1, phase: "running" });
  }
  const claimCount = () => (db.prepare("select count(*) n from execution_claims")
    .get() as { n: number }).n;
  const heartbeat = (at: number) => db.prepare(
    "update execution_owners set heartbeat_at_ms=? where id=?").run(at, owner.id);
  return { db, owner, id: row.id, heartbeat, claimCount };
}

test("95-second timeout only initiates native inspection; recent heartbeat never unlocks", () => {
  const x = fixture();
  try {
    const recent = sweepManagedRecovery(x.db, { minOwnerSilenceMs: 95_000 }, absent);
    assert.equal(recent.released, 0);
    assert.equal(x.claimCount(), 1);
    x.heartbeat(Date.now() - 100_000);
    const verified = sweepManagedRecovery(x.db, { minOwnerSilenceMs: 95_000 }, absent);
    assert.equal(verified.released, 1);
    assert.equal(x.claimCount(), 0);
    const row = x.db.prepare("select phase,outcome,resource_state,exit_evidence from managed_executions where id=?")
      .get(x.id) as { phase: string; outcome: string; resource_state: string; exit_evidence: string };
    assert.deepEqual([row.phase, row.outcome, row.resource_state],
      ["terminal", "interrupted", "released"]);
    assert.equal(JSON.parse(row.exit_evidence).kind, "job_empty_verified");
    assert.equal(sweepManagedRecovery(x.db, {}, absent).released, 0);
  } finally { x.db.close(); }
});

test("unarmed jobs, live owner, active Job and service reservations never auto-release", () => {
  for (const scenario of ["unarmed", "owner_alive", "job_active", "service"] as const) {
    const x = fixture(scenario === "service" ? "service" : "command", scenario !== "unarmed");
    try {
      x.heartbeat(Date.now() - 100_000);
      const probe: RecoveryOsProbe = {
        ...absent,
        process: scenario === "owner_alive" ? () => "same" : absent.process,
        job: scenario === "job_active" ? () => "exists_active" : absent.job,
      };
      const result = sweepManagedRecovery(x.db, {}, probe);
      assert.equal(result.released, 0, scenario);
      assert.equal(x.claimCount(), 1, scenario);
    } finally { x.db.close(); }
  }
});

test("prior boot remains quarantined pending field approval despite candidate OS evidence", () => {
  const x = fixture("command", true, oldBoot);
  try {
    x.heartbeat(Date.now() - 100_000);
    const result = sweepManagedRecovery(x.db, {}, absent);
    assert.equal(result.entries[0]?.reason, "RECOVERY_PRIOR_BOOT_REQUIRES_FIELD_VALIDATION");
    assert.equal(result.released, 0);
    assert.equal(x.claimCount(), 1);
  } finally { x.db.close(); }
});

test("heartbeat update while inspecting a Job defeats the release transaction", () => {
  const x = fixture();
  try {
    x.heartbeat(Date.now() - 100_000);
    let probes = 0;
    const probe: RecoveryOsProbe = {
      ...absent,
      job: () => {
        if (++probes === 2) x.heartbeat(Date.now());
        return "absent";
      },
    };
    const result = sweepManagedRecovery(x.db, {}, probe);
    assert.equal(result.released, 0);
    assert.equal(result.entries[0]?.reason, "RECOVERY_OWNER_HEARTBEAT_CHANGED");
    assert.equal(x.claimCount(), 1);
    assert.equal((x.db.prepare("select resource_state from managed_executions where id=?")
      .get(x.id) as { resource_state: string }).resource_state, "held");
  } finally { x.db.close(); }
});

test("scanner cursor allows a bounded sweep to continue after a quarantined row", () => {
  const x = fixture("command", false);
  try {
    x.heartbeat(Date.now() - 100_000);
    const first = sweepManagedRecovery(x.db, { limit: 1 }, absent);
    assert.equal(first.scanned, 1);
    assert.equal(first.released, 0);
    assert.equal(x.claimCount(), 1);
    assert.equal(first.nextCursor, undefined);
  } finally { x.db.close(); }
});
