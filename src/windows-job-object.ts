import koffi from "koffi";
import { randomUUID } from "node:crypto";

/**
 * Windows x64 Job Object wrapper. No PID-tree fallbacks: a failed assignment
 * or identity check is a failed launch, not permission to run unmanaged work.
 *
 * Extended limit layout (x64): JOBOBJECT_BASIC_LIMIT_INFORMATION = 64 bytes,
 * IO_COUNTERS = 48 bytes, four SIZE_T values = 32 bytes. LimitFlags @ 16.
 * Basic accounting layout: ActiveProcesses DWORD @ 40 of 48 bytes.
 * Never retain a second observation handle: closing the last Job handle
 * triggers KILL_ON_JOB_CLOSE.
 */
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
const JobObjectExtendedLimitInformation = 9;
const JobObjectBasicAccountingInformation = 1;
const PROCESS_TERMINATE = 0x0001;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

type Pointer = unknown;

/** Job Objects are used only where the struct layout below is verified. */
export function windowsJobObjectsSupported(): boolean {
  return process.platform === "win32" && process.arch === "x64";
}

function win32() {
  if (!windowsJobObjectsSupported()) {
    throw new Error("WINDOWS_JOB_UNSUPPORTED: only win32 x64 has a verified layout.");
  }
  const kernel32 = koffi.load("kernel32.dll");
  return {
    create: kernel32.func("CreateJobObjectW", "void *", ["void *", "str16"]),
    setInfo: kernel32.func("SetInformationJobObject", "int", ["void *", "int", "void *", "uint32"]),
    openProcess: kernel32.func("OpenProcess", "void *", ["uint32", "int", "uint32"]),
    assign: kernel32.func("AssignProcessToJobObject", "int", ["void *", "void *"]),
    inJob: kernel32.func("IsProcessInJob", "int", ["void *", "void *", "void *"]),
    processTimes: kernel32.func("GetProcessTimes", "int", ["void *", "void *", "void *", "void *", "void *"]),
    query: kernel32.func("QueryInformationJobObject", "int", ["void *", "int", "void *", "uint32", "void *"]),
    terminate: kernel32.func("TerminateJobObject", "int", ["void *", "uint32"]),
    close: kernel32.func("CloseHandle", "int", ["void *"]),
    error: kernel32.func("GetLastError", "uint32", []),
  };
}

function fail(op: string, error: () => number): never {
  throw new Error(`WINDOWS_JOB_${op}_FAILED: GetLastError=${error()}`);
}

/** Actual kernel creation timestamp; PID alone may be reused across boots. */
export function windowsProcessCreatedAt(pid: number): string {
  const api = win32();
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("WINDOWS_JOB_INVALID_PID");
  const proc = api.openProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) as Pointer;
  if (!proc) fail("OPEN_PROCESS", api.error);
  try {
    const created = Buffer.alloc(8), exited = Buffer.alloc(8),
      kernel = Buffer.alloc(8), user = Buffer.alloc(8);
    if (!api.processTimes(proc, created, exited, kernel, user)) fail("PROCESS_TIMES", api.error);
    const ticks = created.readBigUInt64LE(0);
    const unixMs = Number((ticks - 116444736000000000n) / 10000n);
    if (!Number.isSafeInteger(unixMs) || unixMs <= 0) throw new Error("WINDOWS_JOB_PROCESS_IDENTITY_UNKNOWN");
    return new Date(unixMs).toISOString();
  } finally {
    api.close(proc);
  }
}

/** Windows can retain an exited Process object while another observer still
 * holds its handle. GetProcessTimes creation-time matching is NOT evidence
 * that a process is alive: the exit FILETIME must also be checked.
 */
export function windowsProcessIdentityStatus(pid: number, expectedCreatedAt: string):
  "same" | "absent_or_reused" {
  const api = win32();
  if (!Number.isSafeInteger(pid) || pid < 1 || !expectedCreatedAt) {
    throw new Error("WINDOWS_JOB_PROCESS_IDENTITY_UNKNOWN");
  }
  const proc = api.openProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) as Pointer;
  if (!proc) fail("OPEN_PROCESS", api.error);
  try {
    const created = Buffer.alloc(8), exited = Buffer.alloc(8),
      kernel = Buffer.alloc(8), user = Buffer.alloc(8);
    if (!api.processTimes(proc, created, exited, kernel, user)) fail("PROCESS_TIMES", api.error);
    const ticks = created.readBigUInt64LE(0);
    const unixMs = Number((ticks - 116444736000000000n) / 10000n);
    if (!Number.isSafeInteger(unixMs) || unixMs <= 0) {
      throw new Error("WINDOWS_JOB_PROCESS_IDENTITY_UNKNOWN");
    }
    // Any nonzero ExitTime proves the old process completed, even if its
    // object remains queryable because a monitoring parent holds a handle.
    if (exited.readBigUInt64LE(0) !== 0n) return "absent_or_reused";
    return new Date(unixMs).toISOString() === expectedCreatedAt ? "same" : "absent_or_reused";
  } finally { api.close(proc); }
}

export class WindowsJobObject {
  private readonly api = win32();
  private handle: Pointer;
  private closed = false;
  /** Actual Windows kernel object name, not a synthetic diagnostic label. */
  readonly name: string;

  constructor() {
    this.name = `Local\\taskquay-job-${randomUUID()}`;
    this.handle = this.api.create(null, this.name) as Pointer;
    if (!this.handle) fail("CREATE", this.api.error);
    const creationError = this.api.error();
    if (creationError === 183) { // ERROR_ALREADY_EXISTS: never adopt someone else's Job
      this.close();
      throw new Error("WINDOWS_JOB_NAME_COLLISION");
    }
    try {
      const limits = Buffer.alloc(144);
      limits.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, 16);
      if (!this.api.setInfo(this.handle, JobObjectExtendedLimitInformation, limits, limits.length)) {
        fail("SET_LIMITS", this.api.error);
      }
    } catch (error) {
      this.close();
      throw error;
    }
  }

  assignVerified(pid: number): string {
    if (this.closed) throw new Error("WINDOWS_JOB_CLOSED");
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("WINDOWS_JOB_INVALID_PID");
    const proc = this.api.openProcess(
      PROCESS_TERMINATE | PROCESS_SET_QUOTA | PROCESS_QUERY_LIMITED_INFORMATION,
      0, pid,
    ) as Pointer;
    if (!proc) fail("OPEN_PROCESS", this.api.error);
    try {
      const created = Buffer.alloc(8), exited = Buffer.alloc(8),
        kernel = Buffer.alloc(8), user = Buffer.alloc(8);
      if (!this.api.processTimes(proc, created, exited, kernel, user)) fail("PROCESS_TIMES", this.api.error);
      const ticks = created.readBigUInt64LE(0);
      const unixMs = Number((ticks - 116444736000000000n) / 10000n);
      if (!Number.isSafeInteger(unixMs) || unixMs <= 0) throw new Error("WINDOWS_JOB_PROCESS_IDENTITY_UNKNOWN");
      if (!this.api.assign(this.handle, proc)) fail("ASSIGN", this.api.error);
      const membership = Buffer.alloc(4);
      if (!this.api.inJob(proc, this.handle, membership)) fail("VERIFY", this.api.error);
      if (membership.readUInt32LE(0) !== 1) throw new Error("WINDOWS_JOB_MEMBERSHIP_NOT_CONFIRMED");
      return new Date(unixMs).toISOString();
    } finally {
      this.api.close(proc);
    }
  }

  activeProcesses(): number {
    if (this.closed) throw new Error("WINDOWS_JOB_CLOSED");
    const info = Buffer.alloc(48);
    if (!this.api.query(this.handle, JobObjectBasicAccountingInformation, info, info.length, null)) {
      fail("QUERY", this.api.error);
    }
    return info.readUInt32LE(40);
  }

  terminate(exitCode = 1): void {
    if (this.closed) throw new Error("WINDOWS_JOB_CLOSED");
    if (!this.api.terminate(this.handle, exitCode >>> 0)) fail("TERMINATE", this.api.error);
  }

  close(): void {
    if (this.closed) return;
    const handle = this.handle;
    // Retain the handle on a failed CloseHandle call. A caller must not
    // mistake an unclosed KILL_ON_JOB_CLOSE Job for native cleanup proof,
    // and should still be able to retry closing the same handle.
    if (handle && !this.api.close(handle)) fail("CLOSE", this.api.error);
    this.handle = null;
    this.closed = true;
  }
}
