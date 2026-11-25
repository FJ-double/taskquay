/**
 * Windows web-MCP command lock reproduction, no Provider/model required.
 *
 * A shell command's ROOT process exits, but a descendant inherits stdout.
 * The managed pipe path retains the claim until its live Job member finishes.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { ProcessSessionManager } from "./process-sessions.js";
import { ExecutionCoordinator, ExecutionConflictError } from "./execution-coordinator.js";
import { resolveShellCommand } from "./process-platform.js";

const win=process.platform==="win32" ? {} : {skip:"Windows named-pipe descendant lifecycle"};

test("web command root exit with descendant stdout retained leaves a visible blocked write until actual close",
  {...win,timeout:18_000},async(t)=>{
  const dir=mkdtempSync(join(tmpdir(),"taskquay-web-command-pipe-"));
  const checkout=join(dir,"checkout"),state=join(dir,"isolated-state");
  mkdirSync(checkout);
  const grandchild=join(checkout,"descendant.cjs");
  const rootScript=join(checkout,"root.cjs");
  writeFileSync(grandchild,
    "setTimeout(() => { process.stdout.write('descendant-finished\\n'); process.exit(0); }, 3200);\n");
  writeFileSync(rootScript,
    "const {spawn}=require('node:child_process');\n"+
    "const p=spawn(process.execPath,[process.argv[2]],{stdio:['ignore','inherit','inherit'],detached:true,windowsHide:true});\n"+
    "p.unref();process.exit(0);\n");
  const manager=new ProcessSessionManager({stateDir:state,managedWindowsCommands:true,allowLegacySessionId:true});
  t.after(async()=>{
    manager.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 250));
    rmSync(dir,{recursive:true,force:true,maxRetries:20,retryDelay:100});
  });
  const node = /pwsh(?:\.exe)?$/i.test(resolveShellCommand("", process.platform, process.env, true).executable)
    ? `& "${process.execPath}"` : `"${process.execPath}"`;
  const first=await manager.start({
    workspaceId:"isolated-web-mcp",workspaceRoot:checkout,cwd:checkout,
    command:`${node} "${rootScript}" "${grandchild}"`,
    yieldTimeMs:200,
  });
  assert.ok(first.sessionId);
  let observed=first;
  const deadline=Date.now()+2400;
  while(Date.now()<deadline && observed.phase!=="root_exited_stdio_open" &&
      observed.running){
    observed=await manager.write({workspaceId:"isolated-web-mcp",
      sessionId:first.sessionId!,yieldTimeMs:100});
  }
  assert.equal(observed.phase,"root_exited_stdio_open",
    "When the root exits but descendant stdout stays open, the host must expose an in-between phase");
  const peer=new ExecutionCoordinator(state);
  try {
    assert.throws(()=>peer.acquire({workspaceRoot:checkout,kind:"command"}),
      ExecutionConflictError,
      "the exact write claim must stay held while the descendant can still write");
    const sqlite=new Database(join(state,"devspace.sqlite"),{readonly:true,fileMustExist:true});
    try {
      sqlite.pragma("query_only = ON");
      assert.equal((sqlite.prepare("select count(*) n from execution_claims").get() as {n:number}).n,1);
    }finally{sqlite.close();}
    const finished=await manager.write({workspaceId:"isolated-web-mcp",
      sessionId:first.sessionId!,yieldTimeMs:9000});
    assert.equal(finished.phase,"closed");
    assert.equal(finished.exitCode,0);
    assert.equal(finished.running,false);
    assert.match(finished.output,/descendant-finished/);
    assert.equal((peer.sharedDatabaseHandle.sqlite.prepare(
      "select count(*) n from execution_claims").get() as {n:number}).n,0,
      "claim is released by the actual process close, never by deleting a database row");
    peer.acquire({workspaceRoot:checkout,kind:"command"}).release();
  }finally{peer.close();}
});
