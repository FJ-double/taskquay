import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalAgentStore } from "./local-agent-store.js";

const root = mkdtempSync(join(tmpdir(), "devspace-local-agent-store-test-"));

try {
  const store = new LocalAgentStore(join(root, "agents.json"));
  const created = store.create({
    workspaceId: "ws_1",
    workspaceRoot: join(root, "project"),
    profileName: "reviewer",
    provider: "codex",
    model: "gpt-5.4",
  });

  assert.match(created.id, /^agt_[a-f0-9]{8}$/);
  assert.equal(created.status, "starting");
  assert.equal(store.get(created.id)?.profileName, "reviewer");
  assert.equal(store.get(created.id.slice(0, 7))?.id, created.id);

  const updated = store.update(created.id, {
    status: "idle",
    latestResponse: "done",
    providerSessionId: "thread_123",
  });

  assert.equal(updated.status, "idle");
  assert.equal(store.get("thread_123")?.id, created.id);
  assert.deepEqual(
    store.list({ workspaceRoot: join(root, "project") }).map((agent) => agent.latestResponse),
    ["done"],
  );
  assert.deepEqual(store.list({ workspaceId: "ws_1" }).map((agent) => agent.id), [created.id]);
  assert.deepEqual(store.list({ workspaceId: "ws_other" }), []);
  assert.deepEqual(store.list({ workspaceRoot: join(root, "other") }), []);
} finally {
  rmSync(root, { recursive: true, force: true });
}
