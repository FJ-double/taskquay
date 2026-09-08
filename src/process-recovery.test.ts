import test from "node:test";
import assert from "node:assert/strict";
import { ProcessSessionManager } from "./process-sessions.js";
const node = `"${process.execPath}"`;
const base = { workspaceId: "a", cwd: process.cwd(), yieldTimeMs: 2000 };

test("bounded terminal receipts replay lost start/write failures and cancellations, reject writes and foreign workspaces", { timeout: 15_000 }, async (t) => {
  const events: string[] = [];
  const manager = new ProcessSessionManager({ maxBufferCharacters: 512, diagnostics: (event) => events.push(event) });
  t.after(() => manager.shutdown());
  const result = await manager.start({ ...base, command: `${node} -e "console.log('once');process.exit(7)"` });
  assert.equal(result.running, false); assert.equal(result.exitCode, 7);
  for (let i = 0; i < 2; i++) assert.deepEqual(await manager.write({ workspaceId: "a", sessionId: result.sessionId! }), { ...result, terminalReplay: true });
  assert.equal(events.filter((e) => e === "process_started").length, 1);
  assert.equal(events.filter((e) => e === "process_finished").length, 1);
  assert.equal(events.filter((e) => e === "process_output_consumed").length, 1);
  await assert.rejects(manager.write({ workspaceId: "b", sessionId: result.sessionId! }), /does not belong/);
  await assert.rejects(manager.write({ workspaceId: "a", sessionId: result.sessionId!, chars: "mutation" }), /only empty/);
  const running = await manager.start({ ...base, command: `${node} -e "setInterval(()=>{},1000)"`, yieldTimeMs: 20 });
  const cancelled = await manager.write({ workspaceId: "a", sessionId: running.sessionId!, chars: "\u0003", yieldTimeMs: 2000 });
  assert.equal(cancelled.running, false);
  assert.deepEqual(await manager.write({ workspaceId: "a", sessionId: running.sessionId! }), { ...cancelled, terminalReplay: true });
});

test("terminal receipts expire by count and TTL", { timeout: 10_000 }, async (t) => {
  const manager = new ProcessSessionManager({ maxCompletedSessions: 1, completedSessionTtlMs: 300 });
  t.after(() => manager.shutdown());
  const first = await manager.start({ ...base, command: "echo first" });
  const second = await manager.start({ ...base, command: "echo second" });
  await assert.rejects(manager.write({ workspaceId: "a", sessionId: first.sessionId! }), /Unknown/);
  assert.equal((await manager.write({ workspaceId: "a", sessionId: second.sessionId! })).terminalReplay, true);
  await new Promise((resolve) => setTimeout(resolve, 350));
  await assert.rejects(manager.write({ workspaceId: "a", sessionId: second.sessionId! }), /Unknown/);
});

test("root exit retains lifecycle until inherited stdio closes", { timeout: 10_000, skip: process.platform === "win32" ? "cmd shell root waits for child; POSIX exec fixture required" : false }, async (t) => {
  const manager = new ProcessSessionManager(); t.after(() => manager.shutdown());
  // Child naturally exits after 700ms; no daemon and no detached child.
  const result = await manager.start({ ...base, command: `exec ${node} -e "require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},700)'],{stdio:['ignore',1,2]}).unref()"`, yieldTimeMs: 200 });
  assert.equal(result.running, true); assert.equal(result.phase, "root_exited_stdio_open");
  const closed = await manager.write({ workspaceId: "a", sessionId: result.sessionId!, yieldTimeMs: 2000 });
  assert.equal(closed.phase, "closed"); assert.equal(closed.exitCode, 0);
});
