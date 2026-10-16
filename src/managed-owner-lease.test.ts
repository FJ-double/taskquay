import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { migrateDatabase } from "./db/migrations.js";
import { ExecutionStateStore, type ExecutionOwnerIdentity } from "./execution-state-store.js";
import { ManagedOwnerLease } from "./managed-owner-lease.js";

const owner: ExecutionOwnerIdentity = {
  id: "lease-owner-test", kind: "mcp", pid: 98112,
  processCreatedAt: "2026-10-14T00:00:00.000Z",
  bootId: "fixture-boot", generation: "lease-1",
};
function makeDb() {
  const db = new Database(":memory:");
  migrateDatabase(db);
  const store = new ExecutionStateStore(db);
  store.registerOwner(owner);
  return { db, store };
}

test("managed lease heartbeats preserve exact owner generation and stop closes the timer", () => {
  const { db, store } = makeDb();
  const lease = new ManagedOwnerLease(db, owner, 50, 150);
  try {
    lease.start();
    assert.equal(lease.snapshot().active, true);
    assert.equal(lease.beat(), true);
    const row = db.prepare("select status,heartbeat_at_ms from execution_owners where id=?")
      .get(owner.id) as {status: string;heartbeat_at_ms: number};
    assert.equal(row.status, "active");
    assert.ok(row.heartbeat_at_ms > 0);
    lease.stop();
    assert.equal(lease.beat(), false);
    assert.throws(() => lease.assertCanAdmit(), /NOT_RUNNING/);
    assert.equal(store.heartbeat(owner), true, "A stopped timer is NOT death evidence");
  } finally { lease.stop(); db.close(); }
});

test("changed PID/generation or a dead owner fences new admissions", () => {
  const { db } = makeDb();
  const lease = new ManagedOwnerLease(db, owner, 50, 150);
  try {
    lease.start();
    db.prepare("update execution_owners set generation=? where id=?").run("stolen-generation", owner.id);
    assert.equal(lease.beat(), false);
    assert.throws(() => lease.assertCanAdmit(), /UNVERIFIED/);
    db.prepare("update execution_owners set generation=?,status='dead' where id=?")
      .run(owner.generation, owner.id);
    assert.equal(lease.beat(), false);
    assert.throws(() => lease.assertCanAdmit(), /UNVERIFIED/);
    assert.equal((db.prepare("select status from execution_owners where id=?")
      .get(owner.id) as { status: string }).status, "dead");
  } finally { lease.stop(); db.close(); }
});

test("transient SQLite heartbeat failure is fail-closed but can rejoin exact owner safely", () => {
  const { db } = makeDb();
  const lease = new ManagedOwnerLease(db, owner, 50, 150);
  try {
    lease.start();
    db.exec(`create trigger block_heartbeat before update on execution_owners
      begin select raise(abort,'INJECTED_DB_BUSY'); end;`);
    assert.equal(lease.beat(), false);
    assert.equal(lease.snapshot().active, false);
    assert.throws(() => lease.assertCanAdmit(), /UNVERIFIED/);
    db.exec("drop trigger block_heartbeat");
    lease.assertCanAdmit();
    assert.equal(lease.snapshot().active, true);
  } finally { lease.stop(); db.close(); }
});

test("a successful but stale heartbeat is rechecked before a new admission", () => {
  const { db } = makeDb();
  let ms = Date.now();
  const lease = new ManagedOwnerLease(db, owner, 50, 150, () => ms);
  try {
    lease.start();
    const old = lease.snapshot().lastSuccessMs;
    ms += 10_000;
    lease.assertCanAdmit();
    assert.ok(lease.snapshot().lastSuccessMs > old);
  } finally { lease.stop(); db.close(); }
});
