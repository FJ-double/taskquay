/** Isolated SDK client -> loopback StreamableHTTP -> candidate registration.
 * No active daemon, external auth, Desktop registration or provider inference. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
const candidate = resolve(process.argv[2] ?? "releases/trajectory-two-day-20260908/candidate");
const moduleAt = (name: string) => import(pathToFileURL(join(candidate, `${name}.js`)).href);
const [{ createMcpServer }, { loadConfig }, { defaultDevspaceConfig }, { writeDevspaceConfig }, { SqliteWorkspaceStore }, { WorkspaceRegistry }, { ProcessSessionManager }, { createReviewCheckpointManager }, { WorkLedger }] =
  await Promise.all(["server", "config", "config-schema", "user-config", "workspace-store", "workspaces", "process-sessions", "review-checkpoints", "work-ledger"].map(moduleAt));
const root = mkdtempSync(join(tmpdir(), "devspace-candidate-smoke-"));
const project = join(root, "project"), other = join(root, "other"), stateDir = join(root, "state");
mkdirSync(project); mkdirSync(other);
const env = { DEVSPACE_CONFIG_DIR: join(root, "config"), DEVSPACE_OAUTH_OWNER_TOKEN: "isolated-smoke-owner-token" };
const defaults = defaultDevspaceConfig();
writeDevspaceConfig({ ...defaults, storage: { ...defaults.storage, stateDir }, tools: { ...defaults.tools, mode: "codex" },
  ui: { ...defaults.ui, enabled: false }, skills: { ...defaults.skills, enabled: false },
  logging: { ...defaults.logging, level: "silent" },
  workspaces: { ...defaults.workspaces, allowedRoots: [root], worktreeRoot: join(root, "worktrees") },
  subagents: { enabled: false, instructions: "on-demand", providers: [] } }, env);
const config = loadConfig(env), store = new SqliteWorkspaceStore(stateDir), registry = new WorkspaceRegistry(config, store);
const processes = new ProcessSessionManager({ stateDir });
const server = createMcpServer(config, registry, createReviewCheckpointManager(), processes, () => [], [], undefined,
  async (roots: string[]) => ({ protocol: "fixture", status: "persisted_registration", roots, createdDirectories: [], projectId: "fixture", uiStatus: "unverified" }));
const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true });
const app = express(); app.use(express.json()); app.all("/mcp", async (req, res) => { await transport.handleRequest(req, res, req.body); });
await server.connect(transport);
const http = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => http.once("listening", r));
const address = http.address(); assert(address && typeof address === "object");
const client = new Client({ name: "isolated-smoke", version: "1" });
const checks: string[] = [];
const watchdog = setTimeout(() => { http.closeAllConnections(); void client.close(); processes.shutdown(); }, 30_000);
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)));
  const tools = (await client.listTools()).tools;
  const openTool = tools.find((x) => x.name === "open_workspace")!;
  assert(openTool.outputSchema?.properties?.execution);
  const instructions = client.getInstructions() ?? "";
  assert.match(instructions, /only when exposed by your host schema/);
  const oldOpen = structuredClone(openTool.inputSchema); delete oldOpen.properties!.createDirectory;
  const workTool = tools.find((x) => x.name === "work_task")!;
  const oldWork = structuredClone(workTool.inputSchema);
  (oldWork.properties!.action as { enum: string[] }).enum = ["begin", "record", "finish", "get", "list"];
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args, _meta: { "openai/session": "isolated-smoke" } });
  const oldHostCall = (name: "open_workspace" | "work_task", args: Record<string, unknown>) => {
    const schema = name === "open_workspace" ? oldOpen : oldWork;
    for (const key of Object.keys(args)) assert(key in schema.properties!, `Old host cannot send ${key}`);
    if (name === "work_task") assert((oldWork.properties!.action as { enum: unknown[] }).enum.includes(args.action));
    return call(name, args);
  };
  const data = (r: Awaited<ReturnType<typeof call>>): any => r.structuredContent ?? JSON.parse((r.content as { text: string }[])[0]!.text);
  assert.throws(() => oldHostCall("open_workspace", { path: project, createDirectory: true }), /Old host cannot send/);
  assert.throws(() => oldHostCall("work_task", { workspaceId: "fixture", action: "snapshot" }));
  const missing = await oldHostCall("open_workspace", { path: join(root, "missing") });
  assert(missing.isError); assert.match(JSON.stringify(missing.content), /host exposes createDirectory/);
  checks.push("old open schema without createDirectory: actionable conditional error, no creation");
  const opened = data(await oldHostCall("open_workspace", { path: project }));
  const reused = data(await oldHostCall("open_workspace", { path: project }));
  assert.equal(opened.workspaceId, reused.workspaceId); assert.deepEqual(opened.execution, reused.execution);
  assert.equal(opened.execution.platform, process.platform);
  checks.push("initial and reused open_workspace execution contract");
  const ws = opened.workspaceId;
  const begun = data(await oldHostCall("work_task", { workspaceId: ws, action: "begin", workItemId: "smoke", runKey: "once", title: "Isolated smoke" }));
  const workRunId = begun.workRunId;
  const started = data(await call("exec_command", { workspaceId: ws, workRunId, cmd: `"${process.execPath}" -e "setTimeout(()=>console.log('smoke-once'),150)"`, tty: true, yieldTimeMs: 0 }));
  assert.equal(started.running, true); assert.equal(started.execution.transport, process.platform === "win32" ? "pipe" : "pty");
  let terminal = started;
  for (let i = 0; terminal.running && i < 10; i++) terminal = data(await call("write_stdin", { workspaceId: ws, sessionId: started.sessionId, yieldTimeMs: 1000 }));
  assert.equal(terminal.running, false); assert.equal(terminal.exitCode, 0);
  const ledger = new WorkLedger(stateDir);
  try {
    const revision = ledger.requireScope(workRunId, project, ws).revision;
    for (let i = 0; i < 2; i++) assert.deepEqual(data(await call("write_stdin", { workspaceId: ws, sessionId: started.sessionId })),
      { ...terminal, terminalReplay: true, result: terminal.result.replace("terminalReplay=false", "terminalReplay=true") });
    assert.equal(ledger.requireScope(workRunId, project, ws).revision, revision);
    assert.equal(processes.executionCoordinator.inspect(project).length, 0);
    checks.push("command once, terminal poll twice, unchanged ledger revision, released claims");
    const fail = data(await call("exec_command", { workspaceId: ws, workRunId, cmd: `"${process.execPath}" -e "process.exit(7)"`, yieldTimeMs: 2000 }));
    assert.equal(fail.exitCode, 7); assert.equal(fail.running, false);
    const foreign = data(await call("open_workspace", { path: other }));
    assert((await call("write_stdin", { workspaceId: foreign.workspaceId, sessionId: fail.sessionId })).isError);
    assert((await call("exec_command", { workspaceId: foreign.workspaceId, workRunId, cmd: "echo must-not-execute" })).isError);
    checks.push("exit 7 negative case and workspace/session/run scope rejection");
    const observed = data(await oldHostCall("work_task", { workspaceId: ws, workRunId, action: "get" })); assert(observed);
    checks.push("old work schema get fallback; no snapshot/history sent");
    const finished = data(await oldHostCall("work_task", { workspaceId: ws, workRunId, action: "finish", status: "completed", acceptance: "passed", summary: "Positive and negative smoke assertions passed", evidence: [{ label: "Smoke", reference: "fixture://assertions", outcome: "passed" }] }));
    assert.equal(finished.acceptanceStatus, "passed"); assert.equal(finished.usageStatus, "not_used");
    assert.equal(ledger.db.prepare("select count(*) as n from console_executions").get().n, 0);
    assert.equal(ledger.db.prepare("select count(*) as n from console_operations").get().n, 2);
    checks.push("finish accepted receipt; exactly two command operations, zero provider executions");
  } finally { ledger.close(); }
} finally {
  clearTimeout(watchdog); await client.close(); await server.close(); processes.shutdown(); store.close();
  http.closeAllConnections(); await new Promise<void>((r) => http.close(() => r()));
  rmSync(root, { recursive: true, force: true });
}
const receipt = { status: "passed", transport: "SDK StreamableHTTP loopback", candidate, checks, providerExecutions: 0,
  excluded: ["active server", "ChatGPT UI/schema refresh", "production OAuth", "Desktop registration"], processesStopped: true,
  candidateServerSha256: createHash("sha256").update(readFileSync(join(candidate, "server.js"))).digest("hex") };
const body = JSON.stringify(receipt, null, 2), path = join(dirname(candidate), "smoke.json");
writeFileSync(path, body);
console.log(JSON.stringify({ path, sha256: createHash("sha256").update(body).digest("hex"), ...receipt }));
