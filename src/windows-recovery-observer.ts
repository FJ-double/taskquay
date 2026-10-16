import koffi from "koffi";
import type Database from "better-sqlite3";
import { windowsBootIdentity } from "./windows-boot-identity.js";
import { windowsProcessIdentityStatus } from "./windows-job-object.js";

/** Observation is NOT recovery. Never release a claim using heartbeat or PID alone. */
export interface RecoverySnapshot {
  id: string; owner_id: string; owner_generation: string; owner_pid: number;
  owner_created_at: string; owner_boot_id: string;
  state_version: number; generation: number;
  phase: string; outcome: string; resource_state: string;
  runner_pid: number | null; runner_created_at: string | null;
  runner_boot_id: string | null; job_identity: string | null;
  armed_evidence: string | null; exit_evidence: string | null;
  claim_id: string;
}
export type ProcessProbe = "same" | "absent_or_reused" | "unknown";
export type JobProbe = "absent" | "exists_empty" | "exists_active" | "unknown";
export type RecoveryDecision = "candidate" | "active" | "quarantine";
export interface RecoveryObservation {
  decision: RecoveryDecision;
  reason: string;
  executionId: string;
  version: number;
  ownerGeneration: string;
  bootId: string | null;
  ownerProbe?: ProcessProbe;
  runnerProbe?: ProcessProbe;
  jobProbe?: JobProbe;
  evidenceKind?: "job_empty_verified" | "prior_boot_verified";
  observedAt: string;
}
export interface RecoveryOsProbe {
  boot(): string;
  process(pid: number, createdAt: string): ProcessProbe;
  job(name: string): JobProbe;
}
const nativeName = /^Local\\taskquay-job-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const nativeBoot = /^win-ntboot-v1:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}:[0-9a-f]{16}$/i;

/** A malformed / forbidden PID is unknown, not a dead process. */
function probeProcess(pid: number, createdAt: string): ProcessProbe {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !createdAt) return "unknown";
  try {
    return windowsProcessIdentityStatus(pid, createdAt);
  } catch (error) {
    // Windows OpenProcess ERROR_INVALID_PARAMETER (87) indicates that the
    // given PID is not currently valid. All other errors are ambiguous.
    if (error instanceof Error && /WINDOWS_JOB_OPEN_PROCESS_FAILED: GetLastError=87(?:\D|$)/.test(error.message)) {
      return "absent_or_reused";
    }
    return "unknown";
  }
}
/** Open only QUERY rights to the EXACT named Job. No termination APIs.
 * A handle is never intentionally kept: retained handles delay kill-on-close.
 */
function probeJob(name: string): JobProbe {
  if (process.platform !== "win32" || process.arch !== "x64" || !nativeName.test(name)) return "unknown";
  try {
    const api = koffi.load("kernel32.dll");
    const open = api.func("OpenJobObjectW", "void *", ["uint32", "int", "str16"]);
    const query = api.func("QueryInformationJobObject", "int", ["void *", "int", "void *", "uint32", "void *"]);
    const close = api.func("CloseHandle", "int", ["void *"]);
    const lastError = api.func("GetLastError", "uint32", []);
    const handle = open(0x0004, 0, name);
    if (!handle) {
      const error = lastError();
      return error === 2 ? "absent" : "unknown";
    }
    try {
      const accounting = Buffer.alloc(48);
      if (!query(handle, 1, accounting, accounting.length, null)) return "unknown";
      return accounting.readUInt32LE(40) === 0 ? "exists_empty" : "exists_active";
    } finally { close(handle); }
  } catch { return "unknown"; }
}
export const nativeRecoveryProbe: RecoveryOsProbe = {
  boot: windowsBootIdentity,
  process: probeProcess,
  job: probeJob,
};

/** Requires an EXACT claim link; orphaned/unlinked records never qualify. */
export function readRecoverySnapshot(sqlite: Database.Database, id: string): RecoverySnapshot | undefined {
  return sqlite.prepare(`select e.id,e.owner_id,e.owner_generation,e.state_version,e.generation,
    e.phase,e.outcome,e.resource_state,e.runner_pid,e.runner_created_at,
    e.runner_boot_id,e.job_identity,e.armed_evidence,e.exit_evidence,
    o.pid as owner_pid,o.process_created_at as owner_created_at,
    o.boot_id as owner_boot_id,c.id as claim_id
    from managed_executions e
    join execution_owners o on o.id=e.owner_id and o.generation=e.owner_generation
    join execution_claims c on c.execution_id=e.id and c.owner_id=e.owner_id
    where e.id=?`).get(id) as RecoverySnapshot | undefined;
}
export function observeRecovery(snapshot: RecoverySnapshot, probe: RecoveryOsProbe = nativeRecoveryProbe): RecoveryObservation {
  const observedAt = new Date().toISOString();
  const base: RecoveryObservation = {
    executionId: snapshot.id, version: snapshot.state_version,
    ownerGeneration: snapshot.owner_generation, observedAt,
    bootId: null, decision: "quarantine", reason: "UNVERIFIED",
  };
  const result = (decision: RecoveryDecision, reason: string,
    extra: Partial<RecoveryObservation> = {}): RecoveryObservation =>
    ({ ...base, decision, reason, ...extra });
  if (snapshot.resource_state === "released") return result("quarantine", "ALREADY_RELEASED");
  if (snapshot.resource_state !== "held" && snapshot.resource_state !== "cleanup_pending" &&
      snapshot.resource_state !== "quarantined") return result("quarantine", "RESOURCE_STATE_INVALID");
  if (!["running", "stopping", "terminal"].includes(snapshot.phase) ||
      snapshot.runner_pid === null || !snapshot.runner_created_at || !snapshot.armed_evidence ||
      !snapshot.job_identity || !nativeName.test(snapshot.job_identity) ||
      snapshot.runner_boot_id !== snapshot.owner_boot_id ||
      !nativeBoot.test(snapshot.owner_boot_id)) {
    return result("quarantine", "MISSING_VERIFIED_JOB_OR_BOOT");
  }
  let currentBoot: string;
  try { currentBoot = probe.boot(); }
  catch { return result("quarantine", "BOOT_QUERY_UNAVAILABLE"); }
  if (!nativeBoot.test(currentBoot)) return result("quarantine", "BOOT_QUERY_UNTRUSTED");
  const bootId = currentBoot;
  if (currentBoot !== snapshot.owner_boot_id) {
    // A timestamp alone may shift under time correction; a loader GUID
    // alone may not identify a boot reliably on every Windows variant.
    // BOTH kernel fields must independently differ to claim a prior boot.
    const [, currentGuid, currentTicks] = currentBoot.split(":");
    const [, priorGuid, priorTicks] = snapshot.owner_boot_id.split(":");
    if (currentGuid === priorGuid || currentTicks === priorTicks) {
      return result("quarantine", "BOOT_COMPONENT_CHANGE_UNPROVEN", { bootId });
    }
    // Windows process trees and named kernel Jobs cannot cross a real boot.
    // A separate reboot test is still required before production enablement.
    return result("candidate", "PRIOR_BOOT_ALL_PROCESSES_GONE",
      { bootId, evidenceKind: "prior_boot_verified" });
  }
  const ownerProbe = probe.process(snapshot.owner_pid, snapshot.owner_created_at);
  if (ownerProbe === "same") return result("active", "OWNER_IDENTITY_STILL_ALIVE", { bootId, ownerProbe });
  if (ownerProbe === "unknown") return result("quarantine", "OWNER_PROCESS_UNVERIFIABLE", { bootId, ownerProbe });
  const runnerProbe = probe.process(snapshot.runner_pid, snapshot.runner_created_at);
  if (runnerProbe === "same") return result("quarantine", "RUNNER_STILL_ALIVE", { bootId, ownerProbe, runnerProbe });
  if (runnerProbe === "unknown") return result("quarantine", "RUNNER_PROCESS_UNVERIFIABLE", { bootId, ownerProbe, runnerProbe });
  const jobProbe = probe.job(snapshot.job_identity);
  if (jobProbe !== "absent") return result("quarantine", "JOB_NOT_PROVEN_ABSENT",
    { bootId, ownerProbe, runnerProbe, jobProbe });
  return result("candidate", "EXACT_OWNER_RUNNER_JOB_GONE",
    { bootId, ownerProbe, runnerProbe, jobProbe, evidenceKind: "job_empty_verified" });
}
