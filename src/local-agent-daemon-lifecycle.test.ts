import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  LocalAgentDaemonAlreadyRunningError,
  LocalAgentDaemonLock,
  ensureLocalAgentDaemonStateDir,
  isProcessAlive,
  localAgentDaemonPaths,
  removeLocalAgentDaemonFiles,
  ensureLocalAgentDaemonSecret,
  writeLocalAgentDaemonPid,
} from "./local-agent-daemon-lifecycle.js";

const root = await mkdtemp(join(tmpdir(), "devspace-agentd-lifecycle-test-"));
try {
  const paths = localAgentDaemonPaths(join(root, "state"));
  ensureLocalAgentDaemonStateDir(paths.stateDir);
  const lock = new LocalAgentDaemonLock(paths);
  lock.acquire();
  assert.equal(await readFile(paths.lockPath, "utf8"), `${process.pid}\n`);
  assert.throws(
    () => new LocalAgentDaemonLock(paths).acquire(),
    (error: unknown) => error instanceof LocalAgentDaemonAlreadyRunningError,
  );
  await writeFile(paths.pidPath, "999999\n", { mode: 0o600 });
  assert.throws(
    () => new LocalAgentDaemonLock(paths).acquire(),
    (error: unknown) => error instanceof LocalAgentDaemonAlreadyRunningError,
    "a stale diagnostic PID must not override the live lock owner",
  );
  assert.equal(ensureLocalAgentDaemonSecret(paths).length, 64);
  lock.release();

  await writeFile(paths.pidPath, "999999\n", { mode: 0o600 });
  const recovered = new LocalAgentDaemonLock(paths);
  recovered.acquire();
  writeLocalAgentDaemonPid(paths);
  assert.equal(await readFile(paths.pidPath, "utf8"), `${process.pid}\n`);
  assert.equal(isProcessAlive(process.pid), true);
  recovered.release();
  removeLocalAgentDaemonFiles(paths);
} finally {
  await rm(root, { recursive: true, force: true });
}
