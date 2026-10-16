import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { migrateDatabase } from "./db/migrations.js";
import { ExecutionStateStore } from "./execution-state-store.js";
import { WindowsCommandRunner } from "./execution-runner.js";

const windowsOnly = process.platform === "win32" ? {} : { skip: "Windows Job Objects only" };
const id = () => `ex_${randomUUID().replaceAll("-", "")}`;

function active(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}
const env = () => Object.fromEntries(
  Object.entries(process.env).filter((part): part is [string, string] => typeof part[1] === "string"),
);
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
async function cleanupTestDirectory(dir: string): Promise<void> {
  // Windows may retain file/directory handles briefly after the Job empties.
  await pause(500);
  for (let attempt = 0; attempt < 8; attempt++) {
    try { await rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }); return; }
    catch (error) {
      if (attempt === 7) throw error;
      await pause(300);
    }
  }
}

test("Windows runner does not dispatch the command before armed, then proves Job emptiness", windowsOnly, async () => {
  const dir = mkdtempSync(join(tmpdir(), "taskquay-job-probe-"));
  const marker = join(dir, "marker.txt");
  let armed = false;
  let runner: WindowsCommandRunner | undefined;
  try {
    runner = await WindowsCommandRunner.start({
      executionId: id(), generation: 1, cwd: dir, environment: env(),
      command: "echo GO_CONFIRMED > marker.txt",
      persistArmed: async (proof) => {
        assert.equal(proof.memberCount, 1);
        assert.equal(active(proof.runnerPid), true);
        await pause(250);
        assert.equal(existsSync(marker), false, "User code must be blocked until durable arm");
        armed = true;
      },
    });
    assert.equal(armed, true);
    const finish = await runner.finished;
    assert.equal(finish.rootExitCode, 0);
    assert.equal(finish.stopReason, "root_exit");
    assert.equal(finish.activeProcesses, 0);
    assert.match(readFileSync(marker, "utf8"), /GO_CONFIRMED/);
    assert.equal(active(finish.runnerPid), false);
  } finally {
    if (runner) await runner.cancel(0).catch(() => undefined);
    await cleanupTestDirectory(dir);
  }
});

test("real Windows Job arming is durably stored before GO; completion retains the result until verified release", windowsOnly, async () => {
  const dir = mkdtempSync(join(tmpdir(), "taskquay-job-state-"));
  const database = new Database(join(dir, "state.sqlite"));
  database.pragma("foreign_keys=ON");
  migrateDatabase(database);
  const store = new ExecutionStateStore(database);
  const owner = {
    id: `owner-${randomUUID()}`, kind: "mcp" as const, pid: process.pid,
    processCreatedAt: "test:parent-created", bootId: "test:boot", generation: `gen-${randomUUID()}`,
  };
  store.registerOwner(owner);
  const row = store.create({
    kind: "command", workspaceId: "ws-isolated", checkoutRoot: dir,
    access: "write", resources: [], owner,
    requestHash: createHash("sha256").update("echo").digest("hex"),
    idempotencyScope: "fixture", initialPhase: "starting",
  }).execution;
  let runner: WindowsCommandRunner | undefined;
  try {
    runner = await WindowsCommandRunner.start({
      executionId: row.id, generation: row.generation,
      cwd: dir, command: "echo state_proof", environment: env(),
      persistArmed(proof) {
        assert.equal(proof.memberCount, 1);
        const armed = store.arm({
          executionId: proof.executionId,
          expectedVersion: 0, expectedGeneration: 1,
          pid: proof.runnerPid, createdAt: proof.runnerCreatedAt,
          bootId: owner.bootId, jobIdentity: proof.jobIdentity,
          evidence: `Windows API verified member count: ${proof.memberCount}`,
        });
        assert.ok(armed.armed_evidence);
        assert.match(armed.job_identity!, /taskquay-job-/);
      },
    });
    const proof = await runner.finished;
    assert.equal(proof.activeProcesses, 0);
    let state = store.transition({ executionId: row.id, expectedGeneration: 1, expectedVersion: 1, phase: "running" });
    state = store.transition({
      executionId: row.id, expectedGeneration: 1, expectedVersion: state.state_version,
      phase: "terminal", outcome: "completed", resourceState: "cleanup_pending",
    });
    assert.equal(state.outcome, "completed");
    state = store.transition({
      executionId: row.id, expectedGeneration: 1, expectedVersion: state.state_version,
      resourceState: "released",
      exitEvidence: { kind: "job_empty_verified", verifiedAt: proof.verifiedAt,
        verifier: "WindowsCommandRunner", detail: JSON.stringify(proof) },
    });
    assert.equal(state.resource_state, "released");
    assert.equal(state.outcome, "completed");
    assert.ok((database.prepare("select count(*) as n from execution_audit where execution_id=?")
      .get(row.id) as {n: number}).n >= 4);
  } finally {
    await runner?.cancel(0).catch(() => undefined);
    database.close();
    await cleanupTestDirectory(dir);
  }
});

test("failed durable arm prevents GO and kills only the paused bootstrap", windowsOnly, async () => {
  const dir = mkdtempSync(join(tmpdir(), "taskquay-job-armfail-"));
  const marker = join(dir, "should-not-run");
  try {
    await assert.rejects(WindowsCommandRunner.start({
      executionId: id(), generation: 1, cwd: dir,
      command: "echo failed > should-not-run", environment: env(),
      persistArmed() { throw new Error("STATE_DATABASE_COMMIT_FAILED"); },
    }), /STATE_DATABASE_COMMIT_FAILED/);
    assert.equal(existsSync(marker), false);
  } finally {
    await cleanupTestDirectory(dir);
  }
});

test("Windows closes KILL_ON_JOB_CLOSE Job after test owner crashes", windowsOnly, async () => {
  const dir = mkdtempSync(join(tmpdir(), "taskquay-job-owner-crash-"));
  const ownerFile = join(dir, "owner.mjs");
  const childFile = join(dir, "long-running.cjs");
  const readyFile = join(dir, "owner-ready.json");
  const sleeperPidFile = join(dir, "sleeper.pid");
  writeFileSync(childFile, `require("node:fs").writeFileSync("sleeper.pid", String(process.pid));
    setInterval(() => {}, 1000);`);
  writeFileSync(ownerFile, `import { WindowsCommandRunner } from ${JSON.stringify(new URL("./execution-runner.ts", import.meta.url).href)};
    import { writeFileSync } from "node:fs";
    const env = Object.fromEntries(Object.entries(process.env).filter(([,v]) => typeof v === "string"));
    const runner = await WindowsCommandRunner.start({
      executionId: ${JSON.stringify(id())}, generation: 1,
      command: "node long-running.cjs", cwd: ${JSON.stringify(dir)}, environment: env,
      persistArmed: () => {},
    });
    writeFileSync("owner-ready.json", JSON.stringify({ runnerPid: runner.runnerPid }));
    setInterval(() => {}, 1000);`);
  const ownerProcess = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), ownerFile], {
    cwd: dir, env: env(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  let diagnostic = "";
  ownerProcess.stderr?.on("data", (chunk: Buffer) => { diagnostic += chunk.toString(); });
  let runnerPid = 0;
  let sleeperPid = 0;
  try {
    for (let i = 0; (!existsSync(readyFile) || !existsSync(sleeperPidFile)) && i < 140; i++) await pause(50);
    assert.ok(existsSync(readyFile) && existsSync(sleeperPidFile), `Owner started Job; stderr=${diagnostic}`);
    runnerPid = JSON.parse(readFileSync(readyFile, "utf8")).runnerPid as number;
    sleeperPid = Number(readFileSync(sleeperPidFile, "utf8"));
    assert.ok(active(runnerPid) && active(sleeperPid));
    ownerProcess.kill("SIGKILL");
    for (let i = 0; (active(runnerPid) || active(sleeperPid)) && i < 120; i++) await pause(50);
    assert.equal(active(runnerPid), false, "Owner death must kill the Job bootstrap");
    assert.equal(active(sleeperPid), false, "Owner death must kill Job descendants");
  } finally {
    if (ownerProcess.exitCode === null) ownerProcess.kill("SIGKILL");
    await cleanupTestDirectory(dir);
  }
});

test("Windows Job cancellation kills descendants without impacting another Job", windowsOnly, async () => {
  const dir = mkdtempSync(join(tmpdir(), "taskquay-job-descendants-"));
  // Shell exits after launching its Node child; the child intentionally outlives it.
  const launcher = join(dir, "launch.cjs");
  const sleeper = join(dir, "sleeper.cjs");
  writeFileSync(sleeper, "setInterval(() => {}, 1000);");
  writeFileSync(launcher, `const {spawn}=require("node:child_process");
    const fs=require("node:fs");
    const c=spawn(process.execPath,[${JSON.stringify(sleeper)}],{stdio:"ignore",windowsHide:true});
    fs.writeFileSync(${JSON.stringify(join(dir, "child.pid"))},String(c.pid));
    c.unref();
    // Keep the root alive briefly so the observer can verify its child before
    // the runner's normal-exit cleanup terminates the entire Job.
    setTimeout(() => {}, 1200);`);
  let first: WindowsCommandRunner | undefined;
  let second: WindowsCommandRunner | undefined;
  let firstStderr = "";
  let secondStderr = "";
  try {
    first = await WindowsCommandRunner.start({
      executionId: id(), generation: 1, cwd: dir, environment: env(),
      command: "node launch.cjs",
      persistArmed: async () => {},
      onStderr: (chunk) => { firstStderr += chunk.toString(); },
    });
    second = await WindowsCommandRunner.start({
      executionId: id(), generation: 1, cwd: dir, environment: env(),
      command: "node sleeper.cjs",
      persistArmed: async () => {},
      onStderr: (chunk) => { secondStderr += chunk.toString(); },
    });
    for (let i = 0; !existsSync(join(dir, "child.pid")) && i < 100; i++) await pause(40);
    assert.ok(existsSync(join(dir, "child.pid")), `Launcher created a child; stderr=${firstStderr}; second=${secondStderr}`);
    const childPid = Number(readFileSync(join(dir, "child.pid"), "utf8"));
    assert.equal(active(childPid), true);
    const firstProof = await first.finished;
    assert.equal(firstProof.activeProcesses, 0);
    assert.equal(active(childPid), false, "Root exit alone must not release while child is alive");
    assert.ok(second.activeProcesses > 0, "Unrelated Job stays active");
    assert.equal(active(second.runnerPid), true);
    const secondProof = await second.cancel(0);
    assert.equal(secondProof.activeProcesses, 0);
  } finally {
    await Promise.allSettled([first?.cancel(0), second?.cancel(0)]);
    await cleanupTestDirectory(dir);
  }
});
