import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as z from "zod/v4";
import { resultOutputSchema, textBlock } from "./shared.js";
import { workspaceIdDescription, type ToolRegistrationContext } from "./types.js";

const execFileAsync = promisify(execFile);

/** Shared HP v22 contract: process names/PIDs only, never command arguments. */
export async function listSystemProcesses(filter = "", limit = 80) {
  const windows = process.platform === "win32";
  const { stdout } = await execFileAsync(windows ? "tasklist.exe" : "ps",
    windows ? ["/FO", "CSV", "/NH"] : ["-eo", "pid=,comm="],
    { timeout: 8000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  const all = stdout.split(/\r?\n/).filter(Boolean).map(line => {
    if (windows) {
      const quoted = [...line.matchAll(/"((?:[^"]|"")*)"/g)].map(match => match[1]!.replaceAll('""', '"'));
      return { name: quoted[0] ?? "", pid: Number(quoted[1]) };
    }
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    return { name: match?.[2] ?? "", pid: Number(match?.[1]) };
  });
  const needle = filter.toLowerCase();
  return all.filter(item => Number.isInteger(item.pid) && item.pid > 0 && item.name.toLowerCase().includes(needle))
    .slice(0, Math.min(limit, 200));
}

export function registerTerminalManagementTools({ server, workspaces, processSessions }: ToolRegistrationContext): void {
  server.registerTool("terminal_sessions", {
    title: "Managed terminal sessions",
    description: "List Taskquay-owned terminal sessions for one workspace or terminate one of those sessions. Does not operate on processes from other workspaces. A terminate request initiates termination; poll to verify process exit.",
    inputSchema: {
      workspace_id: z.string().describe(workspaceIdDescription),
      action: z.enum(["list", "terminate"]),
      session_id: z.number().int().positive().optional(),
    },
    outputSchema: resultOutputSchema(),
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, async ({ workspace_id, action, session_id }) => {
    await workspaces.getWorkspace(workspace_id);
    if (action === "terminate") {
      if (session_id === undefined) throw new Error("session_id required for terminate.");
      processSessions.terminate(workspace_id, session_id);
    }
    const result = JSON.stringify({ action, sessions: processSessions.listOwnedSessions(workspace_id) });
    return { content: [textBlock(result)], structuredContent: { result } };
  });
  server.registerTool("system_processes", {
    title: "List operating-system processes",
    description: "Read-only process list (PID and executable name only; no full command line or arguments). For managing a Taskquay command prefer terminal_sessions.",
    inputSchema: { filter: z.string().max(100).optional(), limit: z.number().int().min(1).max(200).optional() },
    outputSchema: resultOutputSchema(),
    annotations: { readOnlyHint: true },
  }, async ({ filter, limit }) => {
    const result = JSON.stringify(await listSystemProcesses(filter, limit));
    return { content: [textBlock(result)], structuredContent: { result } };
  });
}
