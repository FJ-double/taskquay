import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { discoverHostAgents } from "./host-agents.js";
import { captureAgentProviderResult } from "./local-agent-errors.js";
import type { LocalAgentDriver, LocalAgentRunInput, LocalAgentRuntime, LocalAgentRuntimeContext } from "./local-agent-runtime.js";

/** Claude's MCP server exposes tools, not a constrained model turn. Run the user's CLI directly. */
export function claudePrintArgs(input: LocalAgentRunInput): string[] {
  const readOnly = input.writeMode === "read_only";
  const args = [
    "--print", "--output-format", "json", "--restricted",
    "--strict-mcp-config", "--permission-prompts", "none",
    "--permission-mode", readOnly ? "plan" : "acceptEdits",
    "--tools", readOnly ? "Read,Glob,Grep" : "Read,Glob,Grep,Edit,Write",
  ];
  if (input.providerSessionId) args.push("--resume", input.providerSessionId);
  if (input.model) args.push("--model", input.model);
  if (input.effort) args.push("--effort", input.effort);
  if (input.profileInstructions) args.push("--append-system-prompt", input.profileInstructions);
  args.push("--", input.prompt);
  return args;
}

export function claudePrintResult(output: string): { response: string; sessionId: string | null } {
  const value = JSON.parse(output) as Record<string, unknown>;
  if (value.is_error === true || value.subtype === "error") {
    throw new Error(typeof value.result === "string" ? value.result : "Claude CLI task failed.");
  }
  if (value.type !== "result" || typeof value.result !== "string") throw new Error("Claude CLI returned an unexpected response.");
  return { response: value.result, sessionId: typeof value.session_id === "string" ? value.session_id : null };
}

export class ClaudeCliDriver implements LocalAgentDriver {
  readonly provider = "claude" as const;
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}
  runtimeKey(context: LocalAgentRuntimeContext): string { return `claude:cli:${context.workspaceRoot}`; }
  createRuntime(context: LocalAgentRuntimeContext) {
    return captureAgentProviderResult({ provider: this.provider, operation: "create_runtime", run: async (): Promise<LocalAgentRuntime> => {
      const executable = discoverHostAgents(this.env).find(agent => agent.id === "claude");
      if (!executable?.installed || !executable.command) throw new Error("Claude Code CLI is not installed.");
      let alive = true;
      let active: ReturnType<typeof spawn> | undefined;
      const modes = new Map<string, string>();
      return {
        provider: this.provider, isAlive: () => alive,
        releaseSession: async () => undefined,
        close: async () => { alive = false; active?.kill(); },
        run: (input, callbacks) => captureAgentProviderResult({ provider: this.provider, operation: "run", run: async () => {
          const mode = input.writeMode ?? "allowed";
          if (input.providerSessionId && modes.get(input.providerSessionId) !== mode) {
            callbacks?.onNotRequested?.();
            throw new Error("Cannot resume Claude CLI with a changed or unknown permission mode.");
          }
          await callbacks?.onRequest?.();
          const command = spawn(executable.command!, claudePrintArgs(input), {
            cwd: context.workspaceRoot, env: this.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
          });
          active = command;
          await callbacks?.onTurnStarted?.(randomUUID());
          let stdout = "";
          let stderr = "";
          try {
            const code = await new Promise<number>((resolve, reject) => {
              command.once("error", reject);
              command.stdout.on("data", (chunk: Buffer) => {
                stdout += chunk.toString();
                if (stdout.length > 8_000_000) { command.kill(); reject(new Error("Claude CLI output exceeded the response limit.")); }
              });
              command.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-1500); });
              command.once("close", (exitCode) => resolve(exitCode ?? 1));
            });
            callbacks?.onProviderFinished?.();
            if (code !== 0) {
              try { claudePrintResult(stdout); } catch (error) {
                throw new Error(`Claude CLI exited ${code}: ${error instanceof Error ? error.message : String(error)}`);
              }
              throw new Error(`Claude CLI exited ${code}: ${stderr.slice(-500)}`);
            }
            const result = claudePrintResult(stdout);
            if (result.sessionId) {
              modes.set(result.sessionId, mode);
              await callbacks?.onSessionId?.(result.sessionId);
            }
            return { provider: this.provider, providerSessionId: result.sessionId,
              finalResponse: result.response, items: [{ type: "message", text: result.response }] };
          } finally {
            active = undefined;
          }
        } }),
      };
    } });
  }
}
