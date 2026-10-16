import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, fsyncSync, openSync, realpathSync, statSync, unlinkSync, writeSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import koffi from "koffi";

const OBJECT_0 = 0;
const ABANDONED = 0x80;
const TIMEOUT = 0x102;
export const GIT_METADATA_GUARD_FILE = "taskquay-metadata-operation.pending";

/** The manual-review gate MUST acquire the identical OS mutex name.
 * Do not canonicalize only one caller: the older writer contract hashes
 * its caller-supplied root, so both paths must use exactly this function.
 */
export function windowsGitMetadataMutexName(sourceRoot:string):string {
  const digest=createHash("sha256")
    .update(sourceRoot.toLowerCase().replaceAll("/", "\\")).digest("hex");
  return `Local\\taskquay-git-metadata-${digest}`;
}

/** Shared with all Taskquay daemons referencing the same Git common dir.
 * Crashes leave a persistent marker that a later mutex acquisition
 * must NOT quietly clear. A manual review/repair has no automatic API.
 */
function guardFileForRepo(sourceRoot:string):string|null {
  if (!existsSync(sourceRoot)) return null; // Native mutex-only test fixtures
  if(!statSync(sourceRoot).isDirectory())throw new Error("GIT_METADATA_REPO_NOT_DIRECTORY");
  let value:string;
  try{
    value=execFileSync("git",["-C",sourceRoot,
      "rev-parse","--path-format=absolute","--git-common-dir"],{
      encoding:"utf8",timeout:5_000,windowsHide:true,
      env:{...process.env,GIT_OPTIONAL_LOCKS:"0"},
      stdio:["ignore","pipe","ignore"],
    }).trim();
  }catch{throw new Error("GIT_METADATA_COMMON_DIR_UNVERIFIABLE");}
  if(!value||!isAbsolute(value))throw new Error("GIT_METADATA_COMMON_DIR_INVALID");
  return join(realpathSync(resolve(value)),GIT_METADATA_GUARD_FILE);
}
function recordPendingGuard(path:string,reason:"mutation_pending"|"abandoned_owner"):void {
  const fd=openSync(path,"wx",0o600);
  try{
    const payload=JSON.stringify({version:1,reason,createdAt:new Date().toISOString(),
      processId:process.pid,notice:"review_only_no_automatic_clear"})+"\n";
    writeSync(fd,payload);
    fsyncSync(fd);
  }finally{closeSync(fd);}
}

/**
 * Cross-daemon, same-Windows-session metadata serialization. Independent
 * worktrees run concurrently AFTER git worktree add completes; only shared
 * .git/worktrees metadata mutation needs this mutex. No PID/TTL lock theft.
 *
 * A crashed mutex owner is not proof that Git metadata is consistent:
 * WAIT_ABANDONED fails closed and requires separate inspection, not prune.
 * This is not an inter-machine lock or cross-Windows-session guarantee.
 */
export async function withWindowsGitMetadataMutex<T>(
  sourceRoot: string, action: () => Promise<T>, waitMs = 20_000,
): Promise<T> {
  if (process.platform !== "win32") return action();
  if (!Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > 120_000) {
    throw new Error("GIT_METADATA_MUTEX_BUDGET_INVALID");
  }
  const name = windowsGitMetadataMutexName(sourceRoot);
  const api = koffi.load("kernel32.dll");
  const create = api.func("CreateMutexW", "void *", ["void *", "int", "str16"]);
  const wait = api.func("WaitForSingleObject", "uint32", ["void *", "uint32"]);
  const release = api.func("ReleaseMutex", "int", ["void *"]);
  const close = api.func("CloseHandle", "int", ["void *"]);
  const handle = create(null, 0, name);
  if (!handle) throw new Error("GIT_METADATA_MUTEX_CREATE_FAILED");
  let held = false;
  try {
    const until = Date.now() + waitMs;
    do {
      const result = wait(handle, 0);
      if (result === OBJECT_0) {
        held = true;
        const guard=guardFileForRepo(sourceRoot);
        if(guard){
          if(existsSync(guard))throw new Error("GIT_METADATA_PENDING_TRANSACTION_REQUIRES_REVIEW");
          recordPendingGuard(guard,"mutation_pending");
        }
        // A failed action may have partially created Git metadata.
        // Preserve the marker for manual review, even if git itself
        // returned a normal nonzero exit status.
        const value=await action();
        if(guard)unlinkSync(guard);
        return value;
      }
      if (result === ABANDONED) {
        // Prior holder died. Persist quarantine before releasing our
        // new (abandoned) ownership; a SECOND retry must also fail.
        try {
          const guard=guardFileForRepo(sourceRoot);
          if(guard && !existsSync(guard))recordPendingGuard(guard,"abandoned_owner");
        }catch{
          // Always reject even when filesystem/permission proof fails.
          // Production reconciliation must independently check all
          // Git metadata and disallow automatic retry.
        }
        // WAIT_ABANDONED implicitly transfers ownership. Release this
        // abandoned mutex but never perform a metadata mutation.
        if (!release(handle)) throw new Error("GIT_METADATA_MUTEX_ABANDONED_RELEASE_FAILED");
        throw new Error("GIT_METADATA_MUTEX_ABANDONED_REQUIRES_RECONCILIATION");
      }
      if (result !== TIMEOUT) throw new Error(`GIT_METADATA_MUTEX_WAIT_FAILED_${result}`);
      await delay(35);
    } while (Date.now() < until);
    throw new Error("GIT_METADATA_MUTEX_WAIT_TIMEOUT");
  } finally {
    try {
      if (held && !release(handle)) throw new Error("GIT_METADATA_MUTEX_RELEASE_FAILED");
    } finally {
      close(handle);
    }
  }
}
