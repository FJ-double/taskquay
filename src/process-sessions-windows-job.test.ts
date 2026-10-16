import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProcessSessionManager, type ProcessSnapshot } from "./process-sessions.js";

const windows = process.platform === "win32" ? {} : { skip: "win32 Job Object only" };
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const node = `"${process.execPath}"`;

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

async function pollUntil(manager: ProcessSessionManager, workspaceId: string, first: ProcessSnapshot,
  done: (snapshot: ProcessSnapshot, output: string) => boolean): Promise<{ snapshot: ProcessSnapshot; output: string }> {
  let snapshot = first;
  let output = first.output;
  for (let i = 0; !done(snapshot, output) && i < 40; i++) {
    snapshot = await manager.write({ workspaceId, sessionId: first.sessionId!,
      executionId: first.executionId, yieldTimeMs: 500 });
    output += snapshot.output;
  }
  return { snapshot, output };
}

test("terminate kills a grandchild that outlived the root shell and still holds the pipes", windows, async () => {
  const dir = mkdtempSync(join(tmpdir(), "taskquay-pipe-job-"));
  // The intermediate exits immediately; its detached grandchild inherits the
  // session's stdout, so the session stays running with a dead root PID.
  const script = join(dir, "intermediate.cjs");
  writeFileSync(script, [
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],",
    "  { stdio: 'inherit', detached: true, windowsHide: true });",
    "console.log('GRANDCHILD:' + child.pid);",
    "child.unref();",
  ].join("\n"));
  const events: string[] = [];
  const manager = new ProcessSessionManager({ diagnostics: (event) => { events.push(event); } });
  let grandchild = 0;
  try {
    const started = await manager.start({ workspaceId: "ws", cwd: dir,
      command: `${node} "${script}"`, yieldTimeMs: 1_000 });
    let { snapshot, output } = await pollUntil(manager, "ws", started,
      (current, text) => /GRANDCHILD:\d+/.test(text) && current.phase === "root_exited_stdio_open");
    grandchild = Number(/GRANDCHILD:(\d+)/.exec(output)?.[1]);
    assert.ok(grandchild > 0, `grandchild PID missing from output: ${output}`);
    assert.equal(snapshot.phase, "root_exited_stdio_open");
    assert.equal(alive(grandchild), true);
    assert.equal(events.includes("process_job_unavailable"), false);

    manager.terminate("ws", started.sessionId!);
    ({ snapshot } = await pollUntil(manager, "ws", snapshot, (current) => !current.running));
    assert.equal(snapshot.running, false);
    for (let i = 0; alive(grandchild) && i < 50; i++) await pause(40);
    assert.equal(alive(grandchild), false, "grandchild survived session termination");
  } finally {
    if (grandchild && alive(grandchild)) try { process.kill(grandchild); } catch {}
    manager.shutdown();
    await pause(200);
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("managed output decodes a UTF-8 character split across pipe chunks", windows, async () => {
  const dir = mkdtempSync(join(tmpdir(), "taskquay-managed-utf8-"));
  const workspace = join(dir, "workspace");
  mkdirSync(workspace);
  const script = join(workspace, "split.cjs");
  writeFileSync(script, [
    "const bytes = Buffer.from('中文输出-OK\\n', 'utf8');",
    "process.stdout.write(bytes.subarray(0, 1));",
    "setTimeout(() => process.stdout.write(bytes.subarray(1, 4)), 300);",
    "setTimeout(() => process.stdout.write(bytes.subarray(4)), 600);",
  ].join("\n"));
  const manager = new ProcessSessionManager({ stateDir: join(dir, "state"), managedWindowsCommands: true });
  try {
    const started = await manager.start({ workspaceId: "ws", workspaceRoot: workspace, cwd: workspace,
      command: `${node} "${script}"`, yieldTimeMs: 4_000 });
    const { snapshot, output } = await pollUntil(manager, "ws", started, (current) => !current.running);
    assert.equal(snapshot.running, false);
    assert.equal(snapshot.exitCode, 0);
    assert.match(output, /中文输出-OK/);
    assert.equal(output.includes("�"), false);
  } finally {
    manager.shutdown();
    await pause(250);
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
