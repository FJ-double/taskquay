import type Database from "better-sqlite3";
import {
  nativeRecoveryProbe, type RecoveryOsProbe,
  type ProcessProbe, type JobProbe,
} from "./windows-recovery-observer.js";

type ServiceRecord = {
  service_id: string; service_key: string; state: string;
  owner_id: string; owner_generation: string; execution_id: string;
  pid: number | null; created_at: string | null; boot_id: string | null;
  registered_generation: string | null;
  runner_pid: number | null; runner_created_at: string | null;
  runner_boot_id: string | null; job_identity: string | null;
  phase: string | null; resource_state: string | null;
  journal_outcome: string | null; journal_sequence: number | null;
};
export type ServiceRecoveryView = {
  serviceId: string; serviceKey: string; state: string;
  ownerId: string; ownerGeneration: string;
  executionId: string; lastHealth: string | null;
  lastHealthSequence: number | null; observedAt: string;
  decision: "active" | "released" | "quarantine" | "orphan_review";
  reason: string; ownerProbe?: ProcessProbe; runnerProbe?: ProcessProbe;
  jobProbe?: JobProbe;
};
const validJob = /^Local\\taskquay-job-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** Default read-only: a stopped supervisor may have held live services,
 * finished cleanup before crash, or left uncommitted evidence. No automatic
 * port release, service restart, old Job adoption, or daemon resurrection.
 */
export function inspectServiceRecovery(db: Database.Database, id: string,
  probe: RecoveryOsProbe = nativeRecoveryProbe): ServiceRecoveryView | undefined {
  const row = db.prepare(`select s.service_id,s.service_key,s.state,s.owner_id,
    s.owner_generation,s.execution_id,o.pid,o.process_created_at created_at,
    o.boot_id,o.generation registered_generation,
    m.runner_pid,m.runner_created_at,m.runner_boot_id,m.job_identity,
    m.phase,m.resource_state,
    (select h.outcome from managed_service_health_journal h
      where h.service_id=s.service_id order by h.sequence desc limit 1) journal_outcome,
    (select h.sequence from managed_service_health_journal h
      where h.service_id=s.service_id order by h.sequence desc limit 1) journal_sequence
    from managed_service_reservations s
    left join execution_owners o on o.id=s.owner_id and o.generation=s.owner_generation
    left join managed_executions m on m.id=s.execution_id and
      m.owner_id=s.owner_id and m.owner_generation=s.owner_generation
    where s.service_id=?`).get(id) as ServiceRecord | undefined;
  if (!row) return undefined;
  const base = {
    serviceId: row.service_id, serviceKey: row.service_key, state: row.state,
    ownerId: row.owner_id, ownerGeneration: row.owner_generation,
    executionId: row.execution_id, lastHealth: row.journal_outcome,
    lastHealthSequence: row.journal_sequence,
    observedAt: new Date().toISOString(),
  };
  const result = (decision: ServiceRecoveryView["decision"], reason: string,
    extra: Partial<ServiceRecoveryView> = {}): ServiceRecoveryView =>
    ({...base,decision,reason,...extra});
  if (row.state === "released") return result("released","SERVICE_ALREADY_RELEASED");
  if (row.registered_generation !== row.owner_generation || !row.created_at ||
      !row.boot_id || !Number.isSafeInteger(row.pid) || (row.pid ?? 0) <= 0 ||
      !row.phase || !row.resource_state) {
    return result("quarantine","SERVICE_OWNER_OR_EXECUTION_IDENTITY_MISSING");
  }
  let boot: string;
  try {boot=probe.boot();}
  catch{return result("quarantine","SERVICE_BOOT_PROBE_FAILED");}
  if (boot!==row.boot_id || (row.runner_boot_id && boot!==row.runner_boot_id)) {
    return result("quarantine","SERVICE_PRIOR_BOOT_UNVERIFIED");
  }
  const ownerProbe=probe.process(row.pid!,row.created_at);
  if (!row.runner_pid || !row.runner_created_at ||
      !row.job_identity || !validJob.test(row.job_identity)) {
    return result("quarantine","SERVICE_RUNNER_PROOF_MISSING",{ownerProbe});
  }
  const runnerProbe=probe.process(row.runner_pid,row.runner_created_at);
  const jobProbe=probe.job(row.job_identity);
  const info={ownerProbe,runnerProbe,jobProbe};
  if (ownerProbe==="same"&&runnerProbe==="same"&&jobProbe==="exists_active" &&
      row.phase==="running" && row.state==="running") {
    return result("active","EXACT_OWNER_AND_SERVICE_JOB_ALIVE",info);
  }
  if (ownerProbe==="absent_or_reused"&&runnerProbe==="absent_or_reused"&&
      jobProbe==="absent") {
    return result("orphan_review","OWNER_AND_JOB_GONE_REQUIRES_EXPLICIT_RECONCILIATION",info);
  }
  return result("quarantine","SERVICE_JOB_OR_PROCESS_IDENTITY_AMBIGUOUS",info);
}

export function scanServiceRecovery(db: Database.Database,
  options: {afterServiceId?: string; limit?: number}={},
  probe: RecoveryOsProbe = nativeRecoveryProbe) {
  const limit=options.limit??25, cursor=options.afterServiceId??"";
  if(!Number.isSafeInteger(limit)||limit<1||limit>100||
     (cursor!==""&&!/^svc_[a-f0-9]{32}$/.test(cursor))) {
    throw new Error("SERVICE_RECOVERY_SCAN_BOUND_INVALID");
  }
  const records=db.prepare(`select service_id from managed_service_reservations
    where service_id>? and state!='released'
    order by service_id limit ?`).all(cursor,limit+1) as {service_id:string}[];
  const page=records.slice(0,limit);
  return {
    mode:"observe_only" as const,
    entries:page.map(({service_id})=>inspectServiceRecovery(db,service_id,probe)!),
    nextCursor:records.length>limit?page.at(-1)?.service_id:undefined,
  };
}
