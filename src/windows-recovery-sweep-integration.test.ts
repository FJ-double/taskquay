import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import Database from "better-sqlite3";
import { ProcessSessionManager } from "./process-sessions.js";

const fixture = fileURLToPath(new URL("./provider-owner-crash-fixture.ts", import.meta.url));
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function alive(pid: number | undefined) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test("managed daemon heartbeat loop automatically reconciles a proven-dead disposable Job Claim", {
  skip: process.platform !== "win32",
  timeout: 35_000,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "taskquay-recovery-loop-live-"));
  const owner = spawn(process.execPath, ["--import", import.meta.resolve("tsx"),
    fixture, "armed", dir], { cwd: dir, stdio: "ignore", windowsHide: true });
  let manager: ProcessSessionManager | undefined;
  try {
    const marker = join(dir, "armed.json");
    for (let i = 0; i < 160 && !existsSync(marker) && owner.exitCode === null; i++) {
      await pause(50);
    }
    assert.equal(existsSync(marker), true, "isolated worker never reached native Job proof");
    const armed = JSON.parse(readFileSync(marker, "utf8")) as
      {runnerPid:number;executionId:string};
    assert.equal(alive(armed.runnerPid), true);
    assert.equal(owner.kill("SIGKILL"), true, "only the disposable test process may be stopped");
    for (let i = 0; i < 120 && (alive(owner.pid) || alive(armed.runnerPid)); i++) {
      await pause(50);
    }
    assert.equal(alive(owner.pid), false);
    assert.equal(alive(armed.runnerPid), false, "Job closure must precede Claim recovery");
    const db = new Database(join(dir, "devspace.sqlite"));
    try {
      db.prepare("update execution_owners set heartbeat_at_ms=? where pid=?")
        .run(Date.now() - 120_000, owner.pid);
      const held = db.prepare("select count(*) n from execution_claims where execution_id=?")
        .get(armed.executionId) as {n:number};
      assert.equal(held.n, 1);
    } finally { db.close(); }

    // Startup timer and native OS probe are real. The source tree and the
    // currently running Taskquay service/database are never touched.
    manager = new ProcessSessionManager({stateDir: dir, managedWindowsCommands: true});
    let released = false;
    for (let i = 0; i < 100 && !released; i++) {
      await pause(100);
      const view = new Database(join(dir, "devspace.sqlite"), {readonly:true});
      try {
        const n = view.prepare("select count(*) n from execution_claims where execution_id=?")
          .get(armed.executionId) as {n:number};
        released = n.n === 0;
      } finally { view.close(); }
    }
    assert.equal(released, true, "stale proven-dead Job must be automatically reconciled");
    const view = new Database(join(dir, "devspace.sqlite"), {readonly:true});
    try {
      const state = view.prepare("select phase,outcome,resource_state,exit_evidence from managed_executions where id=?")
        .get(armed.executionId) as
        {phase:string;outcome:string;resource_state:string;exit_evidence:string};
      assert.deepEqual([state.phase,state.outcome,state.resource_state],
        ["terminal","interrupted","released"]);
      assert.equal(JSON.parse(state.exit_evidence).kind, "job_empty_verified");
    } finally {view.close();}
  } finally {
    manager?.shutdown();
    manager?.executionCoordinator?.close();
    if (alive(owner.pid)) owner.kill("SIGKILL");
    await pause(200);
    await rm(dir,{recursive:true,force:true,maxRetries:15,retryDelay:100});
  }
});
