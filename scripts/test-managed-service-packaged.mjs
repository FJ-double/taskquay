import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ExecutionCoordinator } from "../dist/execution-coordinator.js";
import { ManagedServiceSupervisor } from "../dist/managed-service-supervisor.js";
import { windowsProcessCreatedAt } from "../dist/windows-job-object.js";
import { windowsBootIdentity } from "../dist/windows-boot-identity.js";
import { nativeRecoveryProbe } from "../dist/windows-recovery-observer.js";

if(process.platform!=="win32") {
  console.log("PACKAGED_MANAGED_SERVICE_SKIPPED_NON_WINDOWS");
  process.exit(0);
}
async function freePort(){
  const s=createServer();
  await new Promise((resolve)=>s.listen({host:"127.0.0.1",port:0},resolve));
  const port=s.address().port;
  await new Promise((resolve)=>s.close(resolve));
  return port;
}
const root=mkdtempSync(join(tmpdir(),"tq-packaged-service-"));
const project=join(root,"project"),data=join(root,"data");
mkdirSync(project);mkdirSync(data);
const source=join(project,"fixture.cjs");
writeFileSync(source,`require("node:http").createServer((req,res)=> {
  if (req.url!=="/healthz") {res.writeHead(404);return res.end();}
  res.setHeader("X-Taskquay-Health-Token",process.env.TASKQUAY_SERVICE_HEALTH_TOKEN);
  res.writeHead(200);res.end("ok");
}).listen(Number(process.env.TASKQUAY_SERVICE_PORT),"127.0.0.1");`);
const coord=new ExecutionCoordinator(join(root,"state"));
const owner={
  id:coord.managedOwnerId,kind:"agentd",pid:process.pid,
  processCreatedAt:windowsProcessCreatedAt(process.pid),
  bootId:windowsBootIdentity(),generation:randomUUID(),
};
coord.registerManagedOwner(owner);
const supervisor=new ManagedServiceSupervisor(coord);
let handle;
try {
  handle=await supervisor.start({
    serviceKey:"packaged-loopback-proof",workspaceId:"fixture",
    workspaceRoot:project,stateRoot:data,owner,
    port:await freePort(),bindHost:"127.0.0.1",
    command:`"${process.execPath}" "${source}"`,healthTimeoutMs:5_000,
  });
  assert.equal(await handle.checkHealth(),true);
  assert.equal(nativeRecoveryProbe.job(handle.jobIdentity),"exists_active");
  await handle.stop();
  assert.equal(nativeRecoveryProbe.job(handle.jobIdentity),"absent");
  assert.equal(await handle.checkHealth(),false);
  const db=coord.sharedDatabaseHandle.sqlite;
  const state=db.prepare("select state from managed_service_reservations")
    .get()?.state;
  assert.equal(state,"released");
  console.log("PACKAGED_MANAGED_SERVICE_OK",JSON.stringify({
    state,jobActive:false,modelRequests:0,remoteNetworkCalls:0,
  }));
} finally {
  if(handle)await handle.stop().catch(()=>undefined);
  coord.close();
  await delay(300);
  if(existsSync(root))rmSync(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});
}
