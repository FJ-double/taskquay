import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { win32 } from "node:path";

export interface ShellCommand { executable: string; args: string[] }
/** Resolve PowerShell 7 once per environment; Windows PowerShell 5 is not pwsh. */
const shells = new Map<string, string>();
export function resolveShellCommand(command: string, _platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env, jobSafe = false): ShellCommand {
  const path = Object.entries(environment).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
  const key = `${jobSafe ? "job" : "shell"}|${path}|${environment.ProgramFiles ?? ""}|${environment.ComSpec ?? environment.COMSPEC ?? ""}`;
  let executable = shells.get(key);
  if (!executable) {
    const lookup = spawnSync("where.exe", ["pwsh.exe"], { env: environment, encoding: "utf8", windowsHide: true, timeout: 3000 });
    const standard = win32.join(environment.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", "pwsh.exe");
    const candidates = [...(existsSync(standard) ? [standard] : []), ...(lookup.status === 0 ? lookup.stdout.trim().split(/\r?\n/).filter(Boolean) : [])];
    // Store-installed PowerShell execution aliases can be runnable while existsSync is false.
    let found = candidates.find(candidate => {
      const probe = spawnSync(candidate, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"],
        { env: environment, encoding: "utf8", windowsHide: true, timeout: 5000 });
      return probe.status === 0 && Number(probe.stdout.trim()) >= 7;
    });
    // Store App Execution Aliases launch another process outside a Job. Use a
    // real pwsh.exe, or CMD, when Windows must enforce Job-tree termination.
    if (jobSafe && found && /[\\/]Microsoft[\\/]WindowsApps[\\/]pwsh\.exe$/i.test(found)) found = undefined;
    executable = found ?? environment.ComSpec ?? environment.COMSPEC ?? "cmd.exe";
    shells.set(key, executable);
  }
  const powershell = /(?:^|[\\/])pwsh(?:\.exe)?$/i.test(executable);
  return { executable, args: powershell ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command] : ["/d", "/s", "/c", command] };
}
/** The Windows command manager uses Job-backed pipes, including requests with tty=true. */
export function executionContract(_tty = false, jobSafe = process.platform === "win32") {
  return { platform: process.platform, shell: resolveShellCommand("", process.platform, process.env, jobSafe).executable,
    transport: "pipe" as const, ptyCapability: "pipe_fallback" as const };
}
export type ExecutionContract = ReturnType<typeof executionContract>;
export interface KillableProcess { pid?: number; exitCode?: number | null; signalCode?: NodeJS.Signals | string | null; kill(signal?: NodeJS.Signals): boolean }
interface ProcessTreeRuntime { platform: NodeJS.Platform; killGroup(pid: number, signal: NodeJS.Signals): void; killWindowsTree(pid: number): boolean }
export function terminateProcessTree(child: KillableProcess, signal: NodeJS.Signals, _detached: boolean, runtime?: ProcessTreeRuntime): void {
  if (child.pid && (child.exitCode ?? null) === null && (child.signalCode ?? null) === null) {
    const killed = runtime ? runtime.killWindowsTree(child.pid) : spawnSync("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).status === 0;
    if (killed) return;
  }
  child.kill(signal);
}
