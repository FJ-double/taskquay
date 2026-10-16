import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { withWindowsGitMetadataMutex, GIT_METADATA_GUARD_FILE } from "./windows-git-metadata-mutex.js";
import { inspectGitMetadataReadonly } from "./git-metadata-recovery-inspection.js";

const win = process.platform === "win32" ? {} : {skip:"Windows kernel named mutex"};
const fixture = fileURLToPath(new URL("./windows-git-metadata-mutex-fixture.ts", import.meta.url));
const pause = (ms:number)=>new Promise<void>((resolve)=>setTimeout(resolve,ms));

test("three independent Windows processes share a native Git mutex, never entering the critical section simultaneously",win,async()=>{
  const dir=mkdtempSync(join(tmpdir(),"taskquay-git-kernel-mutex-"));
  const key=join(dir,"repo");
  const children=Array.from({length:3},(_,i)=>{
    const label=String(i);
    const child=spawn(process.execPath,["--import",import.meta.resolve("tsx"),fixture,key,dir,label],
      {cwd:dir,stdio:["ignore","ignore","pipe"],windowsHide:true});
    let errors="";
    child.stderr?.on("data",(data:Buffer)=>{errors+=data.toString();});
    const completed=new Promise<void>((resolve,reject)=>{
      child.once("error",reject);
      child.once("close",(code)=>code===0?resolve():reject(new Error(`worker-${label}: ${errors}`)));
    });
    return {label,child,completed};
  });
  try {
    for(let i=0;i<150 && !children.every(({label})=>existsSync(join(dir,`ready-${label}`)));i++)await pause(40);
    assert.ok(children.every(({label})=>existsSync(join(dir,`ready-${label}`))),"all workers ready");
    writeFileSync(join(dir,"go"),"go");
    await Promise.all(children.map(({completed})=>completed));
    const events=readFileSync(join(dir,"events.jsonl"),"utf8").trim().split(/\r?\n/)
      .map((line)=>JSON.parse(line) as {label:string;event:string;at:number});
    assert.equal(events.length,6);
    let held=0;
    const seen=new Set<string>();
    for(const entry of events){
      held+=entry.event==="enter"?1:-1;
      assert.ok(held===0||held===1,`overlapping named critical sections: ${JSON.stringify(events)}`);
      if(entry.event==="exit")seen.add(entry.label);
    }
    assert.equal(held,0);
    assert.deepEqual([...seen].sort(),["0","1","2"]);
  } finally {
    for(const {child} of children)if(child.exitCode===null && child.signalCode===null)child.kill("SIGKILL");
    await pause(200);
    rmSync(dir,{recursive:true,force:true,maxRetries:20,retryDelay:100});
  }
});

test("native mutex bounded contention rejects waiting writes without TTL unlocking a peer",win,async()=>{
  const dir=mkdtempSync(join(tmpdir(),"taskquay-git-mutex-timeout-"));
  const key=join(dir,"repo");
  let actionExecuted=false;
  const child=spawn(process.execPath,
    ["--import",import.meta.resolve("tsx"),fixture,key,dir,"hold"],
    {cwd:dir,stdio:["ignore","ignore","pipe"],windowsHide:true});
  let stderr="";
  child.stderr?.on("data",(data:Buffer)=>{stderr+=data.toString();});
  const finished=new Promise<void>((resolve,reject)=>{
    child.once("error",reject);
    child.once("close",(code)=>code===0?resolve():reject(new Error(stderr)));
  });
  try {
    for(let i=0;i<150&&!existsSync(join(dir,"ready-hold"));i++)await pause(25);
    assert.equal(existsSync(join(dir,"ready-hold")),true);
    writeFileSync(join(dir,"go"),"go");
    for(let i=0;i<150&&(!existsSync(join(dir,"events.jsonl"))||
      !readFileSync(join(dir,"events.jsonl"),"utf8").includes('"event":"enter"'));i++)await pause(15);
    assert.equal(existsSync(join(dir,"events.jsonl")),true);
    await assert.rejects(
      withWindowsGitMetadataMutex(key,async()=>{actionExecuted=true;},100),
      /GIT_METADATA_MUTEX_WAIT_TIMEOUT/,
    );
    assert.equal(actionExecuted,false);
    await finished;
    await withWindowsGitMetadataMutex(key,async()=>{actionExecuted=true;});
    assert.equal(actionExecuted,true);
  } finally {
    if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");
    await pause(200);
    rmSync(dir,{recursive:true,force:true,maxRetries:20,retryDelay:100});
  }
});

test("killing only the disposable native mutex holder makes the waiter fail closed on WAIT_ABANDONED",win,async()=>{
  const dir=mkdtempSync(join(tmpdir(),"taskquay-git-abandoned-"));
  const key=join(dir,"repo");
  const child=spawn(process.execPath,
    ["--import",import.meta.resolve("tsx"),fixture,key,dir,"crash"],
    {cwd:dir,stdio:["ignore","ignore","pipe"],windowsHide:true});
  let stderr="";
  child.stderr?.on("data",(data:Buffer)=>{stderr+=data.toString();});
  try{
    for(let i=0;i<150&&!existsSync(join(dir,"ready-crash"));i++)await pause(30);
    assert.ok(existsSync(join(dir,"ready-crash")),"crash-owner must prepare");
    writeFileSync(join(dir,"go"),"go");
    for(let i=0;i<150&&(!existsSync(join(dir,"events.jsonl"))||
      !readFileSync(join(dir,"events.jsonl"),"utf8").includes('"event":"enter"'));i++)await pause(15);
    assert.ok(existsSync(join(dir,"events.jsonl")),stderr);
    let allowed=false;
    const contender=withWindowsGitMetadataMutex(key,async()=>{allowed=true;},5_000);
    await pause(180);
    child.kill("SIGKILL");
    await assert.rejects(contender,/GIT_METADATA_MUTEX_ABANDONED_REQUIRES_RECONCILIATION/);
    assert.equal(allowed,false,"native abandoned lock is NOT authorization to modify Git");
  }finally{
    if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");
    await pause(150);
    rmSync(dir,{recursive:true,force:true,maxRetries:20,retryDelay:100});
  }
});

test("metadata inspection is read-only and flags broken commondir pointers without pruning",win,async()=>{
  const dir=mkdtempSync(join(tmpdir(),"taskquay-git-metadata-audit-"));
  const repo=join(dir,"repository"),wt=join(dir,"tree");
  try{
    execFileSync("git",["init",repo],{windowsHide:true,stdio:"ignore"});
    execFileSync("git",["-C",repo,"-c","user.name=Test","-c","user.email=test@example.invalid",
      "commit","--allow-empty","-m","init"],{windowsHide:true,stdio:"ignore"});
    execFileSync("git",["-C",repo,"worktree","add","--detach",wt,"HEAD"],
      {windowsHide:true,stdio:"ignore"});
    const clean=await inspectGitMetadataReadonly(repo);
    assert.equal(clean.mode,"observe_only");
    assert.equal(clean.consistent,true,JSON.stringify(clean));
    assert.equal(clean.listedWorktrees,2);
    assert.equal(clean.metadataEntries,1);
    const metadata=join(repo,".git","worktrees");
    const entries=(await import("node:fs")).readdirSync(metadata);
    assert.equal(entries.length,1);
    const commondir=join(metadata,entries[0],"commondir");
    const old=readFileSync(commondir,"utf8");
    writeFileSync(commondir,"../missing-root");
    const suspect=await inspectGitMetadataReadonly(repo);
    assert.equal(suspect.consistent,false);
    assert.ok(suspect.issues.includes("GIT_WORKTREE_COMMONDIR_UNRESOLVED"),
      JSON.stringify(suspect.issues));
    assert.equal(existsSync(commondir),true,"inspect must never prune metadata");
    assert.equal(readFileSync(commondir,"utf8"),"../missing-root");
    writeFileSync(commondir,old);
  }finally{rmSync(dir,{recursive:true,force:true,maxRetries:20,retryDelay:100});}
});

test("crashed native Git owner leaves durable quarantine that blocks the SECOND retry, even after the kernel mutex becomes free",win,async()=>{
  const dir=mkdtempSync(join(tmpdir(),"taskquay-git-crash-quarantine-"));
  const repo=join(dir,"repo");
  execFileSync("git",["init",repo],{windowsHide:true,stdio:"ignore"});
  const child=spawn(process.execPath,
    ["--import",import.meta.resolve("tsx"),fixture,repo,dir,"crash"],
    {cwd:dir,stdio:["ignore","ignore","pipe"],windowsHide:true});
  const marker=join(repo,".git",GIT_METADATA_GUARD_FILE);
  try{
    for(let i=0;i<120&&!existsSync(join(dir,"ready-crash"));i++)await pause(20);
    assert.ok(existsSync(join(dir,"ready-crash")));
    writeFileSync(join(dir,"go"),"go");
    for(let i=0;i<160&&!existsSync(marker);i++)await pause(20);
    assert.equal(existsSync(marker),true,"owner writes and fsyncs a marker before Git mutation");
    let mutated=false;
    const waiting=withWindowsGitMetadataMutex(repo,async()=>{mutated=true;},5_000);
    await pause(120);
    child.kill("SIGKILL");
    await assert.rejects(waiting,/GIT_METADATA_MUTEX_ABANDONED_REQUIRES_RECONCILIATION/);
    assert.equal(mutated,false);
    assert.equal(existsSync(marker),true);
    await assert.rejects(
      withWindowsGitMetadataMutex(repo,async()=>{mutated=true;},1_000),
      /GIT_METADATA_PENDING_TRANSACTION_REQUIRES_REVIEW/,
    );
    assert.equal(mutated,false,"subsequent waiter cannot ignore the first abandoned result");
    const audit=await inspectGitMetadataReadonly(repo);
    assert.equal(audit.mode,"observe_only");
    assert.equal(audit.consistent,false);
    assert.ok(audit.issues.includes("GIT_METADATA_PENDING_TRANSACTION_NEEDS_REVIEW"));
    assert.equal(existsSync(marker),true,"read-only audit must not unlock Git metadata");
  }finally{
    if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");
    await pause(140);
    rmSync(dir,{recursive:true,force:true,maxRetries:20,retryDelay:100});
  }
});
