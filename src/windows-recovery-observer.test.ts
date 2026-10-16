import assert from "node:assert/strict";
import test from "node:test";
import type { RecoverySnapshot, RecoveryOsProbe } from "./windows-recovery-observer.js";
import { observeRecovery } from "./windows-recovery-observer.js";

const boot = "win-ntboot-v1:abcdef01-2345-6789-abcd-1234567890ab:01db3abcdef01234";
const before = "win-ntboot-v1:abcdef02-2345-6789-abcd-1234567890ab:01db3abcdef01200";
const name = "Local\\taskquay-job-9f8f6001-a7bc-4cdd-a213-23f7e87be552";
const record: RecoverySnapshot = {
  id: "ex_" + "1".repeat(32), owner_id: "owner", owner_generation: "generation",
  owner_pid: 125, owner_created_at: "2026-10-14T00:00:00.000Z", owner_boot_id: boot,
  state_version: 4, generation: 1, phase: "running", outcome: "pending",
  resource_state: "held", runner_pid: 126, runner_created_at: "2026-10-14T00:00:02.000Z",
  runner_boot_id: boot, job_identity: name, armed_evidence: "membership-proof",
  exit_evidence: null, claim_id: "claim_" + "2".repeat(32),
};
const probe: RecoveryOsProbe = {
  boot: () => boot,
  process: () => "absent_or_reused",
  job: () => "absent",
};
const observe = (update: Partial<RecoverySnapshot> = {},
  os: Partial<RecoveryOsProbe> = {}) => observeRecovery({ ...record, ...update }, { ...probe, ...os });

test("exact owner+runner disappearance and named Job absence make only a recovery candidate", () => {
  const result = observe();
  assert.equal(result.decision, "candidate");
  assert.equal(result.evidenceKind, "job_empty_verified");
  assert.equal(result.version, record.state_version);
  assert.equal(result.ownerGeneration, record.owner_generation);
});
test("heartbeats and stale PIDs never override live owner/runner identities", () => {
  assert.equal(observe({}, { process: (pid) => pid === 125 ? "same" : "absent_or_reused" }).decision, "active");
  assert.equal(observe({}, { process: (pid) => pid === 126 ? "same" : "absent_or_reused" }).decision, "quarantine");
});
test("unknown owner or runner identity never releases a claim", () => {
  assert.equal(observe({}, { process: () => "unknown" }).decision, "quarantine");
  assert.equal(observe({}, { process: (pid) => pid === 125 ? "absent_or_reused" : "unknown" }).decision, "quarantine");
});
test("named Job still present, active, or unqueryable prohibits release", () => {
  for (const state of ["exists_active", "exists_empty", "unknown"] as const) {
    assert.equal(observe({}, { job: () => state }).decision, "quarantine");
  }
});
test("verified prior-boot requires kernel-format identity, never runtime generated IDs", () => {
  const prior = observe({ owner_boot_id: before, runner_boot_id: before }, { boot: () => boot });
  assert.equal(prior.decision, "candidate");
  assert.equal(prior.evidenceKind, "prior_boot_verified");
  assert.equal(observe({ owner_boot_id: boot.slice(0, boot.lastIndexOf(":")) + ":01db3abcdef00001",
    runner_boot_id: boot.slice(0, boot.lastIndexOf(":")) + ":01db3abcdef00001" }).decision,
  "quarantine", "Time adjustment without changed GUID is not a proven reboot");
  const sameTicksOtherGuid = "win-ntboot-v1:abcdee01-2345-6789-abcd-1234567890ab:01db3abcdef01234";
  assert.equal(observe({ owner_boot_id: sameTicksOtherGuid,
    runner_boot_id: sameTicksOtherGuid }).decision, "quarantine",
  "GUID drift alone cannot prove a boot transition");
  assert.equal(observe({ owner_boot_id: "runtime-unverified:random", runner_boot_id: "runtime-unverified:random" },
    { boot: () => boot }).decision, "quarantine");
  assert.equal(observe({}, { boot: () => { throw new Error("unavailable"); } }).decision, "quarantine");
});
test("no armed Job identity and no runner never qualifies for automatic release", () => {
  assert.equal(observe({ phase: "starting", runner_pid: null, job_identity: null }).decision, "quarantine");
  assert.equal(observe({ job_identity: "Local\\not-our-job" }).decision, "quarantine");
  assert.equal(observe({ runner_boot_id: before }).decision, "quarantine");
  assert.equal(observe({ resource_state: "released" }).decision, "quarantine");
});
