import type Database from "better-sqlite3";
import { inspectManagedRecovery } from "./windows-recovery-transaction.js";
import { nativeRecoveryProbe, type RecoveryOsProbe } from "./windows-recovery-observer.js";
import { failInterruptedCommand } from "./work-ledger.js";

export const commandClaimIdPattern = /^claim_[a-f0-9]{32}$/;

interface CommandClaim {
  id: string; checkout_root: string; owner_id: string; owner_pid: number;
  acquired_at: string; execution_id: string | null;
}
interface Operation { id: string; run_id: string; created_at: string }
interface RecoveryItem {
  claimId: string;
  status: "active" | "candidate" | "quarantined" | "released" | "not_found";
  reason?: string;
}
interface RecoveryRequest {
  action: "inspect" | "recover";
  root?: string;
  claimId?: string;
  legacyOnly?: boolean;
  afterClaimId?: string;
}

function bootTime(probe: RecoveryOsProbe): number | undefined {
  try {
    const ticks = /^win-ntboot-v1:[a-f0-9-]{36}:([a-f0-9]{16})$/i.exec(probe.boot())?.[1];
    if (!ticks) return undefined;
    const time = Number((BigInt("0x" + ticks) - 116444736000000000n) / 10_000n);
    if (time >= Date.UTC(2010, 0, 1) && time + 5_000 < Date.now()) return time;
  } catch { /* OS evidence is unavailable. */ }
}

function matchingOperations(sqlite: Database.Database, root: string): Operation[] {
  return sqlite.prepare(`select o.id,o.run_id,o.created_at from console_operations o
    join console_work_runs r on r.id=o.run_id join console_projects p on p.id=r.project_id
    where p.root=? and o.kind='command' and o.status in ('starting','queued','running')
    limit 2`).all(root) as Operation[];
}

function recoverLegacy(sqlite: Database.Database, claim: CommandClaim, boot: number | undefined,
  apply: boolean, probe: RecoveryOsProbe): RecoveryItem {
  const item = { claimId: claim.id };
  if (claim.owner_pid === process.pid) return { ...item, status: "active", reason: "OWNER_PID_CURRENT" };
  const acquired = Date.parse(claim.acquired_at);
  if (!boot || !Number.isFinite(acquired) || acquired < Date.UTC(2010, 0, 1) || acquired >= boot - 5_000) {
    return { ...item, status: "quarantined", reason: "LEGACY_REQUIRES_VERIFIED_REBOOT" };
  }
  const pid = probe.legacyOwner?.(claim.owner_pid);
  if (pid !== "absent_or_reused") {
    return { ...item, status: "quarantined", reason: pid === "same" ? "LEGACY_PID_IN_USE" : "LEGACY_OWNER_UNVERIFIED" };
  }
  // Legacy admission committed an exclusive checkout claim before creating the
  // operation. Accept only a single active command consistent with that order.
  // Zero operations also covers a command without a work run or a terminal receipt.
  const decide = (): RecoveryItem => {
    const operations = matchingOperations(sqlite, claim.checkout_root);
    const operation = operations[0];
    const created = operation ? Date.parse(operation.created_at) : acquired;
    if (operations.length > 1 || !Number.isFinite(created) || created < acquired || created >= boot - 5_000) {
      return { ...item, status: "quarantined", reason: "LEGACY_OPERATION_LINK_AMBIGUOUS" };
    }
    if (!apply) return { ...item, status: "candidate", reason: "LEGACY_PREVIOUS_BOOT_VERIFIED" };
    const removed = sqlite.prepare(`delete from execution_claims where id=? and checkout_root=?
      and owner_id=? and owner_pid=? and acquired_at=? and kind='command' and execution_id is null`)
      .run(claim.id, claim.checkout_root, claim.owner_id, claim.owner_pid, claim.acquired_at);
    if (removed.changes !== 1) return { ...item, status: "not_found" };
    const verifiedAt = new Date().toISOString();
    const evidence = { claimId: claim.id, outcome: "interrupted", verifiedAt,
      recoveryReason: "LEGACY_PREVIOUS_BOOT_VERIFIED", bootTime: new Date(boot).toISOString() };
    if (operation) failInterruptedCommand(sqlite, operation.id, operation.run_id, verifiedAt, evidence);
    sqlite.prepare(`insert into command_claim_recoveries
      (claim_id,checkout_root,operation_id,evidence,recovered_at) values (?,?,?,?,?)`)
      .run(claim.id, claim.checkout_root, operation?.id ?? null, JSON.stringify(evidence), verifiedAt);
    return { ...item, status: "released", reason: evidence.recoveryReason };
  };
  return apply ? sqlite.transaction(decide).immediate() : decide();
}

/** Recovery never tries to acquire the occupied workspace. Both the existing
 * managed proof transaction and the legacy compatibility path fail closed. */
export function recoverCommandClaims(sqlite: Database.Database, request: RecoveryRequest,
  probe: RecoveryOsProbe = nativeRecoveryProbe) {
  if (request.action === "recover" && probe !== nativeRecoveryProbe && !process.env.NODE_TEST_CONTEXT) {
    throw new Error("RECOVERY_SYNTHETIC_OS_PROBE_FORBIDDEN_OUTSIDE_TESTS");
  }
  const clauses = ["kind='command'"];
  const values: string[] = [];
  if (request.root !== undefined) { clauses.push("checkout_root=?"); values.push(request.root); }
  if (request.claimId !== undefined) { clauses.push("id=?"); values.push(request.claimId); }
  if (request.legacyOnly) clauses.push("execution_id is null");
  if (request.afterClaimId) { clauses.push("id>?"); values.push(request.afterClaimId); }
  const claims = sqlite.prepare(`select id,checkout_root,owner_id,owner_pid,acquired_at,execution_id
    from execution_claims where ${clauses.join(" and ")} order by id limit 26`).all(...values) as CommandClaim[];
  const page = claims.slice(0, 25);
  const boot = page.some((claim) => !claim.execution_id) ? bootTime(probe) : undefined;
  const items: RecoveryItem[] = page.map((claim) => {
    try {
      const apply = request.action === "recover";
      if (!claim.execution_id) return recoverLegacy(sqlite, claim, boot, apply, probe);
      const result = inspectManagedRecovery(sqlite, claim.execution_id, { apply, expectedCommandClaimId: claim.id }, probe);
      return { claimId: claim.id, status: result.status, reason: result.observation?.reason };
    } catch {
      return { claimId: claim.id, status: "quarantined", reason: "RECOVERY_STATE_CHANGED_OR_UNVERIFIED" };
    }
  });
  if (request.claimId && items.length === 0) {
    const recovered = request.root !== undefined && sqlite.prepare(
      "select 1 from command_claim_recoveries where claim_id=? and checkout_root=?")
      .get(request.claimId, request.root);
    items.push({ claimId: request.claimId, status: recovered ? "released" : "not_found" });
  }
  return { items, nextCursor: claims.length > page.length ? page.at(-1)?.id : undefined };
}
