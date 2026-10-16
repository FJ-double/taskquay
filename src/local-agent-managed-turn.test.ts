import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Result } from "better-result";
import { LocalAgentManager } from "./local-agent-manager.js";
import { LocalAgentRuntimePool } from "./local-agent-runtime-pool.js";
import { LocalAgentStore } from "./local-agent-store.js";
import type { LocalAgentDriver } from "./local-agent-runtime.js";
import type { LocalAgentProfile } from "./local-agent-profiles.js";
import type { SubagentsConfig } from "./local-agent-config.js";
import { WindowsProviderTurnRunner } from "./provider-turn-runner.js";
import type { ProviderTurnStarter } from "./provider-managed-dispatch.js";
import { WorkLedger } from "./work-ledger.js";
import { inspectManagedRecovery } from "./windows-recovery-transaction.js";
import { windowsBootIdentity } from "./windows-boot-identity.js";
import { AgentStoreError } from "./local-agent-errors.js";

const windows = process.platform === "win32" ? {} : { skip: "win32 Job required" };
const fixtureChildPath = fileURLToPath(new URL("./provider-turn-fixture-child.ts", import.meta.url));
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const subagents: SubagentsConfig = {
  enabled: true, instructions: "on-demand",
  providers: [{ id: "codex", enabled: true, model: "gpt-test", writeMode: "full_access" }],
};
const driver: LocalAgentDriver = {
  provider: "codex", reportsWorkLifecycle: true,
  runtimeKey: (context) => context.agentId,
  createRuntime: async () => { throw new Error("POOLED_PROVIDER_MUST_NOT_RUN"); },
};

async function withAgent(starter: ProviderTurnStarter,
  task: (context: { manager: LocalAgentManager; store: LocalAgentStore; ledger: WorkLedger;
    workspace: string; stateDir: string; profile: LocalAgentProfile }) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "taskquay-managed-agent-"));
  const stateDir = join(dir, "state");
  const store = new LocalAgentStore(stateDir);
  const profile: LocalAgentProfile = {
    name: "reviewer", description: "Fixture", provider: "codex",
    filePath: join(dir, "reviewer.md"), body: "Test.", disabled: false,
  };
  const ledger = new WorkLedger(stateDir);
  const manager = new LocalAgentManager({
    store, drivers: [driver], pool: new LocalAgentRuntimePool(),
    allowedRoots: [dir], loadProfiles: async () => [profile],
    subagents, isolatedProviderTurns: { enabled: true, starter },
  });
  try { await task({ manager, store, ledger, workspace: dir, stateDir, profile }); }
  finally {
    await manager.close();
    store.close();
    ledger.close();
    await pause(200);
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}

test("experimental LocalAgentManager routes a real Windows Job, persists thread, releases claim after proof", windows, async () => {
  await withAgent((input) => WindowsProviderTurnRunner.start({ ...input, fixtureChildPath }),
    async ({ manager, store, ledger, workspace }) => {
      const scope = { workspaceRoot: workspace, workspaceId: "ws-fixture" };
      const started = await manager.start({ target: "reviewer", prompt: "hello-manager",
        ...scope, taskKey: `isolated-${randomUUID()}` });
      assert.equal(started.isOk(), true, started.isErr() ? started.error.message : "");
      if (started.isErr()) return;
      const waited = await manager.wait([started.value.id], scope, 15_000);
      assert.equal(waited.isOk(), true);
      if (waited.isOk()) {
        assert.equal(waited.value[0]?.status, "completed");
        assert.match(JSON.stringify(waited.value), /FIXTURE:Test/);
        assert.match(JSON.stringify(waited.value), /hello-manager/);
      }
      const agent = store.getById(started.value.id);
      assert.equal(agent?.providerSessionId, "fake-session-resume-42");
      const execution = ledger.db.prepare("select * from managed_executions order by rowid desc limit 1")
        .get() as { phase: string; resource_state: string; outcome: string; exit_evidence: string;
          agent_execution_id: string; job_identity: string } | undefined;
      assert.ok(execution, "managed execution must exist");
      assert.deepEqual([execution.phase, execution.resource_state, execution.outcome],
        ["terminal", "released", "completed"]);
      assert.equal(JSON.parse(execution.exit_evidence).kind, "job_empty_verified");
      assert.match(execution.job_identity, /taskquay-job-/);
      assert.equal((ledger.db.prepare("select count(*) n from execution_claims").get() as { n: number }).n, 0);
      const oldReceipt = ledger.db.prepare("select status from console_executions where id=?")
        .get(execution.agent_execution_id) as {status: string};
      assert.equal(oldReceipt.status, "completed");
    });
});

test("experimental manager quarantines the claim if the provider worker fails before Job proof", windows, async () => {
  await withAgent(async () => { throw new Error("PROVIDER_BOOTSTRAP_FAILURE_NO_PROOF"); },
    async ({ manager, ledger, workspace }) => {
      const scope = { workspaceRoot: workspace, workspaceId: "ws-fixture" };
      const started = await manager.start({ target: "reviewer", prompt: "should-not-run", ...scope,
        taskKey: `failure-${randomUUID()}` });
      assert.equal(started.isOk(), true);
      if (started.isErr()) return;
      const firstWait = await manager.wait([started.value.id], scope, 15_000);
      assert.equal(firstWait.isOk(), true);
      const claim = ledger.db.prepare("select id,execution_id from execution_claims order by rowid desc limit 1")
        .get() as { id: string; execution_id: string } | undefined;
      assert.ok(claim, "unknown Job state may not silently release the claim");
      const managed = ledger.db.prepare("select resource_state from managed_executions where id=?")
        .get(claim.execution_id) as { resource_state: string };
      assert.notEqual(managed.resource_state, "released");
      const receipt = ledger.db.prepare("select status from console_executions order by rowid desc limit 1")
        .get() as { status: string };
      assert.equal(receipt.status, "reconciliation_required");
      // The test explicitly purges ONLY ITS OWN temporary SQLite claim after
      // checking quarantine, to allow the fixture's DB connection to close.
    });
});

test("experimental manager admits four isolated Jobs and durably queues a fifth with no dispatched Turn", windows, async () => {
  await withAgent((input) => WindowsProviderTurnRunner.start({ ...input, fixtureChildPath }),
    async ({ manager, ledger, workspace }) => {
      const active: string[] = [];
      for (let i = 0; i < 4; i++) {
        const root = join(workspace, `independent-${i}`);
        mkdirSync(root);
        const started = await manager.start({
          target: "reviewer", prompt: "control",
          workspaceRoot: root, workspaceId: `independent-${i}`,
          taskKey: `independent-${i}-${randomUUID()}`,
        });
        assert.equal(started.isOk(), true, started.isErr() ? started.error.message : "");
        if (started.isOk()) active.push(started.value.id);
      }
      for (let i = 0; i < 120; i++) {
        const started = (ledger.db.prepare(
          "select count(*) n from managed_executions where phase='running'",
        ).get() as { n: number }).n;
        if (started === 4) break;
        await pause(30);
      }
      assert.equal((ledger.db.prepare(
        "select count(*) n from managed_executions where phase='running'",
      ).get() as { n: number }).n, 4);
      assert.equal((ledger.db.prepare(
        "select count(*) n from execution_claims",
      ).get() as { n: number }).n, 4);
      const overflowRoot = join(workspace, "independent-4");
      mkdirSync(overflowRoot);
      const overflow = await manager.start({
        target: "reviewer", prompt: "control",
        workspaceRoot: overflowRoot, workspaceId: "independent-4",
        taskKey: `capacity-overflow-${randomUUID()}`,
      });
      assert.equal(overflow.isOk(), true);
      if (overflow.isOk()) {
        assert.equal(overflow.value.status, "queued");
        assert.equal((ledger.db.prepare("select count(*) n from execution_waiters").get() as {n:number}).n, 1);
        const stopped = manager.cancelQueued(overflow.value.id, {
          workspaceRoot: overflowRoot, workspaceId: "independent-4",
        });
        assert.equal(stopped.isOk(), true);
      }
      assert.equal((ledger.db.prepare(
        "select count(*) n from managed_executions",
      ).get() as { n: number }).n, 4,
      "Queued fifth job must not establish a managed execution or call the provider");
      assert.equal(active.length, 4);
      await manager.close();
    });
});

test("fifth managed Agent queues without Turn or model call, then automatically runs after a Job slot is freed", windows, async () => {
  const gates = new Map<string, () => void>();
  const starter: ProviderTurnStarter = (input) => WindowsProviderTurnRunner.start({
    ...input, fixtureChildPath,
    persistArmed: async (proof) => {
      await input.persistArmed(proof);
      const key = /gated-[0-3]/.exec(input.input.prompt)?.[0];
      if (key) await new Promise<void>((resolve) => { gates.set(key, resolve); });
    },
  });
  await withAgent(starter, async ({ manager, store, ledger, workspace }) => {
    const active: Array<{ id: string; scope: { workspaceRoot: string; workspaceId: string } }> = [];
    try {
      for (let i = 0; i < 4; i++) {
        const root = join(workspace, `managed-queue-${i}`);
        mkdirSync(root);
        const scope = { workspaceRoot: root, workspaceId: `managed-queue-${i}` };
        const started = await manager.start({
          target: "reviewer", prompt: `gated-${i}`, ...scope,
          taskKey: `gated-${i}-${randomUUID()}`,
        });
        assert.equal(started.isOk(), true, started.isErr() ? started.error.message : "");
        if (started.isOk()) active.push({ id: started.value.id, scope });
      }
      for (let attempt = 0; attempt < 150 && gates.size !== 4; attempt++) await pause(30);
      assert.equal(gates.size, 4, "Four real Windows Jobs must be durably armed before queueing");
      const scope = { workspaceRoot: join(workspace, "managed-queue-fifth"), workspaceId: "managed-queue-fifth" };
      mkdirSync(scope.workspaceRoot);
      const taskKey = `fifth-managed-${randomUUID()}`;
      const fifth = await manager.start({ target: "reviewer", prompt: "fifth-auto",
        ...scope, taskKey });
      assert.equal(fifth.isOk(), true, fifth.isErr() ? fifth.error.message : "");
      if (fifth.isErr()) return;
      assert.equal(store.getById(fifth.value.id)?.status, "queued");
      assert.equal(store.getLatestTurn(fifth.value.id), undefined,
        "No Agent Turn may exist before the queue ticket is admitted");
      assert.equal((ledger.db.prepare("select count(*) n from managed_executions").get() as {n:number}).n, 4);
      assert.equal((ledger.db.prepare("select count(*) n from execution_waiters").get() as {n:number}).n, 1);
      const repeated = await manager.start({ target: "reviewer", prompt: "fifth-auto", ...scope, taskKey });
      assert.equal(repeated.isOk(), true);
      if (repeated.isOk()) assert.equal(repeated.value.id, fifth.value.id, "Repeated task identity cannot enqueue twice");
      assert.equal((ledger.db.prepare("select count(*) n from execution_waiters").get() as {n:number}).n, 1);
      const timeout = await manager.wait([fifth.value.id], scope, 50);
      assert.equal(timeout.isOk(), true);
      if (timeout.isOk()) assert.deepEqual(timeout.value[0], {
        id: fifth.value.id, status: "running", wait: "timeout",
      });
      const waiting = manager.wait([fifth.value.id], scope, 15_000);
      gates.get("gated-0")?.();
      gates.delete("gated-0");
      const done = await waiting;
      assert.equal(done.isOk(), true, done.isErr() ? done.error.message : "");
      if (done.isOk()) assert.equal(done.value[0]?.status, "completed",
        `FIFO promotion must complete: ${JSON.stringify(done.value)}`);
      assert.ok(store.getLatestTurn(fifth.value.id), "Agent Turn is inserted only on ticket promotion");
      assert.equal((ledger.db.prepare("select count(*) n from execution_waiters").get() as {n:number}).n, 0);
      assert.equal((ledger.db.prepare("select count(*) n from managed_executions").get() as {n:number}).n, 5);
    } finally {
      for (const release of gates.values()) release();
      await Promise.all(active.map(({ id, scope }) => manager.wait([id], scope, 10_000)));
    }
  });
});

test("cancelQueued stops a managed waiting Agent without creating Turn, WorkLedger, Claim or Job", windows, async () => {
  const gates = new Map<string, () => void>();
  const starter: ProviderTurnStarter = (input) => WindowsProviderTurnRunner.start({
    ...input, fixtureChildPath, persistArmed: async (proof) => {
      await input.persistArmed(proof);
      const key = /cancel-gated-[0-3]/.exec(input.input.prompt)?.[0];
      if (key) await new Promise<void>((resolve) => { gates.set(key, resolve); });
    },
  });
  await withAgent(starter, async ({ manager, store, ledger, workspace }) => {
    const running: Array<{ id: string; scope: {workspaceRoot: string; workspaceId: string} }> = [];
    try {
      for (let i = 0; i < 4; i++) {
        const scope = { workspaceRoot: join(workspace, `cancel-running-${i}`), workspaceId: `cancel-running-${i}` };
        mkdirSync(scope.workspaceRoot);
        const started = await manager.start({ target: "reviewer",
          prompt: `cancel-gated-${i}`, ...scope, taskKey: `cancel-running-${i}-${randomUUID()}` });
        assert.equal(started.isOk(), true);
        if (started.isOk()) running.push({ id: started.value.id, scope });
      }
      for (let attempt = 0; attempt < 150 && gates.size !== 4; attempt++) await pause(30);
      assert.equal(gates.size, 4);
      const scope = { workspaceRoot: join(workspace, "cancel-queued"), workspaceId: "cancel-queued" };
      mkdirSync(scope.workspaceRoot);
      const queued = await manager.start({ target: "reviewer", prompt: "SHOULD_NOT_DISPATCH",
        ...scope, taskKey: `cancel-me-${randomUUID()}` });
      assert.equal(queued.isOk(), true);
      if (queued.isErr()) return;
      const stopped = manager.cancelQueued(queued.value.id, scope);
      assert.equal(stopped.isOk(), true, stopped.isErr() ? stopped.error.message : "");
      for (let attempt = 0; attempt < 100 &&
        (ledger.db.prepare("select count(*) n from execution_waiters").get() as {n:number}).n !== 0; attempt++) {
        await pause(20);
      }
      assert.equal(store.getById(queued.value.id)?.status, "stopped");
      assert.equal(store.getLatestTurn(queued.value.id), undefined);
      assert.equal((ledger.db.prepare("select count(*) n from execution_waiters").get() as {n:number}).n, 0);
      assert.equal((ledger.db.prepare("select count(*) n from managed_executions").get() as {n:number}).n, 4);
      assert.equal((ledger.db.prepare("select count(*) n from execution_claims").get() as {n:number}).n, 4);
      const waited = await manager.wait([queued.value.id], scope, 300);
      assert.equal(waited.isOk(), true);
      if (waited.isOk()) assert.equal(waited.value[0]?.status, "stopped");
    } finally {
      for (const release of gates.values()) release();
      await Promise.all(running.map(({ id, scope }) => manager.wait([id], scope, 10_000)));
    }
  });
});

test("managed Agent queues a second writer on the same checkout and wakes it after verified Job completion", windows, async () => {
  let release!: () => void;
  const starter: ProviderTurnStarter = (input) => WindowsProviderTurnRunner.start({
    ...input, fixtureChildPath, persistArmed: async (proof) => {
      await input.persistArmed(proof);
      if (input.input.prompt.includes("gated-0")) {
        await new Promise<void>((resolve) => { release = resolve; });
      }
    },
  });
  await withAgent(starter, async ({ manager, ledger, store, workspace }) => {
    const scope = { workspaceRoot: workspace, workspaceId: "same-checkout" };
    try {
      const first = await manager.start({ target: "reviewer", prompt: "gated-0",
        ...scope, taskKey: `same-first-${randomUUID()}` });
      assert.equal(first.isOk(), true);
      if (first.isErr()) return;
      for (let i = 0; i < 100 && !release; i++) await pause(20);
      assert.equal(typeof release, "function");
      const second = await manager.start({ target: "reviewer", prompt: "fifth-auto",
        ...scope, taskKey: `same-second-${randomUUID()}` });
      assert.equal(second.isOk(), true);
      if (second.isErr()) return;
      assert.equal(second.value.status, "queued");
      assert.equal(store.getLatestTurn(second.value.id), undefined);
      assert.equal((ledger.db.prepare("select count(*) n from execution_claims").get() as {n:number}).n, 1,
        "Same-checkout writers cannot overlap even with three free global slots");
      const waiting = manager.wait([second.value.id], scope, 15_000);
      release();
      const done = await waiting;
      assert.equal(done.isOk(), true, done.isErr() ? done.error.message : "");
      if (done.isOk()) assert.equal(done.value[0]?.status, "completed");
      assert.equal((ledger.db.prepare("select count(*) n from execution_waiters").get() as {n:number}).n, 0);
      assert.equal((ledger.db.prepare("select count(*) n from execution_claims").get() as {n:number}).n, 0);
    } finally { release?.(); }
  });
});

test("failed Agent queued-state persistence atomically rolls back the managed FIFO ticket", windows, async () => {
  let release!: () => void;
  let workerStarts = 0;
  const starter: ProviderTurnStarter = (input) => {
    workerStarts++;
    return WindowsProviderTurnRunner.start({
      ...input, fixtureChildPath, persistArmed: async (proof) => {
        await input.persistArmed(proof);
        if (input.input.prompt.includes("gated-0")) {
          await new Promise<void>((resolve) => { release = resolve; });
        }
      },
    });
  };
  await withAgent(starter, async ({ manager, ledger, workspace }) => {
    const scope = { workspaceRoot: workspace, workspaceId: "atomic-queue" };
    try {
      const first = await manager.start({ target: "reviewer", prompt: "gated-0",
        ...scope, taskKey: `atomic-queue-first-${randomUUID()}` });
      assert.equal(first.isOk(), true);
      if (first.isErr()) return;
      for (let i = 0; i < 100 && !release; i++) await pause(20);
      assert.equal(typeof release, "function");
      ledger.db.exec(`create trigger prevent_queued_state before update on local_agent_sessions
        when new.status='queued'
        begin select raise(abort,'INJECTED_QUEUED_STATUS_WRITE_FAILURE'); end;`);
      const second = await manager.start({ target: "reviewer", prompt: "MUST_NOT_DISPATCH",
        ...scope, taskKey: `atomic-queue-second-${randomUUID()}` });
      assert.equal(second.isErr(), true);
      assert.equal((ledger.db.prepare("select count(*) n from execution_waiters").get() as {n:number}).n, 0,
        "An aborted Agent queued-state update cannot leave a durable orphan ticket");
      assert.equal((ledger.db.prepare("select count(*) n from execution_claims").get() as {n:number}).n, 1);
      assert.equal((ledger.db.prepare("select count(*) n from managed_executions").get() as {n:number}).n, 1);
      assert.equal(workerStarts, 1, "A failed enqueue must never start the second Provider");
      ledger.db.exec("drop trigger prevent_queued_state");
      release();
      const finished = await manager.wait([first.value.id], scope, 15_000);
      assert.equal(finished.isOk(), true);
    } finally {
      ledger.db.exec("drop trigger if exists prevent_queued_state");
      release?.();
    }
  });
});

test("manager shutdown cancels only its own isolated Job without deleting an unconfirmed claim", windows, async () => {
  await withAgent((input) => WindowsProviderTurnRunner.start({ ...input, fixtureChildPath }),
    async ({ manager, ledger, store, workspace }) => {
      const scope = { workspaceRoot: workspace, workspaceId: "ws-fixture" };
      const started = await manager.start({ target: "reviewer", prompt: "control",
        ...scope, taskKey: `shutdown-${randomUUID()}` });
      assert.equal(started.isOk(), true);
      if (started.isErr()) return;
      let isReady = false;
      for (let i = 0; i < 100; i++) {
        isReady = store.getById(started.value.id)?.controlState === "devspace_active";
        if (isReady) break;
        await pause(30);
      }
      assert.equal(isReady, true, "Control fixture must be actively waiting in a Job");
      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          manager.close(),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error("ISOLATED_MANAGER_SHUTDOWN_TIMEOUT")), 8_000);
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      const row = ledger.db.prepare("select * from managed_executions order by rowid desc limit 1")
        .get() as { resource_state: string };
      assert.notEqual(row.resource_state, "released",
        "A cancelled turn with no final Provider response is not proof of commit");
      assert.equal((ledger.db.prepare("select count(*) n from execution_claims").get() as {n: number}).n, 1);
      // TEST-ONLY dependency injection: manager.close() did not kill the
      // test parent, so emulate a later recovery process observing that
      // owner/runner/job have all disappeared. This must update AgentStore
      // + WorkLedger + exact Claim in the SAME SQLite transaction.
      const id = (ledger.db.prepare("select id from managed_executions")
        .get() as { id: string }).id;
      const recovered = inspectManagedRecovery(ledger.db, id, { apply: true }, {
        boot: windowsBootIdentity,
        process: () => "absent_or_reused",
        job: () => "absent",
      });
      assert.equal(recovered.status, "released");
      assert.equal((ledger.db.prepare("select count(*) n from execution_claims").get() as {n: number}).n, 0);
      const agent = ledger.db.prepare("select control_state from local_agent_sessions where id=?")
        .get(started.value.id) as { control_state: string };
      assert.equal(agent.control_state, "reconcile_required",
        "Lost owner must not make an unknown continuation writable");
      const receipt = ledger.db.prepare("select status from console_executions order by rowid desc limit 1")
        .get() as { status: string };
      assert.equal(receipt.status, "reconciliation_required");
    });
});

test("managed admission rolls back new work run, ledger execution and claim when ledger insertion fails", windows, async (t) => {
  await withAgent(async () => { throw new Error("WORKER_MUST_NOT_START_AFTER_FAILED_ADMISSION"); },
    async ({ manager, ledger, workspace }) => {
      t.mock.method(WorkLedger.prototype, "beginExecution", () => {
        throw new Error("INJECTED_ATOMIC_LEDGER_INSERT_FAILURE");
      });
      const started = await manager.start({
        target: "reviewer", prompt: "no-spawn", workspaceRoot: workspace,
        workspaceId: "ws-fixture", taskKey: `atomic-failure-${randomUUID()}`,
      });
      assert.equal(started.isErr(), true);
      const counts = ["execution_claims", "managed_executions", "console_executions",
        "console_work_runs", "console_work_items"].map((table) => (
        (ledger.db.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n
      ));
      assert.deepEqual(counts, [0, 0, 0, 0, 0], "All admission writes must roll back");
    });
});

test("managed admission queues a conflicting second Agent without orphan execution or Provider invocation", windows, async () => {
  await withAgent((input) => WindowsProviderTurnRunner.start({ ...input, fixtureChildPath }),
    async ({ manager, ledger, workspace }) => {
      const scope = { workspaceRoot: workspace, workspaceId: "ws-fixture" };
      const first = await manager.start({ target: "reviewer", prompt: "control",
        ...scope, taskKey: `exclusive-first-${randomUUID()}` });
      assert.equal(first.isOk(), true);
      if (first.isErr()) return;
      for (let i = 0; i < 120; i++) {
        if ((ledger.db.prepare("select count(*) as n from managed_executions where phase='running'")
          .get() as { n: number }).n === 1) break;
        await pause(25);
      }
      // Another Agent in the same checkout creates ONLY a durable waiter,
      // never an unaccounted legacy queue or started Provider execution.
      const blocked = await manager.start({ target: "reviewer", prompt: "must-not-run",
        ...scope, taskKey: `exclusive-second-${randomUUID()}` });
      assert.equal(blocked.isOk(), true);
      assert.equal((ledger.db.prepare("select count(*) as n from managed_executions").get() as { n: number }).n, 1);
      assert.equal((ledger.db.prepare("select count(*) as n from console_executions").get() as { n: number }).n, 1);
      assert.equal((ledger.db.prepare("select count(*) as n from execution_waiters").get() as { n: number }).n, 1);
      if (blocked.isOk()) {
        assert.equal(blocked.value.status, "queued");
        assert.equal(manager.cancelQueued(blocked.value.id, scope).isOk(), true);
      }
      await manager.close();
    });
});

test("a failed Agent beginTurn rolls back its claim, WorkLedger and local turn in the same transaction", windows, async (t) => {
  await withAgent(async () => { throw new Error("WORKER_MUST_NOT_START"); },
    async ({ manager, store, ledger, workspace }) => {
      t.mock.method(store, "beginTurnResult", () =>
        Result.err(new AgentStoreError("begin_turn", new Error("INJECTED_AGENT_TURN_FAILURE"))));
      const started = await manager.start({ target: "reviewer", prompt: "never-send",
        workspaceRoot: workspace, workspaceId: "ws-fixture",
        taskKey: `no-dispatch-${randomUUID()}` });
      assert.equal(started.isErr(), true);
      for (const table of ["execution_claims", "managed_executions", "console_executions",
        "console_work_runs", "local_agent_turns"]) {
        assert.equal((ledger.db.prepare(`select count(*) n from ${table}`).get() as {n: number}).n,
          0, `${table} must roll back`);
      }
    });
});

test("repeated Agent continuation requestKey cannot replay a completed model turn", windows, async () => {
  await withAgent((input) => WindowsProviderTurnRunner.start({ ...input, fixtureChildPath }),
    async ({ manager, ledger, workspace }) => {
      const scope = { workspaceRoot: workspace, workspaceId: "ws-fixture" };
      const started = await manager.start({
        target: "reviewer", prompt: "first", ...scope,
        taskKey: `replay-start-${randomUUID()}`,
      });
      assert.equal(started.isOk(), true);
      if (started.isErr()) return;
      const secondWait = await manager.wait([started.value.id], scope, 15_000);
      assert.equal(secondWait.isOk(), true,
        secondWait.isErr() ? secondWait.error.message : "");
      const workRunId = (ledger.db.prepare("select run_id from console_executions order by rowid desc limit 1")
        .get() as { run_id: string }).run_id;
      const opts = { requestKey: "continuation-once", workRunId };
      const second = await manager.continue(started.value.id, "continue once", opts, scope);
      assert.equal(second.isOk(), true);
      const secondCompletion = await manager.wait([started.value.id], scope, 15_000);
      assert.equal(secondCompletion.isOk(), true,
        secondCompletion.isErr() ? secondCompletion.error.message : "");
      const before = (ledger.db.prepare("select count(*) as n from managed_executions").get() as { n: number }).n;
      assert.equal(before, 2);
      const replay = await manager.continue(started.value.id, "continue once", opts, scope);
      assert.equal(replay.isOk(), true, replay.isErr()
        ? `Repeat request failed: ${replay.error.message}`
        : "Client is directed to already-recorded outcome");
      const after = (ledger.db.prepare("select count(*) as n from managed_executions").get() as { n: number }).n;
      assert.equal(after, before, "No second Provider process is dispatched for same requestKey");
    });
});

test("failed managed terminal ledger commit rolls back Agent response and claim release together", windows, async () => {
  await withAgent((input) => WindowsProviderTurnRunner.start({ ...input, fixtureChildPath }),
    async ({ manager, store, ledger, workspace }) => {
      // One SQLite connection for AgentStore and WorkLedger: this trigger
      // forces failure AFTER a model response and Agent turn write are ready
      // but BEFORE a managed Job claim can be marked released.
      ledger.db.exec(`create trigger fixture_terminal_failure before update of status on console_executions
        when new.status='completed' begin select raise(abort,'FIXTURE_TERMINAL_COMMIT_FAILED'); end;`);
      const scope = { workspaceRoot: workspace, workspaceId: "ws-fixture" };
      const started = await manager.start({
        target: "reviewer", prompt: "atomic-result", ...scope,
        taskKey: `result-rollback-${randomUUID()}`,
      });
      assert.equal(started.isOk(), true);
      if (started.isErr()) return;
      await manager.wait([started.value.id], scope, 12_000);
      const managed = ledger.db.prepare("select resource_state from managed_executions")
        .get() as { resource_state: string };
      assert.equal(managed.resource_state, "held", "Job claim must remain while terminal commit failed");
      assert.equal((ledger.db.prepare("select count(*) n from execution_claims").get() as {n: number}).n, 1);
      assert.equal((ledger.db.prepare("select count(*) n from execution_responses").get() as {n: number}).n,
        0, "Response insert must roll back with failed receipt");
      assert.notEqual(store.getLatestTurn(started.value.id)?.status, "completed");
      assert.equal(store.getById(started.value.id)?.controlState, "reconcile_required");
    });
});
