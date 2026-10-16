/**
 * Explicit bounded Windows infrastructure soak; NOT a real-Provider stress run.
 * No user DBs, existing services, Windows accounts, or remote model calls.
 * Usage: pnpm exec tsx scripts/run-isolated-soak.ts --seconds 75
 * A fresh Temp tree is the only mutable target. Output receipt intentionally
 * excludes pipe tokens, machine account names and the disposable path.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, connect } from "node:net";
import { closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync, readFileSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import Database from "better-sqlite3";
import { ExecutionCoordinator, type ExecutionClaimInput } from "../src/execution-coordinator.js";
import { ExecutionStateStore, type ExecutionOwnerIdentity } from "../src/execution-state-store.js";
import { readServiceHealthJournal } from "../src/managed-service-health-monitor.js";
import { windowsProcessCreatedAt } from "../src/windows-job-object.js";
import { windowsBootIdentity } from "../src/windows-boot-identity.js";
import { nativeRecoveryProbe } from "../src/windows-recovery-observer.js";

if (process.platform !== "win32" || process.env.TASKQUAY_SERVICE_HOST_FIXTURE === "1") {
  throw new Error("SOAK_NATIVE_WINDOWS_ISOLATED_HOST_ONLY");
}
const args=process.argv.slice(2);
if(args.length!==2 || args[0]!=="--seconds" || !/^\d+$/.test(args[1])) {
  throw new Error("SOAK_USAGE: --seconds 30..600");
}
const seconds=Number(args[1]);
if(!Number.isSafeInteger(seconds)||seconds<30||seconds>600)throw new Error("SOAK_BUDGET_INVALID");
const started=new Date().toISOString(), start=Date.now(), end=start+seconds*1000;
const dir=mkdtempSync(join(tmpdir(),"taskquay-isolated-soak-"));
const state=join(dir,"admission-state"), serviceState=join(dir,"service-state");
const roots=Array.from({length:10},(_,i)=>join(dir,`checkout-${i}`));
for(const p of [...roots,state,serviceState,join(dir,"service-data")])mkdirSync(p,{recursive:true});
const hash=(s:string)=>createHash("sha256").update(s).digest("hex");
let a:ExecutionCoordinator|undefined,b:ExecutionCoordinator|undefined;
let child:ChildProcessWithoutNullStreams|undefined;
let tempPort=0, rounds=0, fairnessChecks=0, admissions=0, maxActive=0,
  busyChecks=0, maxWalBytes=0, samples=0, droppedClientRecoveries=0,
  maxRss=0, serviceCycles=0, healthSamples=0, jobStops=0;
let failed:string|undefined;
let stage="setup";
let serviceAliveAtFailure:boolean|null=null;
let lastServiceStderr="", serviceHostExitAtFailure:number|null=null;
let residualClaims:number|null=null,residualWaiters:number|null=null,
  finalIntegrity:"ok"|"failed"|"unavailable"="unavailable",serviceJournalEvents=0;
const fifoWaitMs:number[]=[];
type ResourceSample={
  elapsedSeconds:number;rssBytes:number;heapUsedBytes:number;walBytes:number;
  checkpointBusy:number|null;checkpointPages:number|null;checkpointedPages:number|null;
};
const resourceSamples:ResourceSample[]=[];
let lastResourceSample=0,checkpointFailures=0;
const percentile=(data:number[],fraction:number)=>{
  if(!data.length)return null;
  const sorted=[...data].sort((a,b)=>a-b);
  return +sorted[Math.ceil((sorted.length-1)*fraction)].toFixed(3);
};
const fixture=fileURLToPath(new URL("../src/managed-service-host-fixture.ts",import.meta.url));
const sourceHash=hash(readFileSync(fileURLToPath(new URL("../src/execution-coordinator.ts",import.meta.url)),"utf8"));
const register=(coord:ExecutionCoordinator,label:string):ExecutionOwnerIdentity=>{
  const owner:ExecutionOwnerIdentity={
    id:coord.managedOwnerId,kind:"agentd",pid:process.pid,
    processCreatedAt:windowsProcessCreatedAt(process.pid),bootId:windowsBootIdentity(),
    generation:`soak-${label}-${randomUUID()}`,
  };
  coord.registerManagedOwner(owner);
  return owner;
};
const getCount=(table:string)=>Number((a!.sharedDatabaseHandle.sqlite
  .prepare(`select count(*) n from ${table}`).get() as {n:number}).n);
const input=(id:number,label:string):ExecutionClaimInput=>({
  workspaceRoot:roots[id],kind:"agent",agentId:label,access:"write",
  resources:[],maxConcurrentAgents:4,
});
const main=async()=>{
  a=new ExecutionCoordinator(state);b=new ExecutionCoordinator(state);
  const owners=new Map<ExecutionCoordinator,ExecutionOwnerIdentity>([
    [a,register(a,"a")],[b,register(b,"b")],
  ]);
  let serial=0;
  const callback=(coord:ExecutionCoordinator,claim:ExecutionClaimInput)=>{
    const owner=owners.get(coord)!;
    return (sqlite:Database.Database)=>{
      const result=new ExecutionStateStore(sqlite).create({
        kind:"agent",workspaceId:"soak-fixture",checkoutRoot:claim.workspaceRoot,
        owner,access:"write",resources:[],idempotencyScope:"soak-no-provider",
        requestKey:`soak-${++serial}-${randomUUID()}`,
        requestHash:hash(JSON.stringify(claim)),initialPhase:"starting",
      });
      assert.equal(result.created,true);
      return {executionId:result.execution.id,value:result.execution.id};
    };
  };
  type Running={coord:ExecutionCoordinator;executionId:string};
  const finish=(p:Running)=>{
    p.coord.completeManaged(p.executionId,(db)=>{
      const store=new ExecutionStateStore(db);
      let row=store.get(p.executionId)!;
      row=store.transition({executionId:row.id,expectedGeneration:row.generation,
        expectedVersion:row.state_version,phase:"terminal",outcome:"failed",
        resourceState:"cleanup_pending"});
      store.transition({executionId:row.id,expectedGeneration:row.generation,
        expectedVersion:row.state_version,resourceState:"released",
        exitEvidence:{kind:"never_dispatched_verified",verifiedAt:new Date().toISOString(),
          verifier:"bounded-isolation-soak",detail:"No model or Provider process launched"}});
    });
  };
  const admissionRound=()=>{
    const running:Running[]=[];
    try {
      for(let i=0;i<4;i++){
        const coord=i%2?b!:a!, v=input(i,`running-${rounds}-${i}`);
        const result=coord.admitManaged(v,callback(coord,v));
        running.push({coord,executionId:result.value});
      }
      assert.equal(getCount("execution_claims"),4);
      maxActive=Math.max(maxActive,getCount("execution_claims"));
      const pending=Array.from({length:6},(_,i)=>{
        const coord=i%2?b!:a!, v=input(4+(i%6),`queued-${rounds}-${i}`);
        return {ticket:coord.enqueueManaged(v,20_000),coord,v,queuedAt:performance.now()};
      });
      for(let i=0;i<pending.length;i++){
        if(i===0)finish(running.shift()!);
        if(i+1<pending.length){
          assert.equal(pending[i+1].ticket.tryAdmit(callback(
            pending[i+1].coord,pending[i+1].v)),undefined,"FIFO barging");
          fairnessChecks++;
        }
        const next=pending[i],result=next.ticket.tryAdmit(callback(next.coord,next.v));
        assert.ok(result,`FIFO starvation at round=${rounds}, ticket=${i}`);
        fifoWaitMs.push(performance.now()-next.queuedAt);
        running.push({coord:next.coord,executionId:result.value});
        maxActive=Math.max(maxActive,getCount("execution_claims"));
        assert.ok(maxActive<=4,"more than four Agent claims active");
        // Recycle exactly one free slot.
        finish(running.shift()!);
        admissions++;
      }
    }finally{
      for(const active of running)finish(active);
    }
    assert.equal(getCount("execution_claims"),0);
    assert.equal(getCount("execution_waiters"),0);
    rounds++;
  };
  const walProbe=()=>{
    const db=a!.sharedDatabaseHandle.sqlite;
    const contender=new Database(join(state,"devspace.sqlite"),{timeout:70});
    try {
      assert.equal(db.pragma("journal_mode",{simple:true}),"wal");
      db.exec("BEGIN IMMEDIATE");
      try{
        assert.throws(()=>contender.exec("BEGIN IMMEDIATE"),(e:unknown)=>
          (e as {code?:string}).code==="SQLITE_BUSY",
          "Second connection must not steal the first writer lock");
        busyChecks++;
      }finally{db.exec("ROLLBACK");}
      contender.exec("BEGIN IMMEDIATE; COMMIT;");
      assert.equal(db.pragma("quick_check",{simple:true}),"ok");
      assert.equal((db.pragma("foreign_key_check") as unknown[]).length,0);
      const wal=join(state,"devspace.sqlite-wal");
      if(existsSync(wal))maxWalBytes=Math.max(maxWalBytes,statSync(wal).size);
      samples++;
    } finally {contender.close();}
  };
  const resourceProbe=()=>{
    const now=Date.now();
    if(now-lastResourceSample<4_000)return;
    lastResourceSample=now;
    const db=a!.sharedDatabaseHandle.sqlite;
    const wal=join(state,"devspace.sqlite-wal");
    let checkpointBusy:number|null=null, checkpointPages:number|null=null,
      checkpointedPages:number|null=null;
    try {
      const status=db.pragma("wal_checkpoint(PASSIVE)") as Array<{
        busy:number;log:number;checkpointed:number;
      }>;
      assert.equal(status.length,1);
      checkpointBusy=status[0].busy;
      checkpointPages=status[0].log;
      checkpointedPages=status[0].checkpointed;
      assert.equal(checkpointBusy,0,"WAL checkpoint reports unhandled busy writer");
    }catch(error){checkpointFailures++;throw error;}
    const mem=process.memoryUsage();
    resourceSamples.push({
      elapsedSeconds:+((now-start)/1000).toFixed(2),rssBytes:mem.rss,
      heapUsedBytes:mem.heapUsed,
      walBytes:existsSync(wal)?statSync(wal).size:0,
      checkpointBusy,checkpointPages,checkpointedPages,
    });
  };
  const freePort=async()=>{
    const sock=createServer();
    await new Promise<void>(resolve=>sock.listen(0,"127.0.0.1",()=>resolve()));
    const p=(sock.address() as {port:number}).port;
    await new Promise<void>(resolve=>sock.close(()=>resolve()));return p;
  };
  const req=(path:string,token:string,command:string)=>new Promise<{ok:boolean;status?:string;error?:string;health?:string}>((resolve,reject)=>{
    const sock=connect(path);
    let data="",done=false;
    const fail=(error:Error)=>{if(done)return;done=true;sock.destroy();reject(error);};
    sock.setTimeout(4000,()=>fail(new Error("SOAK_CONTROL_TIMEOUT")));
    sock.on("error",fail);
    sock.on("connect",()=>sock.write(JSON.stringify({protocol:1,token,command})+"\n"));
    sock.on("data",(b:Buffer)=>{
      if(done)return;
      data+=b.toString();
      if(!data.includes("\n"))return;
      let value:{ok:boolean;status?:string;error?:string;health?:string};
      try{value=JSON.parse(data.slice(0,data.indexOf("\n")));}
      catch{fail(new Error("SOAK_CONTROL_REPLY_INVALID"));return;}
      done=true;sock.destroy();resolve(value);
    });
    sock.on("close",()=>{if(!done)fail(new Error("SOAK_CONTROL_TRUNCATED"));});
  });
  const serviceOnce=async(until:number)=>{
    stage=`service-${serviceCycles}-spawn`;
    tempPort=await freePort();
    const project=join(dir,"service-project");
    mkdirSync(project,{recursive:true});
    const code=join(project,"health.cjs");
    writeFileSync(code,`require("node:http").createServer((req,res)=>{if(req.url!=="/healthz"){res.writeHead(404);return res.end()};res.setHeader("X-Taskquay-Health-Token",process.env.TASKQUAY_SERVICE_HEALTH_TOKEN);res.writeHead(200);res.end("ok")}).listen(Number(process.env.TASKQUAY_SERVICE_PORT),"127.0.0.1");`);
    const config=join(dir,`service-config-${serviceCycles}.json`);
    writeFileSync(config,JSON.stringify({
      testOnly:true,stateDir:serviceState,workspaceRoot:project,
      stateRoot:join(dir,"service-data"),port:tempPort,
      serviceKey:`isolation-soak-${serviceCycles}-${randomUUID().slice(0,6)}`,
      command:`"${process.execPath}" "${code}"`,
    }));
    child=spawn(process.execPath,["--import","tsx",fixture,config],{
      cwd:fileURLToPath(new URL("../",import.meta.url)),
      stdio:["pipe","pipe","pipe"],windowsHide:true,
      env:{...process.env,TASKQUAY_SERVICE_HOST_FIXTURE:"1",
        TASKQUAY_CONTROL_BROKER_TEST_DIAGNOSTICS:"1"},
    });
    let stdout="",stderr="";
    const events:Array<Record<string,unknown>>=[];
    child.stdout.on("data",(b:Buffer)=>{
      stdout+=b.toString("utf8");
      for(;;){const idx=stdout.indexOf("\n");if(idx<0)break;
        const line=stdout.slice(0,idx).trim();stdout=stdout.slice(idx+1);
        if(line){try{events.push(JSON.parse(line));}catch{}}
      }
    });
    child.stderr.on("data",(b:Buffer)=>{stderr=(stderr+b.toString("utf8")).slice(-2048);});
    child.stderr.on("data",()=>{lastServiceStderr=stderr;});
    const event=async(name:string,ms=12_000)=>{
      const finish=Date.now()+ms;
      while(Date.now()<finish){
        const match=events.find((v)=>v.event===name);
        if(match)return match;
        if(child!.exitCode!==null)throw new Error(`SOAK_SERVICE_EXITED_BEFORE_${name}: ${stderr}`);
        await sleep(40);
      }
      throw new Error(`SOAK_SERVICE_EVENT_TIMEOUT_${name}: ${stderr}`);
    };
    const ready=await event("READY");
    stage=`service-${serviceCycles}-ready`;
    const pipe=String(ready.pipePath),token=String(ready.token);
    assert.ok(/^\\\\\.\\pipe\\taskquay-experimental-service-[a-f0-9]{32}$/.test(pipe));
    assert.equal(nativeRecoveryProbe.job(String(ready.jobIdentity)),"exists_active");
    child.stdin.end(); // client disconnect must NOT stop the independently owned Job
    stage=`service-${serviceCycles}-unauthorized-stop`;
    assert.equal((await req(pipe,"00".repeat(32),"STOP")).error,"CONTROL_UNAUTHORIZED");
    assert.equal(nativeRecoveryProbe.job(String(ready.jobIdentity)),"exists_active");
    let reconnects=0;
    while(Date.now()<until){
      stage=`service-${serviceCycles}-admission-round-${rounds}`;
      admissionRound();
      if(rounds%4===0)walProbe();
      resourceProbe();
      if(rounds%3===0){
        stage=`service-${serviceCycles}-status-${rounds}`;
        assert.equal((await req(pipe,token,"STATUS")).status,"running");
        stage=`service-${serviceCycles}-health-${rounds}`;
        assert.equal((await req(pipe,token,"HEALTH")).health,"healthy");
        reconnects+=2;healthSamples++;
      }
      if(rounds%15===0){
        stage=`service-${serviceCycles}-drop-${rounds}`;
        await new Promise<void>((resolve,reject)=>{
          const s=connect(pipe);s.once("error",reject);
          s.once("connect",()=>{s.destroy();resolve();});
        });
        await sleep(3300);
        stage=`service-${serviceCycles}-recover-${rounds}`;
        assert.equal((await req(pipe,token,"STATUS")).status,"running");
        reconnects++;droppedClientRecoveries++;
      }
      maxRss=Math.max(maxRss,process.memoryUsage().rss);
      await sleep(70);
    }
    assert.ok(reconnects>2);
    const stop=await req(pipe,token,"STOP");
    stage=`service-${serviceCycles}-stopping`;
    assert.equal(stop.status,"stop_requested");
    await event("STOPPED",12_000);
    assert.equal(nativeRecoveryProbe.job(String(ready.jobIdentity)),"absent");
    const db=new Database(join(serviceState,"devspace.sqlite"),{readonly:true,fileMustExist:true});
    try{
      const status=db.prepare("select state from managed_service_reservations where service_id=?")
        .get(ready.serviceId) as {state:string};
      assert.equal(status.state,"released");
      const journal=(db.prepare("select count(*) n from managed_service_health_journal where service_id=?")
        .get(ready.serviceId) as {n:number}).n;
      assert.ok(journal>=2);
      serviceJournalEvents+=journal;
    }finally{db.close();}
    jobStops++;serviceCycles++;
    // Wait for actual host exit; the native child process must not persist.
    for(let t=0;t<80 && child.exitCode===null;t++)await sleep(40);
    assert.equal(child.exitCode,0,"supervisor must exit cleanly after Job STOP");
    child=undefined;
  };
  // Two independent service supervisors; the second must start after the
  // first has closed its native service Job and released its reservation.
  await serviceOnce(start+Math.ceil(seconds/2)*1000);
  await serviceOnce(end);
  assert.ok(rounds>=10 && admissions>=60 && fairnessChecks>=50);
  assert.ok(busyChecks>=2 && healthSamples>=2 && serviceCycles===2 && jobStops===2);
  assert.ok(resourceSamples.length>=3 && checkpointFailures===0);
  assert.equal(getCount("execution_claims"),0);
  assert.equal(getCount("execution_waiters"),0);
  assert.equal(a!.sharedDatabaseHandle.sqlite.pragma("integrity_check",{simple:true}),"ok");
  assert.equal((a!.sharedDatabaseHandle.sqlite.pragma("foreign_key_check") as unknown[]).length,0);
};
try {await main();}
catch(e){
  serviceAliveAtFailure=child?child.exitCode===null:null;
  serviceHostExitAtFailure=child?.exitCode??null;
  failed=String(e);
}
finally{
  if(child && child.exitCode===null)child.kill();
  if(a){
    try{
      residualClaims=getCount("execution_claims");
      residualWaiters=getCount("execution_waiters");
      finalIntegrity=a.sharedDatabaseHandle.sqlite.pragma("integrity_check",{simple:true})==="ok"?"ok":"failed";
    }catch{}
  }
  a?.close();b?.close();
  await sleep(500);
  try{rmSync(dir,{recursive:true,force:true,maxRetries:20,retryDelay:100});}
  catch{if(!failed)failed="SOAK_DISPOSABLE_CLEANUP_FAILED";}
}
const files=["src/execution-coordinator.ts","src/managed-service-local-control.ts",
  "scripts/windows-service-control-broker.ps1","scripts/run-isolated-soak.ts"];
const directory=fileURLToPath(new URL("../",import.meta.url));
const codeFingerprint=createHash("sha256");
for(const file of files){
  codeFingerprint.update(file+"\0");
  codeFingerprint.update(readFileSync(join(directory,file)));
}
const receipt={
  schema:"taskquay-isolated-soak",version:2,
  status:failed?"failed":"passed",
  started,finished:new Date().toISOString(),elapsedSeconds:+((Date.now()-start)/1000).toFixed(2),
  requestedSeconds:seconds,testsOnly:true,
  nativeWindows:true,sourceCoordinatorSha256:sourceHash,
  fairnessRounds:rounds,syntheticAgentAdmissions:admissions,
  maxSimultaneousClaims:maxActive,fifoNoBargeChecks:fairnessChecks,
  walBusyDenials:busyChecks,walIntegritySamples:samples,maxWalBytes,
  serviceSupervisors:serviceCycles,serviceJobStops:jobStops,serviceJournalEvents,
  successfulHealthSamples:healthSamples,clientDisconnectRecoveries:droppedClientRecoveries,
  maxObservedHostRssBytes:maxRss,
  fifoWaitMilliseconds:{
    samples:fifoWaitMs.length,p50:percentile(fifoWaitMs,0.5),
    p95:percentile(fifoWaitMs,0.95),p99:percentile(fifoWaitMs,0.99),
    max:percentile(fifoWaitMs,1),
    interpretation:"synthetic queue-to-admission latency; not Provider execution wait",
  },
  resourceSamples,checkpointFailures,
  residualClaims,residualWaiters,finalIntegrity,modelRequests:0,remoteProviderRequests:0,
  sourceFilesSha256:codeFingerprint.digest("hex"),
  lastStage:stage,serviceAliveAtFailure,
  serviceHostExitAtFailure,
  lastServiceStderr:lastServiceStderr.replace(/[a-f0-9]{64}/g,"[REDACTED]").replace(/taskquay-experimental-service-[a-f0-9]{32}/g,"[TEST_PIPE]").slice(-1000),
  // A deterministic terminal record, no capabilities, paths or passwords.
  ...(failed?{error:failed}:{}),
};
const receiptDirectory=join(directory,"releases","soak-receipts");
mkdirSync(receiptDirectory,{recursive:true,mode:0o700});
const receiptName=new Date(start).toISOString().replace(/[:.]/g,"-")+"-"+randomUUID()+".json";
const receiptPath=join(receiptDirectory,receiptName);
const fd=openSync(receiptPath,"wx",0o600);
try{writeSync(fd,JSON.stringify(receipt,null,2)+"\n");fsyncSync(fd);}
finally{closeSync(fd);}
console.log(JSON.stringify(receipt));
console.log("SOAK_RECEIPT="+receiptPath);
if(failed)process.exitCode=1;
