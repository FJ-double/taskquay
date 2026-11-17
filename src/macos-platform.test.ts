import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { ProcessSessionManager } from "./process-sessions.js";
import { resolveShellCommand } from "./process-platform.js";

test("macOS defaults to zsh and keeps explicitly selected POSIX shells", () => {
  assert.deepEqual(resolveShellCommand("echo ok", "darwin", {}), { executable: "/bin/zsh", args: ["-lc", "echo ok"] });
  assert.equal(resolveShellCommand("echo ok", "darwin", { SHELL: "/bin/bash" }).executable, "/bin/bash");
  assert.equal(resolveShellCommand("echo ok", "darwin", { SHELL: "/bin/sh" }).executable, "/bin/sh");
});

test("macOS TTY, pipe fallback and owned-session termination use the actual shell", { skip: process.platform !== "darwin" }, async () => {
  const original = process.env.SHELL;
  delete process.env.SHELL;
  const manager = new ProcessSessionManager();
  const fallback = new ProcessSessionManager({ ptyLoader: async () => { throw new Error("fixture optional PTY unavailable"); } });
  try {
    const pipe = await fallback.start({ workspaceId: "one", command: "printf 'PIPE:%s' \"$ZSH_VERSION\"", cwd: tmpdir(), tty: true, yieldTimeMs: 2000 });
    assert.equal(pipe.exitCode, 0);
    assert.equal(pipe.execution.shell, "/bin/zsh");
    assert.equal(pipe.execution.transport, "pipe");
    assert.equal(pipe.execution.ptyCapability, "pipe_fallback");
    assert.match(pipe.output, /PIPE:\d/);
    const tty = await manager.start({ workspaceId: "one", command: "test -t 0 && printf PTY_OK", cwd: tmpdir(), tty: true, yieldTimeMs: 2000 });
    assert.equal(tty.exitCode, 0);
    assert.equal(tty.execution.transport, "pty");
    assert.equal(tty.execution.shell, "/bin/zsh");
    assert.match(tty.output, /PTY_OK/);
    const liveTty = await manager.start({ workspaceId: "one", command: "sleep 30", cwd: tmpdir(), tty: true, yieldTimeMs: 1 });
    manager.terminate("one", liveTty.sessionId!);
    assert.equal((await manager.write({ workspaceId: "one", sessionId: liveTty.sessionId!, yieldTimeMs: 2000 })).running, false);
    const live = await manager.start({ workspaceId: "one", command: "sleep 30", cwd: tmpdir(), yieldTimeMs: 1 });
    assert(live.running && live.sessionId);
    assert.equal(manager.listOwnedSessions("other").length, 0);
    assert.throws(() => manager.terminate("other", live.sessionId!), /does not belong/);
    manager.terminate("one", live.sessionId);
    const ended = await manager.write({ workspaceId: "one", sessionId: live.sessionId, yieldTimeMs: 2000 });
    assert.equal(ended.running, false);
    assert(manager.listOwnedSessions("one").some(item => item.sessionId === live.sessionId && !item.running));
  } finally {
    manager.shutdown(); fallback.shutdown();
    if (original === undefined) delete process.env.SHELL; else process.env.SHELL = original;
  }
});
