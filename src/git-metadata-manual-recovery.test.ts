import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  type ManualGitRecoveryApproval, releaseTestGitMetadataQuarantine,
} from "./git-metadata-manual-recovery.js";
import {
  GIT_METADATA_GUARD_FILE, withWindowsGitMetadataMutex,
} from "./windows-git-metadata-mutex.js";
import { inspectGitMetadataReadonly } from "./git-metadata-recovery-inspection.js";

const win=process.platform==="win32" ? {} : {skip:"Native Windows test-only recovery mutex"};
const fixture=fileURLToPath(new URL("./windows-git-metadata-mutex-fixture.ts",import.meta.url));
const delay=(ms:number)=>new Promise<void>((resolve)=>setTimeout(resolve,ms));
const hash=(buffer:Buffer)=>createHash("sha256").update(buffer).digest("hex");
function approval(marker:string):ManualGitRecoveryApproval {
  return {
    testOnly:true, reviewer:"test-reviewer",ticket:"REVIEW-"+randomUUID().slice(0,8),
    reason:"Metadata manually inspected in disposable Git fixture before release",
    exactMarkerSha256:hash(readFileSync(marker)),
    affirmation:"I_REVIEWED_THE_GIT_METADATA_AND_APPROVE_THIS_EXACT_MARKER_RELEASE",
  };
}
function fixtureRepo():{base:string;repo:string;marker:string} {
  const base=mkdtempSync(join(tmpdir(),"taskquay-git-recovery-test-"));
  const repo=join(base,"repo");
  execFileSync("git",["init",repo],{windowsHide:true,stdio:"ignore"});
  execFileSync("git",["-C",repo,"-c","user.name=Test","-c","user.email=test@example.invalid",
    "commit","--allow-empty","-m","initial"],{windowsHide:true,stdio:"ignore"});
  return {base,repo,marker:join(repo,".git",GIT_METADATA_GUARD_FILE)};
}
async function withFixtureEnv<T>(action:()=>Promise<T>):Promise<T> {
  const previous=process.env.TASKQUAY_GIT_MANUAL_RECOVERY_FIXTURE;
  process.env.TASKQUAY_GIT_MANUAL_RECOVERY_FIXTURE="1";
  try{return await action();}
  finally{
    if(previous===undefined)delete process.env.TASKQUAY_GIT_MANUAL_RECOVERY_FIXTURE;
    else process.env.TASKQUAY_GIT_MANUAL_RECOVERY_FIXTURE=previous;
  }
}

test("manual recovery of a disposable Git quarantine requires exact approval, preserved audit and original marker archive",win,async()=>{
  const f=fixtureRepo();
  try {
    const tree=join(f.base,"tree");
    execFileSync("git",["-C",f.repo,"worktree","add","--detach",tree,"HEAD"],
      {windowsHide:true,stdio:"ignore"});
    await assert.rejects(withWindowsGitMetadataMutex(f.repo,async()=>{
      throw new Error("injected Git metadata write failure");
    }),/injected Git metadata write failure/);
    assert.equal(existsSync(f.marker),true);
    const before=readFileSync(f.marker);
    const reviewed=await inspectGitMetadataReadonly(f.repo);
    assert.deepEqual(reviewed.issues,["GIT_METADATA_PENDING_TRANSACTION_NEEDS_REVIEW"]);
    const authorized=approval(f.marker);
    await assert.rejects(releaseTestGitMetadataQuarantine(f.repo,authorized),
      /GIT_RECOVERY_TEST_FIXTURE_ONLY/);
    await withFixtureEnv(async()=>{
      await assert.rejects(releaseTestGitMetadataQuarantine(f.repo,{
        ...authorized,affirmation:"not an operator approval" as ManualGitRecoveryApproval["affirmation"],
      }),/GIT_RECOVERY_EXPLICIT_APPROVAL_REQUIRED/);
      await assert.rejects(releaseTestGitMetadataQuarantine(f.repo,{
        ...authorized,exactMarkerSha256:"f".repeat(64),
      }),/GIT_RECOVERY_MARKER_HASH_MISMATCH/);
      assert.deepEqual(readFileSync(f.marker),before);
      const result=await releaseTestGitMetadataQuarantine(f.repo,authorized);
      assert.equal(result.mode,"explicit_human_approval_test_only");
      assert.equal(existsSync(f.marker),false);
      assert.deepEqual(readFileSync(result.markerArchivePath),before);
      const audit=JSON.parse(readFileSync(result.auditPath,"utf8")) as Record<string,unknown>;
      assert.equal(audit.reviewer,authorized.reviewer);
      assert.equal(audit.ticket,authorized.ticket);
      assert.equal(audit.markerSha256,authorized.exactMarkerSha256);
      assert.equal(audit.operation,"planned_rename_original_marker");
      let admitted=false;
      await withWindowsGitMetadataMutex(f.repo,async()=>{admitted=true;});
      assert.equal(admitted,true,"explicitly audited release admits the next worktree metadata operation");
    });
  } finally {rmSync(f.base,{recursive:true,force:true,maxRetries:20,retryDelay:100});}
});

test("manual recovery refuses dirty Git backlinks and retains marker and audit-free state",win,async()=>{
  const f=fixtureRepo();
  try {
    const tree=join(f.base,"tree");
    execFileSync("git",["-C",f.repo,"worktree","add","--detach",tree,"HEAD"],
      {windowsHide:true,stdio:"ignore"});
    await assert.rejects(withWindowsGitMetadataMutex(f.repo,async()=>{throw new Error("failed");}),/failed/);
    const entries=readdirSync(join(f.repo,".git","worktrees"));
    assert.equal(entries.length,1);
    const commondir=join(f.repo,".git","worktrees",entries[0],"commondir");
    const original=readFileSync(commondir);
    writeFileSync(commondir,"../missing");
    try {
      await withFixtureEnv(async()=>{
        await assert.rejects(releaseTestGitMetadataQuarantine(f.repo,approval(f.marker)),
          /GIT_RECOVERY_METADATA_INSPECTION_NOT_CLEAN/);
      });
      assert.equal(existsSync(f.marker),true);
      assert.equal(existsSync(join(f.repo,".git","taskquay-manual-recovery-audit")),false);
    } finally {writeFileSync(commondir,original);}
  } finally {rmSync(f.base,{recursive:true,force:true,maxRetries:20,retryDelay:100});}
});

test("live independent Windows mutex owner cannot be displaced by a manual review; original marker remains",win,async()=>{
  const f=fixtureRepo();
  const child=spawn(process.execPath,["--import",import.meta.resolve("tsx"),
    fixture,f.repo,f.base,"crash"],{cwd:f.base,stdio:["ignore","ignore","pipe"],windowsHide:true});
  let stderr="";
  child.stderr?.on("data",(b:Buffer)=>{stderr+=b.toString();});
  try {
    for(let i=0;i<150 && !existsSync(join(f.base,"ready-crash"));i++)await delay(20);
    assert.ok(existsSync(join(f.base,"ready-crash")));
    writeFileSync(join(f.base,"go"),"go");
    for(let i=0;i<200 && !existsSync(f.marker);i++)await delay(20);
    assert.ok(existsSync(f.marker),stderr);
    await withFixtureEnv(async()=>{
      await assert.rejects(releaseTestGitMetadataQuarantine(f.repo,approval(f.marker)),
        /GIT_RECOVERY_MUTEX_BUSY/);
    });
    assert.equal(existsSync(f.marker),true);
  } finally {
    if(child.exitCode===null && child.signalCode===null)child.kill("SIGKILL");
    await delay(200);
    rmSync(f.base,{recursive:true,force:true,maxRetries:20,retryDelay:100});
  }
});

test("manual release rejects non-disposable repositories even when marker SHA and approval match",win,async()=>{
  const f=fixtureRepo();
  try {
    await assert.rejects(withWindowsGitMetadataMutex(f.repo,async()=>{throw new Error("injected");}),/injected/);
    const request=approval(f.marker);
    await withFixtureEnv(async()=>{
      await assert.rejects(releaseTestGitMetadataQuarantine(tmpdir(),request),
        /GIT_RECOVERY_TEMP_REPOSITORY_REQUIRED/);
    });
    assert.equal(existsSync(f.marker),true);
  } finally {rmSync(f.base,{recursive:true,force:true,maxRetries:20,retryDelay:100});}
});

test("a failed recovery audit write retains the exact original marker and never unblocks Git",win,async()=>{
  const f=fixtureRepo();
  try {
    await assert.rejects(withWindowsGitMetadataMutex(f.repo,async()=>{throw new Error("injected");}),/injected/);
    const before=readFileSync(f.marker);
    const auditDir=join(f.repo,".git","taskquay-manual-recovery-audit");
    writeFileSync(auditDir,"not-a-directory");
    await withFixtureEnv(async()=>{
      await assert.rejects(releaseTestGitMetadataQuarantine(f.repo,approval(f.marker)));
    });
    assert.deepEqual(readFileSync(f.marker),before);
    let admitted=false;
    await assert.rejects(withWindowsGitMetadataMutex(f.repo,async()=>{admitted=true;}),
      /GIT_METADATA_PENDING_TRANSACTION_REQUIRES_REVIEW/);
    assert.equal(admitted,false);
  } finally {rmSync(f.base,{recursive:true,force:true,maxRetries:20,retryDelay:100});}
});
