import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ExecutionCoordinator } from "./execution-coordinator.js";
import { ManagedServiceSupervisor } from "./managed-service-supervisor.js";
import { windowsBootIdentity } from "./windows-boot-identity.js";
import { windowsProcessCreatedAt } from "./windows-job-object.js";
import { nativeRecoveryProbe } from "./windows-recovery-observer.js";

const win = process.platform === "win32" ? {} : { skip: "Windows-only service Job integration" };
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function availablePort() {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen({host:"127.0.0.1", port:0},resolve));
  const port = (socket.address() as {port:number}).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return port;
}
async function fixture(badHealth = false) {
  const root = mkdtempSync(join(tmpdir(), "tq-managed-service-supervisor-"));
  const project = join(root, "checkout"), stateRoot = join(root, "state");
  [project, stateRoot].forEach((dir) => mkdirSync(dir));
  const scriptPath = join(project, "service.cjs");
  writeFileSync(scriptPath, `
const http = require("node:http");
const s = http.createServer((req,res) => {
  if (req.url !== "/healthz") { res.writeHead(404); return res.end(); }
  if (!${badHealth ? "true" : "false"}) {
    res.setHeader("X-Taskquay-Health-Token",process.env.TASKQUAY_SERVICE_HEALTH_TOKEN);
  }
  res.writeHead(200); res.end("ok");
});
s.listen(Number(process.env.TASKQUAY_SERVICE_PORT), "127.0.0.1");
`);
  const coord = new ExecutionCoordinator(join(root, "db"));
  const owner = {
    id: coord.managedOwnerId, kind: "agentd" as const, pid: process.pid,
    processCreatedAt: windowsProcessCreatedAt(process.pid),
    bootId: windowsBootIdentity(), generation: randomUUID(),
  };
  coord.registerManagedOwner(owner);
  const supervisor = new ManagedServiceSupervisor(coord);
  const port = await availablePort();
  const input = {
    serviceKey: "fixture-service", workspaceId: "fixture",
    workspaceRoot: project, stateRoot, owner,
    bindHost: "127.0.0.1" as const, port,
    healthTimeoutMs: 3_500,
    command: `"${process.execPath}" "${scriptPath}"`,
  };
  const cleanup = async () => {
    coord.close();
    await delay(300);
    if (existsSync(root)) rmSync(root, { recursive:true, force:true, maxRetries:20, retryDelay:100 });
  };
  return {root,project,stateRoot,coord,owner,supervisor,input,port,cleanup};
}

test("isolated supervisor starts a real loopback HTTP service only after durable native Job arming and health identity",win,async()=>{
  const f=await fixture();
  let handle: Awaited<ReturnType<typeof f.supervisor.start>>|undefined;
  try {
    handle=await f.supervisor.start(f.input);
    assert.equal(await handle.checkHealth(),true);
    const db=f.coord.sharedDatabaseHandle.sqlite;
    assert.deepEqual((db.prepare("select state from managed_service_reservations")
      .get() as {state:string}).state,"running");
    assert.equal((db.prepare("select count(*) n from execution_claims").get() as {n:number}).n,0);
    assert.equal((db.prepare("select count(*) n from execution_waiters").get() as {n:number}).n,0);
    assert.equal(nativeRecoveryProbe.job(handle.jobIdentity),"exists_active");
    await handle.stop();
    assert.equal(await handle.checkHealth(),false);
    assert.equal(nativeRecoveryProbe.job(handle.jobIdentity),"absent");
    assert.equal((db.prepare("select state from managed_service_reservations")
      .get() as {state:string}).state,"released");
    const execution=db.prepare("select phase,outcome,resource_state,exit_evidence from managed_executions")
      .get() as {phase:string;outcome:string;resource_state:string;exit_evidence:string};
    assert.deepEqual([execution.phase,execution.outcome,execution.resource_state],
      ["terminal","cancelled","released"]);
    assert.equal(JSON.parse(execution.exit_evidence).kind,"job_empty_verified");
    await handle.stop();
  } finally { await handle?.stop().catch(()=>undefined); await f.cleanup(); }
});

test("external listener occupying requested port prevents reservation and never touches that listener",win,async()=>{
  const f=await fixture();
  const server=createServer();
  try {
    await new Promise<void>((resolve)=>server.listen(f.port,"127.0.0.1",resolve));
    await assert.rejects(f.supervisor.start(f.input),/SERVICE_PORT_ALREADY_BOUND/);
    const db=f.coord.sharedDatabaseHandle.sqlite;
    assert.equal((db.prepare("select count(*) n from managed_service_reservations")
      .get() as {n:number}).n,0);
    assert.equal((db.prepare("select count(*) n from managed_executions").get() as {n:number}).n,0);
    assert.equal(server.listening,true);
  } finally {
    if(server.listening) await new Promise<void>((resolve)=>server.close(()=>resolve()));
    await f.cleanup();
  }
});

test("incorrect health identity fails closed, kills only its Job, and does not retain a false running service",win,async()=>{
  const f=await fixture(true);
  try {
    await assert.rejects(f.supervisor.start({...f.input,healthTimeoutMs:1500}),/SERVICE_HEALTH_NOT_CONFIRMED/);
    const db=f.coord.sharedDatabaseHandle.sqlite;
    const current=db.prepare("select state from managed_service_reservations")
      .get() as {state:string};
    assert.equal(current.state,"released",
      "Verified native shutdown releases an unhealthy newly-started service");
    assert.equal((db.prepare("select count(*) n from execution_claims").get() as {n:number}).n,0);
    const row=db.prepare("select phase,resource_state,outcome from managed_executions")
      .get() as {phase:string;resource_state:string;outcome:string};
    assert.deepEqual([row.phase,row.resource_state,row.outcome],["terminal","released","failed"]);
    const newPort=await availablePort();
    assert.equal(typeof newPort,"number");
  } finally { await f.cleanup(); }
});

test("untrusted public service bind is refused before creating any managed execution",win,async()=>{
  const f=await fixture();
  try {
    await assert.rejects(f.supervisor.start({...f.input,bindHost:"0.0.0.0"}),/LOOPBACK_ONLY/);
    assert.equal((f.coord.sharedDatabaseHandle.sqlite.prepare(
      "select count(*) n from managed_service_reservations").get() as {n:number}).n,0);
  } finally { await f.cleanup(); }
});
