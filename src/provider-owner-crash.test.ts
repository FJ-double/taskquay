import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { readRecoverySnapshot, observeRecovery } from "./windows-recovery-observer.js";
import { inspectManagedRecovery } from "./windows-recovery-transaction.js";

const windows = process.platform === "win32" ? {} : { skip: "Win32 owner-crash proof only" };
const fixture = fileURLToPath(new URL("./provider-owner-crash-fixture.ts", import.meta.url));
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function awaitMarker(path: string, child: ChildProcess, detail: () => string) {
  for (let i = 0; i < 180; i++) {
    if (existsSync(path)) return;
    if (child.exitCode !== null) break;
    await pause(50);
  }
  assert.ok(existsSync(path), `Missing disposable crash-fixture marker ${path}: ${detail()}`);
}

for (const mode of ["admitted", "armed", "running"] as const) {
  test(`owner crash at ${mode}: no inference replay, managed claim remains, Job subtree dies`, windows, async () => {
    const dir = mkdtempSync(join(tmpdir(), `taskquay-provider-crash-${mode}-`));
    const child = spawn(process.execPath,
      ["--import", import.meta.resolve("tsx"), fixture, mode, dir],
      { cwd: dir, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let diagnostic = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      diagnostic = (diagnostic + chunk.toString("utf8")).slice(-1600);
    });
    let runnerPid: number | undefined;
    try {
      await awaitMarker(join(dir, "admitted.json"), child, () => diagnostic);
      if (mode !== "admitted") {
        await awaitMarker(join(dir, mode === "armed" ? "armed.json" : "running.json"), child,
          () => diagnostic + (existsSync(join(dir, "fixture-error.txt"))
            ? readFileSync(join(dir, "fixture-error.txt"), "utf8") : ""));
        runnerPid = JSON.parse(readFileSync(join(dir, "armed.json"), "utf8")).runnerPid as number;
        assert.equal(isAlive(runnerPid!), true, "Runner existed within the owner Job before crash");
        if (mode === "armed") assert.equal(existsSync(join(dir, "running.json")), false, "No GO before durable arm");
      }
      if (isAlive(child.pid!)) child.kill("SIGKILL"); // disposable fixture owner ONLY
      for (let i = 0; isAlive(child.pid!) && i < 100; i++) await pause(40);
      if (runnerPid !== undefined) {
        for (let i = 0; isAlive(runnerPid) && i < 120; i++) await pause(50);
        assert.equal(isAlive(runnerPid), false, "Owner death must close the Windows Job");
      }
      const sqlite = new Database(join(dir, "devspace.sqlite"), { readonly: true });
      try {
        const row = sqlite.prepare(`select e.phase, e.resource_state, e.exit_evidence,
          e.armed_evidence, c.execution_id as claim_execution_id
          from managed_executions e join execution_claims c on c.execution_id=e.id`)
          .get() as { phase: string; resource_state: string; exit_evidence: string | null;
            armed_evidence: string | null; claim_execution_id: string } | undefined;
        assert.ok(row, "Durable claim remains after the disposable owner crash");
        assert.equal(row.resource_state, "held");
        assert.equal(row.exit_evidence, null, "OS process exit is not a release receipt");
        assert.equal(row.phase, mode === "admitted" ? "starting" : "running");
        assert.equal(Boolean(row.armed_evidence), mode !== "admitted");
        const executionId = (JSON.parse(readFileSync(join(dir, "admitted.json"), "utf8")) as
          { executionId: string }).executionId;
        const snapshot = readRecoverySnapshot(sqlite, executionId);
        assert.ok(snapshot);
        const observed = observeRecovery(snapshot);
        assert.equal(observed.decision, mode === "admitted" ? "quarantine" : "candidate",
          `An exact native owner/runner/Job proof is required: ${JSON.stringify(observed)}`);
        if (mode !== "admitted") {
          assert.equal(observed.evidenceKind, "job_empty_verified");
          assert.equal(observed.jobProbe, "absent");
        }
      } finally { sqlite.close(); }
      const writable = new Database(join(dir, "devspace.sqlite"));
      try {
        const executionId = (JSON.parse(readFileSync(join(dir, "admitted.json"), "utf8")) as
          { executionId: string }).executionId;
        const snapshot = readRecoverySnapshot(writable, executionId);
        assert.ok(snapshot);
        const dryRun = inspectManagedRecovery(writable, executionId);
        assert.equal(dryRun.status, mode === "admitted" ? "quarantined" : "candidate");
        assert.equal((writable.prepare("select count(*) n from execution_claims").get() as { n: number }).n, 1,
          "Dry run cannot touch a durable claim");
        if (mode === "admitted") {
          assert.equal(inspectManagedRecovery(writable, executionId, { apply: true }).status, "quarantined");
          assert.equal((writable.prepare("select count(*) n from execution_claims").get() as { n: number }).n, 1);
        } else {
          // Failure at the FINAL claim deletion must roll back all new
          // transitions and retain exactly one claim.
          writable.exec(`create trigger test_no_claim_delete before delete on execution_claims
            begin select raise(abort,'INJECTED_RECOVERY_DB_FAILURE'); end;`);
          assert.throws(() => inspectManagedRecovery(writable, executionId, {
            apply: true, expectedVersion: snapshot.state_version,
          }), /INJECTED_RECOVERY_DB_FAILURE/);
          const rolled = writable.prepare("select phase,resource_state,exit_evidence from managed_executions where id=?")
            .get(executionId) as {phase: string;resource_state: string;exit_evidence: string|null};
          assert.equal(rolled.resource_state, "held");
          assert.equal(rolled.phase, "running");
          assert.equal(rolled.exit_evidence, null);
          writable.exec("drop trigger test_no_claim_delete");
          assert.throws(() => inspectManagedRecovery(writable, executionId,
            { apply: true, expectedVersion: snapshot.state_version - 1 }), /RECOVERY_VERSION_CONFLICT/);
          const recovered = inspectManagedRecovery(writable, executionId, {
            apply: true, expectedVersion: snapshot.state_version,
          });
          assert.equal(recovered.status, "released");
          assert.equal((writable.prepare("select count(*) n from execution_claims").get() as { n: number }).n, 0);
          const final = writable.prepare("select phase,outcome,resource_state,exit_evidence from managed_executions where id=?")
            .get(executionId) as {phase: string;outcome: string;resource_state: string;exit_evidence: string};
          assert.deepEqual([final.phase, final.outcome, final.resource_state], ["terminal", "interrupted", "released"]);
          assert.equal(JSON.parse(final.exit_evidence).kind, "job_empty_verified");
          assert.equal(inspectManagedRecovery(writable, executionId, { apply: true }).status, "not_found",
            "Repeat recovery never deletes another claim or replays work");
        }
      } finally { writable.close(); }
    } finally {
      if (child.pid && isAlive(child.pid)) child.kill("SIGKILL");
      await pause(500);
      await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });
}
