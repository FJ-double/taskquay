import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalAgentClient } from "./local-agent-client.js";
import { LocalAgentDaemon, type LocalAgentDaemonManager } from "./local-agent-daemon.js";
import type { RunOverrides, StartLocalAgentInput } from "./local-agent-manager.js";
import type { LocalAgentListScope, LocalAgentRecord } from "./local-agent-store.js";

const root = await mkdtemp(join(tmpdir(), "devspace-agentd-test-"));
const record: LocalAgentRecord = {
  id: "agt_test",
  workspaceRoot: join(root, "project"),
  profileName: "reviewer",
  provider: "codex",
  status: "running",
  createdAt: "now",
  updatedAt: "now",
};

class FakeManager implements LocalAgentDaemonManager {
  activeTurnCount = 1;
  runtimeCount = 0;
  closed = false;
  lastInput?: StartLocalAgentInput;

  async start(input: StartLocalAgentInput): Promise<LocalAgentRecord> {
    this.lastInput = input;
    return record;
  }

  async continue(_agentId: string, _prompt: string, _overrides?: RunOverrides): Promise<LocalAgentRecord> {
    return { ...record, status: "running" };
  }

  get(id: string): LocalAgentRecord | undefined {
    return id === record.id ? record : undefined;
  }

  list(_scope?: LocalAgentListScope): LocalAgentRecord[] {
    return [record];
  }

  async evictIdle(): Promise<void> {}

  async close(): Promise<void> {
    this.closed = true;
    this.activeTurnCount = 0;
  }
}

const manager = new FakeManager();
const daemon = new LocalAgentDaemon({
  stateDir: join(root, "state"),
  manager,
  idleShutdownMs: 60_000,
});
const client = new LocalAgentClient({
  stateDir: join(root, "state"),
  startupTimeoutMs: 2_000,
  requestTimeoutMs: 2_000,
  spawnDaemon: () => { void daemon.start(); },
});

const missingDaemonStateDir = join(root, "missing-daemon-state");
let diagnosticSpawnCount = 0;
const missingDaemonClient = new LocalAgentClient({
  stateDir: missingDaemonStateDir,
  startupTimeoutMs: 50,
  requestTimeoutMs: 50,
  spawnDaemon: () => { diagnosticSpawnCount += 1; },
});
for (const diagnostic of [
  () => missingDaemonClient.status(),
  () => missingDaemonClient.stop(),
  () => missingDaemonClient.logs(),
]) {
  await assert.rejects(diagnostic, /Local agent daemon is not running/);
}
assert.equal(diagnosticSpawnCount, 0, "daemon diagnostics must not start a missing daemon");

let shutdownSocket: ReturnType<typeof createConnection> | undefined;
try {
  const started = await client.run({
    target: "reviewer",
    prompt: "Review this",
    workspaceRoot: join(root, "project"),
  });
  assert.equal(started.id, record.id);
  assert.equal(manager.lastInput?.prompt, "Review this");
  assert.equal((await client.get(record.id, { workspaceRoot: record.workspaceRoot }))?.id, record.id);
  assert.equal((await client.list({ workspaceRoot: record.workspaceRoot }))[0]?.id, record.id);
  assert.equal((await client.status()).state, "ready");

  await client.stop();
  await waitFor(() => manager.closed && !existsSync(daemon.paths.socketPath));
} finally {
  await daemon.close();
}

const idleStateDir = join(root, "idle-state");
const idleManager = new FakeManager();
idleManager.activeTurnCount = 0;
const idleDaemon = new LocalAgentDaemon({
  stateDir: idleStateDir,
  manager: idleManager,
  idleShutdownMs: 200,
  idleCheckIntervalMs: 10,
});
const idleClient = new LocalAgentClient({
  stateDir: idleStateDir,
  startupTimeoutMs: 2_000,
  requestTimeoutMs: 2_000,
  spawnDaemon: () => { void idleDaemon.start(); },
});

try {
  await idleClient.ensureReady();
  await waitFor(() => idleManager.closed && !existsSync(idleDaemon.paths.socketPath));
} finally {
  await idleDaemon.close();
  await rm(root, { recursive: true, force: true });
}

const ownershipStateDir = join(root, "ownership-state");
const ownerManager = new FakeManager();
const competingManager = new FakeManager();
const ownerDaemon = new LocalAgentDaemon({
  stateDir: ownershipStateDir,
  manager: ownerManager,
  idleShutdownMs: 60_000,
});
const competingDaemon = new LocalAgentDaemon({
  stateDir: ownershipStateDir,
  manager: competingManager,
  idleShutdownMs: 60_000,
});

try {
  const startupResults = await Promise.allSettled([
    ownerDaemon.start(),
    competingDaemon.start(),
  ]);
  assert.equal(
    startupResults.filter((result) => result.status === "fulfilled").length,
    1,
    "only one competing daemon may acquire the state-directory lock",
  );
  assert.equal(
    startupResults.filter((result) => result.status === "rejected").length,
    1,
  );
  const lockBefore = readFileSync(ownerDaemon.paths.lockPath, "utf8");
  const pidBefore = readFileSync(ownerDaemon.paths.pidPath, "utf8");
  assert.notEqual(ownerDaemon.paths.endpoint, "");
  assert.equal(readFileSync(ownerDaemon.paths.lockPath, "utf8"), lockBefore);
  assert.equal(readFileSync(ownerDaemon.paths.pidPath, "utf8"), pidBefore);
  const ownerClient = new LocalAgentClient({
    stateDir: ownershipStateDir,
    spawnDaemon: () => { throw new Error("the winning daemon should already be reachable"); },
  });
  assert.equal((await ownerClient.status()).pid, process.pid);
} finally {
  await competingDaemon.close();
  await ownerDaemon.close();
}

const socketStateDir = join(root, "socket-state");
const socketManager = new FakeManager();
socketManager.activeTurnCount = 0;
const socketDaemon = new LocalAgentDaemon({
  stateDir: socketStateDir,
  manager: socketManager,
  requestReadTimeoutMs: 30,
  shutdownTimeoutMs: 100,
  idleShutdownMs: 60_000,
});

try {
  await socketDaemon.start();
  const idleSocket = createConnection(socketDaemon.paths.endpoint);
  await onceSocket(idleSocket, "connect");
  await waitFor(() => socketDaemon.status().clientConnections === 0);
  idleSocket.destroy();

  shutdownSocket = createConnection(socketDaemon.paths.endpoint);
  await onceSocket(shutdownSocket, "connect");
  const shutdownSocketClosed = onceSocket(shutdownSocket, "close");
  const startedAt = Date.now();
  await socketDaemon.close();
  await shutdownSocketClosed;
  assert.ok(Date.now() - startedAt < 500, "shutdown should destroy idle client sockets before closing the server");
} finally {
  shutdownSocket?.destroy();
  await socketDaemon.close();
  await rm(root, { recursive: true, force: true });
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check() && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(check(), true, "condition did not become true before timeout");
}

function onceSocket(
  socket: ReturnType<typeof createConnection>,
  event: "connect" | "close",
  timeoutMs = 2_000,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Socket did not emit ${event} within ${timeoutMs}ms.`));
    }, timeoutMs);
    timeout.unref();

    const cleanup = () => {
      clearTimeout(timeout);
      socket.off(event, onEvent);
      socket.off("error", onError);
    };

    socket.once(event, onEvent);
    socket.once("error", onError);
  });
}
