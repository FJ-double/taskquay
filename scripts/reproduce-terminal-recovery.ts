/** Execute only the baseline process manager in an isolated fixture; no live service calls. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import ts from "typescript";
const candidate = resolve("releases/trajectory-two-day-20260908/candidate");
const baseline = spawnSync("git", ["show", "8d87b40:src/process-sessions.ts"], { encoding: "utf8", timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 });
assert.equal(baseline.status, 0);
const source = baseline.stdout.replace(/from "\.\/([^\"]+)"/g, (_match, name: string) => `from ${JSON.stringify(pathToFileURL(join(candidate, name)).href)}`);
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { ProcessSessionManager } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const manager = new ProcessSessionManager();
try {
  const base = { workspaceId: "baseline-fixture", cwd: process.cwd() };
  const terminal = await manager.start({ ...base, command: "echo baseline-start", yieldTimeMs: 2000 });
  assert.equal(terminal.running, false); assert.equal(terminal.sessionId, undefined);
  await assert.rejects(manager.write({ workspaceId: base.workspaceId, sessionId: 1 }), /Unknown process session/);
  let pending = await manager.start({ ...base, command: `"${process.execPath}" -e "setTimeout(()=>{},100)"`, yieldTimeMs: 0 });
  assert(pending.running); const id = pending.sessionId;
  for (let i = 0; pending.running && i < 5; i++) pending = await manager.write({ workspaceId: base.workspaceId, sessionId: id, yieldTimeMs: 1000 });
  assert.equal(pending.running, false); assert.equal(pending.sessionId, undefined);
  await assert.rejects(manager.write({ workspaceId: base.workspaceId, sessionId: id }), /Unknown process session/);
} finally { manager.shutdown(); }
const receipt = { status: "reproduced", baseline: "8d87b40", sourceSha256: createHash("sha256").update(baseline.stdout).digest("hex"),
  observed: ["terminal start omits sessionId and immediately removes session", "terminal write omits sessionId; next empty poll is Unknown process session"],
  fixtureOnly: true, providerExecutions: 0, processesStopped: true };
const body = JSON.stringify(receipt, null, 2), path = resolve("releases/trajectory-two-day-20260908/baseline-reproduction.json");
writeFileSync(path, body); console.log(JSON.stringify({ path, sha256: createHash("sha256").update(body).digest("hex"), ...receipt }));
