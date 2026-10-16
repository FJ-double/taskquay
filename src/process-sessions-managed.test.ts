import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { ProcessSessionManager, type ProcessSnapshot } from "./process-sessions.js";
import { WorkLedger } from "./work-ledger.js";

const options = process.platform === "win32" ? {} : { skip: "Windows Job integration only" };
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function poll(manager: ProcessSessionManager, snapshot: ProcessSnapshot, output = ""): Promise<ProcessSnapshot> {
  let current = snapshot;
  let text = output + current.output;
  for (let i = 0; current.running && i < 50; i++) {
    current = await manager.write({
      workspaceId: "test-ws", sessionId: snapshot.sessionId!,
      executionId: snapshot.executionId, yieldTimeMs: 1_000,
    });
    text += current.output;
  }
  assert.equal(current.running, false, "Windows Job execution did not become terminal");
  return { ...current, output: text };
}

test("managed exec_command, single-connection work receipt and proof-gated claim release", options, async () => {
  const dir = mkdtempSync(join(tmpdir(), "taskquay-command-managed-"));
  const stateDir = join(dir, "state");
  const workspace = join(dir, "workspace");
  mkdirSync(workspace);
  const ledger = new WorkLedger(stateDir);
  const run = ledger.begin({ root: workspace, workspaceId: "test-ws",
    workItemId: "managed-command", runKey: "one", title: "Managed command test",
    origin: { entryPoint: "other_mcp", evidence: "client_reported" } });
  const manager = new ProcessSessionManager({ stateDir, managedWindowsCommands: true });
  try {
    const started = await manager.start({
      workspaceId: "test-ws", workspaceRoot: workspace, cwd: workspace,
      command: "echo MANAGED_OK", requestKey: "command-once", workRunId: run.id,
      yieldTimeMs: 4_000,
    });
    assert.match(started.executionId!, /^ex_[a-f0-9]{32}$/);
    assert.ok(started.sessionId);
    const result = await poll(manager, started);
    assert.match(result.output, /MANAGED_OK/);
    assert.equal(result.exitCode, 0);
    assert.equal(result.operationId, started.operationId);
    const row = ledger.db.prepare("select * from managed_executions where id=?").get(result.executionId) as
      { resource_state: string; phase: string; outcome: string; job_identity: string; exit_evidence: string };
    assert.deepEqual([row.resource_state, row.phase, row.outcome], ["released", "terminal", "completed"]);
    assert.match(row.job_identity, /taskquay-job-/);
    assert.equal(JSON.parse(row.exit_evidence).kind, "job_empty_verified");
    assert.equal((ledger.db.prepare("select count(*) as n from execution_claims where execution_id=?")
      .get(result.executionId) as { n: number }).n, 0);
    const operation = ledger.db.prepare("select status from console_operations where id=?")
      .get(result.operationId) as { status: string };
    assert.equal(operation.status, "completed");
    await assert.rejects(manager.start({
      workspaceId: "test-ws", workspaceRoot: workspace, cwd: workspace,
      command: "echo MANAGED_OK", requestKey: "command-once", workRunId: run.id,
    }), /RECORDED_OPERATION/);
    assert.equal((ledger.db.prepare("select count(*) as n from managed_executions").get() as { n: number }).n, 1);
  } finally {
    manager.shutdown();
    ledger.close();
    await pause(250);
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("managed write_stdin requires matching execution_id; input, cancel and unrelated Job remain independent", options, async () => {
  const dir = mkdtempSync(join(tmpdir(), "taskquay-command-multi-"));
  const stateDir = join(dir, "state");
  const workspace1 = join(dir, "workspace1"), workspace2 = join(dir, "workspace2");
  mkdirSync(workspace1); mkdirSync(workspace2);
  const manager = new ProcessSessionManager({ stateDir, managedWindowsCommands: true });
  const node = `"${process.execPath}"`;
  try {
    const interactive = await manager.start({
      workspaceId: "test-ws", workspaceRoot: workspace1, cwd: workspace1,
      command: `${node} -e "process.stdin.once('data',d => {console.log('INPUT:' + d.toString().trim());process.exit(0)})"`,
      yieldTimeMs: 10,
    });
    assert.equal(interactive.running, true);
    await assert.rejects(manager.write({
      workspaceId: "test-ws", sessionId: interactive.sessionId!,
      chars: "bad input\n",
    }), /EXECUTION_ID_MISMATCH/);
    await assert.rejects(manager.write({
      workspaceId: "test-ws", sessionId: interactive.sessionId!,
      executionId: `ex_${randomUUID().replaceAll("-", "")}`, chars: "bad input\n",
    }), /EXECUTION_ID_MISMATCH/);
    const other = await manager.start({
      workspaceId: "test-ws", workspaceRoot: workspace2, cwd: workspace2,
      command: `${node} -e "setInterval(()=>{},1000)"`, yieldTimeMs: 10,
    });
    const firstInput = await manager.write({
      workspaceId: "test-ws", sessionId: interactive.sessionId!,
      executionId: interactive.executionId, chars: "hello\n", yieldTimeMs: 3_000,
    });
    const firstResult = await poll(manager, firstInput, interactive.output);
    assert.match(firstResult.output, /INPUT:hello/);
    assert.equal(firstResult.exitCode, 0);
    const stillRunning = await manager.write({
      workspaceId: "test-ws", sessionId: other.sessionId!,
      executionId: other.executionId, yieldTimeMs: 5,
    });
    assert.equal(stillRunning.running, true);
    const cancelled = await manager.write({
      workspaceId: "test-ws", sessionId: other.sessionId!,
      executionId: other.executionId, chars: "\u0003", yieldTimeMs: 3_000,
    });
    const terminal = await poll(manager, cancelled);
    assert.equal(terminal.running, false);
    const db = new Database(join(stateDir, "devspace.sqlite"));
    try {
      const states = db.prepare("select resource_state from managed_executions order by rowid")
        .all() as Array<{ resource_state: string }>;
      assert.deepEqual(states.map((s) => s.resource_state), ["released", "released"]);
      assert.equal((db.prepare("select count(*) as n from execution_claims").get() as { n: number }).n, 0);
    } finally { db.close(); }
  } finally {
    manager.shutdown();
    await pause(250);
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("managed admission rejects a foreign work run atomically: no claim, execution or command", options, async () => {
  const dir = mkdtempSync(join(tmpdir(), "taskquay-command-rollback-"));
  const stateDir = join(dir, "state"), workspace = join(dir, "workspace"), other = join(dir, "other");
  mkdirSync(workspace); mkdirSync(other);
  const ledger = new WorkLedger(stateDir);
  const run = ledger.begin({ root: workspace, workspaceId: "test-ws",
    workItemId: "admission-rollback", runKey: "one", title: "Scope rejection",
    origin: { entryPoint: "other_mcp", evidence: "server_entry" } });
  const manager = new ProcessSessionManager({ stateDir, managedWindowsCommands: true });
  try {
    await assert.rejects(manager.start({
      workspaceId: "test-ws", workspaceRoot: other, cwd: other,
      command: "echo MUST_NOT_RUN", requestKey: "once", workRunId: run.id,
    }), /outside this workspace scope/);
    for (const table of ["execution_claims", "managed_executions", "console_operations"]) {
      const count = ledger.db.prepare(`select count(*) as n from ${table}`).get() as { n: number };
      assert.equal(count.n, 0, `${table} must roll back`);
    }
  } finally {
    manager.shutdown();
    ledger.close();
    await pause(250);
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("managed finalization failure cannot release a claim without a committed ledger receipt", options, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "taskquay-command-finalize-failure-"));
  const stateDir = join(dir, "state"), workspace = join(dir, "workspace");
  mkdirSync(workspace);
  const ledger = new WorkLedger(stateDir);
  const run = ledger.begin({ root: workspace, workspaceId: "test-ws",
    workItemId: "finish-rollback", runKey: "one", title: "Finish failure proof",
    origin: { entryPoint: "other_mcp", evidence: "server_entry" } });
  const manager = new ProcessSessionManager({ stateDir, managedWindowsCommands: true });
  try {
    t.mock.method(WorkLedger.prototype, "endOperation", () => {
      throw new Error("SIMULATED_LEDGER_COMMIT_FAILURE");
    });
    const first = await manager.start({
      workspaceId: "test-ws", workspaceRoot: workspace, cwd: workspace,
      command: "echo FINISH_FAILURE", workRunId: run.id, yieldTimeMs: 5_000,
    });
    const completed = await poll(manager, first);
    assert.match(completed.output, /claim retained for recovery/);
    assert.notEqual(completed.exitCode, 0);
    const state = ledger.db.prepare("select phase,resource_state from managed_executions where id=?")
      .get(first.executionId) as { phase: string; resource_state: string };
    assert.equal(state.resource_state, "held", "transaction rolled back release");
    assert.equal((ledger.db.prepare("select count(*) as n from execution_claims where execution_id=?")
      .get(first.executionId) as { n: number }).n, 1);
    assert.equal((ledger.db.prepare("select status from console_operations where id=?")
      .get(first.operationId) as { status: string }).status, "running");
  } finally {
    manager.shutdown();
    // This fixture deliberately retains a durable unresolved claim. Close
    // its SQLite handle without deleting the claim before removing test files.
    manager.executionCoordinator?.close();
    ledger.close();
    await pause(250);
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
