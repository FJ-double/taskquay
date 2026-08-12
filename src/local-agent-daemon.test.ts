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

try {
  const started = await client.run({
    target: "reviewer",
    prompt: "Review this",
    workspaceRoot: join(root, "project"),
  });
  assert.equal(started.id, record.id);
  assert.equal(manager.lastInput?.prompt, "Review this");
  assert.equal((await client.get(record.id, { workspaceRoot: record.workspaceRoot }))?.id, record.id);
  assert.equal((await client.list())[0]?.id, record.id);
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
  await ownerDaemon.start();
  const lockBefore = readFileSync(ownerDaemon.paths.lockPath, "utf8");
  const pidBefore = readFileSync(ownerDaemon.paths.pidPath, "utf8");
  assert.notEqual(ownerDaemon.paths.endpoint, "");
  await assert.rejects(competingDaemon.start(), /already running/);
  assert.equal(readFileSync(ownerDaemon.paths.lockPath, "utf8"), lockBefore);
  assert.equal(readFileSync(ownerDaemon.paths.pidPath, "utf8"), pidBefore);
  if (process.platform === "win32") {
    assert.match(ownerDaemon.paths.endpoint, /^\\\\\.\\pipe\\/);
  } else {
    assert.equal(existsSync(ownerDaemon.paths.socketPath), true);
  }
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
  await onceSocket(idleSocket, "close");

  const shutdownSocket = createConnection(socketDaemon.paths.endpoint);
  await onceSocket(shutdownSocket, "connect");
  const startedAt = Date.now();
  await socketDaemon.close();
  assert.ok(Date.now() - startedAt < 500, "shutdown should destroy idle client sockets before closing the server");
} finally {
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

function onceSocket(socket: ReturnType<typeof createConnection>, event: "connect" | "close"): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    socket.once(event, () => resolve());
    socket.once("error", reject);
  });
}
