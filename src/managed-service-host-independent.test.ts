import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { connect } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ExecutionCoordinator } from "./execution-coordinator.js";
import { ManagedServiceReservations } from "./managed-service-reservations.js";
import { readServiceHealthJournal } from "./managed-service-health-monitor.js";
import { inspectServiceRecovery, scanServiceRecovery } from "./managed-service-recovery-view.js";
import { nativeRecoveryProbe } from "./windows-recovery-observer.js";
import { windowsBootIdentity } from "./windows-boot-identity.js";
import { windowsProcessCreatedAt } from "./windows-job-object.js";
import { screenWindowsPipeSddl } from "./windows-service-security-audit.js";
import { acquireServiceOwnerSingleton } from "./managed-service-owner-singleton.js";

const win = process.platform === "win32" ? {} : { skip: "Windows process ownership required" };
const fixtureScript = fileURLToPath(new URL("./managed-service-host-fixture.ts", import.meta.url));
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
type Message = {event: string; serviceId?: string; jobIdentity?: string; ownerId?: string;
  ownerGeneration?: string; error?: string; pid?: number; pipePath?: string; token?: string};
async function requestControl(pipePath: string, command: string, token: string) {
  return new Promise<{ok:boolean;status?:string;health?:string;error?:string}>((resolve,reject)=>{
    const socket=connect(pipePath);
    let reply="";
    let settled=false;
    const fail=(error:Error)=>{
      if(settled)return;
      settled=true;socket.destroy();reject(error);
    };
    socket.setTimeout(3_000,()=>fail(new Error("CONTROL_TEST_TIMEOUT")));
    socket.once("connect",()=>socket.write(JSON.stringify({protocol:1,token,command})+"\n"));
    socket.on("data",(part:Buffer)=>{
      if (settled) return;
      reply+=part.toString();
      const end=reply.indexOf("\n");
      if(end<0)return;
      let value:{ok:boolean;status?:string;health?:string;error?:string};
      try{value=JSON.parse(reply.slice(0,end));}
      catch{fail(new Error("CONTROL_INVALID_REPLY"));return;}
      settled=true;socket.destroy();resolve(value);
    });
    socket.once("error",fail);
    socket.once("close",()=>{if(!settled)fail(new Error("CONTROL_TRUNCATED_REPLY"));});
  });
}
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen({host:"127.0.0.1",port:0},resolve));
  const port = (server.address() as {port:number}).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
async function isolated() {
  const dir = mkdtempSync(join(tmpdir(), "tq-owner-separation-"));
  const checkout = join(dir, "checkout"), stateRoot = join(dir, "service-data");
  const stateDir = join(dir, "shared-state");
  for (const item of [checkout, stateRoot, stateDir]) mkdirSync(item);
  const serverCode = join(checkout, "sample-http.cjs");
  writeFileSync(serverCode, `require("node:http").createServer((req,res)=>{
    if(req.url!=="/healthz"){res.writeHead(404);return res.end();}
    res.setHeader("X-Taskquay-Health-Token",process.env.TASKQUAY_SERVICE_HEALTH_TOKEN);
    res.writeHead(200);res.end("ok");
  }).listen(Number(process.env.TASKQUAY_SERVICE_PORT),"127.0.0.1");`);
  const port = await freePort();
  const config = join(dir, "host-input.json");
  writeFileSync(config, JSON.stringify({
    testOnly:true,
    stateDir, workspaceRoot: checkout, stateRoot,
    port, serviceKey: "independent-host-" + randomUUID().slice(0,8),
    command: `"${process.execPath}" "${serverCode}"`,
  }));
  const parent = new ExecutionCoordinator(stateDir);
  const agentOwner = {
    id: parent.managedOwnerId, kind: "agentd" as const,
    pid: process.pid, processCreatedAt: windowsProcessCreatedAt(process.pid),
    bootId: windowsBootIdentity(), generation: randomUUID(),
  };
  parent.registerManagedOwner(agentOwner);
  const child = spawn(process.execPath,
    ["--import",import.meta.resolve("tsx"),fixtureScript,config], {
      cwd: dir, windowsHide:true, stdio:["pipe","pipe","pipe"],
      env:{...process.env,TASKQUAY_SERVICE_HOST_FIXTURE:"1"},
    });
  let stderr = "", incomplete = "";
  const messages: Message[] = [];
  // A STOP acknowledgement can race fixture cleanup: the child may have
  // closed its stdin before Node updates exitCode. EPIPE in this cleanup
  // channel is NOT evidence that a service Job was released.
  child.stdin.on("error",(error:NodeJS.ErrnoException)=>{
    if(error.code!=="EPIPE" && error.code!=="ERR_STREAM_DESTROYED") {
      stderr+=`SERVICE_FIXTURE_STDIN_ERROR ${error.code ?? "UNKNOWN"}\n`;
    }
  });
  child.stderr.on("data",(v:Buffer)=>{stderr+=v.toString();});
  child.stdout.on("data",(v:Buffer)=>{
    incomplete+=v.toString();
    let idx:number;
    while((idx=incomplete.indexOf("\n"))>=0){
      const line=incomplete.slice(0,idx).trim(); incomplete=incomplete.slice(idx+1);
      if(line){try{messages.push(JSON.parse(line) as Message);}catch{}}
    }
  });
  const waitEvent = async(event:string,ms=12_000) => {
    const end=Date.now()+ms;
    while(Date.now()<end){
      const result=messages.find((v)=>v.event===event);
      if(result)return result;
      if(child.exitCode!==null||child.signalCode!==null)
        throw new Error(`SERVICE_HOST_EXITED_BEFORE_${event}: ${stderr};${JSON.stringify(messages)}`);
      await delay(30);
    }
    throw new Error(`SERVICE_HOST_EVENT_TIMEOUT_${event}: ${stderr};${JSON.stringify(messages)}`);
  };
  const stopChild=async()=>{
    if(child.exitCode===null&&child.signalCode===null){
      if(!messages.some(message=>message.event==="STOPPED") &&
          !child.stdin.destroyed && child.stdin.writable){
        child.stdin.write("STOP\n",(error:NodeJS.ErrnoException|null|undefined)=>{
          if(error && error.code!=="EPIPE" && error.code!=="ERR_STREAM_DESTROYED")
            stderr+=`SERVICE_FIXTURE_STOP_WRITE_FAILED ${error.code ?? "UNKNOWN"}\n`;
        });
      }
      try{await waitEvent("STOPPED",9_000);}catch{
        if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");
      }
    }
    for(let i=0;i<100&&child.exitCode===null&&child.signalCode===null;i++)await delay(30);
  };
  const cleanup=async()=>{
    await stopChild();
    if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");
    parent.close();
    await delay(250);
    if(existsSync(dir))rmSync(dir,{recursive:true,force:true,maxRetries:20,retryDelay:100});
  };
  return {dir,child,parent,agentOwner,messages,waitEvent,stopChild,cleanup};
}

test("independent OS service host owns its own Job and writes periodic health audit while Agent coordinator stays separate",win,async()=>{
  const f=await isolated();
  try{
    const ready=await f.waitEvent("READY");
    assert.notEqual(ready.pid,process.pid);
    assert.notEqual(ready.ownerId,f.parent.managedOwnerId);
    assert.equal(nativeRecoveryProbe.job(ready.jobIdentity!),"exists_active");
    assert.ok(ready.serviceId);
    let journal=readServiceHealthJournal(f.parent,ready.serviceId!);
    for(let attempt=0;attempt<100&&journal.length<3;attempt++){
      await delay(45);
      journal=readServiceHealthJournal(f.parent,ready.serviceId!);
    }
    assert.ok(journal.length>=3,"service host must persist periodic health audit from another process");
    assert.ok(journal.every((v)=>v.outcome==="healthy"));
    assert.ok(journal.every((v)=>v.owner_id===ready.ownerId));
    assert.ok(journal.every((v)=>v.owner_generation===ready.ownerGeneration));
    const rows=f.parent.sharedDatabaseHandle.sqlite.prepare(
      "select owner_id,owner_generation,state from managed_service_reservations where service_id=?",
    ).get(ready.serviceId) as {owner_id:string;owner_generation:string;state:string};
    assert.equal(rows.state,"running");
    assert.notEqual(rows.owner_id,f.agentOwner.id);
    const liveView=inspectServiceRecovery(f.parent.sharedDatabaseHandle.sqlite,ready.serviceId!);
    assert.equal(liveView?.decision,"active",JSON.stringify(liveView));
    const anotherJobRoot=join(f.dir,"agent-separate");
    mkdirSync(anotherJobRoot);
    const claim=f.parent.acquire({
      workspaceRoot:anotherJobRoot,kind:"agent",agentId:"standalone-agent",
      maxConcurrentAgents:4,
    });
    claim.release();
    assert.equal(nativeRecoveryProbe.job(ready.jobIdentity!),"exists_active",
      "Agent coordinator claim completion must not stop independent service host Job");
    await f.stopChild();
    assert.equal(nativeRecoveryProbe.job(ready.jobIdentity!),"absent");
    assert.equal((f.parent.sharedDatabaseHandle.sqlite.prepare(
      "select state from managed_service_reservations where service_id=?",
    ).get(ready.serviceId) as {state:string}).state,"released");
    assert.ok(readServiceHealthJournal(f.parent,ready.serviceId!).length>=3,
      "health history survives service shutdown");
  } finally {await f.cleanup();}
});

test("killing only the independent supervisor closes its native Job but never auto-deletes a service reservation",win,async()=>{
  const f=await isolated();
  try{
    const ready=await f.waitEvent("READY");
    assert.equal(nativeRecoveryProbe.job(ready.jobIdentity!),"exists_active");
    f.child.kill("SIGKILL");
    for(let i=0;i<160&&f.child.exitCode===null&&f.child.signalCode===null;i++)await delay(20);
    assert.ok(f.child.exitCode!==null||f.child.signalCode!==null);
    let status="";
    for(let i=0;i<100;i++){
      status=nativeRecoveryProbe.job(ready.jobIdentity!);
      if(status==="absent")break;
      await delay(40);
    }
    assert.equal(status,"absent");
    const reservation=f.parent.sharedDatabaseHandle.sqlite.prepare(
      "select state from managed_service_reservations where service_id=?",
    ).get(ready.serviceId) as {state:string};
    assert.equal(reservation.state,"running",
      "An orphaned service requires evidence-gated reconciliation, not TTL/automatic release");
    const observed=inspectServiceRecovery(f.parent.sharedDatabaseHandle.sqlite,ready.serviceId!);
    assert.equal(observed?.decision,"orphan_review",JSON.stringify(observed));
    assert.equal(observed?.reason,"OWNER_AND_JOB_GONE_REQUIRES_EXPLICIT_RECONCILIATION");
    const readonly=scanServiceRecovery(f.parent.sharedDatabaseHandle.sqlite);
    assert.equal(readonly.mode,"observe_only");
    assert.ok(readonly.entries.some((row)=>row.serviceId===ready.serviceId &&
      row.decision==="orphan_review"));
    const db=f.parent.sharedDatabaseHandle.sqlite;
    const owner=db.prepare("select status from execution_owners where id=?")
      .get(ready.ownerId) as {status:string};
    assert.equal(owner.status,"active","stale heartbeat alone never declares native death");
    const recorded=readServiceHealthJournal(f.parent,ready.serviceId!);
    assert.ok(recorded.length>=1);
    const metadata=db.prepare(
      "select service_key,port,state_root from managed_service_reservations where service_id=?",
    ).get(ready.serviceId) as {service_key:string;port:number;state_root:string};
    const serviceInput={
      workspaceRoot:join(f.dir,"checkout"),workspaceId:"independent-service-owner-fixture",
      stateRoot:join(f.dir,"service-data"),
      serviceKey:metadata.service_key,port:metadata.port,bindHost:"127.0.0.1" as const,
      owner:f.agentOwner,
    };
    assert.throws(()=>new ManagedServiceReservations(f.parent).reserve(serviceInput),
      /UNIQUE constraint failed/,"Dead supervisor cannot authorize an automatic duplicate service");
  } finally {await f.cleanup();}
});

test("closing the initiating client's stdin pipe never stops an independently owned service Job",win,async()=>{
  const f=await isolated();
  try{
    const ready=await f.waitEvent("READY");
    f.child.stdin.end();
    await delay(500);
    assert.equal(f.child.exitCode,null);
    assert.equal(f.child.signalCode,null);
    assert.equal(nativeRecoveryProbe.job(ready.jobIdentity!),"exists_active",
      "A client disconnect cannot become a service termination signal");
    const journal=readServiceHealthJournal(f.parent,ready.serviceId!);
    assert.ok(journal.length>=2,"independent supervisor continues monitoring");
    f.child.kill("SIGTERM");
    for(let i=0;i<120&&f.child.exitCode===null&&f.child.signalCode===null;i++)await delay(30);
    assert.ok(f.child.exitCode!==null||f.child.signalCode!==null);
    let job="";
    for(let i=0;i<100;i++){
      job=nativeRecoveryProbe.job(ready.jobIdentity!);
      if(job==="absent")break;
      await delay(40);
    }
    assert.equal(job,"absent");
    assert.equal((f.parent.sharedDatabaseHandle.sqlite.prepare(
      "select state from managed_service_reservations where service_id=?",
    ).get(ready.serviceId) as {state:string}).state,"running",
      "Windows TerminateProcess is not a graceful STOP; never erase a reservation without committed proof");
  } finally {await f.cleanup();}
});

test("local capability control rejects unauthorized STOP but permits authorized status, health and exact service shutdown",win,async()=>{
  const f=await isolated();
  try {
    const ready=await f.waitEvent("READY");
    assert.ok(ready.pipePath && ready.token);
    assert.equal((await requestControl(ready.pipePath!,"STOP","00".repeat(32))).error,
      "CONTROL_UNAUTHORIZED");
    assert.equal(nativeRecoveryProbe.job(ready.jobIdentity!),"exists_active");
    const status=await requestControl(ready.pipePath!,"STATUS",ready.token!);
    assert.equal(status.ok,true);
    assert.equal(status.status,"running");
    const health=await requestControl(ready.pipePath!,"HEALTH",ready.token!);
    assert.equal(health.ok,true);
    assert.equal(health.health,"healthy");
    const stopped=await requestControl(ready.pipePath!,"STOP",ready.token!);
    assert.equal(stopped.status,"stop_requested");
    await f.waitEvent("STOPPED",12_000);
    assert.equal(nativeRecoveryProbe.job(ready.jobIdentity!),"absent");
    const row=f.parent.sharedDatabaseHandle.sqlite.prepare(
      "select state from managed_service_reservations where service_id=?",
    ).get(ready.serviceId) as {state:string};
    assert.equal(row.state,"released");
  } finally {await f.cleanup();}
});

test("native restricted control pipe recovers after a client opens and disconnects without a request",win,async()=>{
  const f=await isolated();
  try {
    const ready=await f.waitEvent("READY");
    assert.ok(ready.pipePath && ready.token);
    // Multiple consecutive cancellations are necessary: the third abrupt
    // detach previously invalidated WaitForConnection and killed the broker.
    for(let cycle=0;cycle<4;cycle++){
      await new Promise<void>((resolve,reject)=>{
        const socket=connect(ready.pipePath!);
        socket.once("connect",()=>{socket.destroy();resolve();});
        socket.once("error",reject);
      });
      // The native async read cancellation is bounded by 3 seconds.
      await delay(3_400);
      const status=await requestControl(ready.pipePath!,"STATUS",ready.token!);
      assert.equal(status.ok,true,`pipe recovered after cancellation cycle ${cycle}`);
      assert.equal(status.status,"running");
      assert.equal(nativeRecoveryProbe.job(ready.jobIdentity!),"exists_active");
    }
    const anonymousProbe=fileURLToPath(new URL("../scripts/test-windows-anonymous-service-acl.ps1",import.meta.url));
    const denied=execFileSync("pwsh",["-NoProfile","-File",anonymousProbe,
      "-ExistingPipeName",ready.pipePath!],{
      windowsHide:true,timeout:9_000,encoding:"utf8",
    });
    assert.match(denied,/EXPERIMENTAL_NATIVE_PIPE_ACL_OK/,
      "recreated pipe must keep its native restricted DACL after repeated disconnects");
    assert.match(denied,/anonymousTokenPipeError=5/);
  } finally {await f.cleanup();}
});

test("same-state Windows native mutex refuses a duplicate supervisor while original Job is running",win,async()=>{
  const f=await isolated();
  try{
    const ready=await f.waitEvent("READY");
    assert.equal(nativeRecoveryProbe.job(ready.jobIdentity!),"exists_active");
    assert.throws(()=>acquireServiceOwnerSingleton(join(f.dir,"shared-state")),
      /SERVICE_OWNER_ALREADY_RUNNING/);
    assert.equal(nativeRecoveryProbe.job(ready.jobIdentity!),"exists_active");
    await f.stopChild();
    const release=acquireServiceOwnerSingleton(join(f.dir,"shared-state"));
    release();
    release();
  }finally{await f.cleanup();}
});

test("actual experimental control pipe denies anonymous native open, without claiming cross-account production authorization",win,async()=>{
  const f=await isolated();
  try{
    const ready=await f.waitEvent("READY");
    assert.ok(ready.pipePath);
    const restrictedScript=fileURLToPath(new URL("../scripts/test-windows-restricted-token-pipe.ps1",import.meta.url));
    const restricted=execFileSync("pwsh",["-NoProfile","-File",restrictedScript,
      "-ExistingPipeName",ready.pipePath!],{
      windowsHide:true,timeout:9_000,encoding:"utf8",
    });
    assert.match(restricted,/WINDOWS_NATIVE_RESTRICTED_TOKEN_ACL_OK/);
    assert.match(restricted,/restrictedIdentityOpen=5/);
    const script=fileURLToPath(new URL("../scripts/probe-windows-pipe-acl.ps1",import.meta.url));
    const stdout=execFileSync("pwsh",["-NoProfile","-File",script,
      "-ExistingPipeName",ready.pipePath!],{
      windowsHide:true,timeout:7_000,encoding:"utf8",
    });
    const sddl=/PIPE_ACL_SDDL=(D:\S+)/.exec(stdout)?.[1];
    assert.ok(sddl,stdout);
    const review=screenWindowsPipeSddl(sddl);
    assert.equal(review.verifiedExclusive,false,
      "Read-only inspection must never claim OS account-level authorization is complete");
    assert.ok(!review.findings.some((f)=>f.startsWith("PIPE_BROAD_ALLOW_ACE")),
      `The experimental broker must set an exclusive DACL at pipe creation: ${JSON.stringify(review.findings)}`);
    assert.ok(review.findings.includes("PIPE_EFFECTIVE_CROSS_ACCOUNT_ACCESS_NOT_VERIFIED"));
    const nativeProbe=fileURLToPath(new URL("../scripts/test-windows-anonymous-service-acl.ps1",import.meta.url));
    const native=execFileSync("pwsh",["-NoProfile","-File",nativeProbe,
      "-ExistingPipeName",ready.pipePath!],{
      windowsHide:true,timeout:9_000,encoding:"utf8",
    });
    assert.match(native,/EXPERIMENTAL_NATIVE_PIPE_ACL_OK/);
    assert.match(native,/anonymousTokenPipeError=5/);
    assert.equal(f.child.exitCode,null,"Native ACL probes must not exit the fixture host");
    assert.equal(nativeRecoveryProbe.job(ready.jobIdentity!),"exists_active",
      "Opening a read-only ACL inspection handle cannot stop the service");
  }finally{await f.cleanup();}
});
