import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { migrateDatabase } from "./db/migrations.js";
import { ExecutionStateStore, type ExecutionOwnerIdentity } from "./execution-state-store.js";
import { WorkLedger } from "./work-ledger.js";
import { inspectManagedRecovery } from "./windows-recovery-transaction.js";
import type { RecoveryOsProbe } from "./windows-recovery-observer.js";
import { ProcessSessionManager } from "./process-sessions.js";

const boot = "win-ntboot-v1:abcdef01-2345-6789-abcd-1234567890ab:01db3abcdef01234";
const job = "Local\\taskquay-job-9f8f6001-a7bc-4cdd-a213-23f7e87be552";
const hash = createHash("sha256").update("web-command-crash-repro").digest("hex");
const absent: RecoveryOsProbe = {
  boot: () => boot, process: () => "absent_or_reused", job: () => "absent",
};
function disposable() {
  const dir = mkdtempSync(join(tmpdir(), "taskquay-web-command-ledger-"));
  const root = join(dir, "repo");
  mkdirSync(root);
  const db = new Database(join(dir, "devspace.sqlite"));
  db.pragma("foreign_keys=ON");
  migrateDatabase(db);
  const owner: ExecutionOwnerIdentity = {
    id: "mcp-"+randomUUID(), kind: "mcp", pid: 89911,
    processCreatedAt: "2026-10-15T00:00:00.000Z",
    bootId: boot, generation: randomUUID(),
  };
  const store = new ExecutionStateStore(db);
  store.registerOwner(owner);
  const ledger = new WorkLedger(dir);
  const run = ledger.begin({root,workspaceId:"web-ws",workItemId:"crash-ledger",
    runKey:randomUUID(),title:"Web command recovery fixture",
    origin:{entryPoint:"chatgpt_mcp",evidence:"client_reported"}});
  const operationId = ledger.operation({runId:run.id,requestKey:"command:recovery-fixture",
    kind:"command",label:"受管命令（不记录原始命令或凭据）",status:"running"});
  ledger.close();
  const execution = store.create({
    kind:"command",workspaceId:"web-ws",checkoutRoot:root,workRunId:run.id,
    commandOperationId:operationId, owner, access:"write",
    resources:[],idempotencyScope:"command:"+run.id,requestKey:"recovery-fixture",
    requestHash:hash,initialPhase:"starting",
  },(sqlite,id)=>{
    sqlite.prepare(`insert into execution_claims
      (id,owner_id,owner_pid,kind,checkout_root,agent_id,resources,acquired_at,access_mode,execution_id)
      values (?,?,?,?,?,?,?,?,?,?)`).run(
      "claim_"+randomUUID().replaceAll("-",""),owner.id,owner.pid,"command",
      root,null,"[]",new Date().toISOString(),"write",id);
  }).execution;
  const armed=store.arm({executionId:execution.id,expectedVersion:0,expectedGeneration:1,
    pid:89912,createdAt:"2026-10-15T00:00:02.000Z",bootId:boot,
    jobIdentity:job,evidence:"native-test-job-membership"});
  store.transition({executionId:execution.id,expectedGeneration:1,
    expectedVersion:armed.state_version,phase:"running"});
  return {dir,root,db,run,operationId,executionId:execution.id,
    close:()=>{db.close();rmSync(dir,{recursive:true,force:true,maxRetries:15,retryDelay:100});}};
}

test("verified dead Windows web command releases Claim and marks exactly its running operation failed atomically",()=>{
  const fixture=disposable();
  try {
    const report=inspectManagedRecovery(fixture.db,fixture.executionId,{apply:true},absent);
    assert.equal(report.status,"released");
    assert.equal(report.observation?.evidenceKind,"job_empty_verified");
    const row=fixture.db.prepare(`select status,evidence,finished_at from console_operations where id=?`)
      .get(fixture.operationId) as {status:string;evidence:string;finished_at:string|null};
    assert.equal(row.status,"failed");
    assert.ok(row.finished_at);
    const evidence=JSON.parse(row.evidence) as Array<{outcome:string;reference:string}>;
    assert.equal(evidence[0]?.outcome,"failed");
    assert.match(evidence[0]?.reference??"",/forbidden_without_explicit_reconciliation/);
    const claim=(fixture.db.prepare("select count(*) n from execution_claims where execution_id=?")
      .get(fixture.executionId) as {n:number}).n;
    assert.equal(claim,0);
    const terminal=fixture.db.prepare("select phase,outcome,resource_state from managed_executions where id=?")
      .get(fixture.executionId) as {phase:string;outcome:string;resource_state:string};
    assert.deepEqual(terminal,{phase:"terminal",outcome:"interrupted",resource_state:"released"});
    const after=new WorkLedger(fixture.dir);
    try {
      const finished=after.finish(fixture.run.id,{status:"completed",acceptance:"not_applicable",
        summary:"Reconciled interrupted command; not a successful command outcome",evidence:[]});
      assert.equal(finished.executionStatus,"completed");
    }finally{after.close();}
    assert.equal(inspectManagedRecovery(fixture.db,fixture.executionId,{apply:true},absent).status,"not_found");
  }finally{fixture.close();}
});

test("pre-migration unlinked command Operation is quarantined with complete SQLite rollback",()=>{
  const fixture=disposable();
  try{
    fixture.db.prepare("update managed_executions set command_operation_id=null where id=?")
      .run(fixture.executionId);
    const before=(fixture.db.prepare("select count(*) n from execution_audit where execution_id=?")
      .get(fixture.executionId) as {n:number}).n;
    assert.throws(()=>inspectManagedRecovery(fixture.db,fixture.executionId,{apply:true},absent),
      /RECOVERY_COMMAND_OPERATION_LINK_MISSING/);
    const op=fixture.db.prepare("select status,finished_at from console_operations where id=?")
      .get(fixture.operationId) as {status:string;finished_at:null};
    assert.equal(op.status,"running");assert.equal(op.finished_at,null);
    assert.equal((fixture.db.prepare("select count(*) n from execution_claims where execution_id=?")
      .get(fixture.executionId) as {n:number}).n,1);
    assert.equal((fixture.db.prepare("select count(*) n from execution_audit where execution_id=?")
      .get(fixture.executionId) as {n:number}).n,before);
    const state=fixture.db.prepare("select phase,resource_state from managed_executions where id=?")
      .get(fixture.executionId) as {phase:string;resource_state:string};
    assert.equal(state.phase,"running");assert.equal(state.resource_state,"held");
  }finally{fixture.close();}
});

test("mislinked or already completed command operations never get overwritten during crash recovery",()=>{
  for(const mutation of ["other-operation","precompleted"]){
    const fixture=disposable();
    try{
      if(mutation==="other-operation"){
        fixture.db.prepare("update managed_executions set command_operation_id=? where id=?")
          .run("op_nonexistent",fixture.executionId);
      }else{
        fixture.db.prepare("update console_operations set status='completed' where id=?")
          .run(fixture.operationId);
      }
      assert.throws(()=>inspectManagedRecovery(fixture.db,fixture.executionId,{apply:true},absent),
        /RECOVERY_COMMAND_OPERATION_IDENTITY_CONFLICT/);
      assert.equal((fixture.db.prepare("select count(*) n from execution_claims where execution_id=?")
        .get(fixture.executionId) as {n:number}).n,1);
      assert.equal((fixture.db.prepare("select resource_state from managed_executions where id=?")
        .get(fixture.executionId) as {resource_state:string}).resource_state,"held");
    }finally{fixture.close();}
  }
});

test("alive command owner is never reconciled or falsely marked failed",()=>{
  const fixture=disposable();
  try{
    const result=inspectManagedRecovery(fixture.db,fixture.executionId,{apply:true},
      {...absent,process:(pid)=>pid===89911?"same":"absent_or_reused"});
    assert.equal(result.status,"active");
    assert.equal((fixture.db.prepare("select status from console_operations where id=?")
      .get(fixture.operationId) as {status:string}).status,"running");
    assert.equal((fixture.db.prepare("select count(*) n from execution_claims").get() as {n:number}).n,1);
  }finally{fixture.close();}
});

test("real Windows managed web command atomically stores its exact operation link before GO",{
  skip:process.platform!=="win32"?"Windows native Job only":undefined,
  timeout:18_000,
},async()=>{
  const dir=mkdtempSync(join(tmpdir(),"taskquay-web-command-live-link-"));
  const root=join(dir,"repo");
  mkdirSync(root);
  const ledger=new WorkLedger(dir);
  const run=ledger.begin({root,workspaceId:"web-ws",workItemId:"link",
    runKey:randomUUID(),title:"Web command linked",origin:{entryPoint:"chatgpt_mcp",evidence:"client_reported"}});
  ledger.close();
  const manager=new ProcessSessionManager({stateDir:dir,managedWindowsCommands:true});
  try{
    const node=`"${process.execPath}"`;
    let state=await manager.start({workspaceId:"web-ws",workspaceRoot:root,cwd:root,
      workRunId:run.id,requestKey:"test-real-command-link",
      command:`${node} -e "setTimeout(() => console.log('managed-done'), 1200)"`,
      yieldTimeMs:100});
    assert.ok(state.executionId);
    const retryRequest={workspaceId:"web-ws",workspaceRoot:root,cwd:root,
      workRunId:run.id,requestKey:"test-real-command-link",
      command:`${node} -e "setTimeout(() => console.log('managed-done'), 1200)"`,
      yieldTimeMs:100};
    await assert.rejects(manager.start(retryRequest),
      /RECORDED_OPERATION: op_[a-f0-9]{32}.*Command was not replayed/,
      "Network retries must return the original operation even while its write claim is held");
    await assert.rejects(manager.start({...retryRequest,command:`${node} -e "console.log('unexpected-replay')"`}),
      /IDEMPOTENCY_CONFLICT/,
      "A reused requestKey with changed command content must be rejected, not dispatched");
    const db=new Database(join(dir,"devspace.sqlite"),{readonly:true,fileMustExist:true});
    try{
      const link=db.prepare(`select command_operation_id,work_run_id from managed_executions where id=?`)
        .get(state.executionId) as {command_operation_id:string|null;work_run_id:string};
      assert.ok(link.command_operation_id,"crash recovery must have the exact durable ledger link");
      assert.equal(link.work_run_id,run.id);
      assert.equal((db.prepare("select count(*) n from managed_executions where request_key=?")
        .get("test-real-command-link") as {n:number}).n,1);
      const op=db.prepare("select id,run_id,kind from console_operations where id=?")
        .get(link.command_operation_id) as {id:string;run_id:string;kind:string};
      assert.equal(op.run_id,run.id);assert.equal(op.kind,"command");
    }finally{db.close();}
    for(let i=0;state.running && i<12;i++){
      state=await manager.write({workspaceId:"web-ws",sessionId:state.sessionId!,
        executionId:state.executionId!,yieldTimeMs:1500});
    }
    assert.equal(state.running,false);
    assert.equal(state.exitCode,0);
    await assert.rejects(manager.start(retryRequest), /RECORDED_OPERATION/,
      "A lost HTTP response after terminal completion must not re-run the command");
    const after=new WorkLedger(dir);
    try{
      const details=after.detail(after.project(root).id,run.id);
      const operation=(details.operations as Array<{id:string;status:string}>)[0];
      assert.equal(operation?.status,"completed");
    }finally{after.close();}
  }finally{
    manager.shutdown();
    await new Promise<void>(r=>setTimeout(r,400));
    rmSync(dir,{recursive:true,force:true,maxRetries:12,retryDelay:100});
  }
});
