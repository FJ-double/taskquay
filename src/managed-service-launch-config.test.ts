import assert from "node:assert/strict";
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readIsolatedServiceHostConfig } from "./managed-service-launch-config.js";

test("explicit test-only config refuses a production-like root and arbitrary shell command",()=>{
  const dir=mkdtempSync(join(tmpdir(),"taskquay-service-config-"));
  const checkout=join(dir,"checkout"),state=join(dir,"state"),data=join(dir,"data");
  for(const path of [checkout,state,data])mkdirSync(path);
  const script=join(checkout,"service.cjs");
  writeFileSync(script,"setInterval(()=>{},1000);");
  const config=join(dir,"config.json");
  const record={
    testOnly:true,stateDir:state,workspaceRoot:checkout,stateRoot:data,
    serviceKey:"isolated-service",port:41991,
    command:'"'+process.execPath+'" "'+script+'"',
  };
  const prior=process.env.TASKQUAY_SERVICE_HOST_FIXTURE;
  try {
    const write=(value:Record<string,unknown>)=>writeFileSync(config,JSON.stringify(value));
    write(record);
    delete process.env.TASKQUAY_SERVICE_HOST_FIXTURE;
    assert.throws(()=>readIsolatedServiceHostConfig(config),/SERVICE_HOST_NOT_ENABLED/);
    process.env.TASKQUAY_SERVICE_HOST_FIXTURE="1";
    assert.equal(readIsolatedServiceHostConfig(config).serviceKey,"isolated-service");
    write({...record,testOnly:false});
    assert.throws(()=>readIsolatedServiceHostConfig(config),/TEST_ONLY_MARKER/);
    write({...record,command:'"'+process.execPath+'" "'+script+'" & echo FAIL'});
    assert.throws(()=>readIsolatedServiceHostConfig(config),/COMMAND_NOT_ALLOWED/);
    write({...record,stateRoot:checkout});
    assert.throws(()=>readIsolatedServiceHostConfig(config),/ROOTS_NOT_ISOLATED/);
    write({...record,workspaceRoot:process.cwd()});
    assert.throws(()=>readIsolatedServiceHostConfig(config),/ROOTS_NOT_ISOLATED/);
    write({...record,unexpected:"not-permitted"});
    assert.throws(()=>readIsolatedServiceHostConfig(config),/UNKNOWN_PROPERTY/);
  }finally{
    if(prior===undefined)delete process.env.TASKQUAY_SERVICE_HOST_FIXTURE;
    else process.env.TASKQUAY_SERVICE_HOST_FIXTURE=prior;
    rmSync(dir,{recursive:true,force:true,maxRetries:15,retryDelay:100});
  }
});
