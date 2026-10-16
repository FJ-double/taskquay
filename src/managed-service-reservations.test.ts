import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ExecutionCoordinator } from "./execution-coordinator.js";
import { ExecutionStateStore, type ExecutionOwnerIdentity } from "./execution-state-store.js";
import { ManagedServiceReservations } from "./managed-service-reservations.js";
import { ManagedServiceHealthMonitor, readServiceHealthJournal, readServiceHealthAlert } from "./managed-service-health-monitor.js";
import { nativeRecoveryProbe, type RecoveryOsProbe } from "./windows-recovery-observer.js";
import { WindowsCommandRunner } from "./execution-runner.js";
import { windowsProcessCreatedAt } from "./windows-job-object.js";
import { windowsBootIdentity } from "./windows-boot-identity.js";

const boot = "win-ntboot-v1:abcdef01-2345-6789-abcd-1234567890ab:01db3abcdef01234";
const job = "Local\\taskquay-job-4a56df09-e451-4dd5-a5c0-8c6b107d0013";
function fixture(useNativeOwner = false) {
  const root = mkdtempSync(join(tmpdir(), "tq-services-"));
  const source = join(root, "checkout");
  const state1 = join(root, "svc-data-1");
  const state2 = join(root, "svc-data-2");
  const state3 = join(root, "svc-data-3");
  [source, state1, state2, state3].forEach((path) => mkdirSync(path));
  const coord = new ExecutionCoordinator(join(root, "db"));
  const owner: ExecutionOwnerIdentity = {
    id: coord.managedOwnerId, kind: "agentd", pid: process.pid,
    processCreatedAt: useNativeOwner ? windowsProcessCreatedAt(process.pid) : "2026-10-14T00:00:00.000Z",
    bootId: useNativeOwner ? windowsBootIdentity() : boot,
    generation: randomUUID(),
  };
  coord.registerManagedOwner(owner);
  const services = new ManagedServiceReservations(coord);
  const db = coord.sharedDatabaseHandle.sqlite;
  const input = (serviceKey: string, port: number, stateRoot: string) => ({
    serviceKey, port, stateRoot, workspaceRoot: source,
    workspaceId: "fixture", bindHost: "127.0.0.1" as const, owner,
  });
  return {
    root, source, state1, state2, state3, owner, coord, db, services, input,
    count: (table: string) =>
      (db.prepare(`select count(*) n from ${table}`).get() as { n: number }).n,
    cleanup: () => {
      coord.close();
      if (existsSync(root)) rmSync(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
    },
  };
}
const active: RecoveryOsProbe = {
  boot: () => boot,
  process: () => "same",
  job: () => "exists_active",
};
const gone: RecoveryOsProbe = {
  boot: () => boot,
  process: () => "absent_or_reused",
  job: () => "absent",
};
function arm(f: ReturnType<typeof fixture>, executionId: string) {
  const store = new ExecutionStateStore(f.db);
  const current = store.get(executionId)!;
  const armed = store.arm({
    executionId, expectedGeneration: current.generation, expectedVersion: current.state_version,
    pid: 99122, createdAt: "2026-10-14T00:00:02.000Z", bootId: boot,
    jobIdentity: job, evidence: JSON.stringify({kind: "os_job_membership", job}),
  });
  store.transition({
    executionId, expectedGeneration: armed.generation, expectedVersion: armed.state_version,
    phase: "running",
  });
}
function complete(f: ReturnType<typeof fixture>, executionId: string) {
  const store = new ExecutionStateStore(f.db);
  const current = store.get(executionId)!;
  store.transition({
    executionId, expectedGeneration: current.generation, expectedVersion: current.state_version,
    phase: "terminal", outcome: "completed", resourceState: "released",
    exitEvidence: { kind: "job_empty_verified", verifiedAt: new Date().toISOString(),
      verifier: "unit-fixture", detail: "synthetic controlled test state only" },
  });
}

test("persistent service reserves one port and storage namespace without spending Agent slots", () => {
  const f = fixture();
  try {
    const first = f.services.reserve(f.input("hermes-worker", 43111, f.state1));
    const second = f.services.reserve(f.input("content-publisher", 43112, f.state2));
    assert.equal(first.state, "reserved");
    assert.equal(f.count("managed_service_reservations"), 2);
    assert.equal(f.count("execution_claims"), 0);
    assert.equal(f.count("execution_waiters"), 0);
    assert.equal(f.count("managed_executions"), 2);
    assert.deepEqual(f.db.prepare("select distinct kind from managed_executions").all(), [{kind: "service"}]);
    for (let i = 0; i < 4; i++) {
      const source = join(f.root, `agent-${i}`);
      mkdirSync(source);
      const result = f.coord.admitManaged({
        workspaceRoot: source, kind: "agent", agentId: `agent-${i}`,
        maxConcurrentAgents: 4,
      }, (sqlite) => {
        const created = new ExecutionStateStore(sqlite).create({
          kind: "agent", owner: f.owner, workspaceId: "fixture",
          checkoutRoot: source, access: "write", resources: [], initialPhase: "starting",
          idempotencyScope: "stage5-slots", requestKey: `agent-${i}`,
          requestHash: createHash("sha256").update(`agent-${i}`).digest("hex"),
        });
        return { executionId: created.execution.id, value: created.execution.id };
      });
      assert.ok(result.claim.id);
    }
    assert.equal(f.count("execution_claims"), 4,
      "Four Agents remain available even with two long-lived service reservations");
    assert.equal(f.services.inspect(first.service_id)?.state, "reserved");
    assert.equal(f.services.inspect(second.service_id)?.state, "reserved");
  } finally { f.cleanup(); }
});

test("ports, state roots and service keys cannot be reused while a service is reserved", () => {
  const f = fixture();
  try {
    f.services.reserve(f.input("one", 42101, f.state1));
    assert.throws(() => f.services.reserve(f.input("two", 42101, f.state2)), /UNIQUE constraint failed/);
    assert.throws(() => f.services.reserve(f.input("two", 42102, f.state1)), /UNIQUE constraint failed/);
    assert.throws(() => f.services.reserve(f.input("one", 42102, f.state2)), /UNIQUE constraint failed/);
    assert.equal(f.count("managed_service_reservations"), 1);
    assert.equal(f.count("managed_executions"), 1,
      "Failed service reservations roll back managed execution creation and audit");
  } finally { f.cleanup(); }
});

test("service state root must be disjoint from checkout and Owner generation must match", () => {
  const f = fixture();
  try {
    assert.throws(() => f.services.reserve(f.input("bad-root", 43113, f.source)), /DISJOINT/);
    assert.throws(() => f.services.reserve({ ...f.input("bad-owner", 43114, f.state1),
      owner: {...f.owner, id: "other"} }), /OWNER_NOT_CURRENT/);
    assert.throws(() => f.services.reserve(f.input("bad-port", 0, f.state1)), /INVALID_BIND/);
    assert.equal(f.count("managed_executions"), 0);
  } finally { f.cleanup(); }
});

test("service cannot be marked running without a real armed Job or native process identity", () => {
  const f = fixture();
  try {
    const s = f.services.reserve(f.input("service", 43201, f.state1));
    assert.throws(() => f.services.confirmRunning(s.service_id, active), /LIVE_JOB_NOT_VERIFIED/);
    arm(f, s.execution_id);
    assert.throws(() => f.services.confirmRunning(s.service_id, gone), /LIVE_JOB_NOT_VERIFIED/);
    f.services.confirmRunning(s.service_id, active);
    assert.equal(f.services.inspect(s.service_id)?.state, "running");
    assert.throws(() => f.services.confirmRunning(s.service_id, active), /NOT_RESERVED/);
    assert.equal(f.count("execution_claims"), 0);
  } finally { f.cleanup(); }
});

test("service remains reserved on SQLite failure; no port or state-root release", () => {
  const f = fixture();
  try {
    const s = f.services.reserve(f.input("service", 43202, f.state1));
    arm(f, s.execution_id);
    f.db.exec(`create trigger block_running before update on managed_service_reservations
      begin select raise(abort,'INJECTED_SERVICE_STATUS_DB_FAILURE'); end;`);
    assert.throws(() => f.services.confirmRunning(s.service_id, active), /INJECTED_SERVICE_STATUS_DB_FAILURE/);
    assert.equal(f.services.inspect(s.service_id)?.state, "reserved");
    assert.throws(() => f.services.reserve(f.input("other", 43202, f.state2)), /UNIQUE/);
    f.db.exec("drop trigger block_running");
    f.services.confirmRunning(s.service_id, active);
    assert.equal(f.services.inspect(s.service_id)?.state, "running");
  } finally { f.cleanup(); }
});

test("only committed terminal and native-gone proof can release a service port and state root", () => {
  const f = fixture();
  try {
    const s = f.services.reserve(f.input("service", 43203, f.state1));
    arm(f, s.execution_id);
    f.services.confirmRunning(s.service_id, active);
    assert.throws(() => f.services.finalizeExited(s.service_id, gone), /RELEASE_PROOF_UNVERIFIED/);
    complete(f, s.execution_id);
    assert.throws(() => f.services.finalizeExited(s.service_id, active), /RELEASE_PROOF_UNVERIFIED/);
    f.db.exec(`create trigger block_service_release before update on managed_service_reservations
      when new.state='released' begin select raise(abort,'INJECTED_SERVICE_RELEASE_FAILURE'); end;`);
    assert.throws(() => f.services.finalizeExited(s.service_id, gone), /INJECTED_SERVICE_RELEASE_FAILURE/);
    assert.equal(f.services.inspect(s.service_id)?.state, "running");
    f.db.exec("drop trigger block_service_release");
    f.services.finalizeExited(s.service_id, gone);
    assert.equal(f.services.inspect(s.service_id)?.state, "released");
    assert.throws(() => f.services.finalizeExited(s.service_id, gone), /NOT_FINALIZABLE/);
    const reused = f.services.reserve(f.input("next-service", 43203, f.state1));
    assert.equal(reused.state, "reserved", "Ports are reusable only after verified service termination");
    assert.equal(f.count("execution_claims"), 0);
  } finally { f.cleanup(); }
});

test("real Windows service Job survives an independent Agent Job shutdown and releases only after native Job proof",
  process.platform === "win32" ? {} : { skip: "Windows native Job isolation" },
  async () => {
    const f = fixture(true);
    let serviceRunner: WindowsCommandRunner | undefined;
    let agentRunner: WindowsCommandRunner | undefined;
    try {
      const s = f.services.reserve(f.input("native-service-test", 43204, f.state1));
      const nativeBoot = f.owner.bootId;
      serviceRunner = await WindowsCommandRunner.start({
        executionId: s.execution_id, generation: 1, cwd: f.source,
        command: 'node -e "setInterval(()=>{},1000)"', environment: {},
        persistArmed(proof) {
          const store = new ExecutionStateStore(f.db);
          const armed = store.arm({
            executionId: proof.executionId, expectedVersion: 0, expectedGeneration: 1,
            pid: proof.runnerPid, createdAt: proof.runnerCreatedAt,
            bootId: nativeBoot, jobIdentity: proof.jobIdentity,
            evidence: JSON.stringify({ kind: "os_job_membership", count: proof.memberCount }),
          });
          store.transition({ executionId: proof.executionId, expectedVersion: armed.state_version,
            expectedGeneration: 1, phase: "running" });
        },
      });
      f.services.confirmRunning(s.service_id);
      assert.equal(f.services.inspect(s.service_id)?.state, "running");

      const agentRoot = join(f.root, "agent-native");
      mkdirSync(agentRoot);
      const admitted = f.coord.admitManaged({
        workspaceRoot: agentRoot, kind: "agent", agentId: "native-short-agent",
        maxConcurrentAgents: 4,
      }, (sqlite) => {
        const created = new ExecutionStateStore(sqlite).create({
          kind: "agent", owner: f.owner, workspaceId: "native-job-test",
          checkoutRoot: agentRoot, access: "write", resources: [],
          initialPhase: "starting", idempotencyScope: "service-agent-isolation",
          requestKey: randomUUID(), requestHash: createHash("sha256").update("native-agent").digest("hex"),
        });
        return { executionId: created.execution.id, value: created.execution.id };
      });
      agentRunner = await WindowsCommandRunner.start({
        executionId: admitted.value, generation: 1, cwd: agentRoot,
        command: "echo transient_agent_completed", environment: {},
        persistArmed(proof) {
          const store = new ExecutionStateStore(f.db);
          const armed = store.arm({
            executionId: proof.executionId, expectedVersion: 0, expectedGeneration: 1,
            pid: proof.runnerPid, createdAt: proof.runnerCreatedAt,
            bootId: nativeBoot, jobIdentity: proof.jobIdentity,
            evidence: "native-agent-membership-confirmed",
          });
          store.transition({ executionId: proof.executionId, expectedVersion: armed.state_version,
            expectedGeneration: 1, phase: "running" });
        },
      });
      const agentProof = await agentRunner.finished;
      assert.equal(agentProof.activeProcesses, 0);
      f.coord.completeManaged(admitted.value, (sqlite) => {
        const store = new ExecutionStateStore(sqlite);
        const state = store.get(admitted.value)!;
        store.transition({ executionId: admitted.value, expectedVersion: state.state_version,
          expectedGeneration: state.generation, phase: "terminal", outcome: "completed",
          resourceState: "released",
          exitEvidence: {kind: "job_empty_verified", verifiedAt: agentProof.verifiedAt,
            verifier: "WindowsCommandRunner", detail: JSON.stringify(agentProof)} });
      });
      assert.equal(f.count("execution_claims"), 0);
      assert.equal(f.services.inspect(s.service_id)?.state, "running",
        "Agent claim completion must never release long-lived service reservation");
      const serviceState = new ExecutionStateStore(f.db).get(s.execution_id)!;
      assert.equal(nativeRecoveryProbe.job(serviceState.job_identity as string), "exists_active",
        "Agent's Job cleanup must not kill independent persistent service Job");
      assert.throws(() => f.services.finalizeExited(s.service_id), /RELEASE_PROOF_UNVERIFIED/);
      const serviceProof = await serviceRunner.cancel(0);
      const final = new ExecutionStateStore(f.db).get(s.execution_id)!;
      new ExecutionStateStore(f.db).transition({
        executionId: s.execution_id, expectedVersion: final.state_version,
        expectedGeneration: final.generation, phase: "terminal", outcome: "cancelled",
        resourceState: "released",
        exitEvidence: { kind: "job_empty_verified", verifiedAt: serviceProof.verifiedAt,
          verifier: "WindowsCommandRunner", detail: JSON.stringify(serviceProof) },
      });
      let nativeState = "";
      for (let attempt = 0; attempt < 50; attempt++) {
        const current = new ExecutionStateStore(f.db).get(s.execution_id)!;
        const full = f.db.prepare("select runner_pid,runner_created_at,job_identity from managed_executions where id=?")
          .get(s.execution_id) as {runner_pid:number;runner_created_at:string;job_identity:string};
        const currentJob = nativeRecoveryProbe.job(full.job_identity);
        const currentProcess = nativeRecoveryProbe.process(full.runner_pid, full.runner_created_at);
        nativeState = `job=${currentJob};process=${currentProcess};phase=${current.phase};resource=${current.resource_state}`;
        if (currentJob === "absent" && currentProcess === "absent_or_reused") break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.match(nativeState, /job=absent;process=absent_or_reused/,
        `Windows service Job remains unverified: ${nativeState}`);
      f.services.finalizeExited(s.service_id);
      assert.equal(f.services.inspect(s.service_id)?.state, "released");
    } finally {
      await agentRunner?.cancel(0).catch(() => undefined);
      await serviceRunner?.cancel(0).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 400));
      f.cleanup();
    }
  });

test("health audit records unhealthy and probe errors without releasing or restarting a registered service",async()=>{
  const f=fixture();
  try{
    const reserved=f.services.reserve(f.input("audit-service",43211,f.state1));
    f.db.prepare("update managed_service_reservations set state='running' where service_id=?")
      .run(reserved.service_id);
    let n=0;
    const monitor=new ManagedServiceHealthMonitor(f.coord,{
      serviceId:reserved.service_id,
      checkHealth:async()=>{
        n++;
        if(n===1)return false;
        if(n===2)throw new Error("SENSITIVE_TOKEN_MUST_NOT_BE_LOGGED");
        return true;
      },
    },200);
    try{
      assert.equal((await monitor.sample())?.outcome,"unhealthy");
      assert.equal((await monitor.sample())?.outcome,"probe_error");
      assert.equal((await monitor.sample())?.outcome,"healthy");
      const journal=readServiceHealthJournal(f.coord,reserved.service_id);
      assert.deepEqual(journal.map((entry)=>entry.outcome),
        ["unhealthy","probe_error","healthy"]);
      assert.ok(journal.every((entry)=>!entry.note.includes("SENSITIVE_TOKEN")));
      assert.equal(f.services.inspect(reserved.service_id)?.state,"running",
        "Health failure alone cannot authorize process termination or resource unlock");
      assert.equal(f.count("managed_executions"),1,"No model/service restart or duplicate request");
      assert.equal(f.count("execution_claims"),0);
      const page=readServiceHealthJournal(f.coord,reserved.service_id,
        {afterSequence:journal[0].sequence,limit:1});
      assert.deepEqual(page.map((entry)=>entry.outcome),["probe_error"]);
      assert.throws(()=>readServiceHealthJournal(f.coord,reserved.service_id,{limit:101}),
        /SERVICE_HEALTH_READ_BOUND_INVALID/);
    }finally{await monitor.stop();}
  }finally{f.cleanup();}
});

test("health journal write failure preserves service reservation, then retries with one committed entry",async()=>{
  const f=fixture();
  try{
    const reserved=f.services.reserve(f.input("audit-failure",43212,f.state2));
    f.db.prepare("update managed_service_reservations set state='running' where service_id=?")
      .run(reserved.service_id);
    let checks=0;
    const monitor=new ManagedServiceHealthMonitor(f.coord,{
      serviceId:reserved.service_id,checkHealth:async()=>{
        checks++;await new Promise((resolve)=>setTimeout(resolve,30));return true;
      },
    },200);
    try{
      f.db.exec(`create trigger reject_health_write before insert on managed_service_health_journal
        begin select raise(abort,'INJECTED_HEALTH_JOURNAL_FAILURE'); end;`);
      await assert.rejects(monitor.sample(),/INJECTED_HEALTH_JOURNAL_FAILURE/);
      assert.equal(f.services.inspect(reserved.service_id)?.state,"running");
      assert.equal(f.count("managed_service_health_journal"),0);
      f.db.exec("drop trigger reject_health_write");
      const [a,b,c]=await Promise.all([monitor.sample(),monitor.sample(),monitor.sample()]);
      assert.equal(a?.sequence,b?.sequence);
      assert.equal(b?.sequence,c?.sequence);
      assert.equal(checks,2,"Concurrent samples deduplicate into one in-flight health check");
      assert.equal(f.count("managed_service_health_journal"),1);
      assert.equal(f.services.inspect(reserved.service_id)?.state,"running");
    } finally {
      f.db.exec("drop trigger if exists reject_health_write");
      await monitor.stop();
    }
  } finally { f.cleanup(); }
});

test("consecutive persisted health failures expose an alert but never mutate service ownership",async()=>{
  const f=fixture();
  try {
    const reserved=f.services.reserve(f.input("alert-threshold",43213,f.state3));
    f.db.prepare("update managed_service_reservations set state='running' where service_id=?")
      .run(reserved.service_id);
    let healthy=false;
    const monitor=new ManagedServiceHealthMonitor(f.coord,{
      serviceId:reserved.service_id,checkHealth:async()=>healthy,
    });
    try {
      for(let i=1;i<=3;i++){
        await monitor.sample();
        const alert=readServiceHealthAlert(f.coord,reserved.service_id);
        assert.equal(alert.consecutiveFailures,i);
        assert.equal(alert.active,i===3);
      }
      healthy=true;
      await monitor.sample();
      const restored=readServiceHealthAlert(f.coord,reserved.service_id);
      assert.equal(restored.active,false);
      assert.equal(restored.consecutiveFailures,0);
      assert.throws(()=>readServiceHealthAlert(f.coord,reserved.service_id,21),
        /SERVICE_HEALTH_ALERT_THRESHOLD_INVALID/);
      assert.equal(f.services.inspect(reserved.service_id)?.state,"running");
      assert.equal(f.count("managed_executions"),1);
      assert.equal(f.count("execution_claims"),0);
    }finally{await monitor.stop();}
  } finally {f.cleanup();}
});
