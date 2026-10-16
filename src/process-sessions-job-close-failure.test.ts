import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProcessSessionManager } from "./process-sessions.js";
import { ExecutionCoordinator, ExecutionConflictError, type ExecutionClaim } from "./execution-coordinator.js";
import { WindowsJobObject } from "./windows-job-object.js";

test("unverified Windows Job close cannot be mistaken for a released legacy write claim", async () => {
  const root = mkdtempSync(join(tmpdir(), "taskquay-job-close-fail-"));
  const checkout = join(root, "checkout");
  mkdirSync(checkout);
  const manager = new ProcessSessionManager({ stateDir: join(root, "state") });
  const coordinator = manager.executionCoordinator!;
  const privateMethods = manager as unknown as {
    createSession: (input: { workspaceId: string; cwd: string; command: string }) => unknown;
    closePipeJob: (session: unknown) => Promise<boolean>;
    finish: (session: unknown, code?: number) => void;
    sessions: Map<number, unknown>;
    claims: Set<ExecutionClaim>;
  };
  const session = privateMethods.createSession({
    workspaceId: "ws", cwd: checkout, command: "echo test",
  }) as {
    id: number;
    pipeJob?: unknown;
    pipeJobSafetyUnverified?: boolean;
    executionClaim?: ExecutionClaim;
    workFinalized?: boolean;
  };
  const claim = coordinator.acquire({ workspaceRoot: checkout, kind: "command" });
  session.executionClaim = claim;
  privateMethods.claims.add(claim);
  privateMethods.sessions.set(session.id, session);
  let attempts = 0;
  session.pipeJob = {
    activeProcesses: () => 0,
    close: () => { attempts++; throw new Error("INJECTED_WIN32_CLOSE_FAILURE"); },
  };
  const peer = new ExecutionCoordinator(join(root, "state"));
  try {
    assert.equal(await privateMethods.closePipeJob(session), false);
    assert.equal(attempts, 3);
    assert.ok(session.pipeJob, "the retryable native handle must not be dropped");
    session.pipeJobSafetyUnverified = true;
    session.workFinalized = true;
    privateMethods.finish(session, 0);
    assert.throws(() => peer.acquire({ workspaceRoot: checkout, kind: "command" }),
      ExecutionConflictError, "unknown Job cleanup must not free a write Claim");
  } finally {
    // Test fixture cleanup ONLY: not the production recovery mechanism.
    claim.release();
    peer.close();
    manager.shutdown();
    // The synthetic quarantined session intentionally remains in the
    // manager's Claim set, so explicitly close its disposable SQLite handle.
    coordinator.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("Windows legacy command cannot silently release a Claim when Job assignment fails", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "taskquay-job-assign-fail-"));
  const checkout = join(root, "checkout");
  mkdirSync(checkout);
  const stateDir = join(root, "state");
  const manager = new ProcessSessionManager({ stateDir });
  const peer = new ExecutionCoordinator(stateDir);
  t.mock.method(WindowsJobObject.prototype, "assignVerified", () => {
    throw new Error("INJECTED_JOB_ASSIGNMENT_FAILURE");
  });
  try {
    const started = await manager.start({
      workspaceId: "ws", workspaceRoot: checkout, cwd: checkout,
      command: `"${process.execPath}" -e "setTimeout(()=>{},10000)"`,
      yieldTimeMs: 3_000,
    });
    let final = started;
    for (let i = 0; final.running && i < 10; i++) {
      final = await manager.write({ workspaceId: "ws", sessionId: started.sessionId!,
        yieldTimeMs: 1_000 });
    }
    assert.equal(final.running, false, "abort must terminate the known root");
    assert.match(started.output + final.output, /write claim retained for manual reconciliation/);
    assert.throws(() => peer.acquire({ workspaceRoot: checkout, kind: "command" }),
      ExecutionConflictError, "an unverified unmanaged process tree is not release proof");
  } finally {
    t.mock.restoreAll();
    peer.close();
    manager.shutdown();
    manager.executionCoordinator?.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("legacy Job cleanup waits for native zero members before confirming close", async () => {
  const manager = new ProcessSessionManager();
  const internal = manager as unknown as {
    closePipeJob: (session: unknown) => Promise<boolean>;
  };
  let queryCount = 0;
  let terminated = false;
  let closed = false;
  const session: { pipeJob?: unknown } = {
    pipeJob: {
      activeProcesses: () => {
        queryCount++;
        return queryCount <= 2 ? 1 : 0;
      },
      terminate: () => { terminated = true; },
      close: () => { assert.equal(queryCount >= 3, true); closed = true; },
    },
  };
  try {
    assert.equal(await internal.closePipeJob(session), true);
    assert.equal(terminated, true);
    assert.equal(closed, true);
    assert.equal(session.pipeJob, undefined);
  } finally {
    manager.shutdown();
  }
});
