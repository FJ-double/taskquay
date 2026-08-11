import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";

export const LOCAL_AGENT_DAEMON_PROTOCOL_VERSION = 1;
export const LOCAL_AGENT_DAEMON_SOCKET_NAME = "agentd.sock";
export const LOCAL_AGENT_DAEMON_PID_NAME = "agentd.pid";
export const LOCAL_AGENT_DAEMON_LOCK_NAME = "agentd.lock";
export const LOCAL_AGENT_DAEMON_LOG_NAME = "agentd.log";

export interface LocalAgentDaemonPaths {
  stateDir: string;
  socketPath: string;
  pidPath: string;
  lockPath: string;
  logPath: string;
  endpoint: string;
}

export function localAgentDaemonPaths(
  stateDir: string,
  platform: NodeJS.Platform = process.platform,
): LocalAgentDaemonPaths {
  const resolvedStateDir = resolve(stateDir);
  const socketPath = join(resolvedStateDir, LOCAL_AGENT_DAEMON_SOCKET_NAME);
  return {
    stateDir: resolvedStateDir,
    socketPath,
    pidPath: join(resolvedStateDir, LOCAL_AGENT_DAEMON_PID_NAME),
    lockPath: join(resolvedStateDir, LOCAL_AGENT_DAEMON_LOCK_NAME),
    logPath: join(resolvedStateDir, LOCAL_AGENT_DAEMON_LOG_NAME),
    endpoint: platform === "win32"
      ? `\\\\.\\pipe\\devspace-agentd-${hashStateDir(resolvedStateDir)}`
      : socketPath,
  };
}

export function ensureLocalAgentDaemonStateDir(stateDir: string): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
}

export class LocalAgentDaemonAlreadyRunningError extends Error {
  readonly code = "DAEMON_ALREADY_RUNNING" as const;

  constructor(readonly pid?: number) {
    super(pid ? `Local agent daemon is already running (pid ${pid}).` : "Local agent daemon is already running.");
    this.name = "LocalAgentDaemonAlreadyRunningError";
  }
}

export class LocalAgentDaemonLock {
  private fileDescriptor?: number;

  constructor(readonly paths: LocalAgentDaemonPaths) {}

  acquire(): void {
    ensureLocalAgentDaemonStateDir(this.paths.stateDir);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fileDescriptor = openSync(this.paths.lockPath, "wx", 0o600);
        writeSync(fileDescriptor, `${process.pid}\n`);
        chmodSync(this.paths.lockPath, 0o600);
        writeFileSecure(this.paths.pidPath, `${process.pid}\n`);
        this.fileDescriptor = fileDescriptor;
        return;
      } catch (error) {
        if (!isFileExistsError(error)) throw error;
        const pid = readDaemonPid(this.paths.pidPath);
        if (pid !== undefined && isProcessAlive(pid)) {
          throw new LocalAgentDaemonAlreadyRunningError(pid);
        }
        rmSync(this.paths.lockPath, { force: true });
      }
    }
    throw new LocalAgentDaemonAlreadyRunningError(readDaemonPid(this.paths.pidPath));
  }

  release(): void {
    if (this.fileDescriptor === undefined) return;
    closeSync(this.fileDescriptor);
    this.fileDescriptor = undefined;
    rmSync(this.paths.pidPath, { force: true });
    rmSync(this.paths.lockPath, { force: true });
  }
}

export function writeLocalAgentDaemonPid(paths: LocalAgentDaemonPaths): void {
  writeFileSecure(paths.pidPath, `${process.pid}\n`);
}

export function removeLocalAgentDaemonFiles(paths: LocalAgentDaemonPaths): void {
  rmSync(paths.pidPath, { force: true });
  if (process.platform !== "win32") rmSync(paths.socketPath, { force: true });
}

export function readDaemonPid(pidPath: string): number | undefined {
  try {
    const value = readFileSync(pidPath, "utf8").trim();
    if (!/^\d+$/.test(value)) return undefined;
    const pid = Number(value);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function writeFileSecure(path: string, content: string): void {
  const fileDescriptor = openSync(path, "w", 0o600);
  try {
    writeSync(fileDescriptor, content);
    chmodSync(path, 0o600);
  } finally {
    closeSync(fileDescriptor);
  }
}

function isFileExistsError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

function hashStateDir(stateDir: string): string {
  return createHash("sha256").update(stateDir).digest("hex").slice(0, 24);
}
