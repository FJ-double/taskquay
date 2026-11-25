import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { recoverCommandClaims } from "./command-claim-recovery.js";
import { canonicalExecutionRoot, ExecutionCoordinator, ExecutionConflictError } from "./execution-coordinator.js";
import type { RecoveryOsProbe } from "./windows-recovery-observer.js";
import { WorkLedger } from "./work-ledger.js";

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "taskquay-legacy-recovery-"));
  const checkout = join(dir, "checkout");
  const other = join(dir, "other");
  mkdirSync(checkout); mkdirSync(other);
  const ledger = new WorkLedger(dir);
  const peer = new ExecutionCoordinator(dir);
  t.after(() => { peer.close(); ledger.close(); rmSync(dir, { recursive: true, force: true }); });
  const root = canonicalExecutionRoot(checkout);
  const claimId = `claim_${randomUUID().replaceAll("-", "")}`;
  const boot = Date.now() - 60_000;
  const probe: RecoveryOsProbe = {
    boot: () => `win-ntboot-v1:abcdef01-2345-6789-abcd-1234567890ab:${(BigInt(boot) * 10_000n + 116444736000000000n).toString(16).padStart(16, "0")}`,
    process: () => "unknown", job: () => "unknown", legacyOwner: () => "absent_or_reused",
  };
  const run = ledger.begin({ root, workspaceId: "test", workItemId: "legacy", runKey: "one",
    title: "Legacy command", origin: { entryPoint: "other_mcp", evidence: "client_reported" } });
  const operationId = ledger.operation({ runId: run.id, requestKey: "command:one",
    kind: "command", label: "Legacy command", status: "running" });
  ledger.db.prepare("update console_operations set created_at=? where id=?")
    .run(new Date(boot - 30_000).toISOString(), operationId);
  ledger.db.prepare(`insert into execution_claims(id,owner_id,owner_pid,kind,checkout_root,resources,acquired_at,access_mode)
    values (?,?,?,'command',?,'[]',?,'write')`)
    .run(claimId, "previous-owner", process.pid + 10_000, root, new Date(boot - 30_002).toISOString());
  return { checkout, root, other: canonicalExecutionRoot(other), claimId, ledger, peer, probe, operationId, run };
}

test("previous-boot legacy command releases only the scoped claim and settles the interrupted work", (t) => {
  const x = fixture(t);
  const recover = { action: "recover" as const, root: x.root, claimId: x.claimId };
  assert.throws(() => x.peer.acquire({ workspaceRoot: x.checkout, kind: "command" }), ExecutionConflictError);
  assert.equal(recoverCommandClaims(x.ledger.db, { ...recover, root: x.other }, x.probe).items[0]?.status, "not_found");
  assert.equal(recoverCommandClaims(x.ledger.db, { ...recover, action: "inspect" }, x.probe).items[0]?.status, "candidate");
  assert.equal(x.ledger.run(x.run.id).status, "running");
  assert.equal(recoverCommandClaims(x.ledger.db, recover, x.probe).items[0]?.status, "released");
  assert.equal(recoverCommandClaims(x.ledger.db, recover, x.probe).items[0]?.status, "released");
  assert.deepEqual(x.ledger.db.prepare("select status,acceptance from console_work_runs where id=?").get(x.run.id),
    { status: "failed", acceptance: "failed" });
  assert.deepEqual(x.ledger.db.prepare("select status from console_operations where id=?").get(x.operationId), { status: "failed" });
  assert.deepEqual(x.ledger.db.prepare("select count(*) as n from command_claim_recoveries").get(), { n: 1 });
  x.peer.acquire({ workspaceRoot: x.checkout, kind: "command" }).release();
});

test("legacy current-boot, unverified and ambiguous records retain the exact claim", (t) => {
  const x = fixture(t);
  const request = { action: "recover" as const, root: x.root, claimId: x.claimId };
  const before = x.ledger.db.prepare("select acquired_at from execution_claims where id=?").get(x.claimId) as { acquired_at: string };
  x.ledger.db.prepare("update execution_claims set acquired_at=? where id=?").run(new Date().toISOString(), x.claimId);
  assert.equal(recoverCommandClaims(x.ledger.db, request, x.probe).items[0]?.reason, "LEGACY_REQUIRES_VERIFIED_REBOOT");
  x.ledger.db.prepare("update execution_claims set acquired_at=? where id=?").run(before.acquired_at, x.claimId);
  assert.equal(recoverCommandClaims(x.ledger.db, request, { ...x.probe, boot: () => "unverified" }).items[0]?.status, "quarantined");
  assert.equal(recoverCommandClaims(x.ledger.db, request, { ...x.probe, legacyOwner: () => "same" }).items[0]?.reason, "LEGACY_PID_IN_USE");
  x.ledger.operation({ runId: x.run.id, requestKey: "command:other", kind: "command", label: "Unknown command", status: "running" });
  assert.equal(recoverCommandClaims(x.ledger.db, request, x.probe).items[0]?.reason, "LEGACY_OPERATION_LINK_AMBIGUOUS");
  assert.throws(() => x.peer.acquire({ workspaceRoot: x.checkout, kind: "command" }), ExecutionConflictError);
});
