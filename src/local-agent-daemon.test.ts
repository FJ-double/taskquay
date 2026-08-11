import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
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
  assert.equal((await client.get(record.id))?.id, record.id);
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

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check() && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(check(), true, "condition did not become true before timeout");
}
