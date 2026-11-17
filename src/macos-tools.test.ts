import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import ExcelJS from "exceljs";
import PizZip from "pizzip";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./server.js";
import { loadConfig } from "./config.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";

test("shared macOS document tools read/write XLSX, DOCX and PDF through MCP", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "taskquay-mac-tools-"));
  const project = join(root, "project"); await mkdir(project);
  execFileSync("git", ["init", "--quiet", project]);
  const config = loadConfig(writeTestDevspaceConfig(join(root, "config"), {
    storage: { stateDir: join(root, "state") }, workspaces: { allowedRoots: [project] },
    ui: { enabled: false }, logging: { level: "silent" },
  }));
  const workspaces = new WorkspaceRegistry(config);
  const processes = new ProcessSessionManager({ stateDir: config.stateDir });
  const workspace = (await workspaces.openWorkspace(project)).workspace;
  const server = await createMcpServer(config, workspaces, createReviewCheckpointManager(), processes, () => [], []);
  const client = new Client({ name: "mac-tools-fixture", version: "1" });
  const [a,b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); processes.shutdown(); await rm(root, { recursive: true, force: true }); });
  const names = (await client.listTools()).tools.map(tool => tool.name);
  for (const name of ["document_tool", "terminal_sessions", "system_processes"]) assert(names.includes(name));
  assert(!names.includes("windows_mcp")); assert(!names.includes("blender_mcp"));
  async function document(args: Record<string, unknown>) {
    let reply = await client.callTool({ name: "document_tool", arguments: { workspace_id: workspace.id, wait_ms: 1000, ...args } });
    for (let count=0;count<20;count++) {
      const data = reply.structuredContent as { result: string; operation_id: string };
      assert(data?.result);
      const value = JSON.parse(data.result);
      if (!["queued", "running", "finalizing"].includes(value.status)) { assert(!reply.isError, data.result); return value; }
      reply = await client.callTool({ name: "document_tool", arguments: { workspace_id: workspace.id, action: "result", operation_id: data.operation_id, wait_ms: 1000 } });
    }
    throw new Error("Document fixture did not complete");
  }
  const book = new ExcelJS.Workbook(); book.addWorksheet("Sheet1").getCell("A1").value="before";
  await book.xlsx.writeFile(join(project,"sample.xlsx"));
  assert.match(JSON.stringify(await document({ action:"inspect", path:"sample.xlsx" })),/before/);
  const write = await document({ action:"cell_set", path:"sample.xlsx", cell:"A1", value:"after", request_key:"xlsx-edit" });
  assert(write.backup);
  const saved = new ExcelJS.Workbook(); await saved.xlsx.readFile(join(project,"sample.xlsx")); assert.equal(saved.worksheets[0]!.getCell("A1").value,"after");
  const zip = new PizZip();
  zip.file("[Content_Types].xml",'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file("word/document.xml",'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello Mac</w:t></w:r></w:p></w:body></w:document>');
  await writeFile(join(project,"sample.docx"),zip.generate({type:"nodebuffer"}));
  assert.match(JSON.stringify(await document({action:"inspect",path:"sample.docx"})),/Hello Mac/);
  await document({action:"text_replace",path:"sample.docx",find:"Hello Mac",replacement:"Hello arm64",request_key:"docx-edit"});
  const docx = new PizZip(await readFile(join(project,"sample.docx"))); assert.match(docx.file("word/document.xml")!.asText(),/Hello arm64/);
  const pdf = await PDFDocument.create(); const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage().drawText("Taskquay macOS fixture",{x:40,y:100,font}); await writeFile(join(project,"sample.pdf"),await pdf.save());
  assert.match(JSON.stringify(await document({action:"inspect",path:"sample.pdf"})),/Taskquay macOS fixture/);
  await document({action:"pdf_append_blank",path:"sample.pdf",request_key:"pdf-edit"});
  assert.equal((await PDFDocument.load(await readFile(join(project,"sample.pdf")))).getPageCount(),2);
  assert.equal((await readdir(project)).filter(name=>name.endsWith(".bak")).length,3);
  const rejected = await client.callTool({name:"document_tool",arguments:{workspace_id:workspace.id,action:"inspect",path:"../outside.docx"}}); assert(rejected.isError);
  const listing = await client.callTool({name:"system_processes",arguments:{limit:10}});
  const items = JSON.parse((listing.structuredContent as {result:string}).result); assert(items.length>0); assert(items.every((item: Record<string,unknown>)=>typeof item.pid==="number" && typeof item.name==="string" && Object.keys(item).length===2));
  const live = await processes.start({workspaceId:workspace.id,cwd:project,command:"sleep 30",yieldTimeMs:1});
  const ended = await client.callTool({name:"terminal_sessions",arguments:{workspace_id:workspace.id,action:"terminate",session_id:live.sessionId}}); assert(!ended.isError);
  assert.equal((await processes.write({workspaceId:workspace.id,sessionId:live.sessionId!,yieldTimeMs:2000})).running,false);
});
