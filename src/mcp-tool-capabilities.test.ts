import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveToolAvailability, filterToolAvailability } from "./mcp-tool-capabilities.js";
import { restrictMcpTools } from "./static-token-auth.js";
import type { BlenderMcpBridge } from "./blender-mcp-bridge.js";
import type { WindowsMcpBridge } from "./windows-mcp-bridge.js";
import type { McpRegistrationTarget } from "./mcp-modern-server.js";
import { loadConfig } from "./config.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";

test("tool registration intersects platform/backend availability with token grants", async () => {
  const root=mkdtempSync(join(tmpdir(),"taskquay-availability-"));
  try {
    const config=loadConfig(writeTestDevspaceConfig(root,{logging:{level:"silent"}}));
    let closed=0;
    const dead={async listTools(){throw new Error("fixture unavailable");},async close(){closed++;}} as unknown as BlenderMcpBridge;
    const windows={} as WindowsMcpBridge;
    assert.deepEqual(await resolveToolAvailability(config,{windowsMcpBridge:windows,blenderMcpBridge:dead},"darwin"),{windowsDesktop:false,blender:false});
    assert.equal(closed,1);
    const ready={async listTools(){return [];},async close(){}} as unknown as BlenderMcpBridge;
    assert.deepEqual(await resolveToolAvailability(config,{windowsMcpBridge:windows,blenderMcpBridge:ready},"win32"),{windowsDesktop:true,blender:true});
    const names:string[]=[];
    const base={registerTool:(name:string)=>{names.push(name);},registerResource:()=>{}} as unknown as McpRegistrationTarget;
    const target=restrictMcpTools(filterToolAvailability(base,{windowsDesktop:false,blender:false}),["read","document_tool","blender_mcp","windows_mcp"]);
    for(const name of ["read","agent_task","document_tool","blender_mcp","windows_mcp"]) (target.registerTool as Function)(name,{},()=>{});
    assert.deepEqual(names,["read","document_tool"]);
  } finally {rmSync(root,{recursive:true,force:true});}
});
