import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { executionContract, resolveShellCommand, terminateProcessTree } from "./process-platform.js";

test("missing PowerShell 7 falls back to a runnable CMD with its actual path", { skip: process.platform !== "win32" }, () => {
  const shell = resolveShellCommand("echo CMD_FALLBACK_OK", "win32", { ComSpec: process.env.ComSpec, PATH: "", ProgramFiles: "Z:\\taskquay-no-powershell" });
  assert.match(shell.executable, /cmd\.exe$/i);
  const result = spawnSync(shell.executable, shell.args, { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0); assert.match(result.stdout, /CMD_FALLBACK_OK/);
});
test("installed PowerShell 7 including execution aliases is preferred; TTY reports pipe fallback", { skip: process.platform !== "win32" }, t => {
  const located = spawnSync("where.exe", ["pwsh.exe"], { encoding: "utf8", windowsHide: true });
  if (located.status !== 0) return t.skip("PowerShell 7 is not installed.");
  const shell = resolveShellCommand("$PSVersionTable.PSVersion.Major");
  assert.match(shell.executable, /pwsh\.exe$/i);
  const result = spawnSync(shell.executable, shell.args, { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0); assert(Number(result.stdout.trim()) >= 7);
  assert.equal(executionContract(true).shell,
    resolveShellCommand("", process.platform, process.env, true).executable);
  assert.equal(executionContract(true).transport, "pipe");
  assert.equal(executionContract(true).ptyCapability, "pipe_fallback");
});
test("managed Windows Job never reports or runs a WindowsApps PowerShell execution alias", { skip: process.platform !== "win32" }, () => {
  const ordinary = resolveShellCommand("echo safe");
  const job = resolveShellCommand("echo safe", process.platform, process.env, true);
  assert.doesNotMatch(job.executable, /[\\/]Microsoft[\\/]WindowsApps[\\/]pwsh\.exe$/i);
  if (/[\\/]Microsoft[\\/]WindowsApps[\\/]pwsh\.exe$/i.test(ordinary.executable)) {
    assert.match(job.executable, /cmd\.exe$/i);
  }
  assert.equal(executionContract(false, true).shell, job.executable);
});
test("an exited root never targets a potentially reused Windows PID", () => {
  let calls = 0;
  const runtime = { platform: "win32" as const, killGroup: () => { throw new Error("unexpected POSIX path"); }, killWindowsTree: () => { calls++; return true; } };
  terminateProcessTree({ pid: 42, exitCode: 0, kill: () => true }, "SIGTERM", false, runtime);
  assert.equal(calls, 0);
  terminateProcessTree({ pid: 42, exitCode: null, kill: () => true }, "SIGTERM", false, runtime);
  assert.equal(calls, 1);
});
