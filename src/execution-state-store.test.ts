import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import Database from "better-sqlite3";
import { migrateDatabase } from "./db/migrations.js";
import { ExecutionStateStore, type CreateExecutionInput, type ExecutionOwnerIdentity } from "./execution-state-store.js";

const owner: ExecutionOwnerIdentity = {
  id: "owner-test-1", kind: "mcp", pid: 8801,
  processCreatedAt: "2026-10-14T00:00:00Z", bootId: "boot-test", generation: "generation-1",
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const baseInput = (key = "task-key"): CreateExecutionInput => ({
  kind: "command", workspaceId: "ws-fixture", checkoutRoot: "C:/test/source",
  owner, access: "write", resources: ["port:10101"], idempotencyScope: "run-fixture",
  requestKey: key, requestHash: hash("semantic-command-and-context"),
  initialPhase: "starting",
});

function fixture() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrateDatabase(db);
  const store = new ExecutionStateStore(db);
  store.registerOwner(owner);
  return { db, store };
}

test("same-key calls return the existing execution and never invoke side effects twice", () => {
  const { db, store } = fixture();
  try {
    let calls = 0;
    const first = store.create(baseInput(), (conn, executionId) => {
      calls++;
      conn.prepare(`insert into execution_claims
        (id,owner_id,owner_pid,kind,checkout_root,agent_id,resources,acquired_at,access_mode,execution_id)
        values (?,?,?,?,?,?,?,?,?,?)`).run("claim-test", owner.id, owner.pid, "command",
        "C:/test/source", null, '["port:10101"]', new Date().toISOString(), "write", executionId);
    });
    const duplicate = store.create(baseInput(), () => { calls++; });
    assert.equal(first.created, true);
    assert.equal(duplicate.created, false);
    assert.equal(first.execution.id, duplicate.execution.id);
    assert.equal(calls, 1);
    assert.equal((db.prepare("select count(*) as n from execution_claims").get() as { n: number }).n, 1);
    assert.equal((db.prepare("select count(*) as n from execution_audit").get() as { n: number }).n, 1);
    assert.throws(() => store.create({ ...baseInput(), requestHash: hash("other command") }), /IDEMPOTENCY_CONFLICT/);
  } finally { db.close(); }
});

test("ledger/claim creation failure rolls back execution identity and audit in the SAME transaction", () => {
  const { db, store } = fixture();
  try {
    assert.throws(() => store.create(baseInput("rollback"), () => {
      throw new Error("ledger refused write");
    }), /ledger refused/);
    assert.equal((db.prepare("select count(*) as n from managed_executions").get() as { n: number }).n, 0);
    assert.equal((db.prepare("select count(*) as n from execution_audit").get() as { n: number }).n, 0);
    assert.throws(() => store.withWorkUnit(async () => 123), /synchronous/);
    assert.equal(db.inTransaction, false);
  } finally { db.close(); }
});

test("Job arming persists identity and CAS rejects stale updates, resurrection and proofless release", () => {
  const { db, store } = fixture();
  try {
    const created = store.create(baseInput()).execution;
    assert.equal(created.phase, "starting");
    assert.equal(created.resource_state, "held");
    assert.throws(() => store.transition({
      executionId: created.id, expectedVersion: 0, expectedGeneration: 1,
      phase: "terminal", outcome: "completed", resourceState: "released",
    }), /RESOURCE_PROOF_REQUIRED/);
    const armed = store.arm({
      executionId: created.id, expectedVersion: 0, expectedGeneration: 1,
      pid: 8802, createdAt: "2026-10-14T01:00:00Z", bootId: "boot-test",
      jobIdentity: "job-test", evidence: "verified runner assigned to job",
    });
    assert.equal(armed.state_version, 1);
    assert.equal(armed.runner_pid, 8802);
    assert.throws(() => store.arm({
      executionId: created.id, expectedVersion: 0, expectedGeneration: 1,
      pid: 8803, createdAt: "2026-10-14T01:00:00Z", bootId: "boot-test",
      jobIdentity: "another", evidence: "different",
    }), /EXECUTION_VERSION_CONFLICT/);
    const running = store.transition({
      executionId: created.id, expectedVersion: 1, expectedGeneration: 1, phase: "running",
    });
    const terminal = store.transition({
      executionId: created.id, expectedVersion: running.state_version, expectedGeneration: 1,
      phase: "terminal", outcome: "completed", resourceState: "cleanup_pending",
    });
    assert.equal(terminal.outcome, "completed");
    assert.equal(terminal.resource_state, "cleanup_pending");
    assert.throws(() => store.transition({
      executionId: created.id, expectedVersion: terminal.state_version, expectedGeneration: 1,
      phase: "running",
    }), /Invalid execution phase|Terminal execution/);
    assert.throws(() => store.transition({
      executionId: created.id, expectedVersion: terminal.state_version, expectedGeneration: 1,
      outcome: "failed",
    }), /immutable/);
    const released = store.transition({
      executionId: created.id, expectedVersion: terminal.state_version, expectedGeneration: 1,
      resourceState: "released",
      exitEvidence: {
        kind: "job_empty_verified", verifiedAt: "2026-10-14T01:05:00Z",
        verifier: "test-verifier", detail: "zero active job members",
      },
    });
    assert.equal(released.outcome, "completed");
    assert.equal(released.resource_state, "released");
    assert.equal(JSON.parse(released.exit_evidence!).kind, "job_empty_verified");
    assert.throws(() => store.transition({
      executionId: created.id, expectedVersion: terminal.state_version, expectedGeneration: 1,
      resourceState: "quarantined",
    }), /EXECUTION_VERSION_CONFLICT/);
  } finally { db.close(); }
});

test("owner identity cannot be reused for a different process; heartbeat is not death proof", () => {
  const { db, store } = fixture();
  try {
    assert.equal(store.heartbeat(owner), true);
    assert.equal(store.heartbeat({ ...owner, bootId: "other-boot" }), false);
    assert.throws(() => store.registerOwner({ ...owner, pid: 9901 }), /reused/);
  } finally { db.close(); }
});

test("version 17 legacy claims and waiter order survive upgrade to version 21", () => {
  const db = new Database(":memory:");
  try {
    migrateDatabase(db);
    // Build a truthful v17 fixture using the previous NOT NULL waiter definition.
    db.exec(`
      drop table execution_audit;
      drop table managed_queue_recovery_audit;
      drop table managed_service_health_journal;
      drop table managed_service_reservations;
      drop table managed_executions;
      drop table execution_owners;
      alter table execution_claims drop column execution_id;
      alter table execution_waiters rename to execution_waiters_v18_fixture;
      create table execution_waiters (
        sequence integer primary key autoincrement,
        id text not null unique, owner_id text not null, owner_pid integer not null,
        kind text not null, checkout_root text not null, agent_id text,
        thread_key text, access_mode text not null, resources text not null,
        expires_at_ms integer not null
      );
      drop table execution_waiters_v18_fixture;
      create index execution_waiters_order on execution_waiters(sequence);
      delete from devspace_schema_migrations where version=18;
      delete from devspace_schema_migrations where version=19;
      delete from devspace_schema_migrations where version=20;
      delete from devspace_schema_migrations where version=21;
      insert into execution_claims
        (id,owner_id,owner_pid,kind,checkout_root,agent_id,resources,acquired_at,access_mode,thread_key)
        values ('legacy-claim','old-owner',1234,'agent','C:/old',null,'[]','2026-09-01','write',null);
      insert into execution_waiters
        (sequence,id,owner_id,owner_pid,kind,checkout_root,agent_id,thread_key,access_mode,resources,expires_at_ms)
        values (42,'legacy-waiter','old-owner',1234,'agent','C:/old',null,null,'write','[]',2000000000000);
    `);
    const historyBefore = db.prepare("select version,name,applied_at from devspace_schema_migrations order by version").all();
    migrateDatabase(db);
    assert.deepEqual(db.prepare("select version,name,applied_at from devspace_schema_migrations where version<=17 order by version").all(),
      (historyBefore as Array<{ version: number }>).filter((entry) => entry.version <= 17));
    assert.deepEqual(db.prepare("select id,execution_id from execution_claims where id='legacy-claim'").get(),
      { id: "legacy-claim", execution_id: null });
    assert.deepEqual(db.prepare("select sequence,id,execution_id from execution_waiters where id='legacy-waiter'").get(),
      { sequence: 42, id: "legacy-waiter", execution_id: null });
    const column = (db.pragma("table_info(execution_waiters)") as Array<{ name: string; notnull: number }>)
      .find((entry) => entry.name === "expires_at_ms");
    assert.equal(column?.notnull, 0);
    db.prepare(`insert into execution_waiters
      (id,owner_id,owner_pid,kind,checkout_root,agent_id,thread_key,access_mode,resources,expires_at_ms)
      values ('infinite','owner',1,'agent','C:/new',null,null,'write','[]',null)`).run();
    assert.equal((db.prepare("select sequence from execution_waiters where id='infinite'").get() as { sequence: number }).sequence, 43);
    migrateDatabase(db);
    assert.equal((db.prepare("select count(*) as n from devspace_schema_migrations").get() as { n: number }).n, 21);
    assert.equal((db.pragma("table_info(execution_waiters)") as Array<{name: string}>)
      .some((entry) => entry.name === "owner_generation"), true);
  } finally { db.close(); }
});
