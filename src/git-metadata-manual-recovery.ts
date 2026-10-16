/**
 * TEST-ONLY manual de-quarantine of a disposable Git common directory.
 *
 * This is deliberately not a boot-time, daemon or retry recovery path.
 * The reviewer must supply the exact SHA-256 of the pending marker and
 * an explicit approval after an independent metadata review. The native
 * mutex is acquired before re-inspection; failed evidence never removes
 * a marker or mutates Git metadata.
 */
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, realpathSync, renameSync, statSync, writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import koffi from "koffi";
import { inspectGitMetadataReadonly } from "./git-metadata-recovery-inspection.js";
import { GIT_METADATA_GUARD_FILE, windowsGitMetadataMutexName } from "./windows-git-metadata-mutex.js";

const APPROVAL="I_REVIEWED_THE_GIT_METADATA_AND_APPROVE_THIS_EXACT_MARKER_RELEASE";
const OBJECT_0=0, ABANDONED=0x80, TIMEOUT=0x102;

export interface ManualGitRecoveryApproval {
  testOnly:true;
  reviewer:string;
  ticket:string;
  reason:string;
  exactMarkerSha256:string;
  affirmation:typeof APPROVAL;
}
export interface ManualGitRecoveryReceipt {
  mode:"explicit_human_approval_test_only";
  markerSha256:string;
  auditPath:string;
  markerArchivePath:string;
  approvalId:string;
  metadataEntries:number;
}

function fsyncNewFile(path:string, body:string):void {
  const fd=openSync(path,"wx",0o600);
  try { writeSync(fd,body); fsyncSync(fd); }
  finally {closeSync(fd);}
}
function sha256(buf:Buffer):string {
  return createHash("sha256").update(buf).digest("hex");
}
function verifyTempGitCommonDir(sourceRoot:string):{root:string;commonDir:string} {
  if(process.platform!=="win32")throw new Error("GIT_RECOVERY_WINDOWS_ONLY");
  if(process.env.TASKQUAY_GIT_MANUAL_RECOVERY_FIXTURE!=="1") {
    throw new Error("GIT_RECOVERY_TEST_FIXTURE_ONLY");
  }
  const root=realpathSync(sourceRoot), temp=realpathSync(tmpdir());
  // The existing writer hashes the caller-supplied path. If our recovery
  // called it through a symlink or relative alias, the mutex would differ
  // from that writer's. Refuse aliases rather than pretending exclusivity.
  if(resolve(sourceRoot).toLowerCase()!==root.toLowerCase()) {
    throw new Error("GIT_RECOVERY_NONCANONICAL_SOURCE_ROOT");
  }
  if(root.toLowerCase()===temp.toLowerCase() ||
      !root.toLowerCase().startsWith((temp+sep).toLowerCase()) ||
      !/^(?:taskquay-|tq-)/i.test(root.slice(temp.length+1).split(/[\\/]/)[0])) {
    throw new Error("GIT_RECOVERY_TEMP_REPOSITORY_REQUIRED");
  }
  let dir:string;
  try {
    const raw=execFileSync("git",["-C",root,"rev-parse",
      "--path-format=absolute","--git-common-dir"],{
      encoding:"utf8",timeout:5_000,windowsHide:true,
      env:{...process.env,GIT_OPTIONAL_LOCKS:"0",GIT_NO_LAZY_FETCH:"1"},
      stdio:["ignore","pipe","ignore"],
    }).trim();
    if(!isAbsolute(raw))throw new Error("not_absolute");
    dir=realpathSync(resolve(raw));
  } catch {throw new Error("GIT_RECOVERY_COMMON_DIR_UNVERIFIABLE");}
  if(!dir.toLowerCase().startsWith((root+sep).toLowerCase())) {
    throw new Error("GIT_RECOVERY_COMMON_DIR_MUST_BE_INSIDE_DISPOSABLE_REPOSITORY");
  }
  return {root,commonDir:dir};
}

/** Manual review attestation is NOT Windows operator authentication.
 * Intended only for disposable tests until real operator identities,
 * approvals and system-level audit storage have been independently verified.
 */
export async function releaseTestGitMetadataQuarantine(
  sourceRoot:string, approval:ManualGitRecoveryApproval,
):Promise<ManualGitRecoveryReceipt> {
  if(!approval || approval.testOnly!==true || approval.affirmation!==APPROVAL ||
      !/^[a-f0-9]{64}$/.test(approval.exactMarkerSha256) ||
      !/^[a-zA-Z0-9._@-]{3,100}$/.test(approval.reviewer) ||
      !/^[a-zA-Z0-9._-]{6,120}$/.test(approval.ticket) ||
      typeof approval.reason!=="string" ||
      approval.reason.trim().length<20 || approval.reason.length>500) {
    throw new Error("GIT_RECOVERY_EXPLICIT_APPROVAL_REQUIRED");
  }
  const {root,commonDir}=verifyTempGitCommonDir(sourceRoot);
  // Acquiring the exact live metadata mutex blocks clearing while another
  // same-session Taskquay holder is writing. WAIT_ABANDONED never authorizes
  // recovery; a separate native observation/review is required instead.
  const api=koffi.load("kernel32.dll");
  const create=api.func("CreateMutexW","void *",["void *","int","str16"]);
  const wait=api.func("WaitForSingleObject","uint32",["void *","uint32"]);
  const release=api.func("ReleaseMutex","int",["void *"]);
  const close=api.func("CloseHandle","int",["void *"]);
  const mutex=create(null,0,windowsGitMetadataMutexName(sourceRoot));
  if(!mutex)throw new Error("GIT_RECOVERY_MUTEX_CREATE_FAILED");
  let held=false;
  try {
    const acquired=wait(mutex,0);
    if(acquired===ABANDONED) {
      // WAIT_ABANDONED transfers ownership. Release it without clearing
      // the persistent marker. The next explicit review must start anew.
      if(!release(mutex))throw new Error("GIT_RECOVERY_ABANDONED_RELEASE_FAILED");
      throw new Error("GIT_RECOVERY_ABANDONED_MUTEX_REQUIRES_INDEPENDENT_REVIEW");
    }
    if(acquired===TIMEOUT)throw new Error("GIT_RECOVERY_MUTEX_BUSY");
    if(acquired!==OBJECT_0)throw new Error("GIT_RECOVERY_MUTEX_UNVERIFIABLE");
    held=true;
    const marker=join(commonDir,GIT_METADATA_GUARD_FILE);
    if(!existsSync(marker) || !lstatSync(marker).isFile() || lstatSync(marker).isSymbolicLink()) {
      throw new Error("GIT_RECOVERY_MARKER_INVALID_OR_ABSENT");
    }
    const info=statSync(marker);
    if(info.size<16 || info.size>4096)throw new Error("GIT_RECOVERY_MARKER_UNBOUNDED");
    const bytes=readFileSync(marker);
    const hash=sha256(bytes);
    if(hash!==approval.exactMarkerSha256)throw new Error("GIT_RECOVERY_MARKER_HASH_MISMATCH");
    let entry:unknown;
    try { entry=JSON.parse(bytes.toString("utf8")); }
    catch {throw new Error("GIT_RECOVERY_MARKER_FORMAT_INVALID");}
    if(!entry || typeof entry!=="object" ||
        (entry as {version?:unknown}).version!==1 ||
        !["mutation_pending","abandoned_owner"].includes(
          String((entry as {reason?:unknown}).reason))) {
      throw new Error("GIT_RECOVERY_MARKER_FORMAT_INVALID");
    }
    const review=await inspectGitMetadataReadonly(root);
    if(review.gitCommonDir?.toLowerCase()!==commonDir.toLowerCase() ||
        !review.issues.includes("GIT_METADATA_PENDING_TRANSACTION_NEEDS_REVIEW") ||
        review.issues.some((issue)=>issue!=="GIT_METADATA_PENDING_TRANSACTION_NEEDS_REVIEW")) {
      throw new Error("GIT_RECOVERY_METADATA_INSPECTION_NOT_CLEAN");
    }
    // Recheck while the exact mutex is still held. Never treat a clean
    // inspection as approval; the reviewer/token remain mandatory.
    if(!existsSync(marker) || sha256(readFileSync(marker))!==hash) {
      throw new Error("GIT_RECOVERY_MARKER_CHANGED_DURING_REVIEW");
    }
    const approvalId=randomUUID();
    const auditDir=join(commonDir,"taskquay-manual-recovery-audit");
    if(!existsSync(auditDir))mkdirSync(auditDir,{mode:0o700});
    if(!statSync(auditDir).isDirectory() || lstatSync(auditDir).isSymbolicLink()) {
      throw new Error("GIT_RECOVERY_AUDIT_DIR_UNSAFE");
    }
    const auditPath=join(auditDir,`approval-${approvalId}.json`);
    const markerArchivePath=join(auditDir,`marker-${approvalId}.reviewed`);
    const audit={
      version:1,mode:"explicit_human_approval_test_only",approvalId,
      reviewedAt:new Date().toISOString(),root,commonDir,markerSha256:hash,
      reviewer:approval.reviewer,ticket:approval.ticket,reason:approval.reason,
      archive:markerArchivePath,metadataEntries:review.metadataEntries,
      findings:review.issues,operation:"planned_rename_original_marker",
    };
    // Proof of authorization MUST be created and fsync'd BEFORE any
    // unblocking rename. If this write fails, marker stays in place.
    fsyncNewFile(auditPath,JSON.stringify(audit)+"\n");
    if(sha256(readFileSync(marker))!==hash)throw new Error("GIT_RECOVERY_MARKER_CHANGED_BEFORE_RELEASE");
    // Same-volume rename preserves the quarantined original for review;
    // no prune/repair is invoked. Audit remains if rename fails.
    renameSync(marker,markerArchivePath);
    return {mode:"explicit_human_approval_test_only",markerSha256:hash,
      auditPath,markerArchivePath,approvalId,metadataEntries:review.metadataEntries};
  } finally {
    try {if(held && !release(mutex))throw new Error("GIT_RECOVERY_MUTEX_RELEASE_FAILED");}
    finally {close(mutex);}
  }
}
