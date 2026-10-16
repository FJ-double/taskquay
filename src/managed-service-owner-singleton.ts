import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import koffi from "koffi";

/** Same-Windows-session, exact-state-directory exclusive owner.
 * Does not synchronize across machines or user logon sessions.
 * An abandoned owner mutex requires manual native reconciliation.
 */
export function acquireServiceOwnerSingleton(stateDir: string): () => void {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("SERVICE_OWNER_SINGLETON_WINDOWS_ONLY");
  }
  const canonical = realpathSync(stateDir).toLowerCase().replaceAll("/", "\\");
  const identity = createHash("sha256").update(canonical).digest("hex");
  const api = koffi.load("kernel32.dll");
  const create = api.func("CreateMutexW", "void *", ["void *", "int", "str16"]);
  const wait = api.func("WaitForSingleObject", "uint32", ["void *", "uint32"]);
  const release = api.func("ReleaseMutex", "int", ["void *"]);
  const close = api.func("CloseHandle", "int", ["void *"]);
  const handle = create(null, 0, "Local\\taskquay-service-host-" + identity);
  if (!handle) throw new Error("SERVICE_OWNER_SINGLETON_CREATE_FAILED");
  const result = wait(handle, 0);
  if (result !== 0) {
    if (result === 0x80 && !release(handle)) {
      close(handle);
      throw new Error("SERVICE_OWNER_ABANDONED_RELEASE_FAILED");
    }
    close(handle);
    throw new Error(result === 0x80
      ? "SERVICE_OWNER_ABANDONED_NEEDS_NATIVE_REVIEW"
      : result === 0x102
        ? "SERVICE_OWNER_ALREADY_RUNNING"
        : "SERVICE_OWNER_MUTEX_UNVERIFIABLE");
  }
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    try {
      if (!release(handle)) throw new Error("SERVICE_OWNER_SINGLETON_RELEASE_FAILED");
    } finally { close(handle); }
  };
}
