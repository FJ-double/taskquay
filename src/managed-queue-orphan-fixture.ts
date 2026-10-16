/**
 * TEST PROCESS ONLY. Dedicated throwaway owner, temp SQLite, no Provider
 * child, model or network call. Parent test terminates only this PID.
 */
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ExecutionCoordinator, type ManagedAdmissionTicket } from "./execution-coordinator.js";
import { ExecutionStateStore } from "./execution-state-store.js";
import { LocalAgentStore } from "./local-agent-store.js";
import { windowsBootIdentity } from "./windows-boot-identity.js";
import { windowsProcessCreatedAt } from "./windows-job-object.js";

const [mode, dir] = process.argv.slice(2);
if (process.platform !== "win32" || !dir ||
    !["queued", "promotion_rollback", "promoted"].includes(mode ?? "")) {
  process.exit(74);
}
const coordinator = new ExecutionCoordinator(dir);
const owner = {
  id: coordinator.managedOwnerId, kind: "agentd" as const,
  pid: process.pid, processCreatedAt: windowsProcessCreatedAt(process.pid),
  bootId: windowsBootIdentity(), generation: randomUUID(),
};
coordinator.registerManagedOwner(owner);
const store = new LocalAgentStore(dir);
store.useSharedDatabase(coordinator.sharedDatabaseHandle);
const input = { kind: "agent" as const, workspaceRoot: dir, agentId: "" };
let agentId = "";
let ticketId = "";
let ticket!: ManagedAdmissionTicket;
coordinator.withManagedState(() => {
  const agent = store.create({ workspaceRoot: dir, workspaceId: "fixture",
    provider: "codex", profileName: "reviewer" });
  agentId = agent.id;
  ticket = coordinator.enqueueManaged({ ...input, agentId }, 180_000);
  ticketId = ticket.id;
  store.update(agentId, { status: "queued" });
});
writeFileSync(join(dir, "queue-ready.json"), JSON.stringify({
  ticketId, agentId, ownerId: owner.id, ownerGeneration: owner.generation,
  ownerPid: process.pid,
}));
if (mode !== "queued") {
  const begin = () => ticket.tryAdmit((sqlite) => {
    const turn = store.beginTurn(agentId, { prompt: "PROVIDER_NEVER_STARTED" });
    const created = new ExecutionStateStore(sqlite).create({
      kind: "agent", workspaceId: "fixture", checkoutRoot: dir,
      owner, access: "write", resources: [], initialPhase: "starting",
      idempotencyScope: `queue-fixture:${agentId}`,
      requestKey: "never-dispatched",
      requestHash: createHash("sha256").update("fixture-never-dispatched").digest("hex"),
    });
    if (!created.created) throw new Error("FIXTURE_EXECUTION_ALREADY_CREATED");
    if (mode === "promotion_rollback") throw new Error("INJECTED_ATOMIC_PROMOTION_FAILURE");
    return { executionId: created.execution.id, value: turn.turn.id };
  });
  if (mode === "promotion_rollback") {
    try { begin(); throw new Error("EXPECTED_ROLLBACK_NOT_THROWN"); }
    catch (error) {
      if (!(error instanceof Error) || error.message !== "INJECTED_ATOMIC_PROMOTION_FAILURE") throw error;
    }
  } else {
    const promoted = begin();
    if (!promoted) throw new Error("PROMOTION_FAILED_UNEXPECTEDLY");
  }
  writeFileSync(join(dir, "promotion-finished.json"), JSON.stringify({
    mode, ticketId, agentId, ownerPid: process.pid,
  }));
}
// Dedicated test-only keepalive: parent kills exactly this child PID after
// the durable boundary. Never attached to actual Taskquay services.
setInterval(() => {}, 1000);
await new Promise<void>(() => {});
