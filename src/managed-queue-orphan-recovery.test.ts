import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import Database from "better-sqlite3";
import {
  inspectManagedQueueOrphan, scanManagedQueueOrphans, readManagedQueueSnapshot,
} from "./managed-queue-orphan-recovery.js";
import { nativeRecoveryProbe } from "./windows-recovery-observer.js";

const windows = process.platform === "win32" ? {} : { skip: "Windows kernel process identity required" };
const fixture = fileURLToPath(new URL("./managed-queue-orphan-fixture.ts", import.meta.url));
const raceWorker = fileURLToPath(new URL("./managed-queue-orphan-worker.ts", import.meta.url));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const count = (db: Database.Database, table: string) =>
  (db.prepare(`select count(*) n from ${table}`).get() as { n: number }).n;

async function start(mode: "queued" | "promotion_rollback" | "promoted") {
  const dir = mkdtempSync(join(tmpdir(), "taskquay-queue-orphan-"));
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), fixture, mode, dir],
    { cwd: dir, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let errors = "";
  child.stderr?.on("data", (data: Buffer) => { errors += data.toString(); });
  const marker = join(dir, mode === "queued" ? "queue-ready.json" : "promotion-finished.json");
  for (let i = 0; i < 180 && !existsSync(marker) &&
    child.exitCode === null && child.signalCode === null; i++) await sleep(50);
  if (!existsSync(marker)) {
    child.kill("SIGKILL");
    throw new Error(`FIXTURE_START_FAILED mode=${mode}: ${errors}`);
  }
  const { ticketId, agentId } = JSON.parse(readFileSync(marker, "utf8")) as
    { ticketId: string; agentId: string };
  return {
    child, dir, ticketId, agentId,
    db: () => new Database(join(dir, "devspace.sqlite")),
    async terminate() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      for (let i = 0; i < 100 && child.exitCode === null && child.signalCode === null; i++) await sleep(30);
      assert.ok(child.exitCode !== null || child.signalCode !== null, "Fixture OS owner must exit");
    },
    async clean() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await sleep(250);
      await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    },
  };
}

test("real owner exits before promotion: only exact queue ticket is atomically stopped and audited", windows, async () => {
  const f = await start("queued");
  try {
    const db = f.db();
    try {
      const live = inspectManagedQueueOrphan(db, f.ticketId, { apply: true });
      assert.equal(live.status, "active", "Native verifier must protect a running owner");
      assert.equal(count(db, "execution_waiters"), 1);
      await f.terminate();
      const snapshot = readManagedQueueSnapshot(db, f.ticketId);
      assert.ok(snapshot);
      assert.equal(snapshot.owner_generation === null, false);
      const dryRun = inspectManagedQueueOrphan(db, f.ticketId);
      assert.equal(dryRun.status, "candidate", JSON.stringify(dryRun));
      assert.equal(count(db, "execution_waiters"), 1);
      db.pragma("query_only = ON");
      const scan = scanManagedQueueOrphans(db, {}, nativeRecoveryProbe);
      assert.equal(scan.mode, "observe_only");
      assert.equal(scan.entries[0]?.status, "candidate");
      db.pragma("query_only = OFF");
      const result = inspectManagedQueueOrphan(db, f.ticketId, { apply: true });
      assert.equal(result.status, "stopped");
      assert.equal(count(db, "execution_waiters"), 0);
      assert.equal(count(db, "execution_claims"), 0);
      assert.equal(count(db, "managed_executions"), 0);
      assert.equal(count(db, "console_executions"), 0);
      assert.equal(count(db, "local_agent_turns"), 0);
      assert.equal(count(db, "managed_queue_recovery_audit"), 1);
      const record = db.prepare("select status,error_code from local_agent_sessions where id=?")
        .get(f.agentId) as { status: string; error_code: string };
      assert.deepEqual(record, { status: "stopped", error_code: "AGENT_QUEUE_OWNER_EXITED" });
      assert.equal(inspectManagedQueueOrphan(db, f.ticketId, { apply: true }).status, "not_found");
      assert.equal(count(db, "managed_queue_recovery_audit"), 1, "Repeat never replays an Agent");
    } finally { db.close(); }
  } finally { await f.clean(); }
});

test("crash during atomic promotion rollback leaves only an unstarted ticket; verified owner loss stops it", windows, async () => {
  const f = await start("promotion_rollback");
  try {
    await f.terminate();
    const db = f.db();
    try {
      assert.equal(count(db, "execution_waiters"), 1);
      assert.equal(count(db, "execution_claims"), 0);
      assert.equal(count(db, "managed_executions"), 0);
      assert.equal(count(db, "local_agent_turns"), 0);
      assert.equal(inspectManagedQueueOrphan(db, f.ticketId, { apply: true }).status, "stopped");
      assert.equal(count(db, "managed_queue_recovery_audit"), 1);
    } finally { db.close(); }
  } finally { await f.clean(); }
});

test("promotion committed before GO: no ticket means no queue auto-recovery or replay, claim is held", windows, async () => {
  const f = await start("promoted");
  try {
    await f.terminate();
    const db = f.db();
    try {
      assert.equal(inspectManagedQueueOrphan(db, f.ticketId, { apply: true }).status, "not_found");
      assert.equal(count(db, "execution_waiters"), 0);
      assert.equal(count(db, "execution_claims"), 1);
      assert.equal(count(db, "managed_executions"), 1);
      assert.equal(count(db, "local_agent_turns"), 1);
      assert.equal(count(db, "managed_queue_recovery_audit"), 0);
      const managed = db.prepare("select phase,armed_evidence from managed_executions")
        .get() as {phase: string; armed_evidence: string | null};
      assert.deepEqual(managed, { phase: "starting", armed_evidence: null });
    } finally { db.close(); }
  } finally { await f.clean(); }
});

test("injected final ticket deletion failure rolls back Agent status and recovery audit", windows, async () => {
  const f = await start("queued");
  try {
    await f.terminate();
    const db = f.db();
    try {
      db.exec(`create trigger refuse_queue_delete before delete on execution_waiters
        begin select raise(abort,'INJECTED_QUEUE_DELETE_FAILURE'); end;`);
      assert.throws(() => inspectManagedQueueOrphan(db, f.ticketId, { apply: true }),
        /INJECTED_QUEUE_DELETE_FAILURE/);
      assert.equal(count(db, "execution_waiters"), 1);
      assert.equal(count(db, "managed_queue_recovery_audit"), 0);
      assert.equal((db.prepare("select status from local_agent_sessions where id=?")
        .get(f.agentId) as { status: string }).status, "queued");
      db.exec("drop trigger refuse_queue_delete");
      assert.equal(inspectManagedQueueOrphan(db, f.ticketId, { apply: true }).status, "stopped");
    } finally { db.close(); }
  } finally { await f.clean(); }
});

test("competing session update between observation and transaction fails CAS and preserves ticket", windows, async () => {
  const f = await start("queued");
  try {
    await f.terminate();
    const db = f.db();
    try {
      const mutatingProbe = {
        ...nativeRecoveryProbe,
        process: (pid: number, createdAt: string) => {
          const state = nativeRecoveryProbe.process(pid, createdAt);
          db.prepare("update local_agent_sessions set status='error' where id=?")
            .run(f.agentId);
          return state;
        },
      };
      assert.throws(() => inspectManagedQueueOrphan(db, f.ticketId, { apply: true }, mutatingProbe),
        /QUEUE_ORPHAN_CAS_CHANGED/);
      assert.equal(count(db, "execution_waiters"), 1);
      assert.equal(count(db, "managed_queue_recovery_audit"), 0);
      assert.equal((db.prepare("select status from local_agent_sessions where id=?")
        .get(f.agentId) as { status: string }).status, "error");
    } finally { db.close(); }
  } finally { await f.clean(); }
});

for (let round = 1; round <= 4; round++) {
  test(`two independent native queue recovery workers stop a proven-unstarted ticket only once (round ${round}/4)`,
    windows, async () => {
      const f = await start("queued");
      try {
        await f.terminate();
        const run = () => {
          const child = spawn(process.execPath,
            ["--import", import.meta.resolve("tsx"), raceWorker, f.dir, f.ticketId],
            { cwd: f.dir, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
          const result = new Promise<{ status: string; reason?: string }>((resolve, reject) => {
            let out = "", stderr = "";
            child.stdout?.on("data", (data: Buffer) => { out += data.toString(); });
            child.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });
            child.on("error", reject);
            child.on("close", (code) => {
              try { resolve(JSON.parse(out)); }
              catch { reject(new Error(`QUEUE_WORKER_FAILED code=${code}: ${stderr}`)); }
            });
          });
          return { child, result };
        };
        const a = run(), b = run();
        try {
          writeFileSync(join(f.dir, "queue-race-go"), "go");
          let timeout: NodeJS.Timeout | undefined;
          let outcome: Array<{ status: string; reason?: string }>;
          try {
            outcome = await Promise.race([
              Promise.all([a.result, b.result]),
              new Promise<never>((_resolve, reject) => {
                timeout = setTimeout(() => reject(new Error("QUEUE_RACE_TEST_TIMEOUT")), 20_000);
              }),
            ]);
          } finally { if (timeout) clearTimeout(timeout); }
          assert.equal(outcome.filter((entry) => entry.status === "stopped").length, 1,
            JSON.stringify(outcome));
          assert.ok(outcome.every((entry) =>
            ["stopped", "not_found", "rejected"].includes(entry.status)));
          const db = f.db();
          try {
            assert.equal(count(db, "managed_queue_recovery_audit"), 1);
            assert.equal(count(db, "execution_waiters"), 0);
            assert.equal(count(db, "local_agent_turns"), 0);
            assert.equal(count(db, "execution_claims"), 0);
          } finally { db.close(); }
        } finally {
          if (a.child.exitCode === null && a.child.signalCode === null) a.child.kill("SIGKILL");
          if (b.child.exitCode === null && b.child.signalCode === null) b.child.kill("SIGKILL");
        }
      } finally { await f.clean(); }
    });
}
