import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";

const windows = process.platform === "win32" ? {} : { skip: "Requires disposable Windows Job and native kernel observer" };
const crashOwner = fileURLToPath(new URL("./provider-owner-crash-fixture.ts", import.meta.url));
const raceWorker = fileURLToPath(new URL("./windows-recovery-race-worker.ts", import.meta.url));
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function marker(path: string, processToCheck: ChildProcess) {
  for (let i = 0; i < 180 && !existsSync(path) && processToCheck.exitCode === null; i++) await delay(50);
  assert.ok(existsSync(path), "Disposable owner did not reach durable armed boundary");
}
type WorkerOutput = { status: string; error?: string };
function spawnWorker(dir: string, id: string): { child: ChildProcess; result: Promise<WorkerOutput> } {
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"),
    raceWorker, dir, id], { cwd: dir, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const result = new Promise<WorkerOutput>((resolve, reject) => {
    let out = "", stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      try { resolve(JSON.parse(out) as WorkerOutput); }
      catch { reject(new Error(`Recovery worker failed (${code}): ${stderr}`)); }
    });
  });
  return { child, result };
}

for (let round = 1; round <= 6; round++) {
test(`two independent recovery processes cannot double-release one proven-dead Job claim (round ${round}/6)`, windows, async () => {
  const dir = mkdtempSync(join(tmpdir(), "taskquay-recovery-race-"));
  const owner = spawn(process.execPath, ["--import", import.meta.resolve("tsx"),
    crashOwner, "armed", dir], { cwd: dir, stdio: "ignore", windowsHide: true });
  const workers: ChildProcess[] = [];
  try {
    await marker(join(dir, "armed.json"), owner);
    const { executionId } = JSON.parse(readFileSync(join(dir, "admitted.json"), "utf8")) as
      { executionId: string };
    const { runnerPid } = JSON.parse(readFileSync(join(dir, "armed.json"), "utf8")) as
      { runnerPid: number };
    assert.equal(alive(runnerPid), true);
    if (owner.pid && alive(owner.pid)) owner.kill("SIGKILL");
    for (let i = 0; alive(owner.pid!) && i < 100; i++) await delay(50);
    for (let i = 0; alive(runnerPid) && i < 120; i++) await delay(50);
    assert.equal(alive(runnerPid), false, "Kernel must kill the managed Job before recovery");

    const first = spawnWorker(dir, executionId);
    const second = spawnWorker(dir, executionId);
    workers.push(first.child, second.child);
    writeFileSync(join(dir, "race-start"), "go");
    let timeout: NodeJS.Timeout | undefined;
    let outcomes: WorkerOutput[];
    try {
      outcomes = await Promise.race([
        Promise.all([first.result, second.result]),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("RECOVERY_RACE_WORKERS_TIMEOUT")), 20_000);
        }),
      ]);
    } finally { if (timeout) clearTimeout(timeout); }
    assert.equal(outcomes.filter((result) => result.status === "released").length, 1,
      `Exactly one recovery may release: ${JSON.stringify(outcomes)}`);
    assert.ok(outcomes.every((result) => ["released", "not_found", "rejected"].includes(result.status)));
    const db = new Database(join(dir, "devspace.sqlite"), { readonly: true });
    try {
      assert.equal((db.prepare("select count(*) as n from execution_claims where execution_id=?")
        .get(executionId) as { n: number }).n, 0);
      const row = db.prepare("select resource_state,outcome,exit_evidence from managed_executions where id=?")
        .get(executionId) as {resource_state: string;outcome: string;exit_evidence: string};
      assert.equal(row.resource_state, "released");
      assert.equal(row.outcome, "interrupted");
      assert.equal(JSON.parse(row.exit_evidence).kind, "job_empty_verified");
      const audit = db.prepare(`select count(*) as n from execution_audit
        where execution_id=? and action='transition' and next_state like '%released%'`)
        .get(executionId) as { n: number };
      assert.equal(audit.n, 1, "Exactly one terminal resource release is audited");
    } finally { db.close(); }
  } finally {
    if (owner.pid && alive(owner.pid)) owner.kill("SIGKILL");
    for (const worker of workers) if (worker.pid && alive(worker.pid)) worker.kill("SIGKILL");
    await delay(400);
    await rm(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
  }
});
}
