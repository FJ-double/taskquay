/**
 * EXECUTABLE TEST FIXTURE ONLY. A deliberately disposable OS process owning
 * its own temporary SQLite and Windows Job, never a live Taskquay instance.
 */
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ExecutionCoordinator } from "./execution-coordinator.js";
import { ExecutionStateStore } from "./execution-state-store.js";
import { WindowsProviderTurnRunner } from "./provider-turn-runner.js";
import { windowsProcessCreatedAt } from "./windows-job-object.js";
import { windowsBootIdentity } from "./windows-boot-identity.js";

const [mode, dir] = process.argv.slice(2);
if (process.platform !== "win32" || !dir || !["admitted", "armed", "running"].includes(mode ?? "")) {
  process.exit(75);
}
const coordinator = new ExecutionCoordinator(dir);
const token = randomUUID();
const owner = {
  id: coordinator.managedOwnerId,
  kind: "agentd" as const,
  pid: process.pid,
  processCreatedAt: windowsProcessCreatedAt(process.pid),
  bootId: windowsBootIdentity(),
  generation: token,
};
coordinator.registerManagedOwner(owner);
const input = {
  kind: "agent" as const,
  workspaceId: "fixture-ws",
  checkoutRoot: dir,
  owner, access: "write" as const, resources: [],
  idempotencyScope: "owner-crash-fixture",
  requestHash: createHash("sha256").update(mode ?? "").digest("hex"),
  initialPhase: "starting" as const,
};
const admitted = coordinator.admitManaged({ workspaceRoot: dir, kind: "agent",
  agentId: "owner-crash-fixture" }, (sqlite) => {
  const result = new ExecutionStateStore(sqlite).create(input);
  if (!result.created) throw new Error("Fixture admission already existed");
  return { executionId: result.execution.id, value: result.execution.id };
});
writeFileSync(join(dir, "admitted.json"), JSON.stringify({
  executionId: admitted.value, claimId: admitted.claim.id, ownerPid: process.pid,
}));
if (mode === "admitted") {
  // Exit abruptly after the durable transaction and before any fork.
  process.exit(77);
}

const jobInput = {
  executionId: admitted.value, generation: 1, fixtureChildPath:
    fileURLToPath(new URL("./provider-turn-fixture-child.ts", import.meta.url)),
  provider: "codex" as const,
  context: { agentId: "fixture-agent", provider: "codex" as const, workspaceRoot: dir },
  input: { workspaceRoot: dir, prompt: "control" },
  callbacks: {
    onControlReady: () => {
      writeFileSync(join(dir, "running.json"), JSON.stringify({ executionId: admitted.value }));
    },
  },
  persistArmed: async (proof: {
    runnerPid: number; runnerCreatedAt: string; jobIdentity: string;
    executionId: string; generation: number;
  }) => {
    coordinator.withManagedState((sqlite) => {
      const store = new ExecutionStateStore(sqlite);
      const armed = store.arm({
        executionId: proof.executionId, expectedVersion: 0, expectedGeneration: 1,
        pid: proof.runnerPid, createdAt: proof.runnerCreatedAt,
        bootId: owner.bootId, jobIdentity: proof.jobIdentity,
        evidence: JSON.stringify({ kind: "os_job_membership", job: proof.jobIdentity }),
      });
      store.transition({ executionId: proof.executionId, expectedVersion: armed.state_version,
        expectedGeneration: 1, phase: "running" });
    });
    writeFileSync(join(dir, "armed.json"), JSON.stringify({
      runnerPid: proof.runnerPid, jobIdentity: proof.jobIdentity, executionId: proof.executionId,
    }));
    if (mode === "armed") {
      // Never resolve: IPC GO is never sent, despite durable Job membership.
      await new Promise<void>(() => {});
    }
  },
};
void WindowsProviderTurnRunner.start(jobInput).then((runner) => runner.finished,
  (error: unknown) => {
    writeFileSync(join(dir, "fixture-error.txt"),
      error instanceof Error ? error.message : String(error));
    process.exit(76);
  });
